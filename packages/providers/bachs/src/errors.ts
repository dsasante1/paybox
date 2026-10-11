import { PayboxError, type ErrorCode } from '@paybox/shared';

/**
 * Canonical error -> Bachs wire format (spec §30).
 *
 * Bachs answers every failure with one flat object:
 *
 *   { "detail": "Product not found", "error_code": "NOT_FOUND",
 *     "doc_url": "https://docs.bachs.io/api-reference/error-reference#general" }
 *
 * plus `errors[]` on some validation failures and `details` on limit errors
 * (docs.bachs.io/errors, read 2026-10-10). Clients are told to "branch on
 * `error_code`, which is stable, rather than on `detail`", so the codes here
 * are taken from the published error reference and nowhere else, with the
 * HTTP status the reference gives each one.
 */
const DOCS = 'https://docs.bachs.io/api-reference/error-reference';

/** Every code this adapter can emit, with its documented status and section. */
const CODES = {
  BAD_REQUEST: [400, 'general'],
  UNAUTHORIZED: [401, 'general'],
  FORBIDDEN: [403, 'general'],
  NOT_FOUND: [404, 'general'],
  INSUFFICIENT_BALANCE: [400, 'general'],
  IDEMPOTENCY_IN_PROGRESS: [409, 'general'],
  // In the idempotency guide but missing from the error reference; recorded
  // in docs/bachs.md. No section to link, so no doc_url.
  IDEMPOTENCY_CONFLICT: [409, null],
  CONFLICT: [409, 'general'],
  VALIDATION_ERROR: [400, 'general'],
  VALIDATION_FAILED: [422, 'general'],
  TOO_MANY_REQUESTS: [429, 'general'],
  IMMUTABLE_FIELD: [400, 'general'],
  INTERNAL_SERVER_ERROR: [500, 'general'],
  NOT_IMPLEMENTED: [501, 'general'],
  BAD_GATEWAY: [502, 'general'],
  SERVICE_UNAVAILABLE: [503, 'general'],
  PAYMENT_ERROR: [400, 'payments'],
  PAYMENT_METHOD_NOT_ENABLED: [400, 'payments'],
  NO_SAVED_PAYMENT_METHOD: [400, 'payments'],
  SAVED_PAYMENT_METHOD_NOT_FOUND: [404, 'payments'],
  PAYMENT_METHOD_UNUSABLE: [400, 'payments'],
  CHECKOUT_CANNOT_SAVE_PAYMENT_METHOD: [400, 'payments'],
  PRODUCT_NOT_FOUND: [400, 'products-&-prices'],
  PRODUCT_NO_PRICE: [400, 'products-&-prices'],
  PRODUCT_ARCHIVED: [400, 'products-&-prices'],
  UNSUPPORTED_CURRENCY: [400, 'products-&-prices'],
  INTERVAL_REQUIRED: [400, 'products-&-prices'],
  RECURRING_INTERVAL_IMMUTABLE: [400, 'products-&-prices'],
  TRIAL_REQUIRES_RECURRING: [400, 'products-&-prices'],
  METADATA_LIMIT_EXCEEDED: [400, 'products-&-prices'],
  DUPLICATE_CURRENCY: [400, 'products-&-prices'],
  ENVIRONMENT_MISMATCH: [400, 'products-&-prices'],
  INVALID_PRODUCT_REFERENCE: [400, 'products-&-prices'],
  INVALID_UPLOAD_REFERENCE: [400, 'products-&-prices'],
  MEDIA_LIMIT_EXCEEDED: [400, 'products-&-prices'],
  CHECKOUT_ERROR: [400, 'checkout-sessions'],
  CUSTOM_AMOUNT_REQUIRED: [400, 'checkout-sessions'],
  FIXED_AMOUNT_OVERRIDE_NOT_ALLOWED: [400, 'checkout-sessions'],
  PAYMENT_METHOD_NOT_ALLOWED: [400, 'checkout-sessions'],
  CHECKOUT_HAS_NO_PAYMENT_METHOD: [400, 'checkout-sessions'],
  CHECKOUT_RESTRICTION_LEAVES_NO_PAYMENT_METHOD: [400, 'checkout-sessions'],
  CART_CURRENCY_MISMATCH: [400, 'checkout-sessions'],
  BASE_CURRENCY_NOT_COLLECTIBLE: [422, 'checkout-sessions'],
  BILLING_CURRENCY_NOT_AVAILABLE: [400, 'checkout-sessions'],
  BILLING_CURRENCY_HAS_NO_PAYMENT_METHOD: [400, 'checkout-sessions'],
  BASE_CURRENCY_NOT_HELD_BY_ORG: [422, 'checkout-sessions'],
  NGN_SUBSCRIPTIONS_NOT_ENABLED: [403, 'subscriptions-limited-access'],
  SUBSCRIPTION_ALREADY_CANCELED: [400, 'subscriptions-limited-access'],
  SUBSCRIPTION_NOT_MODIFIABLE: [400, 'subscriptions-limited-access'],
  SUBSCRIPTION_NOT_TRIALING: [400, 'subscriptions-limited-access'],
  INVALID_SUBSCRIPTION_PRICE: [400, 'subscriptions-limited-access'],
  SUBSCRIPTION_PRICE_NOT_RECURRING: [400, 'subscriptions-limited-access'],
  SUBSCRIPTION_REQUIRES_CATALOG_PRODUCT: [400, 'subscriptions-limited-access'],
  SUBSCRIPTION_METHOD_NOT_SUPPORTED: [400, 'subscriptions-limited-access'],
  PLAN_NOT_PRICED_IN_CURRENCY: [400, 'subscriptions-limited-access'],
  SUBSCRIPTION_PLAN_INTERVAL_MISMATCH: [400, 'subscriptions-limited-access'],
  PRORATION_BEHAVIOR_NOT_SUPPORTED: [400, 'subscriptions-limited-access'],
  PAYOUTS_NOT_ENABLED: [400, 'payouts'],
  PAYOUT_CURRENCY_NOT_ENABLED: [400, 'payouts'],
  PAYOUT_SOURCE_CURRENCY_UNSUPPORTED: [400, 'payouts'],
  ORGANIZATION_IN_DEBT: [400, 'payouts'],
  PAYOUT_DESTINATION_NOT_FOUND: [404, 'payouts'],
  PAYOUT_DESTINATION_NOT_APPROVED: [400, 'payouts'],
  PAYOUT_DESTINATION_INACTIVE: [400, 'payouts'],
  DESTINATION_TYPE_REQUIRED: [400, 'payouts'],
  CURRENCY_NOT_SUPPORTED: [400, 'payouts'],
  BANK_ROUTING_DETAILS_INVALID: [400, 'payouts'],
  DESTINATION_NOT_FOUND: [404, 'payouts'],
  DESTINATION_PENDING_REVIEW: [400, 'payouts'],
  DESTINATION_REJECTED: [400, 'payouts'],
  AMOUNT_REQUIRED: [400, 'payouts'],
  AMOUNT_NOT_ALLOWED_WITH_QUOTE: [400, 'payouts'],
  QUOTE_REQUIRED: [400, 'payouts'],
  QUOTE_NOT_APPLICABLE: [400, 'payouts'],
  QUOTE_NOT_FOUND: [400, 'payouts'],
  QUOTE_EXPIRED: [400, 'payouts'],
  QUOTE_DESTINATION_MISMATCH: [400, 'payouts'],
  QUOTE_ERROR: [400, 'quotes-limited-access'],
  VIRTUAL_ACCOUNT_CURRENCY_NOT_SUPPORTED: [400, 'virtual-accounts'],
  DEPOSIT_LIMIT_EXCEEDED: [400, 'deposits'],
  UNSUPPORTED_DEPOSIT_CURRENCY: [400, 'deposits'],
  // Both in the disputes guide (guides/disputes/overview) and missing from the
  // error reference, like IDEMPOTENCY_CONFLICT; recorded in docs/bachs.md.
  DISPUTE_NOT_EDITABLE: [409, null],
  DEADLINE_PASSED: [410, null],
} as const satisfies Record<string, readonly [number, string | null]>;

