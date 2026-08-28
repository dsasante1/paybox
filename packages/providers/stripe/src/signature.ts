import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe webhook signatures.
 *
 * `Stripe-Signature: t=<unix seconds>,v1=<hex hmac>` where the HMAC is
 * SHA-256 over `${t}.${payload}` keyed with the endpoint's signing secret.
 * The timestamp is part of the signed material specifically so it cannot be
 * altered without invalidating the signature. Verified against
 * docs.stripe.com/webhooks, read 2026-08-28.
 *
 * Stripe's libraries reject a signature whose timestamp is more than five
 * minutes old, and Stripe regenerates both on every delivery attempt -- which
 * is why the dispatcher re-signs per attempt rather than replaying stored
 * headers. See docs/architecture.md.
 */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

/** Stripe's documented default tolerance, in seconds. */
export const STRIPE_DEFAULT_TOLERANCE_SECONDS = 300;

export function signStripePayload(
  rawBody: string,
  secret: string,
  timestampSeconds: number,
): string {
  return createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
}

export function stripeSignatureHeaders(
  rawBody: string,
  secret: string,
  timestampMs: number,
): Record<string, string> {
  const seconds = Math.floor(timestampMs / 1000);
  return {
    [STRIPE_SIGNATURE_HEADER]: `t=${seconds},v1=${signStripePayload(rawBody, secret, seconds)}`,
  };
}

export interface VerifyOptions {
  /** Reject a signature older than this. Zero disables the check. */
  toleranceSeconds?: number;
  /** Virtual "now" in milliseconds. Required for the recency check. */
  nowMs?: number;
}

/**
 * Verify a `Stripe-Signature` header.
 *
 * Provided so a developer can check the emulator's own signatures with the
 * same algorithm their SDK uses, and so the test suite can assert it rather
 * than trusting the producer.
 */
export function verifyStripeSignature(
  rawBody: string,
  secret: string,
  header: string,
  options: VerifyOptions = {},
): boolean {
  const parts = new Map(
    header
      .split(',')
      .map((piece) => piece.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([k, v]) => [k!, v!]),
  );

  const timestamp = Number(parts.get('t'));
  const provided = parts.get('v1');
  if (!Number.isFinite(timestamp) || !provided) return false;

  const tolerance = options.toleranceSeconds ?? STRIPE_DEFAULT_TOLERANCE_SECONDS;
  if (tolerance > 0 && options.nowMs !== undefined) {
    const ageSeconds = Math.abs(Math.floor(options.nowMs / 1000) - timestamp);
    if (ageSeconds > tolerance) return false;
  }

  const expected = signStripePayload(rawBody, secret, timestamp);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a length mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}
