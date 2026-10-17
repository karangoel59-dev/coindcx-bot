/**
 * The only module that is allowed to place, modify or cancel an order.
 *
 * Everything that can lose money funnels through here so the guardrails —
 * dry-run, size caps, fresh-quote checks, idempotency keys — are impossible to
 * route around from a strategy.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { venueRequest, type VenueRequest } from './venue.js';
import type { CoinDCXClient, FuturesOrderResponse } from '@nemesis-oss/coindcx-sdk';
import type { Config } from './config.js';
import {
  assertClientOrderId,
  checkOrder,
  fetchInstrument,
  quantizeQuantity,
  quantizePrice,
  type Instrument,
} from './instrument.js';
import { log } from './logger.js';
import type { PriceFeed } from './marks.js';
import * as state from './state.js';
import { entryBlockStore, type EntryBlockStore } from './entry-block.js';

/** Only classify create failures; HTTP 408 leaves the submission uncertain. */
function isDefinitiveRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) &&
    status >= 400 && status < 500 && status !== 408;
}

export type Side = 'buy' | 'sell';
export type PositionSide = 'long' | 'short';

/** Normalized position, independent of which shape the API handed us. */
export interface OpenPosition {
  id: string;
  pair: string;
  side: PositionSide;
  size: number;
  entryPrice: number;
  markPrice: number | null;
  leverage: number | null;
  unrealizedPnl: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

/**
 * The SDK types `getPositions()` as snake_case `PositionResponse[]`, but in
 * paper mode the call is short-circuited to `PaperTradingEngine.getPositions()`
 * and returns camelCase `PaperPosition[]` with no conversion. The declared
 * type is a lie in that path, so read both spellings.
 */
function normalizePosition(raw: unknown): OpenPosition | null {
  if (raw === null || typeof raw !== 'object') throw new Error('Invalid position record');
  const r = raw as Record<string, unknown>;

  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (r[k] !== undefined && r[k] !== null) return r[k];
    }
    return undefined;
  };

  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const size = numOrNull(pick('size', 'active_pos', 'quantity'));
  const entryPrice = numOrNull(pick('entry_price', 'entryPrice', 'avg_price'));
  const pair = pick('pair', 'market', 'symbol');
  const sideRaw = String(pick('side') ?? '').toLowerCase();

  if (size === null || typeof pair !== 'string') throw new Error('Position has no valid size or pair');
  if (size === 0) return null;
  const id = pick('id', 'position_id');
  if (entryPrice === null || entryPrice <= 0 || typeof id !== 'string' || !id) {
    throw new Error(`Nonzero position ${pair} has invalid entry price or id; trading blocked`);
  }

  // Some payloads express direction by the sign of the size instead of a side.
  let side: PositionSide;
  if (sideRaw === 'long' || sideRaw === 'buy') side = 'long';
  else if (sideRaw === 'short' || sideRaw === 'sell') side = 'short';
  else if (sideRaw === '') side = size > 0 ? 'long' : 'short';
  else throw new Error(`Unrecognized position side: ${sideRaw}`);

  return {
    id,
    pair,
    side,
    size: Math.abs(size),
    entryPrice,
    markPrice: numOrNull(pick('mark_price', 'markPrice')),
    leverage: numOrNull(pick('leverage')),
    unrealizedPnl: numOrNull(pick('unrealized_pnl', 'unrealizedPnl')),
    stopLoss: numOrNull(pick('stop_loss_trigger', 'stopLoss')),
    takeProfit: numOrNull(pick('take_profit_trigger', 'takeProfit')),
  };
}

export interface EntryParams {
  side: Side;
  quantity: number;
  stopLoss: number;
  takeProfit: number | undefined;
}

export interface ConfirmationClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const CONFIRMATION_MS = 60_000;
const CONFIRMATION_POLL_MS = 500;

function exitAlreadyInProgress(err: unknown): boolean {
  return /exit order is already in progress/i.test(err instanceof Error ? err.message : String(err));
}

