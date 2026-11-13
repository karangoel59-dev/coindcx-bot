import test from 'node:test';
import assert from 'node:assert/strict';
import {
  atrSeries,
  donchianExcludingLast,
  ema,
  macd,
  rsi,
  sma,
  stddev,
  supertrendSeries,
  trueRange,
} from '../src/strategies/indicators.js';
import { DonchianBreakoutStrategy } from '../src/strategies/donchian-breakout.js';
import { Rsi2ReversionStrategy } from '../src/strategies/rsi2-reversion.js';
import { SupertrendStrategy } from '../src/strategies/supertrend.js';
import { MacdTrendStrategy } from '../src/strategies/macd-trend.js';
import { TrendVoteStrategy } from '../src/strategies/trend-vote.js';
import { RunningMacd } from '../src/strategies/indicators.js';
import { log } from '../src/logger.js';
import type { Candle } from '../src/strategy.js';

for (const level of ['info', 'warn', 'error', 'debug'] as const) log[level] = () => {};

const close = (n: number): number => n;
function candle(o: number, h: number, l: number, c: number, i = 0): Candle {
  return { open: o, high: h, low: l, close: c, volume: 1, openTime: i * 60_000, closeTime: i * 60_000 + 59_999 };
}
/** Candles whose high/low straddle the close by a fixed amount. */
function fromCloses(closes: readonly number[], spread = 1): Candle[] {
  return closes.map((c, i) => candle(c, c + spread, c - spread, c, i));
}
const near = (actual: number | null, expected: number, tol = 1e-9): void => {
  assert.ok(actual !== null, 'expected a value, got null');
  assert.ok(Math.abs((actual as number) - expected) < tol, `${actual} !== ${expected}`);
};

// --- primitives --------------------------------------------------------------

test('sma averages only the trailing window and reports null before warmup', () => {
  near(sma([1, 2, 3, 4, 5].map(close), 5), 3);
  near(sma([10, 20, 30, 1, 2, 3].map(close), 3), 2);
  assert.equal(sma([1, 2], 3), null);
  assert.equal(sma([1, 2], 0), null);
});

test('ema seeds from an sma and then applies the 2/(n+1) weight', () => {
  // period 3 over [1,2,3,4]: seed = mean(1,2,3) = 2, then 4*0.5 + 2*0.5 = 3
  near(ema([1, 2, 3, 4].map(close), 3), 3);
  assert.equal(ema([1, 2], 3), null);
  // A flat series must return the same constant, not drift.
  near(ema(new Array(50).fill(7), 10), 7);
});

test('rsi uses Wilder smoothing and pins the degenerate cases', () => {
  // Monotonic rise: no losses at all -> 100.
  near(rsi([1, 2, 3, 4, 5].map(close), 2), 100);
  // Monotonic fall -> 0.
  near(rsi([5, 4, 3, 2, 1].map(close), 2), 0);
  // Perfectly flat -> no gains and no losses; must not be NaN or 100.
  near(rsi(new Array(10).fill(5), 2), 50);
  assert.equal(rsi([1, 2], 5), null);

  // Hand-computed Wilder RSI(2) for [10, 11, 10]:
  //   seed over first 2 changes: gain +1, loss -1 -> avgGain 0.5, avgLoss 0.5
  //   -> rs = 1, rsi = 50
  near(rsi([10, 11, 10].map(close), 2), 50);
});

test('rsi(2) reaches a deeply oversold reading after a sharp drop', () => {
  const value = rsi([100, 101, 102, 103, 90].map(close), 2);
  assert.ok(value !== null && value < 10, `expected < 10, got ${value}`);
});

test('trueRange accounts for gaps against the previous close', () => {
  // No previous close: just the bar range.
  near(trueRange(candle(10, 12, 9, 11), null), 3);
  // Gap up: |high - prevClose| dominates the bar's own range.
  near(trueRange(candle(20, 22, 19, 21), 10), 12);
  // Gap down: |low - prevClose| dominates.
  near(trueRange(candle(5, 7, 4, 6), 20), 16);
});

