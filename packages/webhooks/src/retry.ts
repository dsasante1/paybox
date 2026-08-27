import type { RetryPolicy } from './types.js';

/**
 * Default retry schedule.
 *
 * Exponential with full jitter, capped. Jitter is drawn from the seeded
 * Random, so a run is still reproducible -- the point of jitter here is to let
 * developers see that retry timing is not perfectly periodic, which is what
 * real providers do, not to actually spread load.
 */
export function exponentialBackoff(options: {
  baseMs?: number;
  maxMs?: number;
  jitter?: () => number;
} = {}): (attempt: number) => number {
  const base = options.baseMs ?? 1_000;
  const max = options.maxMs ?? 3_600_000;
  const jitter = options.jitter ?? (() => 1);
  return (attempt: number) => {
    const raw = Math.min(base * 2 ** attempt, max);
    // Full jitter across [raw/2, raw] keeps ordering intuitive while still
    // being visibly non-uniform in the dashboard.
    return Math.round(raw * (0.5 + 0.5 * jitter()));
  };
}

export function createRetryPolicy(
  options: Partial<RetryPolicy> & { jitter?: () => number } = {},
): RetryPolicy {
  return {
    enabled: options.enabled ?? true,
    maxAttempts: options.maxAttempts ?? 5,
    backoff: options.backoff ?? exponentialBackoff({ jitter: options.jitter }),
  };
}

/** No retries -- one attempt, success or failure. */
export const NO_RETRY: RetryPolicy = {
  enabled: false,
  maxAttempts: 1,
  backoff: () => 0,
};
