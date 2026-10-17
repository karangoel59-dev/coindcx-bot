# coindcx-bot

CoinDCX USDT-M futures automation on [`@nemesis-oss/coindcx-sdk`](https://github.com/shubhamtaywade82/coindcx-sdk).

A **target-position engine**: the strategy declares the position it wants to hold, and the engine
diffs that against what the venue actually reports and submits one entry or exit intent at a time, confirming exposure and protection before proceeding.
Replaying a signal twice, or restarting into an open position, converges instead of stacking a
second entry.

The shipped strategy is an EMA crossover. It is a placeholder. Replace it.

---

## Quick start

```bash
npm install
cp .env.example .env

npm run preflight   # read-only: is the pair valid, is sizing sane, would the order be accepted
npm test            # mocked venue and engine regression suite
npm run smoke       # paper round trip: open -> verify protection -> flatten -> confirm flat
npm run paper       # run the engine against live prices, simulated fills
```

`preflight` and `paper` work with no credentials at all. Only `npm run live` needs real keys.

### Monitoring UI

While the bot runs it serves a dashboard at **http://127.0.0.1:8787** — target vs. actual position,
market midpoint with a staleness flag, the sizing balance, a countdown to the next candle close,
the effective mode and risk limits, and a tail of the structured log. A chart shows up to 60
completed candles with pointer and keyboard inspection. The position panel shows stop, entry,
midpoint and take-profit levels; layouts adapt to desktop and mobile. It polls every 2 seconds and is read-only: there are no controls,
so a browser tab cannot start, stop or alter a trade.

It binds to **loopback only**. It exposes positions and balances, so don't put it on a public
interface — tunnel over SSH (`ssh -L 8787:127.0.0.1:8787 host`) if you need it remotely.
`DASHBOARD_PORT=0` disables it.

Its independent position and wallet refreshes are throttled to once every four seconds.
Opening the dashboard adds these read requests to the engine’s own polling.
Log reads are asynchronous, cached for four seconds and limited to the last 128 KiB / 60
complete records. Log files rotate at UTC midnight. Account refresh failures are visible;
live `available_balance` is labeled **Available balance**, the `balance` fallback **Wallet
balance**, and simulated futures equity **Paper equity**. The API retains `equity` for
compatibility and adds `equityBasis`; the sizing formula is unchanged.

### Effective mode under systemd

Node's `--env-file-if-exists=.env` preserves variables already in the process environment.
`npm run live` explicitly sets `MODE=live`; `npm run paper` sets `MODE=paper`. A systemd
`Environment=MODE=live` also overrides `MODE=paper` in `.env`. Read the dashboard's effective
mode or the `client ready` startup log before operating the bot. A service description is
only a label: use `Description=CoinDCX futures trading bot` to avoid a stale paper/live label.
Keep the deployment's mode in one place, and review `systemctl cat coindcx-bot.service` for
overrides before a restart. Never infer that orders are simulated from `.env` alone.

### Going live

1. Create a key at [coindcx.com/api-dashboard](https://coindcx.com/api-dashboard) with **trading
   permission only — never withdrawals** — and whitelist this host's IP.
2. Set `MAX_ORDER_QUANTITY` and/or `MAX_ORDER_NOTIONAL`. Live mode refuses to start without at
   least one. These are your blast radius.
3. `npm run preflight` with the real keys. It places nothing.
4. `MODE=live DRY_RUN=true npm run live` for a session. Every order is logged, none is sent.
5. Only then `npm run live` with `DRY_RUN=false`.

---

## What this adds on top of the SDK

The SDK provides rate limiting, public-market retries and a paper engine. Several futures
request types and runtime event names differ from the venue contract. The broker uses
`src/venue.ts` to serialize and sign documented requests through the SDK transport (pinned to
1.2.0 because the bridge depends on its runtime); paper mode
consumes those same request shapes. Regression coverage lives in `tests/regression.test.ts`.

| Issue | Effect | Where it's handled |
|---|---|---|
| **Paper mode never fills.** The SDK installs its paper handler as an *axios adapter*, then reads `config.data.side`, `.order_type`, `.base_currency`. By adapter time axios has serialized the body to a JSON **string**, so every field is `undefined`. Orders are created with no side or type, never fill (a market order only fills when `order_type === 'market_order'`), and record the pair as `B-undefined_undefined`. | Paper mode looks fine — orders return ids — but no position is ever opened. | `src/paper-adapter.ts` replaces the handler: parses the body first, then routes to the same `PaperTradingEngine`. |
| **Position exit is a no-op in paper.** The SDK's handler answers `/positions/exit` and `/positions/close` with `[]` without touching the engine. | The position survives a "successful" close. | Same adapter implements a real exit, sized exactly to the position (an oversized opposite fill *flips* a paper position rather than closing it). |
| **Candles are typed `{open_time, close_time}`; the API returns `{time}`.** The SDK passes the body through unmapped. | Reading `open_time` gives `undefined`, every candle parses to `NaN` and is dropped — presenting as "0 candles returned" for a pair that plainly has data. | `toCandle()` in `src/engine.ts` reads `time` first, derives `closeTime` from the interval. |
| **Instrument metadata reads the wrong field names.** The SDK looks for `max_leverage`, `tick_size`, `lot_size`; CoinDCX returns `max_leverage_long`/`max_leverage_short`, `price_increment`, `quantity_increment`. | `max_leverage: 0` for every pair, and `ops.sizing.quantizeQuantity()` silently falls back to a hardcoded `0.001` lot — right for BTC, wrong elsewhere. It also drops `min_notional` entirely. | `src/instrument.ts` reads the raw payload. Also surfaces `min_notional` (**60 USDT for BTC**), which rejects small orders with no usable error. |
| **`getPositions()` returns camelCase in paper, snake_case in live**, both typed as snake_case `PositionResponse`. | `entry_price` is `undefined` on the paper path. | The adapter emits snake_case; `normalizePosition()` in `src/broker.ts` reads both spellings regardless. |
| **Runtime stream events are `candle`, `orderUpdate`, `depthSnapshot`, etc.; declarations incorrectly name them with an `on` prefix.** | Registering the declared names silently misses updates. | `src/engine.ts` and `src/marks.ts` register runtime names on `client.ws`. Candle events request REST-finalized data; depth deltas merge into the existing book. |
| **Futures create/exit/TP-SL and signing differ from the SDK types.** | Flat create payloads, pair-only exits and numeric TP/SL are incompatible with the documented API. | `src/venue.ts`, `src/broker.ts`: nested `order`, millisecond timestamp, GET body, position IDs, inline price triggers plus structured TP/SL fallback. |
| **SDK market-order notional checks skip requests with no price.** | A configured notional cap does not independently guard a market order. | Broker checks executable bid/ask plus `MAX_SLIPPAGE_PCT` immediately before submission. |
| **`paper.getAccount().totalEquity` is spot + futures.** Seeding both from one balance double-counts. | Sizing off a 2× equity figure. | `Broker.getEquity()` uses `futuresBalance + unrealizedPnl`. |
| **Valid candle intervals are only `1m, 15m, 1h, 1d`.** `5m` and `4h` return HTTP 422 `BFF-SO-004`; the SDK forwards the string unchecked. | Silent empty result. | `VALID_INTERVALS` in `src/config.ts` rejects at boot. |

Also worth knowing, from the venue rather than the SDK: **CoinDCX options endpoints reject API
key + HMAC entirely.** `/api/v1/options/*` requires a web-session Bearer token whose JWT is pinned
to a source IP and expires in ~36 hours. Spot, margin and futures are fine with HMAC. This bot is
futures-only for that reason.

---

## Layout

```
src/
  config.ts         env parsing, validated at boot — bad config fails before the first order
  client.ts         SDK client construction + safety limits + paper adapter install
  paper-adapter.ts  working replacement for the SDK's paper handler
  instrument.ts     venue constraints read from the raw API: steps, min notional, max leverage
  marks.ts          best bid/ask; WS depth with a REST fallback poller; feeds the paper engine
  broker.ts         the ONLY module that decides entries, exits and protection
  venue.ts          documented wire payloads and exact-body signing through SDK transport
  state.ts          passive snapshot for the UI; nothing in the trading path reads it
  dashboard.ts      localhost-only HTTP server: GET / and GET /api/status
  dashboard-page.ts the page, inlined — no assets, no build step
  reconcile.ts      startup: ask the venue what we hold, adopt it
  engine.ts         finalized REST candles -> queued target -> confirmed intent; stop backstop
  strategy.ts       the Strategy interface
  strategies/
    ema-cross.ts    the example strategy
    always-long.ts  plumbing test, not a strategy
  scripts/
    preflight.ts    read-only pre-session checks
    smoke.ts        paper round trip with assertions
  index.ts          wiring, graceful shutdown
```

### Included strategies

Pick with `STRATEGY=`. Each is a different *family* — they fail in different
market regimes, which is the point of having more than one.

| `STRATEGY` | Family | Lineage | Character |
|---|---|---|---|
| `ema-cross` | Trend | — | Fast/slow EMA cross. Long or flat. |
| `donchian-breakout` | Breakout | Turtle Traders (Dennis, 1983); 20/10 channels | Low win rate, long flat spells, rare large winners. Deepest drawdowns. |
| `supertrend` | Trend | Seban's ATR bands; in freqtrade's official set | Always in the market when shorts are on → most fees. Tightening the multiplier sharply increases whipsaw. |
| `rsi2-reversion` | Mean reversion | Connors, *Short Term Trading Strategies That Work* | In the market only ~5% of the time. High win rate, small winners, hurt by trends. |
| `macd-trend` | Trend | Appel (1979); freqtrade `UniversalMACD` | Smoother than a raw EMA cross but still chops; optional SMA filter. |
| `always-long` | — | — | Plumbing test. Refuses to run live. |

Measured over 600 live BTC 1h candles, which confirms each behaves as its
family predicts rather than claiming any of them makes money:

```
                              flips   long   short   flat     (ALLOW_SHORTS=true)
ema-cross(9/21)                  16    51%      0%    49%
donchian-breakout(20/10)         14    48%     30%    22%
supertrend(10,3)                  8    57%     43%     0%   <- never flat
rsi2-reversion(10/90,sma200)     28     4%     11%    86%   <- highly selective
macd(12/26/9)                    28    53%     47%     0%   <- chops most
```

**`ALLOW_SHORTS` is off by default.** Strategies that would short go flat
instead. A short pays funding and adds a second set of ways to be wrong.

**None of these is backtested here.** They are faithfully implemented against
their published rules and unit-tested against hand-computed indicator values —
which is a statement about correctness, not profitability. Published crypto
results for these families disagree wildly between sources (one vendor reports
both 24% and 65% max drawdown for RSI(2) in different articles), so treat every
number you read, including the table above, as unverified until you backtest it
yourself with fees, funding and slippage.

Indicators live in `src/strategies/indicators.ts` as pure functions —
Wilder-smoothed RSI and ATR, EMA seeded from an SMA, Donchian that excludes the
current bar so a breakout is not self-referential, and a Supertrend with the
band carry-forward that popular implementations often omit. Every one is
unit-tested, because a subtly wrong indicator loses money in a way that looks
like bad luck.

### Writing a strategy

Implement `Strategy` (four members) and add it to `buildStrategy()` in `src/index.ts`:

```ts
export class MyStrategy implements Strategy {
  readonly name = 'my-strategy';

  // Closed candles needed before this can signal. The engine refuses to start
  // with less history — a half-warm 200-SMA is a different, worse strategy.
  readonly requiredCandles = 200;

  warmup(candles: readonly Candle[]): void {
    // Seed indicators. Oldest candle first. Never place orders here.
    // Seed your target too, so a restart mid-trend isn't read as a fresh entry.
  }

  isReady(): boolean {
    return true; // false until warmup has given you enough history
  }

  onClosedCandle(candle: Candle): Target {
    return 'long'; // 'long' | 'short' | 'flat' — the position you want to hold
  }
}
```

`onClosedCandle` only ever sees **closed** candles, so a signal cannot flicker inside a bar.
Return a target, not an order — the engine owns sizing, stops and order placement.

---

## Safety model

- **Dry-run and order budgets.** `DRY_RUN=true` logs all intended mutations without sending
  them. Quantity caps and notional budgets are checked by the broker immediately before entry.
  Notional uses the executable quote plus `MAX_SLIPPAGE_PCT` (default 0.5%). Market fills can
  exceed this estimate during a price jump; this setting is not an exchange-enforced price limit.
- **Pre-trade validation** checks finite values, quantity increments, minimum notional, leverage,
  exit-only status and protective trigger direction. Stop and TP prices use the venue price step.
- **Writes are submitted once.** Every entry carries a client order ID for tracing; futures
  deduplication is not assumed. An uncertain acknowledgement blocks further entries for the
  lifetime of the process and across live restarts. Before submission, the broker atomically
  writes and syncs a private journal under `.bot-state/`, scoped to the API key and instrument
  using a hash. It clears the journal only after verified protection and cancellation of entry
  remainders, or a definitive create rejection. An unreadable/corrupt journal prevents startup;
  an unwritable journal prevents entry. Dry-run never clears an existing live block.
  Blocked entry signals are consumed without sizing or submission; one warning records the
  block instead of repeating the same failure on every poll. Exits remain available.
- **Delayed entry confirmation.** The broker polls positions every 500 ms for up to 60 seconds,
  retrying failed reads. Order-specific trade history distinguishes an observed fill from an
  unconfirmed submission. A fill alone never clears the journal: position protection must
  still be verified. A timeout keeps the entry blocked and attempts cancellation/exit.
- **Verified venue protection.** Entry requests include `stop_loss_price` and optional
  `take_profit_price`. The broker confirms the position’s triggers, attaches structured market
  TP/SL by position ID when needed, and exits if it cannot verify protection. Startup also
  verifies/adopts protection before running. The monitor protects late-visible positions and
  exits when price overshoots an existing stop by `STOP_OVERRUN_TOLERANCE`.
- **Finalized candles and gap recovery.** WS candle events wake REST polling; only bars whose
  interval ended at least two seconds ago reach the strategy. Missing bars update indicators
  in order, and only the newest target trades. Gaps or stale/malformed responses block entries;
  gaps beyond 1000 bars require a restart to warm up again. Pending signals survive busy actions
  and temporary read failures.
- **Continuous MACD.** Fast, slow and signal EMAs use SMA seeds and update through every
  warmup/live candle. Dropping display/filter history cannot reseed them. Replacing the latest
  candle rolls back its previous EMA update. Restarting still seeds from the configured warmup
  window, so it need not match an indefinitely running chart exactly.
- **Positions are read from the venue, never from memory.** Local state drifts.
- **Startup reconciliation** adopts any existing position rather than opening a second one.
- **Single-instance PID lock.** Two copies on one account cancel each other's orders.
- **Exit is confirmed, not assumed.** Exit requests use position IDs; the broker polls for up to
  60 seconds, 500 ms apart, and raises an error if the position remains open. Concurrent exits
  share one confirmation. An accepted or uncertain exit, including the venue's "already in
  progress" response, remains pending until flat; subsequent calls confirm it without another
  submission. Entries and TP/SL changes wait while that exit is pending. If an uncertain exit
  never completes, inspect the venue rather than blindly retrying it. This pending exit state
  is in memory; startup reconciliation applies after a restart. Malformed exposure
  responses also raise errors instead of being interpreted as flat. Positions and working
  orders are paginated, and entries are blocked while working orders exist for the pair.
- **Secrets are scrubbed** from logs by key name.
- **The process cannot exit silently.** Timers are deliberately *not* `unref()`'d — they hold the
  event loop, so losing the websocket can no longer empty it and end the process with code 0 and
  no error. A `process.on('exit')` breadcrumb logs loudly if it ever ends without a signal anyway.
- **A watchdog reports liveness every 60s**, and warns when the quote feed goes stale, candles go
  overdue, or the socket is down — because a bot with a dead feed otherwise looks exactly like a
  bot with no signal. Websocket reconnection is raised from the SDK's default of 10 attempts
  (after which it gives up permanently) to effectively unlimited.

Set `WS_URL` to a dead address (e.g. `WS_URL=http://127.0.0.1:9`) to verify the bot keeps running
on REST polling alone with no socket.

### What it deliberately does not do

- **No backtester.** The EMA example is unvalidated. Pull history with
  `futures.market.getCandles()` and test a strategy before risking anything.
- **Shutdown leaves positions open.** Normal entries have verified venue protection; abrupt
  shutdown during entry or an unresolved submission still requires checking the venue manually.
- **Single pair per process.** The WS depth payload carries no pair field, so `PriceFeed` is
  deliberately single-pair. Run one process per instrument.
- **Paper margin accounting drifts.** The engine's `usedMargin` is not fully released on close.
  Sizing uses `futuresBalance + unrealizedPnl` to avoid compounding it, but don't read paper
  margin or long-run paper PnL as accurate.
- **Limited persistence.** Paper positions, monitoring counters and indicator state are in
  memory. Live exposure lives on the venue; uncertain live submissions persist in `.bot-state/`.
  Keep that directory when deploying or moving the bot. Changing API keys changes the journal
  scope and requires checking for outstanding submissions associated with the previous key.

### Recovering a blocked live entry

Keep the process stopped while investigating. Read the reason and client order ID from the
matching `.bot-state/entry-*.json` file, then review the exchange's order history, working
orders, fills and actual position. A single flat response after a timeout is insufficient
evidence that the order was never accepted.

For an entry that fully filled and has since closed, run the recovery command from the deployed
bot directory with the service stopped and the same live configuration. It acquires the bot's
PID lock and defaults to inspection:

```bash
MODE=live npm run recover-entry -- --client-order-id b6dae5374dbe342ff969aaeab00a7c9c9
# After inspection, repeat with --confirm to clear the matching journal:
MODE=live npm run recover-entry -- --client-order-id b6dae5374dbe342ff969aaeab00a7c9c9 --confirm
```

Replace the example ID with the ID in your journal. Recovery requires a matching terminal filled
order at least 60 seconds old, complete matching order-specific fills, and two flat/no-working-order
checks two seconds apart. It sends no trading mutations. `--confirm` clears only that account and
instrument's journal; `DRY_RUN=true` prevents clearing. Restart after successful recovery; the next
finalized candle evaluates the strategy normally.

Rejected, partially filled or unresolved submissions require separate operator reconciliation;
this command refuses them. Startup reconciliation does not clear an uncertain-entry journal
automatically. Do not delete all journals or replace the API key to bypass a block.

---

## Tax note (India)

Spot carries 1% TDS and 30% flat tax on gains, which makes frequent spot trading structurally
unattractive. INR-settled futures avoid the TDS and are taxed as speculative business income at
slab rates. This bot trades USDT-M futures; confirm your own treatment before scaling up.