test('atr seeds from the mean of the first period true ranges then smooths', () => {
  // Every bar has range 2 and no gaps, so ATR must be exactly 2 throughout.
  const flat = fromCloses(new Array(30).fill(100), 1);
  const series = atrSeries(flat, 14);
  near(series[14] as number, 2);
  near(series[29] as number, 2);
  // Values before the seed index are null, never 0.
  assert.equal(series[13], null);
});

test('donchian excludes the current bar so a breakout is not self-referential', () => {
  const candles = [
    candle(10, 12, 8, 11, 0),
    candle(11, 15, 9, 14, 1),
    candle(14, 16, 13, 15, 2),
    // Current bar: its own high of 99 must NOT appear in the channel.
    candle(15, 99, 14, 98, 3),
  ];
  const ch = donchianExcludingLast(candles, 3);
  assert.deepEqual(ch, { upper: 16, lower: 8 });
  // Needs period + 1 bars: period for the window, one for the current bar.
  assert.equal(donchianExcludingLast(candles, 4), null);
});

test('macd seeds the signal line from the macd series, not from index zero', () => {
  // A *constant-slope* ramp is the degenerate case: MACD converges to exactly
  // its signal line, leaving only float residue. Use an accelerating series so
  // the fast EMA genuinely leads.
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i * i * 0.05);
  const value = macd(closes, 12, 26, 9);
  assert.ok(value !== null);
  const v = value as { macd: number; signal: number; histogram: number };
  assert.ok(v.macd > 0, `expected positive macd, got ${v.macd}`);
  assert.ok(v.macd > v.signal, `expected macd above signal, got ${v.macd} vs ${v.signal}`);
  near(v.histogram, v.macd - v.signal, 1e-12);

  // A flat series has identical EMAs, so every component collapses to zero.
  const flat = macd(new Array(80).fill(50), 12, 26, 9);
  near((flat as { macd: number }).macd, 0, 1e-9);

  // Documents the convergence that motivates the strategy's deadband: on a
  // linear ramp the two lines are equal to within float noise.
  const linear = macd(Array.from({ length: 120 }, (_, i) => 100 + i), 12, 26, 9);
  const lv = linear as { macd: number; signal: number };
  assert.ok(Math.abs(lv.macd - lv.signal) < 1e-9, 'linear ramp should converge to a tie');

  assert.equal(macd(closes, 26, 12, 9), null, 'fast >= slow is rejected');
});

test('stddev is zero on a flat window and positive otherwise', () => {
  near(stddev(new Array(10).fill(5), 5), 0);
  near(stddev([2, 4, 4, 4, 5, 5, 7, 9].map(close), 8), 2);
});

test('supertrend carries bands forward and only flips when price closes through', () => {
  // Steady uptrend -> direction must settle 'up' and stay there.
  const up = fromCloses(Array.from({ length: 60 }, (_, i) => 100 + i * 2), 1);
  const upDir = supertrendSeries(up, 10, 3);
  assert.equal(upDir[upDir.length - 1], 'up');

  // Steady downtrend -> 'down'.
  const down = fromCloses(Array.from({ length: 60 }, (_, i) => 200 - i * 2), 1);
  const downDir = supertrendSeries(down, 10, 3);
  assert.equal(downDir[downDir.length - 1], 'down');

  // Uptrend then a hard reversal must actually flip the direction.
  const reversal = fromCloses(
    [...Array.from({ length: 40 }, (_, i) => 100 + i * 2), ...Array.from({ length: 20 }, (_, i) => 178 - i * 10)],
    1,
  );
  const revDir = supertrendSeries(reversal, 10, 3);
  assert.equal(revDir[revDir.length - 1], 'down');

  // Pre-warmup entries are null rather than a guessed direction.
  assert.equal(supertrendSeries(up, 10, 3)[5], null);
});

// --- strategies --------------------------------------------------------------

const warm = (n: number, f: (i: number) => number): Candle[] =>
  fromCloses(Array.from({ length: n }, (_, i) => f(i)), 1);

