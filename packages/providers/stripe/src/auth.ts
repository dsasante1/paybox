import { PayboxError } from '@paybox/shared';

/**
 * Stripe credential checking (spec §15, §29).
 *
 * Stripe accepts the secret key two ways, and their own SDKs use both:
 *   Authorization: Bearer sk_test_...
 *   Authorization: Basic <base64 of "sk_test_...:">
 * Verified against `stripe/openapi` securitySchemes, read 2026-08-28.
 *
 * A live key is refused outright and that is not configurable. The emulator
 * cannot reach Stripe, so a live key here can only be an accident -- and the
 * accident it usually indicates is a production key pasted into a test config.
 */
export interface StripeAuthOptions {
  /** Accept keys that are not `sk_test_*`. Never accepts `sk_live_*`. */
  allowAnyKey?: boolean;
}

export function assertStripeCredentials(
  header: string | undefined,
  options: StripeAuthOptions = {},
): string {
  if (!header) {
    throw new PayboxError(
      'authentication_failed',
      'No API key provided. Send `Authorization: Bearer sk_test_...`.',
      { httpStatus: 401 },
    );
  }

  const key = extractKey(header);
  if (!key) {
    throw new PayboxError(
      'authentication_failed',
      'Malformed Authorization header. Expected a Bearer or Basic credential.',
      { httpStatus: 401 },
    );
  }

  if (key.startsWith('sk_live_') || key.startsWith('pk_live_') || key.startsWith('rk_live_')) {
    throw new PayboxError(
      'safety_violation',
      'This is a live Stripe secret key. paybox refuses live credentials so it ' +
        'can never be mistaken for, or pointed at, the real Stripe API.',
      { httpStatus: 403 },
    );
  }

  if (!options.allowAnyKey && !isTestKey(key)) {
    throw new PayboxError(
      'authentication_failed',
      `Expected a test key (sk_test_..., rk_test_...); received "${redact(key)}". ` +
        'Set PAYBOX_ALLOW_ANY_KEY=1 to relax this.',
      { httpStatus: 401 },
    );
  }

  return key;
}

function isTestKey(key: string): boolean {
  return key.startsWith('sk_test_') || key.startsWith('rk_test_');
}

/** Bearer, or Basic with the key as the username and an empty password. */
function extractKey(header: string): string | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) return bearer[1]!.trim();

  const basic = /^Basic\s+(.+)$/i.exec(header);
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1]!.trim(), 'base64').toString('utf8');
      // "sk_test_x:" -- the password half is empty by convention.
      return decoded.split(':')[0]?.trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Never echo a whole key back, even a fake one. */
function redact(key: string): string {
  return key.length <= 8 ? '***' : `${key.slice(0, 8)}***`;
}

/**
 * Generate a local test key pair, labelled so it cannot be mistaken for real
 * credentials (spec §29).
 */
export function generateStripeKeys(token: string): {
  secretKey: string;
  publishableKey: string;
} {
  return {
    secretKey: `sk_test_local${token}`,
    publishableKey: `pk_test_local${token}`,
  };
}

/**
 * A local webhook endpoint secret, in the shape Stripe issues one: `whsec_`
 * and a token. Stripe signs webhooks with a per-endpoint secret that is
 * *not* the API key (docs.stripe.com/webhooks, read 2026-08-28), and a
 * developer's `constructEvent` call is handed exactly that string -- so the
 * emulator issues one of the same shape rather than reusing the key.
 * Labelled `local` like every credential here (spec §29).
 */
export function generateStripeWebhookSecret(token: string): string {
  return `whsec_local${token}`;
}
