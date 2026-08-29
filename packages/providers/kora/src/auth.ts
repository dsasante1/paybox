import { PayboxError } from '@paybox/shared';

/**
 * Kora credentials (spec §15, §29).
 *
 * Kora issues a public and a secret key per mode, prefixed `pk_test_` /
 * `sk_test_` and `pk_live_` / `sk_live_`. Verified at
 * developers.korapay.com/docs/api-keys (read 2026-08-29).
 *
 * Refusing a live key is the most important safety property here. The emulator
 * never makes an outbound call, so a live key could not move money -- but it
 * could be logged, persisted or committed, and that is reason enough.
 */
const TEST_KEY = /^(sk|pk)_test_/;
const LIVE_KEY = /^(sk|pk)_live_/;

export interface KoraAuthOptions {
  allowAnyKey?: boolean;
}

export function assertKoraCredentials(
  authorizationHeader: string | undefined,
  options: KoraAuthOptions = {},
): string {
  if (!authorizationHeader) {
    throw new PayboxError('authentication_failed', 'No Authorization header was supplied.');
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) {
    throw new PayboxError(
      'authentication_failed',
      'Authorization header must be of the form "Bearer <secret key>".',
    );
  }
  const key = match[1]!.trim();

  if (LIVE_KEY.test(key)) {
    throw new PayboxError(
      'safety_violation',
      'That looks like a live Kora secret key. paybox refuses live credentials — ' +
        'use a test key (sk_test_...). Rotate this key if it is real.',
      { details: { hint: 'Set PAYBOX_ALLOW_ANY_KEY=1 only if you are certain it is not real.' } },
    );
  }

  if (!options.allowAnyKey && !TEST_KEY.test(key)) {
    throw new PayboxError(
      'authentication_failed',
      'Expected a test secret key beginning with sk_test_. ' +
        'paybox generates one for you on first start — see `paybox status`.',
    );
  }

  return key;
}

/**
 * The local credentials shown at startup.
 *
 * Kora's encryption key **is** the secret key: card payloads are AES-encrypted
 * under it, so there is no third key as there is at Flutterwave.
 */
export function generateKoraKeys(token: string): { secretKey: string; publicKey: string } {
  return { secretKey: `sk_test_local_${token}`, publicKey: `pk_test_local_${token}` };
}
