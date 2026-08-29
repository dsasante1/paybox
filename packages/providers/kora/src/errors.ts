import { PayboxError, type ErrorCode } from '@paybox/shared';

/**
 * Canonical error -> Kora wire format (spec §30).
 *
 * Kora answers with `{ status: boolean, message, data }` -- a **boolean**
 * status, like Paystack, not Flutterwave's string or Stripe's bare object.
 * Verified against the Kora Public APIs Postman collection
 * (docs.korapay.com, collection 303979/SVzxXeSM, read 2026-08-29).
 */
const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  authentication_failed: 401,
  not_found: 404,
  validation_failed: 400,
  invalid_request: 400,
  unsupported_currency: 400,
  duplicate_reference: 400,
  idempotency_conflict: 409,
  invalid_state_transition: 400,
  refund_exceeds_amount: 400,
  insufficient_funds: 400,
  balance_insufficient: 400,
  rate_limited: 429,
  unsupported_operation: 400,
  safety_violation: 403,
  transaction_timeout: 504,
  provider_error: 502,
  network_error: 502,
};

export interface SchemaIssue {
  path: (string | number)[];
  code: string;
  message: string;
  received?: unknown;
  errors?: SchemaIssue[][];
}

/**
 * A schema rejection, recognised structurally rather than by `instanceof`:
 * two copies of zod in one dependency tree defeat the prototype check, and
 * the failure mode is a 500 for what is really a bad request.
 */
export function schemaIssues(error: unknown): SchemaIssue[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { name?: unknown; issues?: unknown };
  if (candidate.name !== 'ZodError' || !Array.isArray(candidate.issues)) return null;
  return candidate.issues as SchemaIssue[];
}

export interface KoraErrorResponse {
  status: number;
  body: { status: false; message: string; data: unknown };
}

function fail(message: string, data: unknown = null): KoraErrorResponse['body'] {
  return { status: false, message, data };
}

export function toKoraError(error: unknown): KoraErrorResponse {
  const issues = schemaIssues(error);
  if (issues) {
    const first = issues[0];
    const path = (first?.path ?? []).join('.');
    return {
      status: 400,
      body: fail(
        path ? `Invalid parameter: ${path}. ${first?.message ?? ''}`.trim() : 'Invalid request.',
        { code: 'validation_failed', ...(path ? { field: path } : {}) },
      ),
    };
  }

  if (error instanceof PayboxError) {
    return {
      status: HTTP_STATUS[error.code] ?? error.httpStatus ?? 400,
      body: fail(error.message, {
        code: error.code,
        ...(Object.keys(error.details).length > 0 ? { meta: error.details } : {}),
      }),
    };
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  return { status: 500, body: fail(message) };
}

/** The `response_message` a settled charge reports. */
export function responseMessage(status: string, failureCode: string | null): string {
  if (status === 'success') return 'Approved by financial institution';
  switch (failureCode) {
    case 'insufficient_funds':
      return 'Insufficient funds';
    case 'expired_card':
      return 'Expired card';
    case 'card_declined':
      return 'Declined by financial institution';
    case 'authentication_required':
      return 'Authorization required';
    case 'authorization_rejected':
      return 'Transaction cancelled by customer';
    case 'transaction_timeout':
      return 'Transaction timed out';
    default:
      return status === 'processing' ? 'Charge in progress' : 'Transaction failed';
  }
}
