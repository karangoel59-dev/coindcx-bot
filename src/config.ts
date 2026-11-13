/**
 * Environment parsing. Fails loudly at boot rather than at order time — a bot
 * that discovers a missing stop-loss setting halfway through a trade is worse
 * than one that refuses to start.
 */

export type Mode = 'paper' | 'live';
export type MarginType = 'isolated' | 'cross';

/**
 * CoinDCX futures candles accept exactly these four intervals. Anything else
 * returns HTTP 422 `BFF-SO-004` — notably "5m" and "4h" do not exist, and the
 * SDK passes the string straight through without checking.
 */
export const VALID_INTERVALS = {
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
} as const;

export type CandleInterval = keyof typeof VALID_INTERVALS;

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v.trim();
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name}="${v}" is not a finite number`);
  return n;
}

function optionalNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name}="${v}" is not a finite number`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(v.trim())) return true;
  if (/^(0|false|no|off)$/i.test(v.trim())) return false;
  throw new Error(`env ${name} must be a boolean`);
}

export interface Config {
  mode: Mode;
  dryRun: boolean;

  apiKey: string;
  apiSecret: string;

  baseCurrency: string;
  quoteCurrency: string;
  /** Exchange-prefixed futures pair, e.g. B-BTC_USDT. */
  pair: string;
  candleInterval: CandleInterval;
  /** Length of one candle in milliseconds, derived from the interval. */
  candleIntervalMs: number;

  leverage: number;
  marginType: MarginType;
  riskPercent: number;
  stopLossPct: number;
  takeProfitPct: number | undefined;
  stopOverrunTolerance: number;

  maxOrderQuantity: number | undefined;
  maxOrderNotional: number | undefined;
  maxSlippagePct: number;

  paperBalance: number;
  paperTakerFee: number;
  paperSlippage: number;

  /** Local monitoring UI port. 0 disables it. Binds to 127.0.0.1 only. */
  dashboardPort: number;

  /**
   * Websocket endpoint override. Leave unset for the default. Point it at a
   * dead address to verify the bot survives with no socket at all — the REST
   * pollers must carry it.
   */
  wsUrl: string | undefined;

  strategy: StrategyName;
  /**
   * Whether strategies that can take both sides may go short. Off by default:
   * a short has unbounded loss, pays funding, and doubles the ways a
   * misconfigured strategy can hurt you. Strategies that would short go flat
   * instead while this is false.
   */
  allowShorts: boolean;

  emaFast: number;
  emaSlow: number;

  donchianEntryPeriod: number;
  donchianExitPeriod: number;

  supertrendPeriod: number;
  supertrendMultiplier: number;

  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  rsiTrendSmaPeriod: number;
  rsiExitSmaPeriod: number;

  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  macdTrendSmaPeriod: number;

  trendVoteLookbacks: number[];
  trendVoteEntry: 'all' | 'majority';

  warmupCandles: number;
}

export type StrategyName =
  | 'ema-cross'
  | 'donchian-breakout'
  | 'supertrend'
  | 'rsi2-reversion'
  | 'macd-trend'
  | 'trend-vote'
  | 'always-long';

const STRATEGY_NAMES: readonly StrategyName[] = [
  'ema-cross',
  'donchian-breakout',
  'supertrend',
  'rsi2-reversion',
  'macd-trend',
  'trend-vote',
  'always-long',
];

