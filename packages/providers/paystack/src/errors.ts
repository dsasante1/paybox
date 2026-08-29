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
  balance_insufficient: 400,
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
  /** Set by zod 3; zod 4 reports the absence inside `errors` instead. */
  received?: unknown;
  /** Nested issues, one array per branch of a union. */
  errors?: SchemaIssue[][];
}

export function schemaIssues(error: unknown): SchemaIssue[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { name?: unknown; issues?: unknown };
  if (candidate.name !== 'ZodError' || !Array.isArray(candidate.issues)) return null;
  return candidate.issues as SchemaIssue[];
}

/** Dotted path of the field a schema issue is about, e.g. `items.0.price`. */
export function issueParam(issue: SchemaIssue | undefined): string | null {
  const path = issue?.path ?? [];
  return path.length > 0 ? path.join('.') : null;
}

/**
 * Whether the field was absent rather than merely wrong.
 *
 * Best-effort, and deliberately checked two ways: zod 3 puts `received` on the
 * issue, while zod 4 reports the absence only inside the per-branch `errors`
 * of a union -- which is exactly the shape a coerced field like `amount`
 * produces. Getting it wrong costs a slightly less precise error code, never
 * the wrong status.
 */
export function issueIsMissing(issue: SchemaIssue | undefined): boolean {
  if (!issue) return false;
  if (issue.received === 'undefined') return true;
  const nested = (issue.errors ?? []).flat();
  return [issue, ...nested].some((entry) => /received undefined/i.test(entry.message ?? ''));
}

export function toPaystackError(error: unknown): PaystackErrorResponse {
  // Same reasoning as the Stripe adapter: a schema rejection is a bad request,
  // and answering it with a 500 sends a developer to debug the emulator
  // instead of their own payload.
  const issues = schemaIssues(error);
  if (issues) {
    const first = issues[0];
    const param = issueParam(first);
    return {
      status: 400,
      body: fail(
        param ? `Invalid parameter: ${param}. ${first?.message ?? ''}`.trim() : 'Invalid request.',
        { code: 'validation_failed', ...(param ? { meta: { param } } : {}) },
      ) as PaystackErrorResponse['body'],
    };
  }

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
