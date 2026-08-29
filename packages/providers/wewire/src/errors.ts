import { PayboxError, type ErrorCode } from '@paybox/shared';

/**
 * Canonical error -> WeWire wire format (spec §30).
 *
 * WeWire answers with `{ success: false, error: { code, message, statusCode,
 * details? } }`, and its documentation is explicit that `success` is the
 * single source of truth: *"If `success` is missing or `true`, treat the
 * response as a success regardless of status."* Verified at
 * docs.wewire.com/working-with-the-api/errors (read 2026-08-29).
 *
 * That is a fourth distinct envelope across five providers — Paystack's
 * boolean `status`, Flutterwave v3's string `status`, Stripe's bare
 * `{error:{…}}`, WeWire's `{success:false,error:{…}}` — which is exactly why
 * each adapter owns its own mapping and none of it reaches the engine.
 */
interface WewireShape {
  code: string;
  httpStatus: number;
}

/**
 * Canonical code -> WeWire's own code, transcribed from its error table.
 *
 * Where WeWire has a more specific code than the canonical vocabulary, the
 * adapter reaches for it: a payout that outruns the wallet is
 * `INSUFFICIENT_BALANCE`, not a generic validation failure, because that is
 * what a client's `switch` will be written against.
 */
const ERRORS: Partial<Record<ErrorCode, WewireShape>> = {
  authentication_failed: { code: 'AUTH_INVALID_CREDENTIALS', httpStatus: 401 },
  safety_violation: { code: 'AUTH_FORBIDDEN', httpStatus: 403 },
  not_found: { code: 'RESOURCE_NOT_FOUND', httpStatus: 404 },
  validation_failed: { code: 'VALIDATION_FAILED', httpStatus: 400 },
  invalid_request: { code: 'VALIDATION_FAILED', httpStatus: 400 },
  unsupported_currency: { code: 'CURRENCY_NOT_SUPPORTED', httpStatus: 400 },
  duplicate_reference: { code: 'RESOURCE_ALREADY_EXISTS', httpStatus: 409 },
  idempotency_conflict: { code: 'RESOURCE_ALREADY_EXISTS', httpStatus: 409 },
  invalid_state_transition: { code: 'VALIDATION_FAILED', httpStatus: 400 },
  refund_exceeds_amount: { code: 'VALIDATION_FAILED', httpStatus: 400 },
  insufficient_funds: { code: 'INSUFFICIENT_BALANCE', httpStatus: 400 },
  balance_insufficient: { code: 'INSUFFICIENT_BALANCE', httpStatus: 400 },
  rate_limited: { code: 'RATE_LIMIT_EXCEEDED', httpStatus: 429 },
  unsupported_operation: { code: 'SETTLEMENT_METHOD_NOT_SUPPORTED', httpStatus: 400 },
  transaction_timeout: { code: 'INTEGRATION_TIMEOUT', httpStatus: 504 },
  provider_error: { code: 'INTEGRATION_ERROR', httpStatus: 502 },
  network_error: { code: 'INTEGRATION_UNAVAILABLE', httpStatus: 503 },
};

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

export interface WewireErrorResponse {
  status: number;
  body: {
    success: false;
    error: {
      code: string;
      message: string;
      statusCode: number;
      details?: { field: string; message: string }[];
      paybox_code?: string;
    };
  };
}

function fail(
  code: string,
  statusCode: number,
  message: string,
  extra: Partial<WewireErrorResponse['body']['error']> = {},
): WewireErrorResponse {
  return {
    status: statusCode,
    body: { success: false, error: { code, message, statusCode, ...extra } },
  };
}

export function toWewireError(error: unknown): WewireErrorResponse {
  // WeWire's validation errors carry one `details` entry per offending field,
  // which is more useful than a single message and is what its own clients
  // render. Zod already knows every field that failed, so all of them go.
  const issues = schemaIssues(error);
  if (issues) {
    return fail('VALIDATION_FAILED', 400, 'Invalid request body', {
      details: issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
      paybox_code: 'validation_failed',
    });
  }

  if (error instanceof PayboxError) {
    // An adapter may name WeWire's code directly where it is more specific
    // than anything the canonical vocabulary carries.
    const explicit = error.details.wewireCode;
    const shape = ERRORS[error.code] ?? { code: 'VALIDATION_FAILED', httpStatus: 400 };
    const code = typeof explicit === 'string' ? explicit : shape.code;
    return fail(code, shape.httpStatus, error.message, { paybox_code: error.code });
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  return fail('INTERNAL_ERROR', 500, message);
}
