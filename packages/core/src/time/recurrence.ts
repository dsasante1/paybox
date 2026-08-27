import type { PlanInterval } from '@paybox/shared';

/**
 * Billing-period arithmetic.
 *
 * Calendar arithmetic, not a fixed number of milliseconds. A "monthly" plan
 * billed by adding 30 days drifts a full week over a year and lands on the
 * wrong day of the month every time, so a test asserting "twelve renewals, one
 * month apart" could never pass. Adding one to the UTC month keeps every
 * renewal on the same nominal day.
 *
 * All arithmetic is UTC. The emulator has no timezone concept, and virtual
 * time is always ISO UTC, so a local-time interpretation could only introduce
 * a discrepancy no real provider would produce.
 */
const MONTHS_PER_INTERVAL: Partial<Record<PlanInterval, number>> = {
  monthly: 1,
  biannually: 6,
  annually: 12,
};

const DAYS_PER_INTERVAL: Partial<Record<PlanInterval, number>> = {
  daily: 1,
  weekly: 7,
};

/**
 * The instant one billing period after `fromISO`.
 *
 * Day-of-month is clamped, so a subscription starting on the 31st bills on the
 * 28th/29th in February and does **not** silently roll into March. Rolling
 * over would shift every subsequent renewal by a month, which is the classic
 * off-by-one in hand-rolled billing code.
 */
export function addInterval(fromISO: string, interval: PlanInterval): string {
  const from = new Date(fromISO);
  if (Number.isNaN(from.getTime())) {
    throw new RangeError(`Cannot advance an invalid date: ${fromISO}`);
  }

  const days = DAYS_PER_INTERVAL[interval];
  if (days !== undefined) {
    const next = new Date(from.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next.toISOString();
  }

  const months = MONTHS_PER_INTERVAL[interval];
  if (months === undefined) {
    throw new RangeError(`Unknown billing interval: ${interval}`);
  }

  const day = from.getUTCDate();
  const next = new Date(from.getTime());
  // Move to the first of the target month before restoring the day, so the
  // intermediate value can never overflow into the month after it.
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  next.setUTCDate(Math.min(day, daysInUtcMonth(next.getUTCFullYear(), next.getUTCMonth())));
  return next.toISOString();
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** How many whole periods of `interval` fit between two instants. */
export function periodsBetween(fromISO: string, toISO: string, interval: PlanInterval): number {
  let count = 0;
  let cursor = fromISO;
  const end = Date.parse(toISO);
  while (Date.parse(cursor) < end && count < 10_000) {
    cursor = addInterval(cursor, interval);
    count++;
  }
  return count;
}