test('donchian goes long on an upside breakout and flat on the tighter exit channel', () => {
  const s = new DonchianBreakoutStrategy({ entryPeriod: 20, exitPeriod: 10, allowShorts: false });
  // Flat history at 100 -> channel is 99/101 (spread 1), no signal.
  s.warmup(warm(60, () => 100));
  assert.equal(s.currentTarget(), 'flat');

  // Close well above the 20-bar high -> long.
  assert.equal(s.onClosedCandle(candle(100, 130, 99, 130, 60)), 'long');
  // Drifting sideways inside both channels holds the position.
  assert.equal(s.onClosedCandle(candle(130, 131, 129, 130, 61)), 'long');
  // A close below the 10-bar low exits to flat, not to short.
  assert.equal(s.onClosedCandle(candle(130, 131, 50, 50, 62)), 'flat');
});

test('donchian only shorts when shorts are enabled', () => {
  const opts = { entryPeriod: 20, exitPeriod: 10 };
  const longOnly = new DonchianBreakoutStrategy({ ...opts, allowShorts: false });
  const both = new DonchianBreakoutStrategy({ ...opts, allowShorts: true });
  for (const s of [longOnly, both]) s.warmup(warm(60, () => 100));

  const breakdown = candle(100, 101, 50, 50, 60);
  assert.equal(longOnly.onClosedCandle(breakdown), 'flat');
  assert.equal(both.onClosedCandle(breakdown), 'short');
});

test('donchian seeds its target from history so a restart mid-trend does not re-enter', () => {
  // A persistent uptrend: a freshly warmed strategy should already be long.
  const s = new DonchianBreakoutStrategy({ entryPeriod: 20, exitPeriod: 10, allowShorts: false });
  s.warmup(warm(80, i => 100 + i * 3));
  assert.equal(s.currentTarget(), 'long');
});

test('rsi2 requires the trend filter to agree before entering', () => {
  const s = new Rsi2ReversionStrategy({
    rsiPeriod: 2, oversold: 10, overbought: 90,
    trendSmaPeriod: 50, exitSmaPeriod: 5, allowShorts: false,
  });
  // Steep uptrend (slope 5), so a dip can be sharp enough to drive RSI(2)
  // under 10 while price is still comfortably above its 50-SMA. On a shallow
  // trend any such dip also breaks the filter, and the entry correctly never
  // fires — which is the strategy working, not a bug.
  s.warmup(warm(120, i => 100 + i * 5)); // last close 695, SMA(50) ~ 573
  assert.equal(s.currentTarget(), 'flat');

  // One -50 bar: RSI(2) ~ 9, close 645 still above the 50-SMA -> long.
  assert.equal(s.onClosedCandle(candle(695, 696, 640, 645, 120)), 'long');

  // Closing back above the 5-SMA is the published exit.
  assert.equal(s.onClosedCandle(candle(645, 705, 644, 700, 121)), 'flat');
});

test('rsi2 refuses to buy an oversold downtrend (the filter is the strategy)', () => {
  const s = new Rsi2ReversionStrategy({
    rsiPeriod: 2, oversold: 10, overbought: 90,
    trendSmaPeriod: 50, exitSmaPeriod: 5, allowShorts: false,
  });
  // Steady downtrend: price below its 50-SMA the whole way.
  s.warmup(warm(120, i => 300 - i));
  // Another leg down leaves RSI(2) deeply oversold, but the filter blocks it.
  assert.equal(s.onClosedCandle(candle(180, 181, 120, 125, 120)), 'flat');
});

test('supertrend holds long through an uptrend and flips on reversal', () => {
  const s = new SupertrendStrategy({ period: 10, multiplier: 3, allowShorts: true });
  s.warmup(warm(80, i => 100 + i * 2));
  assert.equal(s.currentTarget(), 'long');

  // Drive price hard through the lower band.
  let last: string = 'long';
  for (let i = 0; i < 12; i += 1) {
    last = s.onClosedCandle(candle(250 - i * 20, 251 - i * 20, 249 - i * 20 - 20, 230 - i * 20, 80 + i));
  }
  assert.equal(last, 'short');
});

