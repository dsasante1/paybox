import type { Clock, ClockState } from '@paybox/shared';
import { toISO } from '@paybox/shared';

export type ClockListener = (state: ClockState) => void;

/**
 * Controllable clock (spec §39).
 *
 * Two modes:
 *   system  -- virtual time tracks real time, plus any accumulated offset.
 *              `advance` here shifts the offset, so time keeps flowing.
 *   frozen  -- virtual time is pinned. Only `advance`/`set` move it.
 *
 * Freezing is what makes tests deterministic: a payment created at a frozen
 * instant has an exact `expiresAt`, and advancing to it fires the expiry job
 * with no sleeping and no flake.
 *
 * This is one of the two files permitted to read the wall clock. Everything
 * else injects a Clock. See eslint.config.js.
 */
export class VirtualClock implements Clock {
  #mode: 'system' | 'frozen' = 'system';
  #frozenAt = 0;
  #offsetMs = 0;
  /** Scoped override used by the scheduler; see `at()`. */
  #override: number | null = null;
  readonly #listeners = new Set<ClockListener>();

  constructor(options: { startAt?: number | string; frozen?: boolean } = {}) {
    if (options.startAt !== undefined) {
      const at =
        typeof options.startAt === 'string'
          ? Date.parse(options.startAt)
          : options.startAt;
      if (Number.isNaN(at)) {
        throw new TypeError(`VirtualClock: unparseable startAt ${options.startAt}`);
      }
      this.#offsetMs = at - Date.now();
      this.#frozenAt = at;
    } else {
      this.#frozenAt = Date.now();
    }
    if (options.frozen) this.#mode = 'frozen';
  }

  now(): number {
    if (this.#override !== null) return this.#override;
    return this.#real();
  }

  /**
   * The clock's own instant, ignoring any scoped `at()` override.
   *
   * The control surface reads this. A job running under `at()` must see its
   * scheduled instant, but a caller asking "what time is it" while that job
   * is in flight must not: `freeze()` used to pin the clock to a job's
   * instant and `state()` used to report it, which moved virtual time
   * backwards -- the one thing this clock promises never to do.
   */
  #real(): number {
    return this.#mode === 'frozen' ? this.#frozenAt : Date.now() + this.#offsetMs;
  }

  /**
   * Run `fn` as if the current instant were `epochMs`.
   *
   * The scheduler uses this to execute each due job *at the time it was
   * scheduled for* rather than at whatever instant the clock has since reached.
   * Without it, advancing an hour would run a webhook retry due at T+4s but
   * stamp it T+1h and schedule its next attempt from T+1h — so a five-attempt
   * retry ladder would need five separate advances instead of collapsing into
   * one. Timestamps in the event log would be wrong for the same reason.
   *
   * Deliberately does not notify listeners: this is a scoped view of time, not
   * a change to it, and emitting here would recurse straight back into a drain.
   */
  async at<T>(epochMs: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.#override;
    this.#override = epochMs;
    try {
      return await fn();
    } finally {
      this.#override = previous;
    }
  }

  nowISO(): string {
    return toISO(this.now());
  }

  freeze(at?: number | string): ClockState {
    const target =
      at === undefined ? this.#real() : typeof at === 'string' ? Date.parse(at) : at;
    if (Number.isNaN(target)) throw new TypeError(`freeze: unparseable time ${at}`);
    if (target < this.#real()) {
      throw new RangeError('freeze: refusing to move virtual time backwards');
    }
    this.#frozenAt = target;
    this.#mode = 'frozen';
    return this.#emit();
  }

  unfreeze(): ClockState {
    if (this.#mode === 'frozen') {
      // Preserve the virtual instant across the mode switch, so unfreezing
      // never appears to jump time backwards.
      this.#offsetMs = this.#frozenAt - Date.now();
      this.#mode = 'system';
    }
    return this.#emit();
  }

  /** Move virtual time forward. Negative deltas are rejected: nothing in the
   *  engine is designed to handle time running backwards. */
  advance(ms: number): ClockState {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`advance: expected a non-negative duration, got ${ms}`);
    }
    if (this.#mode === 'frozen') this.#frozenAt += ms;
    else this.#offsetMs += ms;
    return this.#emit();
  }

  set(at: number | string): ClockState {
    const target = typeof at === 'string' ? Date.parse(at) : at;
    if (Number.isNaN(target)) throw new TypeError(`set: unparseable time ${at}`);
    if (target < this.#real()) {
      throw new RangeError('set: refusing to move virtual time backwards');
    }
    if (this.#mode === 'frozen') this.#frozenAt = target;
    else this.#offsetMs = target - Date.now();
    return this.#emit();
  }

  state(): ClockState {
    return { mode: this.#mode, now: this.#real(), offsetMs: this.#offsetMs };
  }

  /** The scheduler subscribes here so an advance drains due jobs immediately. */
  onChange(listener: ClockListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): ClockState {
    const state = this.state();
    for (const listener of this.#listeners) listener(state);
    return state;
  }
}

/** Fixed clock for unit tests that do not need the control surface. */
export function fixedClock(at: string | number): Clock {
  const epoch = typeof at === 'string' ? Date.parse(at) : at;
  return { now: () => epoch, nowISO: () => toISO(epoch) };
}
