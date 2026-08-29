import type { PaymentStatus, RefundStatus, TransferStatus } from '@paybox/shared';

/**
 * Canonical -> WeWire.
 *
 * WeWire's transaction vocabulary is `PENDING`, `SUCCESSFUL`, `FAILED`,
 * `REVERSED` and `CANCELLED` — uppercase, and the same five for every kind of
 * money movement. Transcribed from the payout lifecycle diagram and the
 * `status` filter on `GET /v1/transactions`
 * (docs.wewire.com/common-workflows/send-a-payout and
 * /concepts/transactions/list-transactions, read 2026-08-29).
 *
 * The uppercase is not cosmetic. It is the fifth spelling of "this worked"
 * across five providers — `success`, `succeeded`, `successful`, `success`,
 * `SUCCESSFUL` — and echoing it verbatim is the whole point of storing
 * `providerStatus` beside the canonical one.
 *
 * Two mappings are worth stating:
 *
 *   requires_action -> PENDING  WeWire has no step-up state. A collection
 *                               waiting on the customer's phone prompt is
 *                               `PENDING`, exactly as its docs describe.
 *   expired         -> FAILED   There is no expiry status; an operator
 *                               timeout is a failure with a `reason`.
 */
const TO_WEWIRE: Record<PaymentStatus, string> = {
  created: 'PENDING',
  pending: 'PENDING',
  processing: 'PENDING',
  requires_action: 'PENDING',
  authorized: 'PENDING',
  successful: 'SUCCESSFUL',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  expired: 'FAILED',
  // A reversal is its own transaction; the original stays settled.
  refunded: 'SUCCESSFUL',
  partially_refunded: 'SUCCESSFUL',
};

export function toWewireStatus(status: PaymentStatus): string {
  return TO_WEWIRE[status];
}

/**
 * Transfer status.
 *
 * Payouts are the primary object at WeWire, so this is the mapping that
 * matters most. `REVERSED` is a real WeWire terminal state — a settled payout
 * returned by the beneficiary bank — and is one of the two ways a payout can
 * end unhappily after leaving `PENDING`.
 */
const TRANSFER_TO_WEWIRE: Record<TransferStatus, string> = {
  created: 'PENDING',
  pending: 'PENDING',
  processing: 'PENDING',
  successful: 'SUCCESSFUL',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  reversed: 'REVERSED',
};

export function toWewireTransferStatus(status: TransferStatus): string {
  return TRANSFER_TO_WEWIRE[status];
}

/**
 * Refund status.
 *
 * WeWire has no refunds endpoint. Reversals are recorded as their own
 * transaction on the wallet, so a canonical refund surfaces as a `CREDIT`
 * row whose status uses the same five-word vocabulary.
 */
const REFUND_TO_WEWIRE: Record<RefundStatus, string> = {
  pending: 'PENDING',
  processing: 'PENDING',
  successful: 'SUCCESSFUL',
  failed: 'FAILED',
  // paybox parks a refund needing manual intervention here; WeWire has no
  // equivalent, and `PENDING` is the honest answer -- the money has not moved.
  needs_attention: 'PENDING',
};

export function toWewireRefundStatus(status: RefundStatus): string {
  return REFUND_TO_WEWIRE[status];
}

/**
 * The Africa (Ghana corridor) endpoints report a narrower set.
 *
 * `POST /v1/collections` and `POST /v1/disbursements` document exactly three
 * states — `PENDING -> SUCCESSFUL | FAILED` — with no `REVERSED` or
 * `CANCELLED` (docs.wewire.com/ghana/collections, /ghana/disbursements, read
 * 2026-08-29). A failed disbursement is made whole automatically rather than
 * being reported as a reversal, so the extra states have nothing to describe.
 */
export function toAfricaStatus(status: PaymentStatus | TransferStatus): string {
  const mapped =
    (TO_WEWIRE as Record<string, string | undefined>)[status] ??
    (TRANSFER_TO_WEWIRE as Record<string, string | undefined>)[status] ??
    'PENDING';
  return mapped === 'REVERSED' || mapped === 'CANCELLED' ? 'FAILED' : mapped;
}

/** Ledger direction. WeWire types every wallet row as one of these two. */
export type WewireEntryType = 'DEBIT' | 'CREDIT';

/**
 * `channel` on a wallet transaction — how the money moved.
 *
 * Only `AUTOMATED_PAYOUT` is shown in WeWire's published examples; the others
 * are inferred from the transaction types its docs enumerate (payouts,
 * collections, conversions, card activity). docs/wewire.md flags them as
 * unverified rather than presenting them as documented.
 */
export type WewireChannel =
  | 'AUTOMATED_PAYOUT'
  | 'COLLECTION'
  | 'CONVERSION'
  | 'REVERSAL';

/**
 * Canonical failure code -> the reason string on an Africa webhook.
 *
 * WeWire documents the shape of `reason` by example: *"for example `Customer
 * declined the prompt`, `Insufficient funds`, or `Operator timeout`"*
 * (docs.wewire.com/ghana/webhooks, read 2026-08-29).
 *
 * This mapping exists because the canonical failure codes are deliberately
 * generic — the simulator's `declined` outcome carries "The card was declined
 * by the issuer", which is true of a card and nonsense on a mobile-money
 * prompt. Wording is provider knowledge, so the adapter owns it (spec §30).
 */
const AFRICA_REASONS: Record<string, string> = {
  card_declined: 'Customer declined the prompt',
  authentication_failed: 'Customer declined the prompt',
  insufficient_funds: 'Insufficient funds',
  expired: 'Operator timeout',
  timeout: 'Operator timeout',
  processing_error: 'Operator timeout',
};

export function africaFailureReason(failureCode: string | null): string {
  return (failureCode && AFRICA_REASONS[failureCode]) ?? 'Operator timeout';
}
