import type { PaymentMethod, PaymentStatus, RefundStatus, TransferStatus } from '@paybox/shared';

/**
 * Canonical -> Kora.
 *
 * Kora's vocabulary is `pending`, `processing`, `success`, `failed` and
 * `expired`. Verified against the charge and payout responses in the Kora
 * Public APIs Postman collection (docs.korapay.com, collection 303979/SVzxXeSM,
 * read 2026-08-29).
 *
 * Two mappings deserve a note:
 *
 *   requires_action -> processing  A charge awaiting an OTP or an STK prompt is
 *                                  `processing` at Kora; the step-up is
 *                                  reported in `auth_model`, not the status.
 *   cancelled       -> failed      Kora has no cancelled state for a charge.
 */
const TO_KORA: Record<PaymentStatus, string> = {
  created: 'pending',
  pending: 'pending',
  processing: 'processing',
  requires_action: 'processing',
  authorized: 'processing',
  successful: 'success',
  failed: 'failed',
  cancelled: 'failed',
  expired: 'expired',
  // A refund lives on its own object; the charge stays successful.
  refunded: 'success',
  partially_refunded: 'success',
};

export function toKoraStatus(status: PaymentStatus): string {
  return TO_KORA[status];
}

/** How a charge is being authorised. Kora's two documented models. */
export type KoraAuthModel = 'OTP' | 'STK_PROMPT';

/** Canonical method -> Kora's `payment_method`. */
export function toKoraPaymentMethod(method: PaymentMethod | null): string {
  switch (method) {
    case 'mobile_money':
      return 'mobile_money';
    case 'bank_transfer':
    case 'bank':
      return 'bank_transfer';
    case 'ussd':
      return 'ussd';
    default:
      return 'card';
  }
}

/**
 * Refund status.
 *
 * Kora's refunds report `processing` then `success`, which is the same
 * vocabulary as its charges -- unlike Flutterwave, whose refunds say
 * `completed`.
 */
export function toKoraRefundStatus(status: RefundStatus): string {
  switch (status) {
    case 'successful':
      return 'success';
    case 'needs_attention':
      return 'processing';
    default:
      return status;
  }
}

/** Payout status. Same vocabulary again. */
export function toKoraTransferStatus(status: TransferStatus): string {
  switch (status) {
    case 'successful':
      return 'success';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'reversed':
      return 'reversed';
    case 'processing':
      return 'processing';
    default:
      return 'pending';
  }
}
