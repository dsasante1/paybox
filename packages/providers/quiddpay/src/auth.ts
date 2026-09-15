import { PayboxError } from '@paybox/shared';

/**
 * Quid Payments credentials (spec §15, §29).
 *
 * One merchant API key, sent as `Authorization: Bearer <merchant_api_key>`.
 * The key is scoped to a single merchant *integration* and fixes both the
 * merchant and the environment, which is why nothing in the request body
 * selects them. Verified against the `merchantApiKeyAuth` security scheme in
 * Quid's published OpenAPI document (`docs.quiddpayments.com/openapi.json`,
 * contract `2026-06`, read 2026-09-15) and the guide at
 * `docs.quiddpayments.com/merchant-api.md`.
 *
 * Quid's own documentation is explicit that `ak_test` keys are for building
 * and `ak_live` keys only after live access is confirmed, so the prefix is the
 * environment. Refusing a live key is the most important safety property here:
 * the emulator never makes an outbound call, so a live key could not move
 * money, but it could be logged, persisted or committed, and that is reason
 * enough.
 */
const TEST_KEY = /^ak_test_/;
const LIVE_KEY = /^ak_live_/;

export interface QuiddpayAuthOptions {
  allowAnyKey?: boolean;
}

export function assertQuiddpayCredentials(
  authorizationHeader: string | undefined,
  options: QuiddpayAuthOptions = {},
): string {
  if (!authorizationHeader) {
    throw new PayboxError('authentication_failed', 'No Authorization header was supplied.');
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) {
    throw new PayboxError(
      'authentication_failed',
      'Authorization header must be of the form "Bearer <merchant_api_key>".',
    );
  }
  const key = match[1]!.trim();

  if (LIVE_KEY.test(key)) {
    throw new PayboxError(
      'safety_violation',
      'That looks like a live Quid Payments merchant API key. paybox refuses live ' +
        'credentials — use a test key (ak_test_...). Rotate this key if it is real.',
      { details: { hint: 'Set PAYBOX_ALLOW_ANY_KEY=1 only if you are certain it is not real.' } },
    );
  }

  if (!options.allowAnyKey && !TEST_KEY.test(key)) {
    throw new PayboxError(
      'authentication_failed',
      'Expected a test merchant API key beginning with ak_test_. ' +
        'paybox generates one for you on first start — see `paybox status`.',
    );
  }

  return key;
}

/**
 * The local credentials shown at startup.
 *
 * Two values, because Quid separates them: the merchant API key authenticates
 * requests, and a distinct per-endpoint **signing secret** signs webhooks.
 * Both are dashboard-issued at Quid, and only the API key's format is
 * published — so the signing secret gets an obviously-local shape rather than
 * an invented prefix that would read as authoritative. docs/quiddpay.md says
 * so plainly.
 */
export function generateQuiddpayKeys(token: string): {
  apiKey: string;
  signingSecret: string;
} {
  return {
    apiKey: `ak_test_local_${token}`,
    signingSecret: `paybox_local_signing_secret_${token}`,
  };
}
