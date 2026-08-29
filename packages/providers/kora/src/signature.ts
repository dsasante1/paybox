import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Kora webhook verification.
 *
 * `x-korapay-signature` is a hex HMAC-SHA256 of **only the `data` object** of
 * the payload, signed with the merchant's secret key. Verified at
 * developers.korapay.com/docs/webhooks (read 2026-08-29), whose reference
 * implementation is:
 *
 *   crypto.createHmac('sha256', secretKey)
 *         .update(JSON.stringify(req.body.data))
 *         .digest('hex')
 *
 * Signing only `data` has a consequence worth knowing: the `event` field is
 * **not covered by the signature**. A valid `data` object replayed under a
 * different event name would still verify. paybox reproduces the scheme
 * exactly -- a developer who discovers that here has learned something true
 * about their production integration -- and docs/kora.md states it plainly
 * rather than quietly signing the whole body and hiding it.
 */
export const KORA_SIGNATURE_HEADER = 'x-korapay-signature';

/** Sign the `data` object exactly as Kora does. */
export function signKoraData(data: unknown, secretKey: string): string {
  return createHmac('sha256', secretKey).update(JSON.stringify(data)).digest('hex');
}

/**
 * Sign a serialised webhook body by extracting its `data`.
 *
 * The dispatcher hands formatters the exact bytes being sent; Kora signs a
 * sub-object of them, so the body is parsed back to find it. Falls back to
 * signing the whole body if there is no `data` -- better a signature that
 * fails to verify than one silently computed over the wrong thing.
 */
export function signKoraPayload(rawBody: string, secretKey: string): string {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed === 'object' && parsed !== null && 'data' in parsed) {
      return signKoraData((parsed as { data: unknown }).data, secretKey);
    }
  } catch {
    // fall through
  }
  return createHmac('sha256', secretKey).update(rawBody).digest('hex');
}

export function koraSignatureHeaders(
  rawBody: string,
  secretKey: string,
): Record<string, string> {
  return { [KORA_SIGNATURE_HEADER]: signKoraPayload(rawBody, secretKey) };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyKoraSignature(
  data: unknown,
  header: string | undefined,
  secretKey: string,
): boolean {
  return typeof header === 'string' && safeEqual(header, signKoraData(data, secretKey));
}
