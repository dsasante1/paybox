
/**
 * A real, wall-clock sleep.
 *
 * Used only for network simulation (spec §40), where the point is to make the
 * caller actually wait — a virtual delay would be invisible to the developer's
 * HTTP client, which is the thing being tested. Everything schedule-shaped
 * uses the job queue and virtual time instead.
 */
export function realSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
