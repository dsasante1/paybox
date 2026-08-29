import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Flutterwave webhook verification.
 *
 * The two live API versions do this completely differently, and the emulator
 * reproduces both rather than picking the better one -- a developer's
 * verification code has to work here unchanged, and half of them are on v3.
 *
 * **v3** sends `verif-hash`, which is the merchant's secret hash *verbatim*.
 * There is no HMAC and no signing of the body at all: the receiver compares
 * the header to the value they configured. Verified at
 * developer.flutterwave.com/v3.0.0/docs/webhooks (read 2026-08-29), whose
 * reference implementation is `signature !== secretHash`.
 *
 * That is a weak scheme -- it proves only that the sender knows a shared
 * secret, not that this particular body came from Flutterwave, and it cannot
 * detect tampering or replay. paybox reproduces it faithfully anyway, because
 * a developer who discovers that property here has learned something true
 * about their production integration. docs/flutterwave.md says so plainly.
 *
 * **v4** sends `flutterwave-signature`: HMAC-SHA256 over the raw body under
 * the secret hash, **base64**-encoded. Verified at
 * developer.flutterwave.com/docs/webhooks (read 2026-08-29).
 */

export const V3_SIGNATURE_HEADER = 'verif-hash';
export const V4_SIGNATURE_HEADER = 'flutterwave-signature';

/** v3: the header *is* the secret. */
export function v3SignatureHeaders(secret: string): Record<string, string> {
  return { [V3_SIGNATURE_HEADER]: secret };
}

/** v4: base64 HMAC-SHA256 of the exact bytes sent. */
export function signV4Payload(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

export function v4SignatureHeaders(rawBody: string, secret: string): Record<string, string> {
  return { [V4_SIGNATURE_HEADER]: signV4Payload(rawBody, secret) };
}

/** Constant-time compare, so a verifier here cannot leak the secret by timing. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyV3Signature(header: string | undefined, secret: string): boolean {
  return typeof header === 'string' && safeEqual(header, secret);
}

export function verifyV4Signature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  return typeof header === 'string' && safeEqual(header, signV4Payload(rawBody, secret));
}