function isNumeric(value: unknown): value is string | number {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
    Number.isFinite(Number(value));
}

export class Broker {
  private instrument: Instrument | null = null;
  private readonly request: VenueRequest;
  private entryBlock: string | null = null;
  private readonly blockStore: EntryBlockStore;
  private readonly clock: ConfirmationClock;
  private pendingExit: { id: string; reason: string } | null = null;
  private exiting: Promise<void> | null = null;

  isExitPending(): boolean { return this.pendingExit !== null || this.exiting !== null; }

  private setEntryBlock(reason: string | null): void {
    // Keep the in-memory latch even when persisting a failure reason fails.
    if (reason !== null) this.entryBlock = reason;
    this.blockStore.write(reason);
    this.entryBlock = reason;
  }

  getEntryBlock(): string | null {
    return this.entryBlock;
  }

  /** Explicit operator recovery for an acknowledged, fully filled, now closed entry. */
  async recoverCompletedEntry(clientOrderId: string, clear = false): Promise<{
    clientOrderId: string; orderIds: string[]; filledQuantity: number; cleared: boolean;
  }> {
    if (this.cfg.mode !== 'live') throw new Error('Recovery requires MODE=live');
    if (clear && this.cfg.dryRun) throw new Error('DRY_RUN prevents clearing the journal');
    if (!/^b[0-9a-f]{32}$/.test(clientOrderId) ||
        !this.entryBlock?.startsWith(`submission ${clientOrderId} `)) {
      throw new Error('Client order ID does not match the persisted entry block');
    }
    if (this.isExitPending()) throw new Error('Exit confirmation is pending');
    const all = (await Promise.all(['buy', 'sell'].map(side =>
      this.readPages('orders', { side, status: 'filled' })))).flat();
    const orders = all.filter(raw => raw && typeof raw === 'object' &&
      (raw as Record<string, unknown>).client_order_id === clientOrderId).map(normalizeOrder);
    if (!orders.length) throw new Error('No terminal filled order found for the blocked submission');
    let quantity = 0;
    for (const order of orders) {
      const raw = order as unknown as Record<string, unknown>;
      if (order.pair !== this.cfg.pair || order.status !== 'filled' ||
          (raw.side !== 'buy' && raw.side !== 'sell') ||
          !isNumeric(raw.remaining_quantity) || Number(raw.remaining_quantity) !== 0 ||
          !isNumeric(raw.updated_at) || Number(raw.updated_at) <= 0 ||
          Number(raw.updated_at) > this.clock.now() - CONFIRMATION_MS ||
          !isNumeric(raw.total_quantity ?? raw.target_quantity ?? raw.quantity) ||
          !Number.isFinite(order.target_quantity) || order.target_quantity <= 0) {
        throw new Error('Order is not a settled, fully filled order for this instrument');
      }
      const fills = await this.readPages('trades', { pair: this.cfg.pair, order_id: order.id });
      let filled = 0;
      for (const value of fills) {
        const fill = value as Record<string, unknown>;
        if (!fill || fill.order_id !== order.id || fill.pair !== this.cfg.pair || fill.side !== raw.side ||
            !isNumeric(fill.quantity) || Number(fill.quantity) <= 0) {
          throw new Error('Invalid or mismatched fill history; recovery refused');
        }
        filled += Number(fill.quantity);
      }
      if (Math.abs(filled - order.target_quantity) > 1e-8 * Math.max(1, order.target_quantity)) {
        throw new Error('Fill history does not account for the complete entry quantity');
      }
      quantity += filled;
    }
    // A flat snapshot alone cannot prove an uncertain order was never submitted.
    // Here terminal order state and matching fills establish execution first.
    for (let check = 0; check < 2; check++) {
      if (await this.getPosition()) throw new Error('Position is still open; recovery refused');
      if ((await this.getOpenOrders()).length) throw new Error('Working orders remain; recovery refused');
      if (check === 0) await this.clock.sleep(2000);
    }
    const proof = { clientOrderId, orderIds: orders.map(o => String(o.id)), filledQuantity: quantity, cleared: clear };
    if (clear) {
      this.setEntryBlock(null);
      log.info('completed entry reconciled; operator cleared journal', proof);
    }
    return proof;
  }

