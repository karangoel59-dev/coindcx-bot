/**
 * Owns websocket reconnection, replacing the SDK's own loop.
 *
 * Why: @nemesis-oss/coindcx-sdk 1.2.0 disables socket.io's reconnection and
 * schedules its own retry only from the `disconnect` event. A retry that then
 * fails raises `connect_error` instead — the socket never connected, so it
 * never disconnects — and the SDK swallows the rejected promise. One failed
 * attempt therefore ends reconnection for good. In production that left the
 * bot on REST polling for 4.5 days (2026-11-08 → 11-13) until a restart.
 * The same gap meant a socket that failed at startup was never retried.
 *
 * This supervisor schedules the next attempt after *any* failure — a
 * rejected connect, a connect that never settles, or an unexpected close —
 * with capped exponential backoff, plus a periodic check so a missed event
 * cannot strand the socket either. A deliberate disconnect ('io client
 * disconnect', i.e. our own shutdown) and `stop()` end it.
 */

import { log } from './logger.js';

/** The slice of the SDK's WsClient the supervisor drives. */
export interface ReconnectableSocket {
  connect(): Promise<void>;
  isConnected(): boolean;
  setAutoReconnect(enabled: boolean): void;
  on(event: 'open' | 'close' | 'error', listener: (...args: any[]) => void): unknown;
}

export interface WsSupervisorOptions {
  /** First retry delay; doubles per consecutive failure. */
  baseDelayMs?: number;
  /** Ceiling for the retry delay. */
  maxDelayMs?: number;
  /** Treat a connect that has neither resolved nor rejected by now as failed. */
  connectTimeoutMs?: number;
  /** Safety net: how often to check for a dead socket with no retry pending. */
  checkEveryMs?: number;
  /** Called before each attempt to drop the previous, dead socket. */
  discardStale?: () => void;
  /** Injectable for tests; returns [0, 1). */
  random?: () => number;
}

/** Reason socket.io reports when *we* closed the socket. */
const MANUAL_DISCONNECT = 'io client disconnect';

export class WsSupervisor {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly connectTimeoutMs: number;
  private readonly checkEveryMs: number;
  private readonly random: () => number;

  private retryTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private failures = 0;
  private started = false;
  private stopped = false;

  constructor(private readonly ws: ReconnectableSocket, private readonly opts: WsSupervisorOptions = {}) {
    this.baseDelayMs = opts.baseDelayMs ?? 2_000;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
    this.checkEveryMs = opts.checkEveryMs ?? 60_000;
    this.random = opts.random ?? Math.random;
  }

  /** Takes over reconnection. Safe to call whether or not the socket is up. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Two schedulers would race to open parallel sockets; this one is the
    // one that survives a failed attempt.
    this.ws.setAutoReconnect(false);

    this.ws.on('open', () => {
      this.failures = 0;
      this.clearRetry();
    });
    this.ws.on('close', (reason: unknown) => {
      if (reason !== MANUAL_DISCONNECT) this.schedule();
    });
    this.ws.on('error', () => {
      if (!this.ws.isConnected()) this.schedule();
    });

    this.checkTimer = setInterval(() => {
      if (!this.ws.isConnected()) this.schedule();
    }, this.checkEveryMs);

    if (!this.ws.isConnected()) this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
  }

  /** For tests and the dashboard: consecutive failed attempts since the last open. */
  get consecutiveFailures(): number {
    return this.failures;
  }

  private schedule(): void {
    if (this.stopped || this.retryTimer !== null || this.inFlight) return;
    const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(this.failures, 30));
    // Jitter in [50%, 100%] of the backoff so restarts across hosts do not sync up.
    const delay = Math.round(backoff * (0.5 + this.random() * 0.5));
    log.info('websocket reconnect scheduled', { attempt: this.failures + 1, delayMs: delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attempt();
    }, delay);
  }

  private async attempt(): Promise<void> {
    if (this.stopped || this.ws.isConnected()) return;
    this.inFlight = true;
    let timeout: NodeJS.Timeout | undefined;
    try {
      try {
        this.opts.discardStale?.();
      } catch (err) {
        log.warn('could not discard stale websocket', { error: String(err) });
      }
      await Promise.race([
        this.ws.connect(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`connect timed out after ${this.connectTimeoutMs}ms`)), this.connectTimeoutMs);
        }),
      ]);
    } catch (err) {
      log.warn('websocket reconnect failed', { attempt: this.failures + 1, error: String(err) });
    } finally {
      if (timeout) clearTimeout(timeout);
      this.inFlight = false;
    }

    if (this.ws.isConnected()) {
      this.failures = 0;
      log.info('websocket reconnected');
    } else {
      this.failures += 1;
      this.schedule();
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

/**
 * Drops the SDK WsClient's previous socket.io socket if it is not connected.
 *
 * The SDK opens a fresh socket on every `connect()` and never closes the old
 * one, so a long outage would otherwise accumulate dead sockets and their
 * listeners. `WsClient.disconnect()` is not usable here: it also clears the
 * channel subscriptions that must be re-joined on reconnect. This reaches
 * into the SDK's (TypeScript-private) `socket` field, so it is defensive about
 * the shape and does nothing if the SDK changes.
 */
export function discardStaleSdkSocket(wsClient: unknown): void {
  const holder = wsClient as { socket?: unknown };
  const socket = holder.socket as
    | { connected?: boolean; off?: () => unknown; close?: () => unknown }
    | null
    | undefined;
  if (!socket || socket.connected) return;
  socket.off?.();
  socket.close?.();
  holder.socket = null;
}
