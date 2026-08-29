import { PayboxError } from '@paybox/shared';

/**
 * WeWire credentials (spec §15, §29).
 *
 * WeWire does **not** use a bearer token. The key goes in a `ww-api-key`
 * header, verbatim, with no prefix: "There is no `Bearer` prefix. Pass the key
 * verbatim." Verified at docs.wewire.com/working-with-the-api/authentication
 * (read 2026-08-29).
 *
 * That is worth reproducing exactly rather than also accepting `Authorization:
 * Bearer` out of politeness. A developer whose client sends the wrong header
 * should find out here, where the fix is one line, rather than against the
 * real API.
 *
 * Keys are `sk_test_` for sandbox and `sk_live_` for production, and WeWire
 * documents that they do not cross environments.
 */
export const WEWIRE_KEY_HEADER = 'ww-api-key';

const TEST_KEY = /^sk_test_/;
const LIVE_KEY = /^sk_live_/;

export interface WewireAuthOptions {
  allowAnyKey?: boolean;
}

export function assertWewireCredentials(
  headers: Record<string, string | string[] | undefined>,
  options: WewireAuthOptions = {},
): string {
  const raw = headers[WEWIRE_KEY_HEADER];
  const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();

  if (!key) {
    // WeWire's own code for this, so a client branching on it sees what it
    // would see in production.
    throw new PayboxError(
      'authentication_failed',
      'No API key supplied. Send it in the `ww-api-key` header.',
      { details: { wewireCode: 'AUTH_TOKEN_MISSING' } },
    );
  }

  if (LIVE_KEY.test(key)) {
    throw new PayboxError(
      'safety_violation',
      'That looks like a live WeWire API key. paybox refuses live credentials — ' +
        'use a sandbox key (sk_test_...). Rotate this key if it is real.',
      { details: { hint: 'Set PAYBOX_ALLOW_ANY_KEY=1 only if you are certain it is not real.' } },
    );
  }

  if (!options.allowAnyKey && !TEST_KEY.test(key)) {
    throw new PayboxError(
      'authentication_failed',
      'Expected a sandbox key beginning with sk_test_. ' +
        'paybox generates one for you on first start — see `paybox status`.',
      { details: { wewireCode: 'AUTH_INVALID_CREDENTIALS' } },
    );
  }

  return key;
}

export function generateWewireKeys(token: string): { secretKey: string } {
  return { secretKey: `sk_test_local_${token}` };
}
