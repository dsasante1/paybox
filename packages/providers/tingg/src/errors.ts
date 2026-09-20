import { PayboxError, type ErrorCode } from '@paybox/shared';

/**
 * Canonical error -> Tingg's wire format (spec §30).
 *
 * Checkout 3.0 answers in `{ status: { status_code, status_description } }`,
 * and the code is Tingg's own numeric one rather than the HTTP status. The
 * published list, from docs.tingg.africa/reference/initiate-refunds and the
 * sibling reference pages (read 2026-09-20):
 *
 *   200   success
 *   500   generic failure on the checkout platform
 *   1001  no request found
 *   1007  missing country code
 *   1013  body was not valid JSON
 *   1014  missing merchant_transaction_id
 *   1015  missing checkout_request_id
 *   1017  invalid charge msisdn
 *   1027  invalid amount
 *
 * ## The HTTP status these arrive with is not documented
 *
 * Tingg's reference pages give the body code for each failure but never say
 * what HTTP status carries it, and the samples only ever show 200. paybox uses
 * the conventional statuses below so ordinary HTTP tooling behaves sensibly,
 * and docs/tingg.md records that the mapping is paybox's choice rather than
 * Tingg's contract -- a client should branch on `status.status_code`, which is
 * the field Tingg's own examples read.
 */
export const TINGG_ERROR_CODES = {
  SUCCESS: 200,
  GENERIC_FAILURE: 500,
  NO_REQUEST_FOUND: 1001,
  MISSING_COUNTRY_CODE: 1007,
  NOT_JSON: 1013,
  MISSING_MERCHANT_TRANSACTION_ID: 1014,
  MISSING_CHECKOUT_REQUEST_ID: 1015,
  INVALID_MSISDN: 1017,
  INVALID_AMOUNT: 1027,
} as const;

export type TinggErrorCode = (typeof TINGG_ERROR_CODES)[keyof typeof TINGG_ERROR_CODES];

export interface TinggErrorResponse {
  status: number;
  body: Record<string, unknown>;
}

/** The envelope every Checkout 3.0 route answers in, success or failure. */
export function tinggEnvelope(
  statusCode: number,
  description: string,
  results?: unknown,
): Record<string, unknown> {
  return {
    status: { status_code: statusCode, status_description: description },
    ...(results === undefined ? {} : { results }),
  };
}

/** Canonical code -> Tingg code and the HTTP status paybox carries it on. */
const MAPPING: Partial<Record<ErrorCode, { http: number; code: TinggErrorCode }>> = {
  authentication_failed: { http: 401, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
  safety_violation: { http: 401, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
  not_found: { http: 404, code: TINGG_ERROR_CODES.NO_REQUEST_FOUND },
  validation_failed: { http: 400, code: TINGG_ERROR_CODES.NOT_JSON },
  invalid_request: { http: 400, code: TINGG_ERROR_CODES.NOT_JSON },
  unsupported_currency: { http: 400, code: TINGG_ERROR_CODES.NOT_JSON },
  unsupported_operation: { http: 400, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
  duplicate_reference: { http: 409, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
  idempotency_conflict: { http: 409, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
  invalid_state_transition: { http: 409, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
  insufficient_funds: { http: 402, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
  balance_insufficient: { http: 402, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
  rate_limited: { http: 429, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
  provider_error: { http: 502, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
  network_error: { http: 502, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
  transaction_timeout: { http: 504, code: TINGG_ERROR_CODES.GENERIC_FAILURE },
};

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

/**
 * Which published code best describes a missing field.
 *
 * Tingg has a specific code for four of them, and only four. Everything else
 * falls back to 1013 -- not because the body was unparseable, but because that
 * is the only general-purpose rejection code Tingg publishes for the checkout
 * API, and inventing a code beside the documented list would be worse.
 */
export function codeForField(path: string): TinggErrorCode {
  if (path.includes('country_code')) return TINGG_ERROR_CODES.MISSING_COUNTRY_CODE;
  if (path.includes('merchant_transaction_id')) {
    return TINGG_ERROR_CODES.MISSING_MERCHANT_TRANSACTION_ID;
  }
  if (path.includes('checkout_request_id')) return TINGG_ERROR_CODES.MISSING_CHECKOUT_REQUEST_ID;
  if (path.includes('msisdn')) return TINGG_ERROR_CODES.INVALID_MSISDN;
  if (path.includes('amount')) return TINGG_ERROR_CODES.INVALID_AMOUNT;
  return TINGG_ERROR_CODES.NOT_JSON;
}

/**
 * Raise a coded Tingg error from inside a route.
 *
 * The code travels on `PayboxError.details.tinggCode` so the canonical
 * taxonomy stays the engine's and the wire code stays the adapter's -- the
 * same split Quid and Wise use.
 */
export function fail(canonical: ErrorCode, code: TinggErrorCode, message: string): PayboxError {
  return new PayboxError(canonical, message, { details: { tinggCode: code } });
}

export function toTinggError(error: unknown): TinggErrorResponse {
  const issues = schemaIssues(error);
  if (issues) {
    const first = issues[0];
    const path = first ? first.path.join('.') : '';
    const code = codeForField(path);
    return {
      status: 400,
      body: tinggEnvelope(
        code,
        first ? `${path || 'request'}: ${first.message}` : 'The request body was not valid.',
      ),
    };
  }

  if (error instanceof PayboxError) {
    const declared = error.details.tinggCode;
    const mapped = MAPPING[error.code];
    if (typeof declared === 'number') {
      return {
        status: mapped?.http ?? error.httpStatus ?? 400,
        body: tinggEnvelope(declared as TinggErrorCode, error.message),
      };
    }
    if (mapped) {
      return { status: mapped.http, body: tinggEnvelope(mapped.code, error.message) };
    }
    return {
      status: error.httpStatus ?? 400,
      body: tinggEnvelope(TINGG_ERROR_CODES.GENERIC_FAILURE, error.message),
    };
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  return { status: 500, body: tinggEnvelope(TINGG_ERROR_CODES.GENERIC_FAILURE, message) };
}