  constructor(
    private readonly client: CoinDCXClient,
    private readonly cfg: Config,
    private readonly prices: PriceFeed,
    request?: VenueRequest,
    blockStore?: EntryBlockStore,
    clock?: ConfirmationClock,
  ) {
    this.request = request ?? venueRequest(client, cfg);
    this.blockStore = blockStore ?? entryBlockStore(cfg);
    this.entryBlock = this.blockStore.read();
    this.clock = clock ?? { now: () => Date.now(), sleep: delay };
    if (this.entryBlock) log.warn('restored entry block; venue reconciliation requires operator review', {
      reason: this.entryBlock,
    });
  }

  /**
   * Loads venue constraints. Must run before any sizing or order call —
   * `open()` and `sizeEntry()` throw without it rather than guessing a lot size.
   */
  async loadInstrument(): Promise<Instrument> {
    const instrument = await fetchInstrument(this.cfg.pair, this.cfg.quoteCurrency);
    const maxLeverage = Math.max(instrument.maxLeverageLong, instrument.maxLeverageShort);
    if (maxLeverage > 0 && this.cfg.leverage > maxLeverage) {
      throw new Error(
        `LEVERAGE=${this.cfg.leverage} exceeds the ${this.cfg.pair} maximum of ${maxLeverage}`,
      );
    }
    this.instrument = instrument;
    state.update({
      instrument: {
        minQuantity: instrument.minQuantity,
        minNotional: instrument.minNotional,
        quantityIncrement: instrument.quantityIncrement,
      },
    });
    return instrument;
  }

  private requireInstrument(): Instrument {
    if (!this.instrument) {
      throw new Error('Instrument metadata not loaded; call loadInstrument() first');
    }
    return this.instrument;
  }

  /**
   * Current position for the configured pair, read from the venue rather than
   * from local memory. Local state drifts; the exchange is the only truth.
   */
  async getPosition(): Promise<OpenPosition | null> {
    const list = await this.readPages('positions', {});
    const positions = list.map(normalizePosition).filter((p): p is OpenPosition =>
      p !== null && p.pair === this.cfg.pair);
    if (positions.length > 1) throw new Error('Multiple positions for this pair; trading blocked');
    const found = positions[0] ?? null;
    state.update({ position: found, positionAt: Date.now() });
    return found;
  }

  private async readPages(path: string, extra: Record<string, unknown>): Promise<unknown[]> {
    const all: unknown[] = [];
    const size = 100;
    for (let page = 1; page <= 100; page++) {
      const raw = await this.request('POST', path, {
        ...extra, page: String(page), size: String(size),
        margin_currency_short_name: [this.cfg.quoteCurrency],
      });
      if (!Array.isArray(raw)) throw new Error(`Invalid ${path} response; trading blocked`);
      all.push(...raw);
      if (raw.length < size) return all;
    }
    throw new Error(`Pagination limit exceeded for ${path}; trading blocked`);
  }

  async getOpenOrders(): Promise<FuturesOrderResponse[]> {
    const lists = await Promise.all(['buy', 'sell'].map(side =>
      this.readPages('orders', { side, status: 'open,partially_filled,untriggered' })));
    return lists.flat().map(normalizeOrder).filter(o => o.pair === this.cfg.pair);
  }

  async cancelAllOrders(): Promise<void> {
    const orders = await this.getOpenOrders();
    if (this.cfg.dryRun) {
      log.info('dry-run: would cancel open orders', { pair: this.cfg.pair, count: orders.length });
      return;
    }
    // Cancel only enumerated orders for this instrument, never account-wide.
    for (const order of orders) await this.request('POST', 'orders/cancel', { id: order.id });
    if ((await this.getOpenOrders()).length) throw new Error('Working orders remain after cancellation');
  }

