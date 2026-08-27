import type { Clock } from '@paybox/shared';

/**
 * Structured logging (spec §42).
 *
 * One JSON object per line, timestamped on *virtual* time so log ordering
 * matches the timeline the dashboard shows. A ring buffer keeps the last N
 * lines in memory so `paybox logs` and the dashboard can read them back
 * without a file tail.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export class PayboxLogger {
  readonly #clock: Clock;
  readonly #min: number;
  readonly #buffer: LogEntry[] = [];
  readonly #capacity: number;
  #sink: (entry: LogEntry) => void;

  constructor(options: {
    clock: Clock;
    level?: LogLevel;
    capacity?: number;
    sink?: (entry: LogEntry) => void;
  }) {
    this.#clock = options.clock;
    this.#min = LEVEL_ORDER[options.level ?? 'info'];
    this.#capacity = options.capacity ?? 1_000;
    this.#sink =
      options.sink ??
      ((entry) => {
        process.stdout.write(`${JSON.stringify(entry)}\n`);
      });
  }

  #write(level: LogLevel, event: string, meta: Record<string, unknown> = {}): void {
    const entry: LogEntry = { timestamp: this.#clock.nowISO(), level, event, ...meta };
    this.#buffer.push(entry);
    if (this.#buffer.length > this.#capacity) this.#buffer.shift();
    if (LEVEL_ORDER[level] >= this.#min) this.#sink(entry);
  }

  debug(event: string, meta?: Record<string, unknown>): void {
    this.#write('debug', event, meta);
  }
  info(event: string, meta?: Record<string, unknown>): void {
    this.#write('info', event, meta);
  }
  warn(event: string, meta?: Record<string, unknown>): void {
    this.#write('warn', event, meta);
  }
  error(event: string, meta?: Record<string, unknown>): void {
    this.#write('error', event, meta);
  }

  /** Most recent entries, newest last. */
  recent(limit = 200): LogEntry[] {
    return this.#buffer.slice(-limit);
  }
}
