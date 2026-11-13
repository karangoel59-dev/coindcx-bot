import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { discardStaleSdkSocket, WsSupervisor } from '../src/ws-supervisor.js';
import { log } from '../src/logger.js';

for (const level of ['info', 'warn', 'error', 'debug'] as const) log[level] = () => {};

/**
 * Stand-in for the SDK WsClient. Each connect() consumes the next scripted
 * outcome: 'ok' connects (and emits 'open'), 'fail' rejects (and emits
 * 'error', as connect_error does), 'hang' never settles.
 */
class FakeSocket extends EventEmitter {
  connected = false;
  autoReconnect = true;
  attempts = 0;
  constructor(private readonly script: ('ok' | 'fail' | 'hang')[]) { super(); }
  setAutoReconnect(enabled: boolean): void { this.autoReconnect = enabled; }
  isConnected(): boolean { return this.connected; }
  connect(): Promise<void> {
    this.attempts += 1;
    const outcome = this.script.shift() ?? 'fail';
    if (outcome === 'hang') return new Promise(() => {});
    if (outcome === 'fail') {
      this.emit('error', new Error('websocket error'));
      return Promise.reject(new Error('websocket error'));
    }
    this.connected = true;
    this.emit('open');
    return Promise.resolve();
  }
  drop(reason: string): void {
    this.connected = false;
    this.emit('close', reason);
  }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
/** Advance mocked time in steps, letting promise callbacks run in between. */
async function advance(ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await flush(); }
}
const opts = { baseDelayMs: 1_000, maxDelayMs: 8_000, connectTimeoutMs: 5_000, checkEveryMs: 60_000, random: () => 1 };

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }));
afterEach(() => mock.timers.reset());

test('a failed reconnect schedules another instead of ending reconnection (2026-11-08 stall)', async () => {
  // Connected, then dropped by the server; the first retry fails — the exact
  // sequence after which the SDK's own loop never tried again.
  const ws = new FakeSocket(['fail', 'fail', 'ok']);
  ws.connected = true;
  const sup = new WsSupervisor(ws, opts);
  sup.start();
  assert.equal(ws.autoReconnect, false, 'the SDK loop must be disabled so only one scheduler runs');

  ws.drop('transport close');
  await advance(1_000);            // attempt 1 fails
  assert.equal(ws.attempts, 1);
  assert.equal(ws.isConnected(), false);
  await advance(2_000);            // attempt 2 fails, backoff doubled
  assert.equal(ws.attempts, 2);
  await advance(4_000);            // attempt 3 succeeds
  assert.equal(ws.attempts, 3);
  assert.equal(ws.isConnected(), true);
  assert.equal(sup.consecutiveFailures, 0);
  sup.stop();
});

test('a socket that never connected at startup is retried', async () => {
  const ws = new FakeSocket(['ok']);
  const sup = new WsSupervisor(ws, opts);
  sup.start();
  await advance(1_000);
  assert.equal(ws.isConnected(), true);
  sup.stop();
});

test('a connect that never settles times out and is retried', async () => {
  const ws = new FakeSocket(['hang', 'ok']);
  const sup = new WsSupervisor(ws, opts);
  sup.start();
  await advance(1_000);            // attempt 1 starts and hangs
  assert.equal(ws.attempts, 1);
  await advance(5_000);            // times out
  await advance(2_000);            // attempt 2 after backoff
  assert.equal(ws.attempts, 2);
  assert.equal(ws.isConnected(), true);
  sup.stop();
});

test('backoff is capped and reset by a successful open', async () => {
  const ws = new FakeSocket(['fail', 'fail', 'fail', 'fail', 'fail', 'ok']);
  const sup = new WsSupervisor(ws, opts);
  sup.start();
  // 1s, 2s, 4s, 8s, 8s (capped) then success on the sixth attempt at +31s.
  await advance(23_000);
  assert.equal(ws.attempts, 5);
  await advance(8_000);
  assert.equal(ws.attempts, 6);
  assert.equal(ws.isConnected(), true);
  assert.equal(sup.consecutiveFailures, 0);
  sup.stop();
});

test('our own shutdown disconnect is not reconnected, and stop() halts retries', async () => {
  const ws = new FakeSocket([]);
  ws.connected = true;
  const sup = new WsSupervisor(ws, opts);
  sup.start();
  ws.drop('io client disconnect');
  await advance(5_000);
  assert.equal(ws.attempts, 0);

  const ws2 = new FakeSocket([]);
  const sup2 = new WsSupervisor(ws2, opts);
  sup2.start();
  sup2.stop();
  await advance(120_000);
  assert.equal(ws2.attempts, 0);
  sup.stop();
});

test('the periodic check recovers a dead socket even if no event announced it', async () => {
  const ws = new FakeSocket(['ok']);
  ws.connected = true;
  const sup = new WsSupervisor(ws, opts);
  sup.start();
  ws.connected = false;            // died silently: no 'close' emitted
  await advance(61_000);
  assert.equal(ws.isConnected(), true);
  sup.stop();
});

test('the stale socket is discarded before each attempt', async () => {
  const ws = new FakeSocket(['fail', 'ok']);
  let discarded = 0;
  const sup = new WsSupervisor(ws, { ...opts, discardStale: () => { discarded += 1; } });
  sup.start();
  await advance(3_000);
  assert.equal(ws.attempts, 2);
  assert.equal(discarded, 2);
  sup.stop();
});

test('discardStaleSdkSocket closes a dead socket but never a live one', () => {
  const calls: string[] = [];
  const dead = { connected: false, off: () => calls.push('off'), close: () => calls.push('close') };
  const client: { socket: unknown } = { socket: dead };
  discardStaleSdkSocket(client);
  assert.deepEqual(calls, ['off', 'close']);
  assert.equal(client.socket, null);

  const live = { connected: true, off: () => calls.push('live-off'), close: () => calls.push('live-close') };
  const client2 = { socket: live };
  discardStaleSdkSocket(client2);
  assert.equal(client2.socket, live);
  assert.ok(!calls.includes('live-close'));

  assert.doesNotThrow(() => discardStaleSdkSocket({}));
  assert.doesNotThrow(() => discardStaleSdkSocket({ socket: null }));
});
