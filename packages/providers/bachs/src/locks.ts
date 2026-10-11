/**
 * In-process mutual exclusion, keyed.
 *
 * Several Bachs operations are a read of adapter state, one or more engine
 * calls, and a write back -- and the engine opens its own transactions, so the
 * three cannot share one. Without a lock, an expiry job and a hosted-page
 * payment on the same checkout can each act on a stale copy (one sends
 * `checkout.expired`, the other writes the session back to `open`), and two
 * refunds on one charge can both pass the one-refund check. paybox is one
 * process on one SQLite connection, so serialising per key here is enough.
 *
 * Module-level on purpose: the routes and the scheduler's expiry handler are
 * built separately and must contend for the same lock.
 */
const tails = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.catch(() => undefined);
  tails.set(key, settled);
  try {
    return await run;
  } finally {
    if (tails.get(key) === settled) tails.delete(key);
  }
}

export const checkoutLock = (checkoutId: string) => `checkout:${checkoutId}`;
export const chargeLock = (paymentId: string) => `charge:${paymentId}`;
export const emailLock = (email: string) => `customer-email:${email.toLowerCase()}`;
