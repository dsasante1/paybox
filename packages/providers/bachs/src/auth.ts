import { PayboxError } from '@paybox/shared';
import { organizationId } from './ids.js';

/**
 * Bachs credentials (spec §15, §29).
 *
 * One secret key, sent as `Authorization: Bearer <key>`. "Prefix conventions
 * are strict: `sk_sandbox_` keys route to the sandbox deployment, while
 * `sk_live_` keys route to production and process real money."
 * (docs.bachs.io/authentication, read 2026-10-10.) A missing or invalid key is
 * `401 UNAUTHORIZED` (api-standards).
 *
 * Refusing a live key is the most important property here. The emulator never
 * makes an outbound call, so a live key could not move money -- but it could
 * be logged, persisted or committed, and that is reason enough.
 *
 * Keys at Bachs also carry **scopes** (`products:write`, `webhooks:read`, ...)
 * chosen in its dashboard, and a valid key without the scope is a `403
 * FORBIDDEN`. paybox has no dashboard to choose scopes in, so every sandbox key
 * here holds every scope; docs/bachs.md says so.
 */
const SANDBOX_KEY = /^sk_sandbox_/;
const LIVE_KEY = /^sk_live_/;

export interface BachsAuthOptions {
  allowAnyKey?: boolean;
}

export function assertBachsCredentials(
  authorizationHeader: string | undefined,
  options: BachsAuthOptions = {},
): string {
  if (!authorizationHeader) {
    throw new PayboxError('authentication_failed', 'Missing API key', {
      details: { bachsCode: 'UNAUTHORIZED' },
    });
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) {
    throw new PayboxError('authentication_failed', 'Invalid API key', {
      details: { bachsCode: 'UNAUTHORIZED' },
    });
  }
  const key = match[1]!.trim();

  if (LIVE_KEY.test(key)) {
    throw new PayboxError(
      'safety_violation',
      'That is a live Bachs secret key (sk_live_...). paybox refuses live credentials; ' +
        'use a sandbox key (sk_sandbox_...). Rotate this key if it is real.',
      { details: { bachsCode: 'UNAUTHORIZED' } },
    );
  }

  if (!options.allowAnyKey && !SANDBOX_KEY.test(key)) {
    throw new PayboxError('authentication_failed', 'Invalid API key', {
      details: { bachsCode: 'UNAUTHORIZED' },
    });
  }

  return key;
}

/**
 * The local credentials shown at startup.
 *
 * The key wears the documented sandbox prefix and says `local` straight after
 * it, so it reads as test material wherever it is pasted. The organization id
 * is what every webhook carries as `organization_id`; it is derived from the
 * same token so it is stable for a given seed.
 */
export function generateBachsKeys(token: string): {
  secretKey: string;
  organizationId: string;
} {
  return {
    secretKey: `sk_sandbox_local_${token}`,
    organizationId: organizationId(token),
  };
}
