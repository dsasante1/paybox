import type { PaymentStatus, TransferStatus } from '@paybox/shared';

/**
 * Canonical -> Wise.
 *
 * Wise's transfer vocabulary is lower_snake_case and describes *where the
 * money is*, not whether the request succeeded: `incoming_payment_waiting`
 * means Wise is waiting to be funded, and `outgoing_payment_sent` — not
 * "successful" — is the happy terminal state.
 *
 * The five statuses paybox can reach are exactly the five Wise's own
 * simulation endpoint accepts, which is a useful constraint to be bound by:
 * `GET /simulation/transfers/{transferId}/{status}` enumerates `processing`,
 * `funds_converted`, `outgoing_payment_sent`, `bounced_back` and
 * `funds_refunded` (Wise Platform API OpenAPI 3.1.0, `2026Q3`,
 * `simulationTransferStateChange`, read 2026-08-29). Anything paybox reported
 * outside that set could not be driven by a developer's existing sandbox
 * script.
 *
 * `incoming_payment_waiting` is the sixth, and it is where every transfer
 * starts — before it is funded.
 */
const TRANSFER_TO_WISE: Record<TransferStatus, string> = {
  // A created-but-unfunded transfer. Wise's own initial state.
  created: 'incoming_payment_waiting',
  pending: 'incoming_payment_waiting',
  processing: 'processing',
  successful: 'outgoing_payment_sent',
  // Wise distinguishes a payout that never left (`bounced_back`) from money
  // returned to the sender (`funds_refunded`). paybox's canonical `failed`
  // maps to the first; a reversal maps to the second.
  failed: 'bounced_back',
  cancelled: 'cancelled',
  reversed: 'funds_refunded',
};

export function toWiseTransferStatus(status: TransferStatus): string {
  return TRANSFER_TO_WISE[status];
}

/**
 * The subset Wise's simulation endpoint accepts, and the canonical status
 * each drives.
 *
 * Inverted from the map above rather than written twice, so the two cannot
 * drift. `incoming_payment_waiting` is deliberately absent: it is the initial
 * state, not something you can simulate a transfer *into*.
 */
export const SIMULATABLE_STATUSES = [
  'processing',
  'funds_converted',
  'outgoing_payment_sent',
  'bounced_back',
  'funds_refunded',
] as const;

export type SimulatableStatus = (typeof SIMULATABLE_STATUSES)[number];

/**
 * Wise's simulated status -> the canonical transition it drives.
 *
 * `funds_converted` has no canonical equivalent: it is a real Wise milestone
 * (the FX leg has settled) that does not change whether the money has left.
 * It maps to `processing`, and `docs/wise.md` says so — inventing a canonical
 * status for one provider's intermediate step is exactly the leak spec §30
 * forbids.
 */
const SIMULATION_TO_CANONICAL: Record<SimulatableStatus, TransferStatus> = {
  processing: 'processing',
  funds_converted: 'processing',
  outgoing_payment_sent: 'successful',
  bounced_back: 'failed',
  funds_refunded: 'reversed',
};

export function canonicalForSimulation(status: SimulatableStatus): TransferStatus {
  return SIMULATION_TO_CANONICAL[status];
}

/**
 * Wise reports the FX leg separately from the payout leg, and paybox has one
 * status for both. A transfer parked at `processing` is therefore either
 * before or after conversion; the adapter records which on the transfer's
 * metadata so the reported status can tell them apart.
 */
export function refineProcessing(converted: boolean): string {
  return converted ? 'funds_converted' : 'processing';
}

/**
 * Payment status, for the pay-in leg of a Wise transfer.
 *
 * paybox models an inbound payment as a canonical Payment; Wise reports it
 * only as a change to the transfer's own status, so this is used for the
 * balance top-up simulation rather than a first-class object.
 */
const PAYMENT_TO_WISE: Record<PaymentStatus, string> = {
  created: 'incoming_payment_waiting',
  pending: 'incoming_payment_waiting',
  processing: 'processing',
  requires_action: 'incoming_payment_waiting',
  authorized: 'processing',
  successful: 'outgoing_payment_sent',
  failed: 'bounced_back',
  cancelled: 'cancelled',
  expired: 'bounced_back',
  refunded: 'funds_refunded',
  partially_refunded: 'outgoing_payment_sent',
};

export function toWisePaymentStatus(status: PaymentStatus): string {
  return PAYMENT_TO_WISE[status];
}

/** `FundingStatus` on a transfer funding response. Spec enum, verbatim. */
export type WiseFundingStatus = 'CREATED' | 'COMPLETED' | 'REJECTED';
