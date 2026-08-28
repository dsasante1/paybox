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


/**
 * ISO 8583 response codes and their string classification.
 *
 * Paystack returns two extra fields on a transaction: `response_code`, the raw
 * 2-digit processor code (cards only), and `gateway_response_code`, a
 * string classification of it. Transcribed from
 * <https://paystack.com/docs/payments/gateway-responses/>, read 2026-08-28.
 *
 * Only the codes the emulator can actually produce are mapped. Paystack's full
 * table is ~60 entries; inventing a code for a failure paybox cannot simulate
 * would be worse than leaving it out. Anything unmapped resolves to `unknown`,
 * which is what Paystack documents for unlisted codes.
 */
interface GatewayCodes {
  responseCode: string;
  gatewayResponseCode: string;
}

const FAILURE_CODES: Record<string, GatewayCodes> = {
  card_declined: { responseCode: '05', gatewayResponseCode: 'do_not_honor' },
  insufficient_funds: { responseCode: '51', gatewayResponseCode: 'insufficient_funds' },
  expired_card: { responseCode: '54', gatewayResponseCode: 'expired_card' },
  provider_error: { responseCode: '06', gatewayResponseCode: 'processing_error' },
  authentication_required: { responseCode: '55', gatewayResponseCode: 'invalid_pin' },
  authorization_rejected: { responseCode: '17', gatewayResponseCode: 'customer_cancellation' },
  transaction_timeout: { responseCode: '91', gatewayResponseCode: 'issuer_or_switch_inoperative' },
  network_error: { responseCode: '96', gatewayResponseCode: 'system_malfunction' },
};

export function gatewayCodes(
  status: PaymentStatus,
  failureCode: string | null,
): GatewayCodes {
  // `approved` is the only success value Paystack documents.
  if (status === 'successful' || status === 'partially_refunded' || status === 'refunded') {
    return { responseCode: '00', gatewayResponseCode: 'approved' };
  }
  if (status === 'pending' || status === 'processing' || status === 'requires_action') {
    return { responseCode: '09', gatewayResponseCode: 'processing' };
  }
  return (
    (failureCode ? FAILURE_CODES[failureCode] : undefined) ?? {
      responseCode: '06',
      gatewayResponseCode: 'unknown',
    }
  );
}
