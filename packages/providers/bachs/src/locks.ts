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
/**
 * Subscription-side keys, added with billing. Whenever several are held, they
 * are taken in this order and never the reverse:
 *
 *   checkout -> fulfil -> customer -> subscription -> credit -> charge
 *
 * `fulfil` exists because a checkout's completion work (saving the card,
 * starting the subscription) runs from the payment's success event, which can
 * be published by a caller that already holds the checkout lock. Taking the
 * checkout lock again there would wait on itself.
 */
export const fulfilLock = (checkoutId: string) => `fulfil:${checkoutId}`;
export const customerLock = (customerId: string) => `customer:${customerId}`;
export const subscriptionLock = (subscriptionId: string) => `subscription:${subscriptionId}`;
/**
 * A customer's credit balance in one currency. Two subscriptions of one
 * customer each hold only their own lock, and both may spend the same credit,
 * so the read, the invoice it discounts and the ledger entry run under this.
 */
export const creditLock = (customerId: string, currency: string) => `credit:${customerId}:${currency}`;
/** One owner's customer email: each owner keeps its own customers. */
export const emailLock = (email: string, pot: string | null = null) =>
  `customer-email:${pot ?? ''}:${email.toLowerCase()}`;
/**
 * One dispute's evidence, submission and ruling. Opening a dispute takes the
 * charge lock first (one open dispute per charge); balance movements come
 * after, under the treasury's own key:
 *
 *   charge -> dispute -> treasury
 */
export const disputeLock = (disputeId: string) => `dispute:${disputeId}`;
