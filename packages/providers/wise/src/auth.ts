import { PayboxError } from '@paybox/shared';

/**
 * Wise credentials (spec §15, §29).
 *
 * Wise uses a bearer token — either a Personal API Token from
 * Settings → Connect and manage apps, or an OAuth 2.0 user access token valid
 * for 12 hours. Both are declared in the spec as
 * `type: http, scheme: bearer, bearerFormat: JWT`
 * (`components.securitySchemes.PersonalToken` / `UserToken`, Wise Platform API
 * OpenAPI 3.1.0, version `2026Q3`, read 2026-08-29).
 *
 * paybox issues its own `wise_test_local_…` token and prints it in the startup
 * banner.
 *
 * The live-credential guard here is shaped differently from the other
 * adapters', because Wise's tokens carry no `sk_live_`-style marker. What it
 * refuses instead is anything that **looks like a real JWT** — three
 * base64url segments separated by dots. A real Wise access token always does;
 * a locally generated one never will. That is the honest test available, and
 * `docs/wise.md` says so rather than implying a stronger guarantee than the
 * format allows.
 */
const LOCAL_TOKEN = /^wise_test_local_/;
const JWT_SHAPED = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

export interface WiseAuthOptions {
  allowAnyKey?: boolean;
}

export function assertWiseCredentials(
  header: string | undefined,
  options: WiseAuthOptions = {},
): string {
  const value = header?.trim();
  if (!value) {
    throw new PayboxError(
      'authentication_failed',
      'No API token supplied. Send `Authorization: Bearer <token>`.',
      { details: { wiseCode: 'UNAUTHORIZED' } },
    );
  }

  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (!match?.[1]) {
    throw new PayboxError(
      'authentication_failed',
      'Malformed Authorization header. Wise expects `Bearer <token>`.',
      { details: { wiseCode: 'UNAUTHORIZED' } },
    );
  }

  const token = match[1].trim();

  if (JWT_SHAPED.test(token)) {
    throw new PayboxError(
      'safety_violation',
      'That looks like a real Wise access token (a JWT). paybox refuses live credentials — ' +
        'use the local token from the startup banner. Rotate this token if it is real.',
      { details: { hint: 'Set PAYBOX_ALLOW_ANY_KEY=1 only if you are certain it is not real.' } },
    );
  }

  if (!options.allowAnyKey && !LOCAL_TOKEN.test(token)) {
    throw new PayboxError(
      'authentication_failed',
      'Expected the local token generated at startup (wise_test_local_…). See `paybox status`.',
      { details: { wiseCode: 'UNAUTHORIZED' } },
    );
  }

  return token;
}

export function generateWiseKeys(token: string): { apiToken: string } {
  return { apiToken: `wise_test_local_${token}` };
}
