import type {
  DisputeStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  RefundStatus,
  SubscriptionStatus,
  TransferStatus,
} from '@paybox/shared';

/**
 * Canonical -> Flutterwave v3.
 *
 * Flutterwave's transaction status vocabulary is small: `successful`,
 * `failed`, `pending`. Verified against the charge and verify responses at
 * developer.flutterwave.com/v3.0.0/docs/direct-card-charge (read 2026-08-29).
 *
 * Two mappings deserve a note:
 *
 *   requires_action -> pending    A charge waiting on a PIN, OTP or 3DS
 *                                 redirect is `pending` at Flutterwave; the
 *                                 step-up itself is reported in
 *                                 `meta.authorization`, not in the status.
 *   cancelled       -> failed     Flutterwave has no cancelled state.
 *
 * Note what is **not** here: there is no `refunded` transaction status. A
 * refund lives on its own object and the transaction stays `successful`,
 * exactly as at Stripe.
 */
const TO_FLUTTERWAVE: Record<PaymentStatus, string> = {
  created: 'pending',
  pending: 'pending',
  processing: 'pending',
  requires_action: 'pending',
  authorized: 'pending',
  successful: 'successful',
  failed: 'failed',
  cancelled: 'failed',
  expired: 'failed',
  refunded: 'successful',
  partially_refunded: 'successful',
};

export function toFlutterwaveStatus(status: PaymentStatus): string {
  return TO_FLUTTERWAVE[status];
}

/**
 * The authorization step a charge is waiting on.
 *
 * Flutterwave reports these in `meta.authorization.mode`, and the four values
 * are the ones its direct-card-charge guide documents: `pin`, `avs_noauth`,
 * `otp` and `redirect`.
 */
export type FlutterwaveAuthMode = 'pin' | 'avs_noauth' | 'otp' | 'redirect';

/** Fields the caller must send back for each mode, per the same guide. */
export const AUTH_MODE_FIELDS: Record<FlutterwaveAuthMode, readonly string[]> = {
  pin: ['pin'],
  avs_noauth: ['city', 'address', 'state', 'country', 'zipcode'],
  otp: ['otp'],
  redirect: [],
};

/**
 * `auth_model` on the transaction, which is a different field from the mode.
 *
 * The mode says what the *caller* must supply next; the model records how the
 * charge was ultimately authorised. A 3-D Secure card reports `VBVSECURECODE`
 * even though its mode was `redirect`.
 */
export function authModelFor(mode: FlutterwaveAuthMode | null): string {
  switch (mode) {
    case 'pin':
      return 'PIN';
    case 'otp':
      return 'OTP';
    case 'avs_noauth':
      return 'AVS_NOAUTH';
    case 'redirect':
      return 'VBVSECURECODE';
    default:
      return 'noauth';
  }
}

/** Canonical payment method -> Flutterwave's `payment_type`. */
export function toFlutterwavePaymentType(method: PaymentMethod | null): string {
  switch (method) {
    case 'mobile_money':
      return 'mobilemoney';
    case 'bank':
      return 'bank';
    case 'bank_transfer':
      return 'banktransfer';
    case 'ussd':
      return 'ussd';
    case 'eft':
      return 'account';
    case 'qr':
      return 'qr';
    default:
      return 'card';
  }
}

/** Flutterwave's `type` query parameter on /charges -> canonical method. */
export function fromFlutterwaveChargeType(type: string): PaymentMethod | null {
  const normalised = type.toLowerCase();
  if (normalised === 'card') return 'card';
  if (normalised.startsWith('mobile_money')) return 'mobile_money';
  if (normalised === 'bank_transfer') return 'bank_transfer';
  if (normalised === 'ussd') return 'ussd';
  if (normalised === 'debit_ng_account' || normalised === 'account') return 'eft';
  if (normalised === 'nqr' || normalised === 'qr') return 'qr';
  return null;
}

/**
 * Refund status.
 *
 * Flutterwave reports refunds as `completed` rather than `successful`, which
 * is the one place its refund vocabulary diverges from its transaction one.
 */
export function toFlutterwaveRefundStatus(status: RefundStatus): string {
  switch (status) {
    case 'successful':
      return 'completed';
    case 'needs_attention':
      return 'pending';
    default:
      return status;
  }
}

/** Payout status. Flutterwave writes these in caps on transfers. */
export function toFlutterwaveTransferStatus(status: TransferStatus): string {
  switch (status) {
    case 'successful':
      return 'SUCCESSFUL';
    case 'failed':
    case 'cancelled':
      return 'FAILED';
    case 'reversed':
      return 'REVERSED';
    default:
      return 'NEW';
  }
}

/** Subscription status. Flutterwave uses `active` / `cancelled`. */
export function toFlutterwaveSubscriptionStatus(status: SubscriptionStatus): string {
  switch (status) {
    case 'cancelled':
    case 'completed':
      return 'cancelled';
    default:
      return 'active';
  }
}

/** Payment-plan invoice status. */
export function toFlutterwaveInvoiceStatus(status: InvoiceStatus): string {
  switch (status) {
    case 'success':
      return 'successful';
    case 'failed':
      return 'failed';
    case 'void':
    case 'uncollectible':
      return 'cancelled';
    default:
      return 'pending';
  }
}

/** Chargeback status. Flutterwave writes these in caps. */
export function toFlutterwaveDisputeStatus(status: DisputeStatus): string {
  switch (status) {
    case 'resolved':
      return 'CLOSED';
    case 'awaiting_bank_feedback':
      return 'PENDING_PROCESSOR';
    default:
      return 'OPEN';
  }
}
