import { PayboxError, type ErrorCode } from '@paybox/shared';

/**
 * Canonical error -> Quid Payments wire format (spec §30).
 *
 * Quid answers with `{ error: { code, message } }` — a nested object like
 * Stripe's, not Paystack's or Kora's boolean `status`. The `code` comes from a
 * closed list published as the `MerchantErrorCode` component in Quid's OpenAPI
 * document (`docs.quiddpayments.com/openapi.json`, contract `2026-06`, read
 * 2026-09-15), and the guide calls those code meanings part of the versioned
 * contract: they cannot change without a migration note. So the adapter maps
 * onto that list rather than inventing codes beside it.
 */
export const QUIDDPAY_ERROR_CODES = [
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_KEY_IN_FLIGHT',
  'IDEMPOTENCY_IN_PROGRESS',
  'INVALID_ARGUMENT',
  'INVOICE_LINE_AMOUNT_INVALID',
  'MERCHANT_ID_REQUIRED',
  'BANK_TRANSFER_CAPACITY_UNAVAILABLE',
  'PAYMENT_AMOUNT_MISMATCH',
  'PAYMENT_ATTEMPT_PENDING',
  'PROVIDER_PAYMENT_REJECTED',
  'PROVIDER_RAIL_UNAVAILABLE',
  'PROVIDER_RAIL_UNSUPPORTED',
  'RAIL_NOT_ALLOWED',
  'SESSION_NOT_PAYABLE',
  'WEBHOOK_URL_UNSAFE',
  'FEE_QUOTE_INVALID',
  'MANUAL_PAYOUT_CONFLICT',
  'REFERENCE_CONFLICT',
  'FEE_LIMIT_EXCEEDED',
  'RECIPIENT_UNAVAILABLE',
  'QUOTE_EXPIRED',
  'RECIPIENT_NOT_VERIFIED',
  'PAYOUTS_PAUSED',
  'PAYOUT_LIMIT',
  'PAYOUT_DAILY_LIMIT',
  'INSUFFICIENT_FUNDS',
] as const;

export type QuiddpayErrorCode = (typeof QUIDDPAY_ERROR_CODES)[number];

/**
 * Canonical code -> Quid code and HTTP status.
 *
 * Quid's list has no generic "not found" or "server error" member, because
 * those paths do not use the coded envelope: a missing or out-of-scope record
 * returns `{ detail }` at 404/403, and validation can return a field map at
 * 400. `toQuiddpayError` reproduces both shapes below rather than forcing
 * everything through one.
 */