  /**
   * Position size from account equity, risk budget and stop distance.
   * Quantized to the instrument's lot size — an unquantized quantity is
   * rejected by the venue, which in a live run looks like a dead strategy.
   */
  async sizeEntry(entryPrice: number, stopPrice: number): Promise<number> {
    const instrument = this.requireInstrument();
    const equity = await this.getEquity();
    if (!Number.isFinite(equity) || equity <= 0) throw new Error('No usable equity for sizing');
    const sized = this.client.ops.sizing.calculatePositionSize({
      accountBalance: equity,
      riskPercent: this.cfg.riskPercent,
      entryPrice,
      stopLossPrice: stopPrice,
      leverage: this.cfg.leverage,
    });

    this.prices.requireFreshMark();
    const book = this.prices.getBidAsk();
    const budgetPrice = Math.max(entryPrice, book?.ask ?? entryPrice) * (1 + this.cfg.maxSlippagePct);
    let qty = sized.quantity;
    if (this.cfg.maxOrderQuantity !== undefined) {
      qty = Math.min(qty, this.cfg.maxOrderQuantity);
    }
    if (this.cfg.maxOrderNotional !== undefined && entryPrice > 0) {
      qty = Math.min(qty, this.cfg.maxOrderNotional / budgetPrice);
    }

    qty = Math.min(qty, equity * this.cfg.leverage / budgetPrice);

    // Quantize against the instrument's real step, not the SDK's hardcoded
    // 0.001 fallback.
    const quantized = quantizeQuantity(instrument, qty);
    log.info('sized entry', {
      equity,
      riskPercent: this.cfg.riskPercent,
      entryPrice,
      stopPrice,
      raw: sized.quantity,
      capped: qty,
      quantized,
      notional: quantized * entryPrice,
      minNotional: instrument.minNotional,
      marginRequired: sized.marginRequired,
    });
    return quantized;
  }

  /** Futures wallet equity in the quote currency, or paper equity in paper mode. */
  async getEquity(): Promise<number> {
    const equity = await this.readEquity();
    state.update({ equity, equityAt: Date.now() });
    return equity;
  }

  private async readEquity(): Promise<number> {
    if (this.cfg.mode === 'paper') {
      const acct = this.client.paper.getAccount();
      // Not `totalEquity`: the paper engine defines that as spot + futures,
      // and seeding both from PAPER_BALANCE would double-count the account.
      // A futures bot sizes off the futures wallet plus open PnL.
      state.update({ equityBasis: 'paper-equity' });
      return acct.futuresBalance + acct.unrealizedPnl;
    }
    const wallet = await this.request('GET', 'wallets');
    if (!Array.isArray(wallet)) throw new Error('Invalid futures wallet response');
    const entry = wallet.find(w => String(w.currency_short_name ?? w.currency).toUpperCase() === this.cfg.quoteCurrency);
    if (!entry) throw new Error(`No ${this.cfg.quoteCurrency} futures wallet`);
    const balance = Number(entry.available_balance ?? entry.balance);
    if (!Number.isFinite(balance) || balance < 0) throw new Error('Invalid wallet balance');
    state.update({ equityBasis: entry.available_balance != null ? 'available-balance' : 'wallet-balance' });
    return balance;
  }

