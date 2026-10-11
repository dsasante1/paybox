import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Bachs webhook signatures (docs.bachs.io/guides/webhooks/overview, read
 * 2026-10-10).
 *
 * Every delivery carries three headers:
 *
 *   X-Bachs-Timestamp     Unix seconds when the event was sent.
 *   X-Bachs-Signature     HMAC-SHA256 hex digest of "{timestamp}.{raw_body}".
 *   X-Bachs-Signature-V2  "t={timestamp},v1={signature}", repeating `v1=`
 *                         "once per currently valid secret".
 *
 * The HMAC key is the signing secret's own UTF-8 bytes -- `whsec_` prefix and
 * all -- exactly as Bachs' Python, Node and Java samples use it
 * (`secret.encode()`, `createHmac("sha256", secret)`), unlike Standard
 * Webhooks, which base64-decodes the part after the prefix.
 *
 * The signature covers a timestamp, so it is recomputed at every attempt
 * (`resignsPerAttempt`): a retry an hour later carries that hour's timestamp,
 * and a verifier's 300-second tolerance window holds.
 *
 * During a rotation overlap both secrets are valid. V2 then carries a `v1=`
 * for each, current first; the legacy single-value header keeps the current
 * secret's digest, which is what a verifier written against it must deploy.
 */
export const BACHS_TIMESTAMP_HEADER = 'X-Bachs-Timestamp';
export const BACHS_SIGNATURE_HEADER = 'X-Bachs-Signature';
export const BACHS_SIGNATURE_V2_HEADER = 'X-Bachs-Signature-V2';

/** The documented default tolerance in Bachs' verification samples. */
export const BACHS_TOLERANCE_SECONDS = 300;

export function signBachsPayload(rawBody: string, secret: string, timestampSeconds: number): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`, 'utf8').digest('hex');
}

export function bachsSignatureHeaders(
  rawBody: string,
  secrets: readonly string[],
  timestampMs: number,
): Record<string, string> {
  const t = Math.floor(timestampMs / 1000);
  const [current] = secrets;
  if (current === undefined) throw new Error('At least one signing secret is required.');
  const signatures = secrets.map((secret) => signBachsPayload(rawBody, secret, t));
  return {
    [BACHS_TIMESTAMP_HEADER]: String(t),
    [BACHS_SIGNATURE_HEADER]: signatures[0]!,
    [BACHS_SIGNATURE_V2_HEADER]: [`t=${t}`, ...signatures.map((s) => `v1=${s}`)].join(','),
  };
}

/**
 * Verify a delivery the way Bachs' own `verify_v2` sample does: split on
 * commas, take `t=`, accept if **any** `v1=` matches, within the tolerance.
 * Exported so tests and the docs' worked example use the published algorithm
 * rather than one written to agree with the signer.
 */
export function verifyBachsSignatureV2(
  header: string,
  rawBody: string,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = BACHS_TOLERANCE_SECONDS,
): boolean {
  const parts = header.split(',').map((part) => {
    const index = part.indexOf('=');
    return index === -1 ? ['', ''] : [part.slice(0, index), part.slice(index + 1)];
  });
  const t = Number(parts.find(([key]) => key === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signBachsPayload(rawBody, secret, t));
  return parts
    .filter(([key]) => key === 'v1')
    .some(([, value]) => {
      const candidate = Buffer.from(value!);
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
}
