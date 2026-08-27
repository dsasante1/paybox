/**
 * The Clock port (spec §39).
 *
 * Nothing outside packages/core/src/time reads the wall clock. Everything --
 * timestamps on rows, webhook backoff deadlines, payment expiry, scenario step
 * delays -- reads from here, which is what lets `paybox time advance 5m` fire
 * five minutes of scheduled work instantly and deterministically.
 *
 * The implementation lives in @paybox/core; only the port is here, so that
 * every package can depend on the port without depending on the runtime.
 */
export interface Clock {
  /** Current virtual time, epoch milliseconds. */
  now(): number;
  /** Current virtual time as an ISO-8601 string. */
  nowISO(): string;
}

export interface ClockState {
  mode: 'system' | 'frozen';
  /** Virtual now, epoch ms. */
  now: number;
  /** virtual - real, in ms. Non-zero after an advance. */
  offsetMs: number;
}

export function toISO(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