const MAPPING: Partial<Record<ErrorCode, { status: number; code: QuiddpayErrorCode }>> = {
  authentication_failed: { status: 401, code: 'UNAUTHORIZED' },
  safety_violation: { status: 401, code: 'UNAUTHORIZED' },
  validation_failed: { status: 400, code: 'INVALID_ARGUMENT' },
  invalid_request: { status: 400, code: 'INVALID_ARGUMENT' },
  unsupported_currency: { status: 400, code: 'INVALID_ARGUMENT' },
  unsupported_operation: { status: 400, code: 'PROVIDER_RAIL_UNSUPPORTED' },
  invalid_state_transition: { status: 409, code: 'SESSION_NOT_PAYABLE' },
  duplicate_reference: { status: 409, code: 'REFERENCE_CONFLICT' },
  idempotency_conflict: { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' },
  insufficient_funds: { status: 409, code: 'INSUFFICIENT_FUNDS' },
  balance_insufficient: { status: 409, code: 'INSUFFICIENT_FUNDS' },
  rate_limited: { status: 429, code: 'RATE_LIMITED' },
  transaction_timeout: { status: 409, code: 'PROVIDER_RAIL_UNAVAILABLE' },
  provider_error: { status: 409, code: 'PROVIDER_RAIL_UNAVAILABLE' },
  network_error: { status: 409, code: 'PROVIDER_RAIL_UNAVAILABLE' },
};

/**
 * Quid code -> HTTP status.
 *
 * Consulted **before** the canonical mapping whenever a route names a code
 * explicitly, because at Quid the code is the contract and the status follows
 * from it. Its guide draws the line plainly: "Conflicts return
 * error.code/error.message (409); validation can return a field map or message
 * list (400)". A capped payout whose fee has moved is a conflict, not a
 * malformed request, and answering 400 would tell a client to fix its payload
 * when the right response is to re-quote.
 */
const CODE_STATUS: Record<QuiddpayErrorCode, number> = {
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_KEY_IN_FLIGHT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  INVALID_ARGUMENT: 400,
  INVOICE_LINE_AMOUNT_INVALID: 400,
  MERCHANT_ID_REQUIRED: 400,
  BANK_TRANSFER_CAPACITY_UNAVAILABLE: 409,
  PAYMENT_AMOUNT_MISMATCH: 400,
  PAYMENT_ATTEMPT_PENDING: 409,
  PROVIDER_PAYMENT_REJECTED: 409,
  PROVIDER_RAIL_UNAVAILABLE: 409,
  PROVIDER_RAIL_UNSUPPORTED: 400,
  RAIL_NOT_ALLOWED: 400,
  SESSION_NOT_PAYABLE: 409,
  WEBHOOK_URL_UNSAFE: 400,
  FEE_QUOTE_INVALID: 400,
  MANUAL_PAYOUT_CONFLICT: 409,
  REFERENCE_CONFLICT: 409,
  FEE_LIMIT_EXCEEDED: 409,
  RECIPIENT_UNAVAILABLE: 409,
  QUOTE_EXPIRED: 409,
  RECIPIENT_NOT_VERIFIED: 409,
  PAYOUTS_PAUSED: 409,
  PAYOUT_LIMIT: 409,
  PAYOUT_DAILY_LIMIT: 409,
  INSUFFICIENT_FUNDS: 409,
};

export interface QuiddpayErrorResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface SchemaIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

/**
 * A schema rejection, recognised structurally rather than by `instanceof`:
 * two copies of zod in one dependency tree defeat the prototype check, and the
 * failure mode is a 500 for what is really a bad request.
 */
export function schemaIssues(error: unknown): SchemaIssue[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { name?: unknown; issues?: unknown };
  if (candidate.name !== 'ZodError' || !Array.isArray(candidate.issues)) return null;
  return candidate.issues as SchemaIssue[];
}

/** `{ error: { code, message } }` — the coded envelope. */
export function quiddpayError(
  code: QuiddpayErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { error: { code, message, ...extra } };
}

/**
 * Raise a coded Quid error from inside a route.
 *
 * The code travels on `PayboxError.details.quiddpayCode` so the canonical
 * taxonomy stays the engine's and the wire code stays the adapter's — the same
 * split Wise uses for its `RESOURCE_NOT_FOUND`.
 */
export function fail(
  canonical: ErrorCode,
  code: QuiddpayErrorCode,
  message: string,
): PayboxError {
  return new PayboxError(canonical, message, { details: { quiddpayCode: code } });
}

export function toQuiddpayError(error: unknown): QuiddpayErrorResponse {
  const issues = schemaIssues(error);
  if (issues) {
    // Quid's documented validation shape is a **field map**, not a coded
    // envelope: `{"amount_minor": ["This field is required."]}`. Reproduced as
    // published, because a client written against it branches on the shape.
    const fields: Record<string, string[]> = {};
    for (const issue of issues) {
      const key = issue.path.length > 0 ? issue.path.join('.') : 'non_field_errors';
      (fields[key] ??= []).push(issue.message);
    }
    return { status: 400, body: fields };
  }

  if (error instanceof PayboxError) {
    const declared = error.details.quiddpayCode;
    const mapped = MAPPING[error.code];

    // Missing or out-of-scope records answer with `{ detail }`, which is what
    // Quid's 403 and 404 responses carry. There is no `NOT_FOUND` member of
    // MerchantErrorCode to use instead, and inventing one would be a claim
    // about the provider's contract.
    if (error.code === 'not_found') {
      return { status: 404, body: { detail: error.message } };
    }

    if (typeof declared === 'string') {
      const code = declared as QuiddpayErrorCode;
      return {
        status: CODE_STATUS[code] ?? mapped?.status ?? error.httpStatus ?? 409,
        body: quiddpayError(code, error.message),
      };
    }
    if (mapped) {
      return { status: mapped.status, body: quiddpayError(mapped.code, error.message) };
    }
    return {
      status: error.httpStatus ?? 400,
      body: quiddpayError('INVALID_ARGUMENT', error.message),
    };
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  return { status: 500, body: { detail: message } };
}