  /** Submit once, confirm the fill, and verify venue protection before returning. */
  async open(params: EntryParams): Promise<FuturesOrderResponse | null> {
    if (this.entryBlock) throw new Error(`Entries blocked: ${this.entryBlock}`);
    if (this.isExitPending()) throw new Error('Exit confirmation is pending; entry blocked');
    const instrument = this.requireInstrument();
    if (await this.getPosition()) throw new Error('Refusing entry into an existing position');
    if ((await this.getOpenOrders()).length) throw new Error('Working orders exist; entry blocked');
    this.prices.requireFreshMark();
    const book = this.prices.getBidAsk();
    if (!book) throw new Error('No fresh order book');
    const executionPrice = params.side === 'buy' ? book.ask : book.bid;
    const budgetPrice = executionPrice * (1 + this.cfg.maxSlippagePct);
    const check = checkOrder(instrument, params.quantity, executionPrice, this.cfg.leverage, params.side);
    if (!check.ok) throw new Error(`Pre-trade check failed: ${check.reason}`);
    if (this.cfg.maxOrderQuantity !== undefined && params.quantity > this.cfg.maxOrderQuantity) {
      throw new Error('Quantity cap exceeded');
    }
    if (this.cfg.maxOrderNotional !== undefined && params.quantity * budgetPrice > this.cfg.maxOrderNotional) {
      throw new Error('Notional cap exceeded at current executable quote plus slippage allowance');
    }
    const stop = quantizePrice(instrument, params.stopLoss);
    const tp = params.takeProfit === undefined ? undefined : quantizePrice(instrument, params.takeProfit);
    validateTriggers(params.side === 'buy' ? 'long' : 'short', executionPrice, stop, tp);
    // One-character prefix plus a 32-character UUID fits the venue's limit.
    const clientOrderId = `b${randomUUID().replace(/-/g, '')}`;
    assertClientOrderId(clientOrderId);
    const request = { order: {
      side: params.side, pair: this.cfg.pair, order_type: 'market_order',
      total_quantity: params.quantity, price: null, stop_price: null, time_in_force: null,
      leverage: this.cfg.leverage, notification: 'no_notification',
      margin_currency_short_name: this.cfg.quoteCurrency,
      position_margin_type: this.cfg.marginType === 'cross' ? 'crossed' : 'isolated',
      client_order_id: clientOrderId, stop_loss_price: stop,
      ...(tp === undefined ? {} : { take_profit_price: tp }),
    } };
    if (this.cfg.dryRun) {
      log.info('dry-run: would open protected position', { request });
      return null;
    }

    // Set this BEFORE sending: timeouts and malformed acknowledgements cannot
    // cause the next candle to submit a second entry under a new UUID.
    this.setEntryBlock(`submission ${clientOrderId} has not been reconciled`);
    let createAcknowledged = false;
    let orders: FuturesOrderResponse[] = [];
    try {
      const raw = await this.request('POST', 'orders/create', request);
      createAcknowledged = true;
      orders = (Array.isArray(raw) ? raw : [raw]).map(normalizeOrder);
      const order = orders[0];
      if (!order || orders.some(o => o.pair !== this.cfg.pair)) throw new Error('Unexpected entry acknowledgement');
      const entryIds = new Set(orders.map(o => o.id));
      state.bump('entries');
      log.info('entry submitted', { id: order.id, clientOrderId, status: order.status });
      let fillObserved = false;
      const pos = await this.waitForPosition(p => p !== null,
        () => fillObserved
          ? 'Entry filled but position remained unavailable within 60s'
          : 'Entry position not visible within 60s; fill status unconfirmed',
        async () => {
          if (fillObserved || this.cfg.mode === 'paper') return;
          for (const id of entryIds) {
            const fills = await this.readPages('trades', { pair: this.cfg.pair, order_id: id });
            if (fills.some((raw: unknown) => {
              if (!raw || typeof raw !== 'object') return false;
              const fill = raw as Record<string, unknown>;
              return fill.order_id === id && fill.pair === this.cfg.pair && fill.side === params.side &&
                Number.isFinite(Number(fill.quantity)) && Number(fill.quantity) > 0;
            })) {
              fillObserved = true;
              log.info('entry fill observed; awaiting position and protection', { clientOrderId, id });
              return;
            }
          }
        });
      if (!pos || pos.side !== (params.side === 'buy' ? 'long' : 'short')) {
        throw new Error('Entry resulted in unexpected position direction');
      }
      await this.ensureProtection(pos, stop, tp);
      const remainder = (await this.getOpenOrders()).filter(o => entryIds.has(o.id));
      if (remainder.length) {
        for (const remaining of remainder) await this.request('POST', 'orders/cancel', { id: remaining.id });
        if ((await this.getOpenOrders()).some(o => entryIds.has(o.id))) {
          throw new Error('Entry remainder could not be cancelled');
        }
      }
      const finalPos = await this.getPosition();
      if (finalPos) await this.ensureProtection(finalPos, stop, tp);
      this.setEntryBlock(null);
      return order;
    } catch (err) {
      try {
        this.setEntryBlock(`submission ${clientOrderId} failed: ${err instanceof Error ? err.message : String(err)}`);
      } catch (journalError) {
        log.error('could not update entry journal; original submission block retained', {
          error: String(journalError),
        });
      }
      // A rejection of a later read, cancellation or TP/SL request says
      // nothing about whether the entry was submitted. Keep those latched.
      if (!createAcknowledged && isDefinitiveRejection(err)) {
        this.setEntryBlock(null);
        log.warn('venue rejected the create request; entries re-enabled', { error: String(err) });
        throw err;
      }
      log.error('entry not safely protected; blocking entries and attempting exit', { error: String(err) });
      try {
        for (const submitted of orders) await this.request('POST', 'orders/cancel', { id: submitted.id });
      } catch (cancelError) {
        log.warn('entry cancellation failed', { error: String(cancelError) });
      }
      try {
        await this.flatten('entry-protection-failed');
      } catch (flattenError) {
        log.warn('post-failure flatten failed', { error: String(flattenError) });
      }
      throw err;
    }
  }

