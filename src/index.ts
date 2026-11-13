/**
 * Entrypoint: wire, reconcile, run, shut down cleanly.
 */

import { Broker } from './broker.js';
import { buildClient } from './client.js';
import { loadConfig, type Config } from './config.js';
import { startDashboard } from './dashboard.js';
import { Engine } from './engine.js';
import { acquireLock, releaseLock } from './lock.js';
import { log, setErrorHook } from './logger.js';
import { PriceFeed } from './marks.js';
import { reconcile } from './reconcile.js';
import * as state from './state.js';
import type { Strategy } from './strategy.js';
import { AlwaysLongStrategy } from './strategies/always-long.js';
import { DonchianBreakoutStrategy } from './strategies/donchian-breakout.js';
import { EmaCrossStrategy } from './strategies/ema-cross.js';
import { MacdTrendStrategy } from './strategies/macd-trend.js';
import { Rsi2ReversionStrategy } from './strategies/rsi2-reversion.js';
import { SupertrendStrategy } from './strategies/supertrend.js';
import { TrendVoteStrategy } from './strategies/trend-vote.js';
import { discardStaleSdkSocket, WsSupervisor } from './ws-supervisor.js';

function buildStrategy(cfg: Config): Strategy {
  switch (cfg.strategy) {
    case 'always-long':
      return new AlwaysLongStrategy();
    case 'ema-cross':
      return new EmaCrossStrategy(cfg.emaFast, cfg.emaSlow);
    case 'donchian-breakout':
      return new DonchianBreakoutStrategy({
        entryPeriod: cfg.donchianEntryPeriod,
        exitPeriod: cfg.donchianExitPeriod,
        allowShorts: cfg.allowShorts,
      });
    case 'supertrend':
      return new SupertrendStrategy({
        period: cfg.supertrendPeriod,
        multiplier: cfg.supertrendMultiplier,
        allowShorts: cfg.allowShorts,
      });
    case 'rsi2-reversion':
      return new Rsi2ReversionStrategy({
        rsiPeriod: cfg.rsiPeriod,
        oversold: cfg.rsiOversold,
        overbought: cfg.rsiOverbought,
        trendSmaPeriod: cfg.rsiTrendSmaPeriod,
        exitSmaPeriod: cfg.rsiExitSmaPeriod,
        allowShorts: cfg.allowShorts,
      });
    case 'macd-trend':
      return new MacdTrendStrategy({
        fastPeriod: cfg.macdFast,
        slowPeriod: cfg.macdSlow,
        signalPeriod: cfg.macdSignal,
        trendSmaPeriod: cfg.macdTrendSmaPeriod,
        allowShorts: cfg.allowShorts,
      });
    case 'trend-vote':
      return new TrendVoteStrategy({
        lookbacks: cfg.trendVoteLookbacks,
        entry: cfg.trendVoteEntry,
        allowShorts: cfg.allowShorts,
      });
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  acquireLock();

  setErrorHook((msg) => {
    state.bump('errors');
    state.update({ lastError: { at: Date.now(), msg } });
  });
  state.update({
    startedAt: Date.now(),
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    pair: cfg.pair,
    interval: cfg.candleInterval,
    intervalMs: cfg.candleIntervalMs,
    leverage: cfg.leverage,
  });

  if (cfg.mode === 'live' && !cfg.dryRun) {
    log.warn('LIVE MODE — orders will reach the exchange', {
      pair: cfg.pair,
      leverage: cfg.leverage,
      maxOrderQuantity: cfg.maxOrderQuantity ?? null,
      maxOrderNotional: cfg.maxOrderNotional ?? null,
    });
  }
  if (cfg.dryRun) {
    log.info('DRY RUN — orders are logged and discarded; the position never changes, ' +
      'so the engine will re-evaluate the same gap each candle');
  }

  const client = buildClient(cfg);
  const prices = new PriceFeed(client, cfg);
  const broker = new Broker(client, cfg, prices);
  const strategy = buildStrategy(cfg);
  // Caught here rather than at the first candle: starting a 200-SMA strategy
  // with 60 bars of history silently runs a different strategy.
  if (cfg.warmupCandles <= strategy.requiredCandles) {
    throw new Error(
      `${strategy.name} needs more than ${strategy.requiredCandles} warmup candles but ` +
        `WARMUP_CANDLES=${cfg.warmupCandles}. Raise it (max 1000).`,
    );
  }
  const engine = new Engine(client, cfg, broker, prices, strategy);
  state.update({ strategy: strategy.name });

  // Order matters: venue constraints and a quote before anything that might
  // size or price an order.
  await broker.loadInstrument();
  await prices.seed();
  log.info('price feed seeded', { pair: cfg.pair, quote: prices.getBidAsk() });

  await reconcile(broker, cfg);
  await broker.syncLeverage();
  await engine.warmup();

  // The SDK's own reconnect loop dies after a single failed attempt (see
  // ws-supervisor.ts); the supervisor replaces it. Started after the initial
  // connect below so the two do not race to open the first socket.
  const wsSupervisor = new WsSupervisor(client.ws, {
    discardStale: () => discardStaleSdkSocket(client.ws),
  });

  // Make socket transitions visible. Previously a drop was logged only by the
  // SDK's own logger and nothing in this process reacted to it.
  client.ws.on('open', () => {
    state.update({ wsConnected: true });
    log.info('websocket open');
  });
  client.ws.on('close', (reason: string) => {
    state.update({ wsConnected: false });
    log.warn('websocket closed — falling back to REST polling while it reconnects', { reason });
  });
  client.ws.on('error', (err: Error) => {
    state.update({ wsConnected: false });
    log.warn('websocket error', { error: err.message });
  });

  // A websocket failure must not stop the bot: the REST pollers in PriceFeed
  // and Engine cover the same ground, just slower. Paper runs with placeholder
  // credentials will land here.
  try {
    await client.connectWebsocket();
    state.update({ wsConnected: true });
    log.info('websocket connected');
  } catch (err) {
    state.update({ wsConnected: false });
    log.warn('websocket unavailable; running on REST polling until it reconnects', { error: String(err) });
  }
  // Registered either way: on a down socket the SDK records the user channel
  // and joins it on the next connect, so private order/position updates come
  // back with the socket instead of only when the first connect succeeded.
  try {
    client.subscribePrivateStreams();
  } catch (err) {
    log.warn('private streams not subscribed', { error: String(err) });
  }
  wsSupervisor.start();

  // Must come after the websocket attempt so the depth subscription lands on a
  // live socket; the REST refresh timer it also starts works either way.
  prices.start();

  await engine.start();

  // Read-only UI. Its independent broker refresh is throttled to avoid
  // issuing position/wallet requests on every browser poll.
  const dashboard = startDashboard({
    cfg,
    entryBlock: () => broker.getEntryBlock(),
    refresh: async () => {
      await broker.getPosition();
      await broker.getEquity();
    },
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', {
      signal,
      note: 'Open positions are LEFT OPEN and keep their venue-side stops. ' +
        'Flatten manually if that is not what you want.',
    });
    engine.stop();
    prices.stop();
    wsSupervisor.stop();
    dashboard?.close();
    try {
      client.disconnect();
    } catch {
      // Socket may already be gone.
    }
    releaseLock();
    // Give the final log lines a tick to flush.
    setTimeout(() => process.exit(0), 100);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Last-resort breadcrumb. If the process ever ends without going through
  // `shutdown` — an empty event loop, a stray `process.exit` — this is the
  // line that says so instead of leaving an unexplained gap in the log.
  process.on('exit', (code) => {
    if (!shuttingDown) {
      log.error('process exiting WITHOUT a shutdown signal', {
        code,
        note:
          'Not a clean stop. Any open position is unmanaged: no stop monitor, ' +
          'no signal handling. Check the venue.',
      });
      releaseLock();
    }
  });

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception — exiting', { error: String(err) });
    engine.stop();
    prices.stop();
    releaseLock();
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  log.error('fatal', { error: err instanceof Error ? err.message : String(err) });
  releaseLock();
  process.exit(1);
});
