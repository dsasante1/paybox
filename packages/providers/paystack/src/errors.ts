import { PayboxError, type ErrorCode } from '@paybox/shared';
import { fail } from './serializers.js';

/**
 * Canonical error -> Paystack wire format (spec §30).
 *
 * Paystack returns `{ status: false, message: "..." }` with an HTTP status.
 * Mapping lives here, not in the engine, so the engine never learns what a
 * Paystack error looks like.
 */
const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  authentication_failed: 401,
  not_found: 404,
  validation_failed: 400,
  invalid_request: 400,
  unsupported_currency: 400,
  refund_exceeds_amount: 400,
  duplicate_reference: 400,
  idempotency_conflict: 409,
  invalid_state_transition: 400,
  // A transfer the balance cannot cover is a rejected request, not a decline:
  // nothing was attempted. Declines never reach here -- they settle the
  // payment as failed and return 200 with the failure on the transaction.
  insufficient_funds: 400,
  unsupported_operation: 501,
  rate_limited: 429,
  safety_violation: 403,
  provider_error: 502,
  network_error: 502,
};

export interface PaystackErrorResponse {
  status: number;
  body: { status: false; message: string; [key: string]: unknown };
}

export function toPaystackError(error: unknown): PaystackErrorResponse {
  if (error instanceof PayboxError) {
    return {
      status: HTTP_STATUS[error.code] ?? error.httpStatus ?? 400,
      body: fail(error.message, {
        // Paystack surfaces field-level problems under `errors`; keeping the
        // canonical code alongside makes emulator issues easy to distinguish
        // from a genuine Paystack-shaped rejection.
        code: error.code,
        ...(Object.keys(error.details).length > 0 ? { meta: error.details } : {}),
      }) as PaystackErrorResponse['body'],
    };
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  return { status: 500, body: fail(message) as PaystackErrorResponse['body'] };
}
