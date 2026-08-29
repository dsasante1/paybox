/**
 * Canonical error taxonomy (spec §3, §30).
 *
 * The engine only ever raises these. Each provider adapter owns the mapping
 * from a canonical code to that provider's wire format -- Paystack's
 * `{status: false, message}`, Stripe's `{error: {type, code}}`, and so on.
 * Keeping provider error shapes out of the engine is what stops provider
 * logic leaking into core.
 */
export const ERROR_CODES = [
  'invalid_request',
  'validation_failed',
  'authentication_failed',
  'not_found',
  'duplicate_reference',
  'idempotency_conflict',
  'invalid_state_transition',
  'refund_exceeds_amount',
  'insufficient_funds',
  // Distinct from insufficient_funds, which is a *card* decline. This is the
  // merchant's own balance being too small to cover a payout or a transfer --
  // a different failure, reported differently by both providers, and one no
  // customer can fix.
  'balance_insufficient',
  'card_declined',
  'expired_card',
  'authentication_required',
  'authorization_rejected',
  'transaction_timeout',
  'provider_error',
  'network_error',
  'unsupported_currency',
  'unsupported_operation',
  'rate_limited',
  'safety_violation',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface PayboxErrorOptions {
  /** HTTP status the API boundary should use if the adapter has no opinion. */
  httpStatus?: number;
  /** Machine-readable extras surfaced in the dashboard and structured logs. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class PayboxError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: PayboxErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'PayboxError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? defaultHttpStatus(code);
    this.details = options.details ?? {};
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

function defaultHttpStatus(code: ErrorCode): number {
  switch (code) {
    case 'authentication_failed':
      return 401;
    case 'not_found':
      return 404;
    case 'duplicate_reference':
    case 'idempotency_conflict':
    case 'invalid_state_transition':
      return 409;
    case 'validation_failed':
    case 'invalid_request':
    case 'refund_exceeds_amount':
    case 'unsupported_currency':
      return 400;
    case 'unsupported_operation':
      return 501;
    case 'rate_limited':
      return 429;
    case 'safety_violation':
      return 403;
    case 'provider_error':
    case 'network_error':
      return 502;
    default:
      // Declines and other payment-outcome codes are not transport errors:
      // the request succeeded, the payment did not.
      return 200;
  }
}
