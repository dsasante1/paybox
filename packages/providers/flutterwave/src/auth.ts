import { PayboxError } from '@paybox/shared';

/**
 * Flutterwave credentials (spec §15, §29).
 *
 * v3 keys are prefixed by kind and mode: `FLWSECK_TEST-…` for a test secret
 * key, `FLWSECK-…` for a live one. Verified at
 * developer.flutterwave.com/v3.0.0/docs/authentication (read 2026-08-29),
 * which states test keys "will always have `_TEST` as prefix".
 *
 * Refusing a live key is the single most important safety property here. The
 * emulator never makes an outbound call, so a live key could not move money --
 * but it could be logged, persisted or committed, and that is reason enough.
 */
const TEST_SECRET = /^FLWSECK_TEST-/i;
const TEST_PUBLIC = /^FLWPUBK_TEST-/i;
/** A live key is the same prefix *without* `_TEST`. */
const LIVE_KEY = /^FLW(SECK|PUBK)-/i;

export interface FlutterwaveAuthOptions {
  /** Escape hatch, off by default, for testing key-rotation flows. */
  allowAnyKey?: boolean;
}

export function assertFlutterwaveCredentials(
  authorizationHeader: string | undefined,
  options: FlutterwaveAuthOptions = {},
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
      'That looks like a live Flutterwave secret key. paybox refuses live credentials — ' +
        'use a test key (FLWSECK_TEST-...). Rotate this key if it is real.',
      { details: { hint: 'Set PAYBOX_ALLOW_ANY_KEY=1 only if you are certain it is not real.' } },
    );
  }

  if (!options.allowAnyKey && !TEST_SECRET.test(key)) {
    throw new PayboxError(
      'authentication_failed',
      'Expected a test secret key beginning with FLWSECK_TEST-. ' +
        'paybox generates one for you on first start — see `paybox status`.',
    );
  }

  return key;
}

/**
 * The local credentials shown at startup.
 *
 * Three keys, because Flutterwave issues three: a secret key for server calls,
 * a public key for the inline checkout, and an **encryption key** used to
 * 3DES-encrypt direct card payloads. Flutterwave's encryption key is 24
 * characters, which is the 3DES key length, so the generated one has to be too
 * or a developer's real encryption code would fail against the emulator.
 */
export function generateFlutterwaveKeys(token: string): {
  secretKey: string;
  publicKey: string;
  encryptionKey: string;
} {
  const body = token.toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(24, 'X');
  return {
    secretKey: `FLWSECK_TEST-${body.slice(0, 20)}-X`,
    publicKey: `FLWPUBK_TEST-${body.slice(0, 20)}-X`,
    // Exactly 24 chars: 3DES-EDE3 takes a 24-byte key.
    encryptionKey: `FLWSECK_TESTLOCAL${body.slice(0, 7)}`.slice(0, 24),
  };
}