  private async waitForPosition(predicate: (p: OpenPosition | null) => boolean,
    failure: string | (() => string), observe?: () => Promise<void>): Promise<OpenPosition | null> {
    const started = this.clock.now(), deadline = started + CONFIRMATION_MS;
    let nextObservation = started + 5000, reportedReadError = false;
    let lastError: unknown;
    while (true) {
      try {
        const pos = await this.getPosition();
        if (predicate(pos)) return pos;
      } catch (err) {
        lastError = err;
        if (!reportedReadError) {
          reportedReadError = true;
          log.warn('position confirmation read failed; retrying within deadline', { error: String(err) });
        }
      }
      const now = this.clock.now();
      if (now >= deadline) break;
      if (observe && now >= nextObservation) {
        nextObservation = now + 5000;
        try { await observe(); }
        catch (err) { log.warn('entry fill lookup failed; position confirmation continues', { error: String(err) }); }
      }
      await this.clock.sleep(Math.min(CONFIRMATION_POLL_MS, Math.max(0, deadline - this.clock.now())));
    }
    const message = typeof failure === 'function' ? failure() : failure;
    throw new Error(lastError ? `${message}; last position read: ${String(lastError)}` : message);
  }

  /** Verify inline protection, otherwise attach the documented market TP/SL. */
  async ensureProtection(pos: OpenPosition, stop?: number, tp?: number): Promise<void> {
    const instrument = this.requireInstrument();
    const stopPrice = stop ?? (pos.stopLoss && pos.stopLoss > 0 ? pos.stopLoss :
      quantizePrice(instrument, pos.entryPrice * (pos.side === 'long' ? 1 - this.cfg.stopLossPct : 1 + this.cfg.stopLossPct)));
    const takeProfit = tp ?? (pos.takeProfit && pos.takeProfit > 0 ? pos.takeProfit : undefined);
    this.prices.requireFreshMark();
    validateTriggers(pos.side, this.prices.getMark()!, stopPrice, takeProfit);
    if (this.cfg.dryRun) {
      log.info('dry-run: would verify/attach protection', { id: pos.id, stopPrice, takeProfit });
      return;
    }
    const matches = (p: OpenPosition | null): boolean => p !== null && p.id === pos.id &&
      p.side === pos.side && p.stopLoss !== null && Math.abs(p.stopLoss - stopPrice) < instrument.priceIncrement / 2 &&
      (takeProfit === undefined || (p.takeProfit !== null && Math.abs(p.takeProfit - takeProfit) < instrument.priceIncrement / 2));
    if (!matches(pos)) {
      await this.request('POST', 'positions/create_tpsl', {
        id: pos.id, stop_loss: { stop_price: String(stopPrice), order_type: 'stop_market' },
        ...(takeProfit === undefined ? {} : {
          take_profit: { stop_price: String(takeProfit), order_type: 'take_profit_market' },
        }),
      });
      await this.waitForPosition(matches, 'Venue TP/SL triggers could not be verified');
    }
    log.info('position protection verified', { id: pos.id, stopPrice, takeProfit });
  }