test('supertrend goes flat instead of short when shorts are disabled', () => {
  const s = new SupertrendStrategy({ period: 10, multiplier: 3, allowShorts: false });
  s.warmup(warm(80, i => 300 - i * 2));
  assert.equal(s.currentTarget(), 'flat');
});

test('macd trend follows the signal cross and respects its optional sma filter', () => {
  // Accelerating uptrend, so the fast EMA genuinely leads rather than
  // converging to a tie.
  const rising = (i: number): number => 100 + i * i * 0.05;
  const plain = new MacdTrendStrategy({
    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, trendSmaPeriod: 0, allowShorts: false,
  });
  plain.warmup(warm(120, rising));
  assert.equal(plain.currentTarget(), 'long');

  // With a 100-SMA filter, the same rising series is still long...
  const filtered = new MacdTrendStrategy({
    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, trendSmaPeriod: 100, allowShorts: false,
  });
  filtered.warmup(warm(150, rising));
  assert.equal(filtered.currentTarget(), 'long');

  // ...but an accelerating downtrend is flat (long-only) rather than long.
  const downtrend = new MacdTrendStrategy({
    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, trendSmaPeriod: 100, allowShorts: false,
  });
  downtrend.warmup(warm(150, i => 2000 - i * i * 0.05));
  assert.equal(downtrend.currentTarget(), 'flat');
});

test('macd holds its target when the lines are tied rather than inventing a signal', () => {
  // A perfectly linear ramp converges to macd === signal. Long-only, so the
  // correct outcome is to hold flat, not to flip on 1e-15 of float residue.
  const s = new MacdTrendStrategy({
    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, trendSmaPeriod: 0, allowShorts: true,
  });
  s.warmup(warm(150, i => 100 + i));
  const target = s.currentTarget();
  assert.notEqual(target, 'short', 'a float-noise tie must not produce a short');
});

test('continuous MACD matches full-history calculations beyond the candle buffer capacity', () => {
  const history = warm(600, i => 150 + Math.sin(i / 11) * 20 + Math.cos(i / 37) * 10);
  const indicator = new RunningMacd(12, 26, 9);
  const strategy = new MacdTrendStrategy({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    trendSmaPeriod: 0, allowShorts: true });
  strategy.warmup(history.slice(0, 250));
  for (let i = 0; i < history.length; i++) {
    indicator.update(history[i]!.close);
    const expected = macd(history.slice(0, i + 1).map(c => c.close), 12, 26, 9);
    const actual = indicator.current();
    if (!expected) { assert.equal(actual, null); continue; }
    near(actual!.macd, expected.macd, 1e-10);
    near(actual!.signal, expected.signal, 1e-10);
    if (i >= 250) {
      assert.equal(strategy.onClosedCandle(history[i]!), expected.histogram > 0 ? 'long' : 'short');
    }
  }
});

test('replacing the newest MACD candle does not double-update continuous indicators', () => {
  const options = { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    trendSmaPeriod: 0, allowShorts: true };
  const history = warm(250, i => 150 + Math.sin(i / 11) * 20);
  const strategy = new MacdTrendStrategy(options), reference = new MacdTrendStrategy(options);
  strategy.warmup(history); reference.warmup(history);
  const next = { ...history.at(-1)!, openTime: history.at(-1)!.openTime + 60_000, close: 1000 };
  strategy.onClosedCandle(next);
  const corrected = { ...next, close: 90 };
  assert.equal(strategy.onClosedCandle(corrected), reference.onClosedCandle(corrected));
  const following = { ...corrected, openTime: corrected.openTime + 60_000, close: 150 };
  assert.equal(strategy.onClosedCandle(following), reference.onClosedCandle(following));
});

