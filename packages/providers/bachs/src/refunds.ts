import type { Payment, Refund } from '@paybox/shared';
import { uuidFrom } from './ids.js';
import { withLock } from './locks.js';
import type { BachsState, StoredRefund } from './state.js';

/**
 * The Bachs record for an engine refund, creating one if it has none.
 *
 * A refund made through the Bachs API gets its record before the engine call.
 * One made by paybox's own tooling -- `paybox refund`, the dashboard, a
 * dispute -- never passes through the adapter, but it is still money returned
 * on a Bachs charge: it must appear in `/v1/refunds`, count against the
 * one-refund rule and send `refund.*` webhooks. Its id is derived from the
 * engine refund's, so every reader agrees on it, and its reference is the
 * engine id, the only reference it has.
 */
export async function refundRecord(
  state: BachsState,
  refund: Refund,
  payment: Payment,
): Promise<StoredRefund> {
  // Two readers meeting an unrecorded refund at once must make one record,
  // with one sequence number.
  return withLock(`refund-record:${refund.id}`, () => recordFor(state, refund, payment));
}

async function recordFor(state: BachsState, refund: Refund, payment: Payment): Promise<StoredRefund> {
  const known =
    (await state.refunds.byEngineId(refund.id)) ??
    (typeof refund.metadata.bachs_refund_id === 'string'
      ? await state.refunds.get(refund.metadata.bachs_refund_id)
      : null);
  if (known && known.engineId) return known;
  if (known) {
    const linked = { ...known, engineId: refund.id };
    await state.refunds.put(linked);
    await state.refunds.indexEngine(refund.id, linked.id);
    return linked;
  }
  const record: StoredRefund = {
    id: uuidFrom(`refund:${refund.id}`),
    engineId: refund.id,
    seq: await state.nextSeq(),
    chargeId: payment.providerTransactionId,
    reference: refund.id,
    requestedAmount: refund.amount,
    currency: refund.currency,
    feeBearer: 'org',
    reason: refund.reason,
    simulatedOutcome: refund.status === 'failed' ? 'failed' : 'success',
    createdAt: refund.createdAt,
  };
  await state.refunds.put(record);
  await state.refunds.indexEngine(refund.id, record.id);
  return record;
}
