import { PayboxError, type ErrorCode } from '@paybox/shared';

/**
 * Canonical error -> Wise wire format (spec §30).
 *
 * Wise does not have one error envelope; it has several, accumulated across
 * API generations. The spec carries at least three distinct shapes:
 *
 *   {timestamp, errors:[{code,message,path,arguments}]}   the money endpoints
 *   {error, message, timestamp, path, errors:[…]}          newer services
 *   {type, status, code, detail}                           RFC-7807-style
 *
 * paybox uses the first, because it is the one documented on the endpoints
 * this adapter implements — `POST /accounts` types its 400 as exactly that
 * (Wise Platform API OpenAPI 3.1.0, `2026Q3`, read 2026-08-29). The transfer
 * and quote endpoints carry **no** error schema in the spec at all, which
 * `docs/wise.md` records rather than papering over.
 *
 * That is a fifth distinct envelope across six providers, which is the whole
 * argument for each adapter owning its own mapping and none of it reaching
 * the engine.
 */
interface WiseShape {
  code: string;
  httpStatus: number;
}

/**
 * Canonical code -> Wise's own error code.
 *
 * Wise's codes are dotted and resource-scoped (`transfer.not-found`,
 * `payment.exists`), transcribed from `FundingErrorCode` — the one complete
 * enum the spec publishes. Where a canonical code has no documented Wise
 * equivalent, the generic `NOT_VALID` from the recipient-validation envelope
 * is used rather than an invented dotted code.
 */
const ERRORS: Partial<Record<ErrorCode, WiseShape>> = {
  authentication_failed: { code: 'UNAUTHORIZED', httpStatus: 401 },
  safety_violation: { code: 'FORBIDDEN', httpStatus: 403 },
  not_found: { code: 'RESOURCE_NOT_FOUND', httpStatus: 404 },
  validation_failed: { code: 'NOT_VALID', httpStatus: 400 },
  invalid_request: { code: 'NOT_VALID', httpStatus: 400 },
  unsupported_currency: { code: 'NOT_VALID', httpStatus: 400 },
  duplicate_reference: { code: 'payment.exists', httpStatus: 409 },
  idempotency_conflict: { code: 'payment.exists', httpStatus: 409 },
  invalid_state_transition: { code: 'transfer.invalid-state', httpStatus: 422 },
  refund_exceeds_amount: { code: 'NOT_VALID', httpStatus: 400 },
  insufficient_funds: { code: 'balance.payment-option-unavailable', httpStatus: 422 },
  balance_insufficient: { code: 'balance.payment-option-unavailable', httpStatus: 422 },
  rate_limited: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 },
  unsupported_operation: { code: 'payment.option-unavailable', httpStatus: 422 },
  transaction_timeout: { code: 'unexpected.error', httpStatus: 504 },
  provider_error: { code: 'unexpected.error', httpStatus: 502 },
  network_error: { code: 'unexpected.error', httpStatus: 503 },
};

export interface SchemaIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

export function schemaIssues(error: unknown): SchemaIssue[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { name?: unknown; issues?: unknown };
  if (candidate.name !== 'ZodError' || !Array.isArray(candidate.issues)) return null;
  return candidate.issues as SchemaIssue[];
}

export interface WiseErrorResponse {
  status: number;
  body: {
    timestamp: string;
    errors: { code: string; message: string; path?: string; arguments?: string[] }[];
    paybox_code?: string;
  };
}

export interface WiseErrorOptions {
  /** ISO instant. Passed in, never read from a clock here (spec §7). */
  now: string;
}

export function toWiseError(error: unknown, options: WiseErrorOptions): WiseErrorResponse {
  const timestamp = options.now;

  // Wise's validation envelope carries one entry per offending field, which is
  // more useful than a single message and is what its own clients render.
  const issues = schemaIssues(error);
  if (issues) {
    return {
      status: 400,
      body: {
        timestamp,
        errors: issues.map((issue) => ({
          code: 'NOT_VALID',
          message: issue.message,
          path: issue.path.join('.') || 'body',
        })),
        paybox_code: 'validation_failed',
      },
    };
  }

  if (error instanceof PayboxError) {
    // An adapter may name a Wise code directly where it is more specific than
    // anything the canonical vocabulary carries.
    const explicit = error.details.wiseCode;
    const shape = ERRORS[error.code] ?? { code: 'NOT_VALID', httpStatus: 400 };
    const code = typeof explicit === 'string' ? explicit : shape.code;
    const path = typeof error.details.field === 'string' ? error.details.field : undefined;
    return {
      status: shape.httpStatus,
      body: {
        timestamp,
        errors: [{ code, message: error.message, ...(path ? { path } : {}) }],
        paybox_code: error.code,
      },
    };
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  return {
    status: 500,
    body: { timestamp, errors: [{ code: 'unexpected.error', message }] },
  };
}
