import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Quid Payments webhook verification.
 *
 * Three headers, verified at `docs.quiddpayments.com/webhooks` and in the
 * `MerchantWebhookSignatureHeader` component of the published OpenAPI document
 * (contract `2026-06`, both read 2026-09-15):
 *
 *   X-Payment-Platform-Event-Id     opaque id, stable across retries
 *   X-Payment-Platform-Event-Type   the event name, also present in the body
 *   X-Payment-Platform-Signature    `t=<unix_seconds>,v1=<hex HMAC-SHA256>`
 *
 * The signed content is `<t>.<raw_request_body>` under the endpoint's signing
 * secret — the same construction Stripe uses, and for the same reason: the
 * timestamp is inside the MAC, so a captured delivery cannot be replayed with
 * a fresh one. Quid documents a 300-second tolerance.
 *
 * Signing the **raw** body is load-bearing and Quid says so twice ("Capture
 * the raw request body before JSON parsing"). A verifier that re-serialises
 * the parsed object will pass here whenever key order and whitespace happen to
 * survive the round trip and fail in production when they do not — so paybox
 * signs the exact bytes it sends and nothing else.
 */
export const QUIDDPAY_SIGNATURE_HEADER = 'x-payment-platform-signature';
export const QUIDDPAY_EVENT_ID_HEADER = 'x-payment-platform-event-id';
export const QUIDDPAY_EVENT_TYPE_HEADER = 'x-payment-platform-event-type';

/** Quid's documented replay window, in seconds. */
export const QUIDDPAY_TOLERANCE_SECONDS = 300;

/** `<t>.<raw_request_body>` — the exact bytes the MAC covers. */
export function quiddpaySignedContent(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`;
}

export function signQuiddpayPayload(
  rawBody: string,
  secret: string,
  timestampSeconds: number,
): string {
  return createHmac('sha256', secret)
    .update(quiddpaySignedContent(timestampSeconds, rawBody))
    .digest('hex');
}

/**
 * The signature header for one delivery attempt.
 *
 * `timestampMs` is the virtual-time instant of *this attempt*, handed in by
 * the dispatcher, so a retry after `paybox time advance 10m` carries a fresh
 * timestamp and a fresh MAC — which is what makes a consumer's tolerance check
 * worth testing rather than something the emulator quietly sidesteps.
 */
export function quiddpaySignatureHeaders(
  rawBody: string,
  secret: string,
  timestampMs: number,
): Record<string, string> {
  const timestamp = Math.floor(timestampMs / 1000);
  return {
    [QUIDDPAY_SIGNATURE_HEADER]: `t=${timestamp},v1=${signQuiddpayPayload(
      rawBody,
      secret,
      timestamp,
    )}`,
  };
}

/** `t=…,v1=…` parsed into its parts. Returns null for anything malformed. */
export function parseQuiddpaySignature(
  header: string | undefined,
): { timestamp: number; signature: string } | null {
  if (typeof header !== 'string') return null;
  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const part of header.split(',')) {
    const [key, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (key === 't') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) timestamp = seconds;
    }
    if (key === 'v1') signature = value;
  }
  if (timestamp === null || signature === null) return null;
  return { timestamp, signature };
}

export interface QuiddpayVerifyOptions {
  /** Current time in ms. Passed in — never read from a clock here (spec §7). */
  now: number;
  toleranceSeconds?: number;
}

/**
 * Verify a delivery the way Quid's own checklist says a consumer should.
 *
 * Tolerance first, then a constant-time comparison. Available to anyone
 * writing a verifier against the emulator, and used by paybox's own tests.
 */
export function verifyQuiddpaySignature(
  header: string | undefined,
  rawBody: string,
  secret: string,
  options: QuiddpayVerifyOptions,
): boolean {
  const parsed = parseQuiddpaySignature(header);
  if (!parsed) return false;

  const tolerance = options.toleranceSeconds ?? QUIDDPAY_TOLERANCE_SECONDS;
  if (Math.abs(Math.floor(options.now / 1000) - parsed.timestamp) > tolerance) return false;

  const expected = signQuiddpayPayload(rawBody, secret, parsed.timestamp);
  const a = Buffer.from(parsed.signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