export type BachsErrorCode = keyof typeof CODES;

export interface BachsErrorBody {
  detail: string;
  error_code: BachsErrorCode;
  doc_url?: string;
  errors?: Array<{ field: string; message: string; type: string }>;
  details?: Record<string, unknown>;
}

export interface BachsErrorResponse {
  status: number;
  body: BachsErrorBody;
}

/** Canonical code -> the Bachs code used when a route did not name one. */
const CANONICAL: Partial<Record<ErrorCode, BachsErrorCode>> = {
  invalid_request: 'BAD_REQUEST',
  validation_failed: 'VALIDATION_ERROR',
  authentication_failed: 'UNAUTHORIZED',
  safety_violation: 'UNAUTHORIZED',
  not_found: 'NOT_FOUND',
  duplicate_reference: 'CONFLICT',
  idempotency_conflict: 'IDEMPOTENCY_CONFLICT',
  invalid_state_transition: 'CONFLICT',
  refund_exceeds_amount: 'BAD_REQUEST',
  balance_insufficient: 'INSUFFICIENT_BALANCE',
  unsupported_currency: 'UNSUPPORTED_CURRENCY',
  unsupported_operation: 'NOT_IMPLEMENTED',
  rate_limited: 'TOO_MANY_REQUESTS',
  provider_error: 'BAD_GATEWAY',
  network_error: 'BAD_GATEWAY',
};

