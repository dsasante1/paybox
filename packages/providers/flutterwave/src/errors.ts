import { PayboxError, type ErrorCode } from '@paybox/shared';

/**
 * Canonical error -> Flutterwave v3 wire format (spec §30).
 *
 * Flutterwave answers with `{ status: "error", message, data }`, where `data`
 * carries the failure detail when there is one. Verified against the error
 * responses at developer.flutterwave.com/v3.0.0/docs/common-errors and
 * .../direct-card-charge (read 2026-08-29).
 *
 * The mapping lives here, not in the engine, so core never learns what a
 * Flutterwave error looks like -- the same rule that keeps Stripe's
 * `{error:{type,code}}` and Paystack's `{status:false,message}` out of it.
 */
const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  authentication_failed: 401,
  not_found: 404,
  validation_failed: 400,
  invalid_request: 400,
  unsupported_currency: 400,
  duplicate_reference: 400,
  idempotency_conflict: 400,
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

/**
 * A schema rejection, recognised structurally.
 *
 * Detected by shape rather than `instanceof ZodError` because two copies of
 * zod in one dependency tree defeat the prototype check, and the failure mode
 * of getting this wrong is a 500 for what is really a bad request.
 */
export interface SchemaIssue {
  path: (string | number)[];
  code: string;
  message: string;
  received?: unknown;
  errors?: SchemaIssue[][];
}

export function schemaIssues(error: unknown): SchemaIssue[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { name?: unknown; issues?: unknown };
  if (candidate.name !== 'ZodError' || !Array.isArray(candidate.issues)) return null;
  return candidate.issues as SchemaIssue[];
}

export interface FlutterwaveErrorResponse {
  status: number;
  body: { status: 'error'; message: string; data: unknown };
}

function fail(message: string, data: unknown = null): FlutterwaveErrorResponse['body'] {
  return { status: 'error', message, data };
}

export function toFlutterwaveError(error: unknown): FlutterwaveErrorResponse {
  // A malformed request is the client's fault. Falling through to the 500
  // below would tell a developer the emulator broke when their payload was
  // simply wrong, and send them debugging paybox instead of their own code.
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
        // The canonical code alongside, so an emulator-specific rejection is
        // distinguishable from a genuine Flutterwave-shaped one.
        code: error.code,
        ...(Object.keys(error.details).length > 0 ? { meta: error.details } : {}),
      }),
    };
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  return { status: 500, body: fail(message) };
}

/**
 * The `processor_response` a settled charge reports.
 *
 * Flutterwave puts the acquirer's own words here, and integrations surface it
 * to support staff, so a failure that reported nothing would be less useful
 * than one that reported the truth.
 */
export function processorResponse(
  status: string,
  failureCode: string | null,
): string {
  if (status === 'successful') return 'Approved. Successful';
  switch (failureCode) {
    case 'insufficient_funds':
      return 'Insufficient Funds';
    case 'expired_card':
      return 'Expired Card';
    case 'card_declined':
      return 'Do not honour';
    case 'authentication_required':
      return 'Pending redirect to issuer’s 3DS authentication page';
    case 'authorization_rejected':
      return 'Transaction rejected by customer';
    case 'transaction_timeout':
      return 'Transaction timed out';
    case 'network_error':
      return 'Transaction failed';
    default:
      return status === 'pending' ? 'Pending' : 'Transaction failed';
  }
}