test('every strategy reports requiredCandles and refuses to signal before warmup', () => {
  const strategies = [
    new DonchianBreakoutStrategy({ entryPeriod: 20, exitPeriod: 10, allowShorts: false }),
    new SupertrendStrategy({ period: 10, multiplier: 3, allowShorts: false }),
    new Rsi2ReversionStrategy({
      rsiPeriod: 2, oversold: 10, overbought: 90,
      trendSmaPeriod: 200, exitSmaPeriod: 5, allowShorts: false,
    }),
    new MacdTrendStrategy({
      fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, trendSmaPeriod: 0, allowShorts: false,
    }),
    new TrendVoteStrategy({ lookbacks: [20, 60, 120], entry: 'all', allowShorts: false }),
  ];
  for (const s of strategies) {
    assert.ok(s.requiredCandles > 0, `${s.name} must declare requiredCandles`);
    assert.equal(s.isReady(), false, `${s.name} must not be ready before warmup`);
    assert.equal(s.currentTarget(), null, `${s.name} must report no target before warmup`);
    // One candle is never enough for any of these.
    assert.equal(s.onClosedCandle(candle(100, 101, 99, 100, 0)), 'flat');
  }
  // The 200-SMA variant must demand real history.
  const rsiStrategy = strategies[2] as Rsi2ReversionStrategy;
  assert.ok(rsiStrategy.requiredCandles > 200, 'rsi2 with a 200 SMA needs >200 candles');
});

// --- trend-vote ----------------------------------------------------------------

const votes = (entry: 'all' | 'majority', allowShorts = false) =>
  new TrendVoteStrategy({ lookbacks: [1, 2, 3], entry, allowShorts });
/** Feeds closes one by one and returns the target after each. */
function feed(s: TrendVoteStrategy, closes: readonly number[]): string[] {
  return fromCloses(closes).map(c => s.onClosedCandle(c));
}

test('trend-vote needs max(lookback) + 1 candles and rejects bad lookbacks', () => {
  assert.equal(new TrendVoteStrategy({ lookbacks: [20, 60, 120], entry: 'all', allowShorts: false }).requiredCandles, 121);
  assert.throws(() => new TrendVoteStrategy({ lookbacks: [], entry: 'all', allowShorts: false }));
  assert.throws(() => new TrendVoteStrategy({ lookbacks: [0, 5], entry: 'all', allowShorts: false }));
  assert.throws(() => new TrendVoteStrategy({ lookbacks: [2.5], entry: 'all', allowShorts: false }));
});

test('trend-vote "all" waits for every lookback to agree; "majority" does not', () => {
  // Last close 11.5 is below the 1-bar-ago close but above the 2- and 3-bar ones: vote +1.
  const closes = [10, 11, 12, 11.5];
  assert.equal(feed(votes('all'), closes).at(-1), 'flat');
  assert.equal(feed(votes('majority'), closes).at(-1), 'long');
  // Every lookback up: vote +3.
  assert.equal(feed(votes('all'), [10, 11, 12, 13]).at(-1), 'long');
});

test('trend-vote holds while the majority agrees and exits when it is lost', () => {
  const s = votes('all');
  // 13: vote +3 -> long. 12.5: vote +1 -> hold (hysteresis). 11.5: vote -3 -> flat.
  assert.deepEqual(feed(s, [10, 11, 12, 13, 12.5, 11.5]), ['flat', 'flat', 'flat', 'long', 'long', 'flat']);
});

test('trend-vote only shorts when shorts are enabled', () => {
  const falling = [13, 12, 11, 10];
  assert.equal(feed(votes('all'), falling).at(-1), 'flat');
  assert.equal(feed(votes('all', true), falling).at(-1), 'short');
  // A short is held on a partial bounce (vote -1) and closed when the majority flips.
  assert.deepEqual(feed(votes('all', true), [13, 12, 11, 10, 10.5, 10.8]).slice(3), ['short', 'short', 'flat']);
  // A bounce above every lookback reverses straight to long (the engine flattens first).
  assert.equal(feed(votes('all', true), [13, 12, 11, 10, 10.5, 12.5]).at(-1), 'long');
});

test('trend-vote seeds its hysteresis from history so a restart mid-trend keeps the position', () => {
  const s = votes('all');
  s.warmup(fromCloses([10, 11, 12, 13, 12.5]));
  assert.equal(s.currentTarget(), 'long');
  // The same final bars without the entry in view would not enter on their own.
  const fresh = votes('all');
  fresh.warmup(fromCloses([11, 12, 13, 12.5]));
  assert.equal(fresh.currentTarget(), 'flat');
});
