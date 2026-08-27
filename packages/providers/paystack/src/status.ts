import type { PaymentStatus, SubscriptionStatus } from '@paybox/shared';

/**
 * Paystack's transaction status vocabulary.
 *
 * Kept verbatim so responses echo exactly what the real API would. The
 * canonical status drives the engine; this is what goes on the wire.
 */
export type PaystackStatus =
  | 'success'
  | 'failed'
  | 'abandoned'
  | 'pending'
  | 'ongoing'
  | 'processing'
  | 'queued'
  | 'reversed';

/**
 * Canonical -> Paystack.
 *
 * Two mappings deserve a note:
 *   requires_action -> ongoing   Paystack uses `ongoing` while it waits for a
 *                                customer action (the mobile-money prompt, or
 *                                an OTP), which is what requires_action means.
 *   partially_refunded -> success  A partial refund does not change the
 *                                transaction's own status at Paystack; the
 *                                refund is a separate object. Reporting
 *                                anything else here would be a fiction.
 */
const TO_PAYSTACK: Record<PaymentStatus, PaystackStatus> = {
  created: 'pending',
  pending: 'pending',
  processing: 'processing',
  requires_action: 'ongoing',
  authorized: 'processing',
  successful: 'success',
  failed: 'failed',
  cancelled: 'abandoned',
  expired: 'abandoned',
  refunded: 'reversed',
  partially_refunded: 'success',
};

const FROM_PAYSTACK: Record<PaystackStatus, PaymentStatus> = {
  success: 'successful',
  failed: 'failed',
  abandoned: 'cancelled',
  pending: 'pending',
  queued: 'pending',
  ongoing: 'requires_action',
  processing: 'processing',
  reversed: 'refunded',
};

export function toPaystackStatus(status: PaymentStatus): PaystackStatus {
  return TO_PAYSTACK[status];
}

export function fromPaystackStatus(status: string): PaymentStatus | null {
  return FROM_PAYSTACK[status as PaystackStatus] ?? null;
}

/** Human-readable line Paystack puts in `gateway_response`. */
export function gatewayResponse(status: PaymentStatus, failureCode: string | null): string {
  if (status === 'successful') return 'Successful';
  if (status === 'expired') return 'Transaction has expired';
  if (status === 'cancelled') return 'Transaction was abandoned';
  if (status !== 'failed') return 'Pending';
  switch (failureCode) {
    case 'insufficient_funds':
      return 'Insufficient funds';
    case 'card_declined':
      return 'Declined';
    case 'expired_card':
      return 'Expired card';
    case 'authorization_rejected':
      return 'Transaction rejected by customer';
    case 'transaction_timeout':
      return 'Transaction timed out';
    default:
      return 'Transaction failed';
  }
}


/**
 * Subscription status: canonical -> Paystack.
 *
 * Only one differs in spelling. Paystack writes `non-renewing` with a hyphen;
 * the canonical vocabulary is snake_case throughout, so the adapter maps it
 * here rather than letting a provider's punctuation into the engine.
 *
 * Schema `SubscriptionCreateResponse.data.status` in the pinned OpenAPI spec.
 */
const SUBSCRIPTION_TO_PAYSTACK: Record<SubscriptionStatus, string> = {
  active: 'active',
  non_renewing: 'non-renewing',
  attention: 'attention',
  completed: 'complete',
  cancelled: 'cancelled',
};

export function toPaystackSubscriptionStatus(status: SubscriptionStatus): string {
  return SUBSCRIPTION_TO_PAYSTACK[status];
}
