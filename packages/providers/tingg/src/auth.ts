import { PayboxError } from '@paybox/shared';
import type { Storage } from '@paybox/core';

/**
 * Tingg credentials (spec §15, §29).
 *
 * Checkout 3.0 wants **two** credentials on every call, which is unlike any
 * other adapter here:
 *
 *   apiKey:        <application consumer key>
 *   Authorization: Bearer <access token>
 *
 * The token comes from an OAuth 2.0 `client_credentials` exchange against
 * `/v1/oauth/token/request`, which itself is authenticated by the `apiKey`
 * header alone. So the key is the long-lived credential and the token is the
 * short-lived one, and a request needs both.
 *
 * Payouts does not use either. Its credentials are a `username`/`password`
 * pair **inside the request body**, under `payload.credentials` -- a wholly
 * separate scheme under the same brand. `assertBeepCredentials` handles that.
 *
 * Verified at docs.tingg.africa/reference/authenticate-requests,
 * /reference/generate-token and /reference/postpayment, all read 2026-09-20.
 *
 * ## Why this adapter matches the key instead of checking a prefix
 *
 * Paystack has `sk_test_`, Kora has `sk_test_`, Quid has `ak_test_`. Tingg
 * publishes no such convention: its documented sample key is a bare 32-character
 * opaque string (`pscPbgj27sEYaPBdxYoHSshEDdt5Pivq`), so there is nothing in the
 * shape of a Tingg key that distinguishes a live one from a sandbox one.
 *
 * A prefix check is therefore impossible, and guessing one would be inventing
 * provider behaviour. Requiring an exact match against the key paybox generated
 * is strictly safer than any prefix rule would have been: a real live key does
 * not match, so it is refused on arrival rather than accepted and logged.
 */

export const TINGG_TOKEN_TTL_SECONDS = 3_600;

export interface TinggCredentials {
  /** The `apiKey` header value. */
  apiKey: string;
  clientId: string;
  clientSecret: string;
  /** `payload.credentials.username` on every BEEP call. */
  payoutsUsername: string;
  payoutsPassword: string;
}

/**
 * The local credentials shown at startup.
 *
 * Every one is given an obviously-local shape rather than an imitation of
 * Tingg's opaque sample values, because a credential that *looks* issued is
 * the kind of thing that ends up pasted somewhere real.
 */
export function generateTinggKeys(token: string): TinggCredentials {
  return {
    apiKey: `paybox_local_tingg_apikey_${token}`,
    clientId: `paybox_local_tingg_client_${token}`,
    clientSecret: `paybox_local_tingg_secret_${token}`,
    payoutsUsername: 'sandboxUser',
    // Tingg's own published sandbox password, so a script copied out of the
    // Payouts guide works unchanged. It authenticates nothing anywhere.
    payoutsPassword: 'sandboxPassword!',
  };
}

export interface TinggAuthOptions {
  credentials: TinggCredentials;
  allowAnyKey?: boolean;
}

/** `apiKey` alone -- what the token endpoint itself requires. */
export function assertApiKey(
  header: string | undefined,
  options: TinggAuthOptions,
): void {
  const supplied = header?.trim();
  if (!supplied) {
    throw new PayboxError(
      'authentication_failed',
      'No apiKey header was supplied. Tingg requires one on every request, including the token request.',
    );
  }
  if (options.allowAnyKey) return;
  if (supplied !== options.credentials.apiKey) {
    throw new PayboxError(
      'authentication_failed',
      'The apiKey header did not match this emulator\'s key. Tingg publishes no test-key prefix, ' +
        'so paybox matches the key it generated — run `paybox status` to see it, or set ' +
        'PAYBOX_ALLOW_ANY_KEY=1 to accept any key.',
    );
  }
}

/* ------------------------------ access tokens ----------------------------- */

interface StoredToken {
  token: string;
  clientId: string;
  expiresAt: number;
}

const TOKEN_PREFIX = 'oauth:';

