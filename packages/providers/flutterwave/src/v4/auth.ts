import { createHmac } from 'node:crypto';
import { PayboxError } from '@paybox/shared';

/**
 * Flutterwave v4 authentication.
 *
 * v4 does not take an API key. A client exchanges a `client_id` and
 * `client_secret` for a short-lived OAuth 2.0 access token at
 * `idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token`, and
 * sends that token as a bearer. Verified at
 * developer.flutterwave.com/docs/authentication (read 2026-08-29), which also
 * documents the ten-minute lifetime.
 *
 * paybox serves its own token endpoint at the same shape. Emulating the
 * exchange rather than accepting any bearer is the point: **token expiry is a
 * real failure mode** that v3 integrations never had to handle, and one a
 * developer should meet under a `time advance` rather than in production ten
 * minutes after deploying.
 */

/** Flutterwave documents `expires_in: 600`. */
export const V4_TOKEN_LIFETIME_SECONDS = 600;

export interface V4Credentials {
  clientId: string;
  clientSecret: string;
}

/** The local credentials shown at startup. Clearly labelled TEST (spec §29). */
export function generateV4Credentials(token: string): V4Credentials {
  const body = token.toLowerCase().replace(/[^a-z0-9]/g, '');
  return {
    clientId: `flw-test-local-${body.slice(0, 12)}`,
    clientSecret: `flwsec-test-local-${body.slice(0, 20)}`,
  };
}

/**
 * Mint an access token.
 *
 * Deterministically derived from the credentials and the issue instant, so a
 * fixed seed and a frozen clock produce the same token -- which is what lets
 * the compat suite assert on it. Real tokens are opaque JWTs; this one is
 * opaque too, and docs/flutterwave.md says it is not a credential.
 */
export function mintAccessToken(
  credentials: V4Credentials,
  issuedAtMs: number,
): { accessToken: string; expiresAtMs: number } {
  const payload = `${credentials.clientId}.${issuedAtMs}`;
  const signature = createHmac('sha256', credentials.clientSecret)
    .update(payload)
    .digest('base64url')
    .slice(0, 32);
  return {
    accessToken: `flwtok_${signature}`,
    expiresAtMs: issuedAtMs + V4_TOKEN_LIFETIME_SECONDS * 1000,
  };
}

/**
 * Check the credentials presented at the token endpoint.
 *
 * Only `client_credentials` is accepted, which is the grant Flutterwave
 * documents; another grant type is refused rather than quietly ignored.
 */
export function assertV4TokenRequest(
  body: { client_id?: string; client_secret?: string; grant_type?: string },
  expected: V4Credentials,
  options: { allowAnyKey?: boolean } = {},
): void {
  if (body.grant_type !== 'client_credentials') {
    throw new PayboxError(
      'validation_failed',
      'Only the `client_credentials` grant type is supported.',
      { details: { received: body.grant_type ?? null } },
    );
  }
  if (!body.client_id || !body.client_secret) {
    throw new PayboxError(
      'authentication_failed',
      '`client_id` and `client_secret` are both required.',
    );
  }
  // A live-looking credential is refused for the same reason a live API key
  // is: it could be logged, persisted or committed (spec §29).
  if (/live/i.test(body.client_secret) && !/test/i.test(body.client_secret)) {
    throw new PayboxError(
      'safety_violation',
      'That looks like a live Flutterwave client secret. paybox refuses live credentials.',
    );
  }
  if (options.allowAnyKey) return;
  if (body.client_id !== expected.clientId || body.client_secret !== expected.clientSecret) {
    throw new PayboxError(
      'authentication_failed',
      'Invalid client credentials. `paybox status` prints the ones this environment issued.',
    );
  }
}

/**
 * Validate a bearer token, including expiry.
 *
 * The expiry check is the reason this exists at all -- see the note above.
 * Tokens are tracked by the plugin rather than decoded, because a real token
 * is opaque to the client too.
 */
export function assertV4AccessToken(
  authorizationHeader: string | undefined,
  known: Map<string, number>,
  nowMs: number,
): string {
  if (!authorizationHeader) {
    throw new PayboxError('authentication_failed', 'No Authorization header was supplied.');
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) {
    throw new PayboxError(
      'authentication_failed',
      'Authorization header must be of the form "Bearer <access token>".',
    );
  }
  const token = match[1]!.trim();
  const expiresAt = known.get(token);
  if (expiresAt === undefined) {
    throw new PayboxError('authentication_failed', 'Unauthorized');
  }
  if (nowMs >= expiresAt) {
    throw new PayboxError(
      'authentication_failed',
      'The access token has expired. Request a new one from the token endpoint; ' +
        `v4 tokens live ${V4_TOKEN_LIFETIME_SECONDS} seconds.`,
      { details: { expiredAt: new Date(expiresAt).toISOString() } },
    );
  }
  return token;
}
