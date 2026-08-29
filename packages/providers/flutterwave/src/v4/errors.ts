import { PayboxError, type ErrorCode } from '@paybox/shared';
import { schemaIssues } from '../errors.js';

/**
 * Canonical error -> Flutterwave v4 wire format.
 *
 * v4 answers with `{ status: "failed", error: { type, code, message } }`,
 * where `type` is an uppercase slug and `code` a five-digit string --
 * completely unlike v3's `{status:"error", message, data}`. Verified against
 * the 401 example at developer.flutterwave.com/docs/api-headers (read
 * 2026-08-29), which shows `{"type":"UNAUTHORIZED","code":"10401"}`.
 *
 * Two versions of one provider answering errors in two different shapes is
 * exactly why each adapter owns its own mapping (spec §30).
 */
interface V4Shape {
  type: string;
  code: string;
  httpStatus: number;
}

const ERRORS: Partial<Record<ErrorCode, V4Shape>> = {
  authentication_failed: { type: 'UNAUTHORIZED', code: '10401', httpStatus: 401 },
  safety_violation: { type: 'FORBIDDEN', code: '10403', httpStatus: 403 },
  not_found: { type: 'NOT_FOUND', code: '10404', httpStatus: 404 },
  validation_failed: { type: 'VALIDATION_ERROR', code: '10400', httpStatus: 400 },
  invalid_request: { type: 'BAD_REQUEST', code: '10400', httpStatus: 400 },
  unsupported_currency: { type: 'VALIDATION_ERROR', code: '10400', httpStatus: 400 },
  duplicate_reference: { type: 'DUPLICATE_REQUEST', code: '10409', httpStatus: 409 },
  idempotency_conflict: { type: 'DUPLICATE_REQUEST', code: '10409', httpStatus: 409 },
  invalid_state_transition: { type: 'INVALID_STATE', code: '10400', httpStatus: 400 },
  refund_exceeds_amount: { type: 'VALIDATION_ERROR', code: '10400', httpStatus: 400 },
  insufficient_funds: { type: 'INSUFFICIENT_FUNDS', code: '10402', httpStatus: 402 },
  balance_insufficient: { type: 'INSUFFICIENT_FUNDS', code: '10402', httpStatus: 402 },
  rate_limited: { type: 'TOO_MANY_REQUESTS', code: '10429', httpStatus: 429 },
  unsupported_operation: { type: 'NOT_IMPLEMENTED', code: '10501', httpStatus: 400 },
  transaction_timeout: { type: 'TIMEOUT', code: '10504', httpStatus: 504 },
  provider_error: { type: 'SERVER_ERROR', code: '10500', httpStatus: 502 },
  network_error: { type: 'SERVER_ERROR', code: '10500', httpStatus: 502 },
};

export interface V4ErrorResponse {
  status: number;
  body: { status: 'failed'; error: Record<string, unknown> };
}

function fail(type: string, code: string, message: string, extra?: Record<string, unknown>) {
  return {
    status: 'failed' as const,
    error: { type, code, message, ...(extra ?? {}) },
  };
}

export function toV4Error(error: unknown): V4ErrorResponse {
  const issues = schemaIssues(error);
  if (issues) {
    const first = issues[0];
    const path = (first?.path ?? []).join('.');
    return {
      status: 400,
      body: fail(
        'VALIDATION_ERROR',
        '10400',
        path ? `Invalid parameter: ${path}. ${first?.message ?? ''}`.trim() : 'Invalid request.',
        path ? { field: path } : undefined,
      ),
    };
  }

  if (error instanceof PayboxError) {
    const shape = ERRORS[error.code] ?? {
      type: 'BAD_REQUEST',
      code: '10400',
      httpStatus: 400,
    };
    return {
      status: shape.httpStatus,
      body: fail(shape.type, shape.code, error.message, {
        // The canonical code, so an emulator-specific rejection is
        // distinguishable from a genuine Flutterwave-shaped one.
        paybox_code: error.code,
        ...(Object.keys(error.details).length > 0 ? { paybox_details: error.details } : {}),
      }),
    };
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  return { status: 500, body: fail('SERVER_ERROR', '10500', message) };
}
