import { PayboxError } from '@paybox/shared';

/**
 * Credential handling (spec §15, §29).
 *
 * The emulator accepts local test keys and refuses anything that looks like a
 * production credential. This is the single most important safety property in
 * the product: a developer who pastes their real live key into a local tool by
 * accident should get a loud error, not a silent success that trains them to
 * treat the two as interchangeable.
 *
 * We never make an outbound call to a provider, so a live key here could not
 * move money -- but it could be logged, persisted, or committed, and that is
 * reason enough to reject it.
 */
const LOCAL_KEY_PATTERN = /^(sk|pk)_test_/;
const LIVE_KEY_PATTERN = /^(sk|pk)_live_/;

export interface AuthOptions {
  /** Escape hatch, off by default, for testing key-rotation flows. */
  allowAnyKey?: boolean;
}

export function assertPaystackCredentials(
  authorizationHeader: string | undefined,
  options: AuthOptions = {},
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

  if (LIVE_KEY_PATTERN.test(key)) {
    throw new PayboxError(
      'safety_violation',
      'That looks like a live Paystack secret key. paybox refuses live credentials — ' +
        'use a test key (sk_test_...). Rotate this key if it is real.',
      { details: { hint: 'Set PAYBOX_ALLOW_ANY_KEY=1 only if you are certain it is not real.' } },
    );
  }

  if (!options.allowAnyKey && !LOCAL_KEY_PATTERN.test(key)) {
    throw new PayboxError(
      'authentication_failed',
      'Expected a test secret key beginning with sk_test_. ' +
        'paybox generates one for you on first start — see `paybox status`.',
    );
  }

  return key;
}

/** Generate the local credentials shown at startup. Clearly labelled. */
export function generateLocalKeys(token: string): { secretKey: string; publicKey: string } {
  return {
    secretKey: `sk_test_local_${token}`,
    publicKey: `pk_test_local_${token}`,
  };
}