export function bachsErrorBody(
  code: BachsErrorCode,
  detail: string,
  extra: Partial<Pick<BachsErrorBody, 'errors' | 'details'>> = {},
): BachsErrorBody {
  const section = CODES[code][1];
  return {
    detail,
    error_code: code,
    ...(section ? { doc_url: `${DOCS}#${section}` } : {}),
    ...extra,
  };
}

/**
 * Raise a coded Bachs error from inside a route.
 *
 * The wire code travels on `details.bachsCode`, so the canonical taxonomy
 * stays the engine's and the wire code stays the adapter's -- the split every
 * adapter here uses.
 */
export function fail(
  canonical: ErrorCode,
  code: BachsErrorCode,
  detail: string,
  details: Record<string, unknown> = {},
): PayboxError {
  return new PayboxError(canonical, detail, { details: { ...details, bachsCode: code } });
}

interface Issue {
  code: string;
  path: PropertyKey[];
  message: string;
  input?: unknown;
  expected?: string;
}

function schemaIssues(error: unknown): Issue[] | null {
  if (
    error &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  ) {
    return (error as { issues: Issue[] }).issues;
  }
  return null;
}

/**
 * Zod's issues in Bachs' validation shape.
 *
 * The documented example is FastAPI's: `{ "field": "name", "message": "Field
 * required", "type": "missing" }`, and a `detail` that names every missing
 * field at once ("Missing required field(s): name, price"). A missing field is
 * reproduced exactly; any other failure keeps the schema's own message under
 * the field name, which is the shape of Bachs' second documented example
 * ("price: amount is required for a fixed price.").
 */
function validationError(issues: Issue[]): BachsErrorResponse {
  const errors = issues.map((issue) => {
    const field = issue.path.map(String).join('.') || 'body';
    const missing = issue.code === 'invalid_type' && issue.input === undefined;
    return missing
      ? { field, message: 'Field required', type: 'missing' }
      : { field, message: issue.message, type: issue.code === 'custom' ? 'value_error' : issue.code };
  });
  const missing = errors.filter((entry) => entry.type === 'missing').map((entry) => entry.field);
  const first = errors[0]!;
  const detail =
    missing.length === errors.length
      ? `Missing required field(s): ${missing.join(', ')}`
      : `${first.field}: ${first.message}`;
  return { status: 400, body: bachsErrorBody('VALIDATION_ERROR', detail, { errors }) };
}

export function toBachsError(error: unknown): BachsErrorResponse {
  const issues = schemaIssues(error);
  if (issues && issues.length > 0) return validationError(issues);

  if (error instanceof PayboxError) {
    const declared = error.details.bachsCode;
    const code: BachsErrorCode =
      typeof declared === 'string' && declared in CODES
        ? (declared as BachsErrorCode)
        : (CANONICAL[error.code] ?? 'BAD_REQUEST');
    const extra: Partial<Pick<BachsErrorBody, 'details' | 'errors'>> = {};
    if (error.details.limit && typeof error.details.limit === 'object') {
      extra.details = error.details.limit as Record<string, unknown>;
    }
    return { status: CODES[code][0], body: bachsErrorBody(code, error.message, extra) };
  }

  // Fastify's own failures: a malformed JSON body, an unsupported media type.
  const status = (error as { statusCode?: number } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const message = error instanceof Error ? error.message : 'Bad request';
    return { status: 400, body: bachsErrorBody('BAD_REQUEST', message) };
  }

  return {
    status: 500,
    body: bachsErrorBody('INTERNAL_SERVER_ERROR', 'Internal server error'),
  };
}
