import type { Job, JobRepository, Storage } from '../ports.js';
import type { VirtualClock } from './clock.js';

/** A handler may ask to be retried instead of throwing. */
export type JobResult = void | { retryInMs: number; error?: string };
export type JobHandler = (job: Job) => Promise<JobResult>;

export interface SchedulerOptions {
  storage: Storage;
  clock: VirtualClock;
  /** How often to look for due work while virtual time tracks real time. */
  pollIntervalMs?: number;
  /** How long a claimed job may run before another worker may reclaim it. */
  leaseMs?: number;
  batchSize?: number;
  logger?: {
    debug(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
}

/**
 * Durable job scheduler (replaces Redis + BullMQ).
 *
 * Jobs live in a table and their `runAt` is compared against *virtual* time,
 * which is the whole reason we did not take BullMQ: BullMQ's delays live in
 * Redis on the wall clock, so `paybox time advance 5m` could never fire a
 * retry scheduled five minutes out. Here, an advance triggers `drain()` and
 * every job that just became due runs immediately.
 *
 * `drain()` loops because draining can itself enqueue newly-due work: a
 * webhook that fails at t+0 schedules a retry at t+1s, which is also inside a
 * 5-minute advance and must therefore run within the same drain.
 */
export class Scheduler {
  readonly #storage: Storage;
  readonly #jobs: JobRepository;
  readonly #clock: VirtualClock;
  readonly #handlers = new Map<string, JobHandler>();
  readonly #pollIntervalMs: number;
  readonly #leaseMs: number;
  readonly #batchSize: number;
  readonly #logger: NonNullable<SchedulerOptions['logger']>;

  #timer: NodeJS.Timeout | null = null;
  #unsubscribeClock: (() => void) | null = null;
  #running = false;
  /** Serialises ticks so a poll and a clock-advance drain cannot interleave. */
  #inFlight: Promise<unknown> = Promise.resolve();

  constructor(options: SchedulerOptions) {
    this.#storage = options.storage;
    this.#jobs = options.storage.jobs;
    this.#clock = options.clock;
    this.#pollIntervalMs = options.pollIntervalMs ?? 200;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#batchSize = options.batchSize ?? 25;
    this.#logger = options.logger ?? {
      debug: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  register(kind: string, handler: JobHandler): void {
    if (this.#handlers.has(kind)) {
      throw new Error(`A handler for job kind "${kind}" is already registered.`);
    }
    this.#handlers.set(kind, handler);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;

    this.#timer = setInterval(() => {
      void this.#serialise(() => this.tick());
    }, this.#pollIntervalMs);
    this.#timer.unref?.();

    // The important half: when someone advances virtual time, do not wait for
    // the next poll -- drain everything that just became due, synchronously
    // from the caller's perspective.
    this.#unsubscribeClock = this.#clock.onChange(() => {
      void this.#serialise(() => this.drain());
    });
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribeClock?.();
    this.#unsubscribeClock = null;
    await this.#inFlight.catch(() => {});
  }

  /** Await whatever tick or drain is currently in flight. */
  async settle(): Promise<void> {
    await this.#inFlight.catch(() => {});
  }

  /** Run one batch of due jobs. Returns how many were processed. */
  async tick(): Promise<number> {
    const nowISO = this.#clock.nowISO();
    await this.#jobs.reclaimExpiredLeases(nowISO);

    const leaseUntil = new Date(this.#clock.now() + this.#leaseMs).toISOString();
    const due = await this.#jobs.claimDue(nowISO, leaseUntil, this.#batchSize);
    for (const job of due) {
      // Execute each job at its own scheduled instant, not at whatever time
      // the clock has since advanced to. See VirtualClock#at.
      const scheduledAt = Date.parse(job.runAt);
      await this.#clock.at(Number.isNaN(scheduledAt) ? this.#clock.now() : scheduledAt, () =>
        this.#run(job),
      );
    }
    return due.length;
  }

  /**
   * Run due jobs until none remain. Bounded, because a misbehaving handler
   * that re-enqueues itself with a zero delay would otherwise spin forever.
   */
  async drain(maxIterations = 1_000): Promise<number> {
    let processed = 0;
    for (let i = 0; i < maxIterations; i++) {
      const count = await this.tick();
      if (count === 0) return processed;
      processed += count;
    }
    this.#logger.warn('Scheduler drain hit its iteration bound', { maxIterations });
    return processed;
  }

  async #run(job: Job): Promise<void> {
    const handler = this.#handlers.get(job.kind);
    if (!handler) {
      await this.#jobs.fail(job.id, `No handler registered for job kind "${job.kind}".`);
      this.#logger.error('Unhandled job kind', { kind: job.kind, jobId: job.id });
      return;
    }

    try {
      const result = await handler(job);
      if (result && typeof result.retryInMs === 'number') {
        await this.#retry(job, result.retryInMs, result.error ?? null);
      } else {
        await this.#jobs.complete(job.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn('Job handler threw', { jobId: job.id, kind: job.kind, message });
      await this.#retry(job, defaultBackoffMs(job.attempt), message);
    }
  }

  async #retry(job: Job, delayMs: number, error: string | null): Promise<void> {
    if (job.attempt + 1 >= job.maxAttempts) {
      await this.#jobs.fail(job.id, error ?? 'Retries exhausted.');
      return;
    }
    const runAt = new Date(this.#clock.now() + Math.max(0, delayMs)).toISOString();
    await this.#jobs.reschedule(job.id, runAt, error);
  }

  #serialise<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#inFlight.then(fn, fn);
    this.#inFlight = next.catch((error) => {
      this.#logger.error('Scheduler tick failed', { error });
    });
    return next;
  }

  get storage(): Storage {
    return this.#storage;
  }
}

/** Exponential backoff with a cap, used when a handler throws unexpectedly. */
export function defaultBackoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 1_000, 60_000);
}
