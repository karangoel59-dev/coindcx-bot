/**
 * Multi-horizon time-series momentum vote.
 *
 * Lineage: time-series momentum — Moskowitz, Ooi & Pedersen, "Time Series
 * Momentum" (JFE, 2012) — which Liu & Tsyvinski ("Risks and Returns of
 * Cryptocurrency", RFS 2021) found also holds in crypto. Using several
 * lookbacks instead of one is the usual way to avoid betting the whole
 * strategy on a single window length.
 *
 * Rules, evaluated on each closed candle:
 *
 *   - Each lookback L votes +1 if the close is above the close L bars ago,
 *     -1 if below, 0 if equal.
 *   - Enter long when the vote total reaches the entry threshold ('all' =
 *     every lookback agrees; 'majority' = more up votes than down).
 *     Shorts mirror this when enabled.
 *   - Hold while the total stays on the position's side of zero, and go flat
 *     the bar it does not. Entering on unanimity but exiting on a lost
 *     majority is deliberate hysteresis: it keeps the strategy from
 *     re-trading every wobble around the threshold.
 *
 * Built for daily candles (CANDLE_INTERVAL=1d): the default lookbacks are
 * 20/60/120 days. On 1h candles the same numbers mean hours, which makes it
 * a much faster and costlier strategy than the one backtested.
 *
 * It is long or flat by default. In the backtest behind this strategy,
 * adding shorts helped in the 2025-26 bear market and hurt in the 2023-25
 * bull market — net worse overall — so ALLOW_SHORTS is a regime bet, not an
 * improvement.
 *
 * It relies on STOP_LOSS_PCT being a catastrophe stop (~20%), not a tight
 * one. A trend that is held for weeks will touch a 1.5% stop on most days,
 * and the engine then re-enters on the next close: the strategy degenerates
 * into paying fees on daily noise. The same is true of TAKE_PROFIT_PCT,
 * which caps exactly the large winners trend following depends on.
 */

import { CandleBuffer } from './buffer.js';
import { log } from '../logger.js';
import type { Candle, Strategy, Target } from '../strategy.js';

export type TrendVoteEntry = 'all' | 'majority';

export interface TrendVoteOptions {
  /** Lookbacks in bars, e.g. [20, 60, 120]. */
  lookbacks: readonly number[];
  entry: TrendVoteEntry;
  allowShorts: boolean;
}

export class TrendVoteStrategy implements Strategy {
  readonly name: string;
  readonly requiredCandles: number;

  private readonly buffer: CandleBuffer;
  private readonly enterAt: number;
  private target: Target = 'flat';

  constructor(private readonly opts: TrendVoteOptions) {
    if (opts.lookbacks.length === 0) throw new Error('trend-vote needs at least one lookback');
    if (opts.lookbacks.some(l => !Number.isInteger(l) || l <= 0)) {
      throw new Error(`trend-vote lookbacks must be positive integers, got ${opts.lookbacks.join(',')}`);
    }
    this.name = `trend-vote(${opts.lookbacks.join('/')},${opts.entry}${opts.allowShorts ? ',short' : ''})`;
    // The close L bars ago needs L + 1 closes; one more so a fresh restart
    // never evaluates on exactly the minimum.
    this.requiredCandles = Math.max(...opts.lookbacks) + 1;
    this.enterAt = opts.entry === 'all' ? opts.lookbacks.length : 1;
    this.buffer = new CandleBuffer(this.requiredCandles + 10);
  }

  warmup(candles: readonly Candle[]): void {
    // Replay bar by bar so the seeded target includes the hysteresis state —
    // a restart mid-trend must hold, not wait for a fresh unanimous vote.
    this.target = 'flat';
    for (const c of candles) {
      this.buffer.push(c);
      if (this.isReady()) this.target = this.evaluate();
    }
    log.info('strategy warmed up', {
      strategy: this.name,
      candles: candles.length,
      seededTarget: this.target,
      vote: this.isReady() ? this.vote() : null,
    });
  }

  isReady(): boolean {
    return this.buffer.length >= this.requiredCandles;
  }

  currentTarget(): Target | null {
    return this.isReady() ? this.target : null;
  }

  onClosedCandle(candle: Candle): Target {
    this.buffer.push(candle);
    if (!this.isReady()) return 'flat';

    const next = this.evaluate();
    if (next !== this.target) {
      log.info('signal change', { strategy: this.name, from: this.target, to: next, vote: this.vote() });
    }
    this.target = next;
    return next;
  }

  /** Sum of the per-lookback votes for the newest close. */
  vote(): number {
    const closes = this.buffer.closes();
    const last = closes[closes.length - 1] as number;
    let score = 0;
    for (const lookback of this.opts.lookbacks) {
      score += Math.sign(last - (closes[closes.length - 1 - lookback] as number));
    }
    return score;
  }

  private evaluate(): Target {
    const score = this.vote();

    if (this.target === 'long' && score > 0) return 'long';
    if (this.target === 'short' && score < 0) return 'short';

    if (score >= this.enterAt) return 'long';
    if (score <= -this.enterAt && this.opts.allowShorts) return 'short';
    return 'flat';
  }
}
