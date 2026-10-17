/**
 * The loop.
 *
 * Candle closes drive the strategy; the strategy's desired position is diffed
 * against the venue's actual position; entry/exit intents run in sequence. A separate monitor watches the mark price between candles so a stop
 * breach is not left waiting for the next bar.
 */

import type { CoinDCXClient } from '@nemesis-oss/coindcx-sdk';
import type { Broker } from './broker.js';
import type { Config } from './config.js';
import { log } from './logger.js';
import type { PriceFeed } from './marks.js';
import * as state from './state.js';
import type { Candle, Strategy, Target } from './strategy.js';

const CANDLE_POLL_MS = 20_000;
const STOP_MONITOR_MS = 5_000;
const WATCHDOG_MS = 60_000;

/**
 * Maps a REST candle.
 *
 * The SDK types these as `{ open_time, close_time }`, but `/market_data/candles`
 * actually returns a single `time` field (ms epoch, the bar's open) and the SDK
 * passes the body through unmapped. Reading `open_time` yields undefined, so
 * every candle parses to NaN and gets dropped — which presents as "0 candles
 * returned" for a pair that plainly has data. Read `time` first, and keep the
 * documented names as fallbacks in case the SDK ever starts mapping them.
 */
function toCandle(raw: unknown, intervalMs: number): Candle | null {
  if (raw === null || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;

  const openTime = Number(c['time'] ?? c['open_time'] ?? c['openTime']);
  const close = Number(c['close']);
  if (!Number.isFinite(openTime) || openTime <= 0 || !Number.isFinite(close) || close <= 0) return null;

  const values = ['open', 'high', 'low', 'close', 'volume'].map(key => Number(c[key]));
  if (values.some(v => !Number.isFinite(v)) || values.slice(0, 4).some(v => v <= 0) || values[4]! < 0 ||
      openTime % intervalMs !== 0) return null;
  return {
    open: Number(c['open']),
    high: Number(c['high']),
    low: Number(c['low']),
    close,
    volume: Number(c['volume']),
    openTime,
    closeTime: openTime + intervalMs - 1,
  };
}

export class Engine {
  /** openTime of the most recent candle we have seen (closed or forming). */
  private latestOpenTime = 0;
  private polling: Promise<void> | null = null;
  private pendingTarget: Target | null = null;
  private targetVersion = 0;
  private appliedVersion = 0;
  private dataBlocked = false;
  private draining: Promise<void> | null = null;
  private actionTail: Promise<void> = Promise.resolve();
  /** openTime of the last candle we dispatched to the strategy. */
  private lastDispatched = 0;
  /** Serializes all order-emitting work; the monitor and the loop share it. */
  private busy = false;
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private lastEntryBlockNotice: string | null = null;

  constructor(
    private readonly client: CoinDCXClient,
    private readonly cfg: Config,
    private readonly broker: Broker,
    private readonly prices: PriceFeed,
    private readonly strategy: Strategy,
  ) {}

  /** Seeds the strategy from REST history. Oldest first, in-progress dropped. */
  async warmup(): Promise<void> {
    const raw = await this.client.futures.market.getCandles(
      this.cfg.pair,
      this.cfg.candleInterval,
      this.cfg.warmupCandles,
    );
    if (!Array.isArray(raw)) throw new Error('Invalid warmup response');
    const parsed = raw.map(c => toCandle(c, this.cfg.candleIntervalMs));
    if (parsed.some(c => c === null)) throw new Error('Invalid warmup candle');
    const candles = (parsed as Candle[]).sort((a, b) => a.openTime - b.openTime);

    const needed = this.strategy.requiredCandles;
    if (candles.length <= needed) {
      throw new Error(
        `Only ${candles.length} candles returned for ${this.cfg.pair} ${this.cfg.candleInterval}; ` +
          `${this.strategy.name} needs more than ${needed}. Raise WARMUP_CANDLES, use a shorter ` +
          'interval, or pick a more liquid pair.',
      );
    }

    // Leave a short publication grace period after the interval boundary.
    const closed = candles.filter(c => c.openTime + this.cfg.candleIntervalMs + 2000 <= Date.now());
    if (closed.length < needed) {
      throw new Error(
        `Only ${closed.length} finalized warmup candles; ${this.strategy.name} needs ${needed}`,
      );
    }
    this.assertContinuous(closed);
    this.strategy.warmup(closed);

    const lastClosed = closed[closed.length - 1];
    if (lastClosed) this.lastDispatched = lastClosed.openTime;
    this.latestOpenTime = candles.at(-1)?.openTime ?? 0;

    if (lastClosed) {
      state.update({
        lastCandle: { openTime: lastClosed.openTime, close: lastClosed.close },
        candleHistory: closed.slice(-60).map(c => ({ openTime: c.openTime, close: c.close })),
      });
    }
    // Publish the seeded target so the UI shows the strategy's standing view
    // rather than "none" until the first live candle closes.
    state.update({ target: this.strategy.currentTarget?.() ?? null });

    log.info('warmup complete', {
      pair: this.cfg.pair,
      interval: this.cfg.candleInterval,
      closedCandles: closed.length,
      lastClosedOpenTime: lastClosed?.openTime ?? null,
      latestOpenTime: this.latestOpenTime,
      strategyReady: this.strategy.isReady(),
    });
  }

  async start(): Promise<void> {
    this.wirePrivateStreams();
    this.subscribeCandles();

    // REST polling is the reliable spine; the websocket, when it connects, is
    // a latency improvement on top. Close detection is keyed on openTime, so
    // the same candle arriving by both paths is dispatched exactly once.
    this.addTimer(
      setInterval(() => {
        void this.pollCandles().catch((err: unknown) => {
          log.warn('candle poll failed', { error: String(err) });
        });
      }, CANDLE_POLL_MS),
    );

    this.addTimer(
      setInterval(() => {
        void this.monitorStop().catch((err: unknown) => {
          log.error('stop monitor failed', { error: String(err) });
        });
      }, STOP_MONITOR_MS),
    );

    this.addTimer(setInterval(() => this.watchdog(), WATCHDOG_MS));
    this.addTimer(setInterval(() => { void this.drainTarget(); }, STOP_MONITOR_MS));

    log.info('engine started', { strategy: this.strategy.name, pair: this.cfg.pair });
  }

  stop(): void {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /**
   * Timers are deliberately NOT unref'd. They are what keeps the process
   * alive: with everything unref'd, the websocket was the only referenced
   * handle, so when it dropped the event loop emptied and Node exited with
   * code 0 — a trading bot vanishing with no error. `stop()` clears them, and
   * shutdown calls `process.exit` anyway, so holding the loop open costs
   * nothing on the way out.
   */
  private addTimer(t: NodeJS.Timeout): void {
    this.timers.push(t);
  }

  private subscribeCandles(): void {
    // The SDK declarations name callbacks with an `on` prefix, but its
    // runtime emits bare names. WS is a wake-up; only REST-finalized bars trade.
    this.client.ws.on('candle', () => {
      if (this.stopping || Date.now() < this.lastDispatched + this.cfg.candleIntervalMs * 2 + 2000) return;
      void this.pollCandles().catch(err => log.error('candle refresh failed', { error: String(err) }));
    });
    this.client.publicStreams.subscribeCandles(this.cfg.pair, this.cfg.candleInterval);
  }

  private wirePrivateStreams(): void {
    this.client.ws.on('orderUpdate', (u: import('@nemesis-oss/coindcx-sdk').WsOrderUpdate) => {
      log.info('order update', {
        id: u.id,
        clientOrderId: u.client_order_id,
        side: u.side,
        status: u.status,
        price: u.price,
        quantity: u.quantity,
        filled: u.filled_quantity,
      });
    });

    this.client.ws.on('positionUpdate', (u: import('@nemesis-oss/coindcx-sdk').WsPositionUpdate) => {
      log.info('position update', {
        id: u.id,
        pair: u.pair,
        side: u.side,
        size: u.size,
        entryPrice: u.entry_price,
        markPrice: u.mark_price,
        unrealizedPnl: u.unrealized_pnl,
      });
    });

    this.client.ws.on('balanceUpdate', (u: import('@nemesis-oss/coindcx-sdk').WsBalanceUpdate) => {
      log.info('balance update', {
        currency: u.currency,
        balance: u.balance,
        available: u.available_balance,
      });
    });
  }

  private pollCandles(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.polling) return this.polling.then(() => this.drainTarget());
    this.polling = this.fetchClosedCandles().finally(() => { this.polling = null; });
    return this.polling.then(() => this.drainTarget());
  }

  private assertContinuous(candles: Candle[]): void {
    for (let i = 1; i < candles.length; i++) {
      if (candles[i]!.openTime - candles[i - 1]!.openTime !== this.cfg.candleIntervalMs) {
        throw new Error('Candle history has a gap or duplicate; entries blocked');
      }
    }
  }

  private async fetchClosedCandles(): Promise<void> {
    // Fetch every missing interval, plus overlap and the forming bar. If a
    // gap exceeds the API history window, fail closed instead of skipping it.
    const needed = Math.max(3, Math.ceil((Date.now() - this.lastDispatched) / this.cfg.candleIntervalMs) + 2);
    try {
      if (needed > 1000) throw new Error('Candle gap exceeds 1000 bars; restart to warm indicators');
      const raw = await this.client.futures.market.getCandles(this.cfg.pair, this.cfg.candleInterval, needed);
      if (!Array.isArray(raw) || !raw.length) throw new Error('No candle history returned');
      const candles = raw.map(c => toCandle(c, this.cfg.candleIntervalMs));
      if (candles.some(c => c === null)) throw new Error('Invalid candle history');
      const sorted = (candles as Candle[]).sort((a, b) => a.openTime - b.openTime);
      const closed = sorted.filter(c => c.openTime + this.cfg.candleIntervalMs + 2000 <= Date.now());
      const expectedClosed = Math.floor((Date.now() - 2000) / this.cfg.candleIntervalMs) * this.cfg.candleIntervalMs - this.cfg.candleIntervalMs;
      if (!closed.at(-1) || closed.at(-1)!.openTime < expectedClosed) {
        throw new Error('Candle history is stale; entries blocked');
      }
      const missing = closed.filter(c => c.openTime > this.lastDispatched);
      this.assertContinuous(missing);
      if (missing[0] && missing[0].openTime !== this.lastDispatched + this.cfg.candleIntervalMs) {
        throw new Error('Missing candles were not recovered; entries blocked');
      }
      for (const candle of missing) {
        await this.onClosedCandle(candle, false);
        this.lastDispatched = candle.openTime;
      }
      this.latestOpenTime = sorted.at(-1)?.openTime ?? this.latestOpenTime;
      this.dataBlocked = false;
      state.update({ candleDataBlocked: false });
      // Trading runs outside the polling promise: another closed candle can
      // update the pending target while an exchange request is still in flight.
    } catch (err) {
      this.dataBlocked = true;
      state.update({ candleDataBlocked: true });
      throw err;
    }
  }

  private async onClosedCandle(candle: Candle, apply = true): Promise<void> {
    if (!this.strategy.isReady()) {
      log.debug('strategy not ready; skipping candle', { openTime: candle.openTime });
      return;
    }

    const previousTarget = state.get().target;
    const target = this.strategy.onClosedCandle(candle);
    state.bump('candles');
    state.update({
      target,
      lastCandle: { openTime: candle.openTime, close: candle.close },
      candleHistory: [...state.get().candleHistory, { openTime: candle.openTime, close: candle.close }].slice(-60),
      ...(previousTarget !== null && previousTarget !== target
        ? { lastSignalChange: { at: Date.now(), from: previousTarget, to: target } }
        : {}),
    });
    log.info('candle closed', {
      openTime: candle.openTime,
      close: candle.close,
      target,
    });

    this.pendingTarget = target;
    this.targetVersion++;
    if (apply) await this.drainTarget();
  }

  private drainTarget(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.runTargets().finally(() => { this.draining = null; });
    return this.draining;
  }

  private async runTargets(): Promise<void> {
    if (this.stopping || this.dataBlocked || this.pendingTarget === null || this.appliedVersion === this.targetVersion) return;
    await this.withLock('target', async () => {
      while (!this.stopping && !this.dataBlocked && this.pendingTarget !== null && this.appliedVersion !== this.targetVersion) {
        const version = this.targetVersion;
        await this.applyTarget(this.pendingTarget);
        this.appliedVersion = version;
      }
    });
  }

  /**
   * Brings the venue's position in line with `target`. At most one order per
   * call; a reversal flattens first and lets the next cycle re-enter, so we
   * never hold two intents in flight.
   */
  private async applyTarget(target: Target): Promise<void> {
    const pos = await this.broker.getPosition();
    if (this.stopping || this.dataBlocked || (this.pendingTarget !== null && this.pendingTarget !== target)) return;
    if (this.broker.isExitPending()) {
      await this.broker.flatten('pending-exit');
      return;
    }
    const actual: Target = pos ? pos.side : 'flat';

    if (actual === target) {
      log.debug('already at target', { target });
      return;
    }

    if (target === 'flat') {
      await this.broker.flatten('signal:flat');
      return;
    }

    if (pos) {
      // Opposite position open: close it now, enter on the next evaluation.
      await this.broker.flatten(`signal:reverse-to-${target}`);
      return;
    }

    const entryBlock = this.broker.getEntryBlock();
    if (entryBlock) {
      if (entryBlock !== this.lastEntryBlockNotice) {
        log.warn('entry skipped while submission requires reconciliation', { reason: entryBlock });
        this.lastEntryBlockNotice = entryBlock;
      }
      return;
    }
    this.lastEntryBlockNotice = null;

    const mark = this.prices.requireFreshMark();
    const stopLoss =
      target === 'long' ? mark * (1 - this.cfg.stopLossPct) : mark * (1 + this.cfg.stopLossPct);
    const takeProfit =
      this.cfg.takeProfitPct === undefined
        ? undefined
        : target === 'long'
          ? mark * (1 + this.cfg.takeProfitPct)
          : mark * (1 - this.cfg.takeProfitPct);

    const quantity = await this.broker.sizeEntry(mark, stopLoss);
    if (quantity <= 0) {
      log.warn('sizing produced no quantity; skipping entry', { mark, stopLoss });
      return;
    }

    if (this.stopping || this.dataBlocked || (this.pendingTarget !== null && this.pendingTarget !== target)) return;
    await this.broker.open({
      side: target === 'long' ? 'buy' : 'sell',
      quantity,
      stopLoss,
      takeProfit,
    });
  }

  /**
   * Backstop for the venue-side stop. The exchange stop is primary and we do
   * not race it — this only fires when the mark has run well past the stop
   * while the position is somehow still open, which is the signal that the
   * venue stop never armed.
   */
  private async monitorStop(): Promise<void> {
    if (this.stopping || this.busy) return;

    await this.withLock('stop-backstop', async () => {
      if (this.broker.isExitPending()) {
        await this.broker.flatten('pending-exit');
        return;
      }
      const pos = await this.broker.getPosition();
      if (!pos) return;
      const mark = this.prices.getMark();
      if (mark === null || this.prices.isStale()) return;

      if (pos.stopLoss === null || pos.stopLoss <= 0) {
        try { await this.broker.ensureProtection(pos); }
        catch (err) {
          log.error('open position has no verified stop; exiting', { error: String(err) });
          await this.broker.flatten('missing-protection');
        }
        return;
      }
      const stop = pos.stopLoss ?? (
        pos.side === 'long'
          ? pos.entryPrice * (1 - this.cfg.stopLossPct)
          : pos.entryPrice * (1 + this.cfg.stopLossPct));
      const stopDistance = Math.abs(pos.entryPrice - stop);
      const slack = stopDistance * this.cfg.stopOverrunTolerance;
      const breached = pos.side === 'long' ? mark < stop - slack : mark > stop + slack;

      if (!breached) return;

      log.error('mark overshot the stop while the position is still open', {
        side: pos.side,
        entryPrice: pos.entryPrice,
        stop,
        mark,
        slack,
        note: 'Venue stop likely never armed. Flattening at market.',
      });
      await this.broker.flatten('stop-backstop');
    });
  }

  /**
   * Periodic liveness report. Silence is the thing we cannot afford: a bot
   * that has lost its price feed, or stopped receiving candles, otherwise
   * looks identical to a bot with no signal. One heartbeat line a minute makes
   * both visible in the log and in the UI.
   */
  private watchdog(): void {
    if (this.stopping) return;

    const quoteStale = this.prices.isStale();
    const wsConnected = this.client.ws.isConnected();
    state.update({ wsConnected });

    // How overdue is the candle we should have seen by now?
    const expectedBy = this.latestOpenTime + this.cfg.candleIntervalMs * 2;
    const candleOverdueMs = this.latestOpenTime > 0 ? Date.now() - expectedBy : 0;
    const candlesOverdue = candleOverdueMs > this.cfg.candleIntervalMs;

    const fields = {
      wsConnected,
      quoteStale,
      lastCandleOpenTime: this.latestOpenTime || null,
      candleOverdueMs: candlesOverdue ? candleOverdueMs : 0,
      busy: this.busy,
    };

    if (quoteStale || candlesOverdue || this.dataBlocked) {
      log.warn('watchdog: data feed degraded', {
        ...fields,
        note: quoteStale
          ? 'No fresh quote — entries are blocked until one arrives.'
          : 'Candles are overdue; REST polling should be filling the gap.',
      });
      return;
    }
    if (!wsConnected) {
      log.warn('watchdog: websocket down, running on REST polling', fields);
      return;
    }
    log.debug('watchdog: ok', fields);
  }

  /** Queue work so a target arriving during an order is never discarded. */
  private async withLock(who: string, fn: () => Promise<void>): Promise<void> {
    const action = this.actionTail.then(async () => {
      if (this.stopping) return;
      this.busy = true;
      try { await fn(); }
      finally { this.busy = false; }
    });
    this.actionTail = action.catch(err => {
      log.error('action failed', { who, error: String(err) });
    });
    await this.actionTail;
  }
}
