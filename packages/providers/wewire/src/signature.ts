import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WeWire webhook verification — the Standard Webhooks specification.
 *
 * WeWire is the first provider in paybox that does not roll its own scheme.
 * It implements <https://www.standardwebhooks.com>, which means three headers
 * rather than one (docs.wewire.com/working-with-the-api/webhooks, read
 * 2026-08-29):
 *
 *   webhook-id         opaque message id, stable across retries
 *   webhook-timestamp  unix seconds, checked against a 5-minute tolerance
 *   webhook-signature  `v1,<base64 HMAC-SHA256>`
 *
 * The signed content is `{id}.{timestamp}.{body}` and the HMAC key is **not**
 * the literal secret: it is the base64-decoded portion after the `whsec_`
 * prefix. Getting that wrong is the single most common Standard Webhooks
 * integration bug, and reproducing it exactly is more useful than being
 * lenient about it.
 *
 * The header may carry several space-separated signatures during a secret
 * rotation; a verifier must accept a match against any of them. `verify`
 * below does, so a developer can test their rotation handling here.
 */
export const WEWIRE_ID_HEADER = 'webhook-id';
export const WEWIRE_TIMESTAMP_HEADER = 'webhook-timestamp';
export const WEWIRE_SIGNATURE_HEADER = 'webhook-signature';

/** Standard Webhooks' documented replay window. */
export const WEWIRE_TOLERANCE_SECONDS = 300;

/**
 * The HMAC key: whatever follows `whsec_`, base64-decoded.
 *
 * A secret without the prefix is used verbatim as UTF-8 bytes, which is what
 * the reference libraries do and keeps paybox's generated local secrets
 * usable either way.
 */
export function wewireSigningKey(secret: string): Buffer {
  return secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');
}

/** `{id}.{timestamp}.{body}` — the exact bytes Standard Webhooks signs. */
export function wewireSignedContent(id: string, timestampSeconds: number, rawBody: string): string {
  return `${id}.${timestampSeconds}.${rawBody}`;
}

export function signWewirePayload(
  id: string,
  timestampSeconds: number,
  rawBody: string,
  secret: string,
): string {
  const mac = createHmac('sha256', wewireSigningKey(secret))
    .update(wewireSignedContent(id, timestampSeconds, rawBody))
    .digest('base64');
  return `v1,${mac}`;
}

/**
 * The message id for a delivery, derived from the body.
 *
 * Standard Webhooks requires `webhook-id` to be stable across every retry of
 * one message and distinct between messages. paybox's formatter signature
 * (`sign(rawBody, secret, context)`) deliberately receives only the bytes, so
 * that signing stays a pure function and cannot reach for a clock or a
 * counter — see webhooks/src/types.ts. Hashing the body satisfies both
 * requirements from the bytes alone: identical retries hash identically, and
 * two different events differ in their ids, timestamps or amounts.
 *
 * Prefixed `msg_` the way Standard Webhooks' own examples are.
 */
export function wewireMessageId(rawBody: string): string {
  const digest = createHash('sha256').update(rawBody).digest('base64url');
  return `msg_${digest.slice(0, 27)}`;
}

export function wewireSignatureHeaders(
  rawBody: string,
  secret: string,
  timestampMs: number,
): Record<string, string> {
  const id = wewireMessageId(rawBody);
  const timestamp = Math.floor(timestampMs / 1000);
  return {
    [WEWIRE_ID_HEADER]: id,
    [WEWIRE_TIMESTAMP_HEADER]: String(timestamp),
    [WEWIRE_SIGNATURE_HEADER]: signWewirePayload(id, timestamp, rawBody, secret),
  };
}

export interface WewireVerifyOptions {
  /** Current time in ms. Passed in — never read from a clock here (spec §7). */
  now: number;
  toleranceSeconds?: number;
}

/**
 * Verify a delivery the way a correct consumer would.
 *
 * Used by the emulator's own tests and available to anyone writing a
 * verifier: it checks the tolerance window first, then compares against every
 * signature in the header.
 */
export function verifyWewireSignature(
  headers: Record<string, string | undefined>,
  rawBody: string,
  secret: string,
  options: WewireVerifyOptions,
): boolean {
  const id = headers[WEWIRE_ID_HEADER];
  const timestamp = headers[WEWIRE_TIMESTAMP_HEADER];
  const header = headers[WEWIRE_SIGNATURE_HEADER];
  if (!id || !timestamp || !header) return false;

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  const tolerance = options.toleranceSeconds ?? WEWIRE_TOLERANCE_SECONDS;
  if (Math.abs(Math.floor(options.now / 1000) - seconds) > tolerance) return false;

  const expected = signWewirePayload(id, seconds, rawBody, secret);
  // A rotation puts several `v1,...` values in the header, space-separated.
  return header.split(' ').some((candidate) => {
    const a = Buffer.from(candidate.trim());
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
