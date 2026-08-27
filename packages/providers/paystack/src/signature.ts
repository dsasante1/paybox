import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paystack webhook signing.
 *
 * Verified against Paystack's webhook documentation (fetched 2026-08-27):
 * events carry an `x-paystack-signature` header containing an HMAC-SHA512 of
 * the raw event payload, keyed with the integration's secret key.
 *
 * We sign the exact bytes we are about to send, never a re-serialised object.
 * The single most common real-world Paystack integration bug is a framework
 * that re-encodes the body before the developer can hash it -- this emulator
 * should reproduce the provider's behaviour faithfully so that bug shows up
 * locally, not introduce a second version of it.
 */
export const PAYSTACK_SIGNATURE_HEADER = 'x-paystack-signature';

export function signPaystackPayload(rawBody: string, secretKey: string): string {
  return createHmac('sha512', secretKey).update(rawBody, 'utf8').digest('hex');
}

export function paystackSignatureHeaders(
  rawBody: string,
  secretKey: string,
): Record<string, string> {
  return { [PAYSTACK_SIGNATURE_HEADER]: signPaystackPayload(rawBody, secretKey) };
}

/** Constant-time comparison, provided so the bundled examples model it right. */
export function verifyPaystackSignature(
  rawBody: string,
  secretKey: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signPaystackPayload(rawBody, secretKey), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
