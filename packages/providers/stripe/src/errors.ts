import { PayboxError, type ErrorCode } from '@paybox/shared';

/**
 * Canonical error -> Stripe wire format (spec §30).
 *
 * Stripe answers with `{ error: { type, code, message, param, ... } }`, where
 * `type` is one of four values. Verified against `stripe/openapi`
 * `openapi/spec3.json` schema `api_errors`, read 2026-08-28.
 *
 * Mapping lives here, not in the engine, so the engine never learns what a
 * Stripe error looks like -- the same rule that keeps Paystack's
 * `{status:false,message}` out of core.
 */
export type StripeErrorType =
  | 'api_error'
  | 'card_error'
  | 'idempotency_error'
  | 'invalid_request_error';

interface StripeErrorShape {
  type: StripeErrorType;
  /** Stripe's own `code`, which is not the canonical one. */
  code?: string;
  /** Only on card errors: the issuer's reason. */
  declineCode?: string;
  httpStatus: number;
}

/**
 * How each canonical code surfaces.
 *
 * Card errors are HTTP 402 at Stripe -- not 200 as at Paystack, and not 400.
 * That difference is the whole reason this mapping is per-adapter.
 */
const ERRORS: Partial<Record<ErrorCode, StripeErrorShape>> = {
  authentication_failed: { type: 'invalid_request_error', httpStatus: 401 },
  not_found: { type: 'invalid_request_error', code: 'resource_missing', httpStatus: 404 },
  validation_failed: { type: 'invalid_request_error', code: 'parameter_invalid', httpStatus: 400 },
  invalid_request: { type: 'invalid_request_error', httpStatus: 400 },
  unsupported_currency: {
    type: 'invalid_request_error',
    code: 'currency_not_supported',
    httpStatus: 400,
  },
  duplicate_reference: {
    type: 'invalid_request_error',
    code: 'resource_already_exists',
    httpStatus: 400,
  },
  idempotency_conflict: { type: 'idempotency_error', httpStatus: 400 },
  invalid_state_transition: {
    type: 'invalid_request_error',
    code: 'payment_intent_unexpected_state',
    httpStatus: 400,
  },
  refund_exceeds_amount: {
    type: 'invalid_request_error',
    code: 'charge_already_refunded',
    httpStatus: 400,
  },
  // Card declines are 402 Payment Required, with a decline_code alongside.
  card_declined: {
    type: 'card_error',
    code: 'card_declined',
    declineCode: 'generic_decline',
    httpStatus: 402,
  },
  insufficient_funds: {
    type: 'card_error',
    code: 'card_declined',
    declineCode: 'insufficient_funds',
    httpStatus: 402,
  },
  expired_card: { type: 'card_error', code: 'expired_card', httpStatus: 402 },
  authentication_required: {
    type: 'card_error',
    code: 'authentication_required',
    httpStatus: 402,
  },
  authorization_rejected: {
    type: 'card_error',
    code: 'card_declined',
    declineCode: 'transaction_not_allowed',
    httpStatus: 402,
  },
  transaction_timeout: { type: 'api_error', httpStatus: 500 },
  provider_error: { type: 'api_error', httpStatus: 500 },
  network_error: { type: 'api_error', httpStatus: 500 },
  rate_limited: { type: 'invalid_request_error', code: 'rate_limit', httpStatus: 429 },
  unsupported_operation: { type: 'invalid_request_error', httpStatus: 400 },
  safety_violation: { type: 'invalid_request_error', httpStatus: 403 },
};

/**
 * The `code` / `decline_code` pair Stripe reports for a canonical failure.
 *
 * Derived from the canonical code rather than the card number, because a
 * settled payment keeps only masked fragments -- there is deliberately no
 * column that could hold a PAN (spec §29). The same table drives both the
 * error envelope and `last_payment_error` on the intent, so the two can never
 * disagree.
 */
export function stripeFailure(
  canonicalCode: string | null,
): { code: string; declineCode?: string } | null {
  if (!canonicalCode) return null;
  const shape = ERRORS[canonicalCode as ErrorCode];
  if (!shape?.code) return null;
  return shape.declineCode
    ? { code: shape.code, declineCode: shape.declineCode }
    : { code: shape.code };
}

export interface StripeErrorResponse {
  status: number;
  body: { error: Record<string, unknown> };
}

export function toStripeError(error: unknown): StripeErrorResponse {
  if (error instanceof PayboxError) {
    const shape = ERRORS[error.code] ?? {
      type: 'invalid_request_error' as const,
      httpStatus: 400,
    };
    return {
      status: shape.httpStatus,
      body: {
        error: {
          type: shape.type,
          message: error.message,
          ...(shape.code ? { code: shape.code } : {}),
          ...(shape.declineCode ? { decline_code: shape.declineCode } : {}),
          // Stripe puts the charge that failed on the error itself, so an
          // integration can look up the attempt without parsing the message.
          ...(typeof error.details.stripeCharge === 'string'
            ? { charge: error.details.stripeCharge }
            : {}),
          ...(typeof error.details.stripePaymentIntent === 'string'
            ? { payment_intent: error.details.stripePaymentIntent }
            : {}),
          // The canonical code, so an emulator-specific rejection is
          // distinguishable from a genuine Stripe-shaped one.
          paybox_code: error.code,
          ...(Object.keys(error.details).length > 0 ? { paybox_details: error.details } : {}),
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  return { status: 500, body: { error: { type: 'api_error', message } } };
}