export function loadConfig(): Config {
  const rawMode = str('MODE', 'paper').toLowerCase();
  if (rawMode !== 'paper' && rawMode !== 'live') {
    throw new Error(`MODE must be "paper" or "live", got "${rawMode}"`);
  }
  const mode: Mode = rawMode;

  const rawMarginType = str('MARGIN_TYPE', 'isolated').toLowerCase();
  if (rawMarginType !== 'isolated' && rawMarginType !== 'cross') {
    throw new Error(`MARGIN_TYPE must be "isolated" or "cross", got "${rawMarginType}"`);
  }

  // Paper mode still signs public-endpoint-adjacent calls through the same
  // client, but it never needs real credentials — allow placeholders there so
  // a fresh clone can run `npm run paper` with no account at all.
  const apiKey = mode === 'live' ? required('COINDCX_API_KEY') : str('COINDCX_API_KEY', 'paper');
  const apiSecret = mode === 'live' ? required('COINDCX_API_SECRET') : str('COINDCX_API_SECRET', 'paper');

  const baseCurrency = str('BASE_CURRENCY', 'BTC').toUpperCase();
  const quoteCurrency = str('QUOTE_CURRENCY', 'USDT').toUpperCase();

  const rawInterval = str('CANDLE_INTERVAL', '15m');
  if (!(rawInterval in VALID_INTERVALS)) {
    throw new Error(
      `CANDLE_INTERVAL="${rawInterval}" is not supported by CoinDCX. ` +
        `Valid values: ${Object.keys(VALID_INTERVALS).join(', ')}.`,
    );
  }
  const candleInterval = rawInterval as CandleInterval;

  const maxOrderQuantity = optionalNum('MAX_ORDER_QUANTITY');
  const maxOrderNotional = optionalNum('MAX_ORDER_NOTIONAL');
  if (mode === 'live' && maxOrderQuantity === undefined && maxOrderNotional === undefined) {
    throw new Error(
      'Live mode requires at least one of MAX_ORDER_QUANTITY or MAX_ORDER_NOTIONAL. ' +
        'These are the only thing standing between a strategy bug and your balance.',
    );
  }

  const stopLossPct = num('STOP_LOSS_PCT', 0.015);
  if (stopLossPct <= 0 || stopLossPct >= 1) {
    throw new Error(`STOP_LOSS_PCT must be in (0,1), got ${stopLossPct}`);
  }

  const riskPercent = num('RISK_PERCENT', 0.5);
  if (riskPercent <= 0 || riskPercent > 100) {
    throw new Error(`RISK_PERCENT must be in (0,100], got ${riskPercent}`);
  }

  const emaFast = num('EMA_FAST', 9);
  const emaSlow = num('EMA_SLOW', 21);
  if (emaFast >= emaSlow) {
    throw new Error(`EMA_FAST (${emaFast}) must be less than EMA_SLOW (${emaSlow})`);
  }

  const warmupCandles = num('WARMUP_CANDLES', 250);
  if (warmupCandles <= emaSlow) {
    throw new Error(`WARMUP_CANDLES (${warmupCandles}) must exceed EMA_SLOW (${emaSlow})`);
  }

  const donchianEntryPeriod = num('DONCHIAN_ENTRY_PERIOD', 20);
  const donchianExitPeriod = num('DONCHIAN_EXIT_PERIOD', 10);
  if (donchianExitPeriod > donchianEntryPeriod) {
    throw new Error(
      `DONCHIAN_EXIT_PERIOD (${donchianExitPeriod}) must not exceed DONCHIAN_ENTRY_PERIOD ` +
        `(${donchianEntryPeriod}); the exit channel is meant to be the tighter one`,
    );
  }

  const supertrendPeriod = num('SUPERTREND_PERIOD', 10);
  const supertrendMultiplier = num('SUPERTREND_MULTIPLIER', 3);
  if (supertrendMultiplier <= 0) throw new Error('SUPERTREND_MULTIPLIER must be positive');

  const rsiPeriod = num('RSI_PERIOD', 2);
  const rsiOversold = num('RSI_OVERSOLD', 10);
  const rsiOverbought = num('RSI_OVERBOUGHT', 90);
  const rsiTrendSmaPeriod = num('RSI_TREND_SMA_PERIOD', 200);
  const rsiExitSmaPeriod = num('RSI_EXIT_SMA_PERIOD', 5);
  if (rsiOversold <= 0 || rsiOversold >= 100) throw new Error('RSI_OVERSOLD must be in (0,100)');
  if (rsiOverbought <= 0 || rsiOverbought >= 100) throw new Error('RSI_OVERBOUGHT must be in (0,100)');
  if (rsiOversold >= rsiOverbought) {
    throw new Error(
      `RSI_OVERSOLD (${rsiOversold}) must be below RSI_OVERBOUGHT (${rsiOverbought})`,
    );
  }

  const macdFast = num('MACD_FAST', 12);
  const macdSlow = num('MACD_SLOW', 26);
  const macdSignal = num('MACD_SIGNAL', 9);
  if (macdFast >= macdSlow) {
    throw new Error(`MACD_FAST (${macdFast}) must be less than MACD_SLOW (${macdSlow})`);
  }
  const macdTrendSmaPeriod = num('MACD_TREND_SMA_PERIOD', 0);

  const trendVoteLookbacks = str('TREND_VOTE_LOOKBACKS', '20,60,120')
    .split(',')
    .map(part => Number(part.trim()));
  if (trendVoteLookbacks.some(l => !Number.isInteger(l) || l <= 0)) {
    throw new Error('TREND_VOTE_LOOKBACKS must be a comma-separated list of positive integers');
  }
  if (new Set(trendVoteLookbacks).size !== trendVoteLookbacks.length) {
    throw new Error('TREND_VOTE_LOOKBACKS must not repeat a lookback');
  }
  const trendVoteEntry = str('TREND_VOTE_ENTRY', 'all');
  if (trendVoteEntry !== 'all' && trendVoteEntry !== 'majority') {
    throw new Error(`TREND_VOTE_ENTRY must be "all" or "majority", got "${trendVoteEntry}"`);
  }

  const rawStrategy = str('STRATEGY', 'ema-cross');
  if (!STRATEGY_NAMES.includes(rawStrategy as StrategyName)) {
    throw new Error(
      `STRATEGY="${rawStrategy}" is unknown. Valid values: ${STRATEGY_NAMES.join(', ')}.`,
    );
  }
  const strategy = rawStrategy as StrategyName;
  if (strategy === 'always-long' && mode === 'live' && !bool('DRY_RUN', true)) {
    throw new Error(
      'STRATEGY=always-long is a plumbing test, not a strategy. It will not run live ' +
        'with DRY_RUN=false.',
    );
  }

  const maxSlippagePct = num('MAX_SLIPPAGE_PCT', 0.005);
  const leverage = num('LEVERAGE', 3);
  const takeProfitPct = optionalNum('TAKE_PROFIT_PCT');
  const stopOverrunTolerance = num('STOP_OVERRUN_TOLERANCE', 0.1);
  for (const [name, value] of Object.entries({ MAX_ORDER_QUANTITY: maxOrderQuantity,
    MAX_ORDER_NOTIONAL: maxOrderNotional, TAKE_PROFIT_PCT: takeProfitPct })) {
    if (value !== undefined && value <= 0) throw new Error(`${name} must be positive`);
  }
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error('LEVERAGE must be a positive integer');
  if (takeProfitPct !== undefined && takeProfitPct >= 1) throw new Error('TAKE_PROFIT_PCT must be below 1');
  if (maxSlippagePct < 0 || maxSlippagePct >= 1) throw new Error('MAX_SLIPPAGE_PCT must be in [0,1)');
  if (stopOverrunTolerance < 0 || stopOverrunTolerance > 1) throw new Error('STOP_OVERRUN_TOLERANCE must be in [0,1]');
  const integerPeriods = {
    EMA_FAST: emaFast,
    EMA_SLOW: emaSlow,
    WARMUP_CANDLES: warmupCandles,
    DONCHIAN_ENTRY_PERIOD: donchianEntryPeriod,
    DONCHIAN_EXIT_PERIOD: donchianExitPeriod,
    SUPERTREND_PERIOD: supertrendPeriod,
    RSI_PERIOD: rsiPeriod,
    RSI_TREND_SMA_PERIOD: rsiTrendSmaPeriod,
    RSI_EXIT_SMA_PERIOD: rsiExitSmaPeriod,
    MACD_FAST: macdFast,
    MACD_SLOW: macdSlow,
    MACD_SIGNAL: macdSignal,
  };
  for (const [name, value] of Object.entries(integerPeriods)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer, got ${value}`);
    }
  }
  // 0 means "no filter" for this one, so it is checked separately.
  if (!Number.isInteger(macdTrendSmaPeriod) || macdTrendSmaPeriod < 0) {
    throw new Error('MACD_TREND_SMA_PERIOD must be a non-negative integer');
  }
  if (warmupCandles > 1000) throw new Error('WARMUP_CANDLES must not exceed 1000');

  return {
    mode,
    dryRun: bool('DRY_RUN', true),
    apiKey,
    apiSecret,
    baseCurrency,
    quoteCurrency,
    pair: `B-${baseCurrency}_${quoteCurrency}`,
    candleInterval,
    candleIntervalMs: VALID_INTERVALS[candleInterval],
    leverage,
    marginType: rawMarginType,
    riskPercent,
    stopLossPct,
    takeProfitPct,
    stopOverrunTolerance,
    maxOrderQuantity,
    maxOrderNotional,
    maxSlippagePct,
    paperBalance: num('PAPER_BALANCE', 10_000),
    paperTakerFee: num('PAPER_TAKER_FEE', 0.0005),
    paperSlippage: num('PAPER_SLIPPAGE', 0.0005),
    dashboardPort: num('DASHBOARD_PORT', 8787),
    wsUrl: process.env['WS_URL']?.trim() || undefined,
    strategy,
    allowShorts: bool('ALLOW_SHORTS', false),
    emaFast,
    emaSlow,
    donchianEntryPeriod,
    donchianExitPeriod,
    supertrendPeriod,
    supertrendMultiplier,
    rsiPeriod,
    rsiOversold,
    rsiOverbought,
    rsiTrendSmaPeriod,
    rsiExitSmaPeriod,
    macdFast,
    macdSlow,
    macdSignal,
    macdTrendSmaPeriod,
    trendVoteLookbacks,
    trendVoteEntry,
    warmupCandles,
  };
}