  /** Exit by position ID and poll until the venue confirms flat. */
  async flatten(reason: string): Promise<void> {
    if (this.exiting) return this.exiting;
    this.exiting = this.confirmExit(reason).finally(() => { this.exiting = null; });
    return this.exiting;
  }

  private async confirmExit(reason: string): Promise<void> {
    const pos = await this.getPosition();
    if (!pos) {
      if (this.pendingExit) log.info('exit confirmed flat', this.pendingExit);
      this.pendingExit = null;
      return;
    }
    if (this.cfg.dryRun) {
      log.info('dry-run: would flatten', { reason, id: pos.id });
      return;
    }
    if (this.pendingExit && this.pendingExit.id !== pos.id) {
      throw new Error('Position changed while exit confirmation is pending; operator review required');
    }
    if (!this.pendingExit) {
      this.pendingExit = { id: pos.id, reason };
      try {
        await this.request('POST', 'positions/exit', { id: pos.id });
        state.bump('exits');
      } catch (err) {
        if (exitAlreadyInProgress(err)) {
          log.info('venue exit already in progress; awaiting flat', { id: pos.id });
        } else if (isDefinitiveRejection(err)) {
          this.pendingExit = null;
          throw err;
        } else {
          // A timeout may follow acceptance. Poll rather than send a duplicate exit.
          log.warn('exit submission outcome uncertain; awaiting flat', { id: pos.id, error: String(err) });
        }
      }
    }
    await this.waitForPosition(p => p === null, 'Position still open after 60s; exit confirmation pending');
    log.info('exit confirmed flat', this.pendingExit);
    this.pendingExit = null;
  }

  /** Sets leverage on the venue so it matches config before the first entry. */
  async syncLeverage(): Promise<void> {
    if (this.cfg.mode === 'paper' || this.cfg.dryRun) return;
    try {
      await this.request('POST', 'positions/update_leverage', {
        pair: this.cfg.pair,
        leverage: this.cfg.leverage,
      });
      log.info('leverage synced', { pair: this.cfg.pair, leverage: this.cfg.leverage });
    } catch (err) {
      // Not fatal: leverage is also passed per order. Worth knowing about though.
      log.warn('could not set account leverage; per-order leverage still applies', {
        error: String(err),
      });
    }
  }
}

function validateTriggers(side: PositionSide, price: number, stop: number, tp?: number): void {
  if (!Number.isFinite(stop) || stop <= 0 || (side === 'long' ? stop >= price : stop <= price)) {
    throw new Error('Stop is invalid or already breached');
  }
  if (tp !== undefined && (!Number.isFinite(tp) || tp <= 0 || (side === 'long' ? tp <= price : tp >= price))) {
    throw new Error('Take profit is invalid or already breached');
  }
}

function normalizeOrder(raw: unknown): FuturesOrderResponse {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid order acknowledgement');
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || !r['id'] || typeof r['pair'] !== 'string') {
    throw new Error('Order has no valid id or pair');
  }
  return { ...r, status: String(r['status'] ?? '').toLowerCase(),
    target_quantity: Number(r['total_quantity'] ?? r['target_quantity'] ?? r['quantity']),
  } as unknown as FuturesOrderResponse;
}