/**
 * Mint an access token.
 *
 * Stored in `storage.providerState` rather than held in memory, so a token
 * survives anything that rebuilds the adapter and so `paybox reset` clears it
 * along with everything else. The value comes from the injected id factory,
 * which means a fixed `PAYBOX_SEED` reproduces the same token -- the property
 * the integration suite relies on.
 */
export async function issueToken(
  storage: Storage,
  input: { token: string; refreshToken: string; clientId: string; now: number; nowISO: string },
): Promise<{ access_token: string; refresh_token: string; expires_in: number; token_type: 'bearer' }> {
  const record: StoredToken = {
    token: input.token,
    clientId: input.clientId,
    expiresAt: input.now + TINGG_TOKEN_TTL_SECONDS * 1_000,
  };
  await storage.providerState.put(
    'tingg',
    `${TOKEN_PREFIX}${input.token}`,
    JSON.stringify(record),
    input.nowISO,
  );
  return {
    // Field order matches Tingg's documented response body. Harmless, but a
    // developer diffing against the real API should see the same shape.
    expires_in: TINGG_TOKEN_TTL_SECONDS,
    token_type: 'bearer',
    access_token: input.token,
    refresh_token: input.refreshToken,
  } as { access_token: string; refresh_token: string; expires_in: number; token_type: 'bearer' };
}

export function assertClientCredentials(
  body: { client_id: string; client_secret: string; grant_type: string },
  options: TinggAuthOptions,
): void {
  if (body.grant_type !== 'client_credentials') {
    throw new PayboxError(
      'invalid_request',
      `Unsupported grant_type "${body.grant_type}". Tingg issues tokens for client_credentials only.`,
    );
  }
  if (options.allowAnyKey) return;
  if (
    body.client_id !== options.credentials.clientId ||
    body.client_secret !== options.credentials.clientSecret
  ) {
    throw new PayboxError(
      'authentication_failed',
      'Invalid client_id or client_secret. Run `paybox status` to see this emulator\'s credentials.',
    );
  }
}

/**
 * Both credentials on an ordinary Checkout 3.0 call.
 *
 * The token is checked against virtual time, so `paybox time advance 2h`
 * expires it exactly as an hour-long token would expire in production -- which
 * is the point of having a TTL in an emulator at all.
 */
export async function assertCheckoutCredentials(
  storage: Storage,
  headers: { apiKey: string | undefined; authorization: string | undefined },
  options: TinggAuthOptions & { now: number },
): Promise<string> {
  assertApiKey(headers.apiKey, options);

  const match = /^Bearer\s+(.+)$/i.exec((headers.authorization ?? '').trim());
  if (!match) {
    throw new PayboxError(
      'authentication_failed',
      'Authorization header must be of the form "Bearer <access token>". ' +
        'Get one from POST /v1/oauth/token/request.',
    );
  }
  const token = match[1]!.trim();
  const raw = await storage.providerState.get('tingg', `${TOKEN_PREFIX}${token}`);
  if (!raw) {
    throw new PayboxError('authentication_failed', 'Unknown or revoked access token.');
  }
  const stored = JSON.parse(raw) as StoredToken;
  if (options.now >= stored.expiresAt) {
    throw new PayboxError(
      'authentication_failed',
      'The access token has expired. Tingg tokens live for one hour; request another.',
    );
  }
  return token;
}

/* ---------------------------- payout credentials --------------------------- */

/**
 * BEEP's credentials, from the request body.
 *
 * Returns the code Tingg would put in `authStatus` rather than throwing,
 * because a BEEP authentication failure is **not** an HTTP error there: the
 * envelope comes back 200 with `authStatusCode: 132`. Throwing would produce
 * a shape no Tingg client knows how to read.
 */
export function assertBeepCredentials(
  credentials: { username: string; password: string } | undefined,
  options: TinggAuthOptions,
): boolean {
  if (!credentials) return false;
  if (options.allowAnyKey) return true;
  return (
    credentials.username === options.credentials.payoutsUsername &&
    credentials.password === options.credentials.payoutsPassword
  );
}
