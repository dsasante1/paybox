import type { SigningContext } from '@paybox/webhooks';

/**
 * Tingg does not sign its webhooks. At all.
 *
 * This file exists to say so in the place a reader will look, and to make the
 * absence deliberate rather than an oversight. Every other adapter here has a
 * scheme:
 *
 *   Paystack    HMAC-SHA512 of the body, `x-paystack-signature`
 *   Stripe      HMAC-SHA256 of `${t}.${body}`, re-signed per attempt
 *   Kora        HMAC-SHA256 of the `data` object only
 *   Quid        Standard-Webhooks-shaped `${id}.${t}.${body}`
 *   WeWire      Standard Webhooks proper
 *   Wise        RSA-SHA256, the only asymmetric one
 *   Flutterwave v3 sends the secret back verbatim, which is not a signature
 *
 * Tingg sends none of these. Its IPN documentation
 * (docs.tingg.africa/reference/4-implement-webhook-via-callback-url-1 and
 * /docs/callback, both read 2026-09-20) describes the callback body, the
 * retry behaviour and the response the merchant must send, and never mentions
 * a signature, an HMAC, a shared secret or a verification header. The
 * integration dashboard page lists what can be configured -- service codes,
 * payment option codes, API keys -- and a webhook secret is not among them.
 *
 * The Payouts callback goes further: its only authentication is the merchant's
 * own `username` and `password`, echoed back **inside the callback body**. A
 * receiver that checks them is comparing a secret that just travelled in
 * plaintext against one it already holds, which establishes nothing an
 * attacker replaying the body could not also satisfy.
 *
 * This is reproduced rather than improved on, for the same reason Flutterwave
 * v3's `verif-hash` is: a developer's Tingg integration cannot verify a
 * signature, and an emulator that invented one would teach them to write
 * verification code that fails the moment it meets the real thing. The
 * honest service paybox can do here is make the absence visible -- which is
 * what docs/tingg.md does, in the strongest terms the file allows.
 *
 * The secret on the endpoint row is unused. It is not removed from the model
 * because every other provider needs it, and a nullable secret would push
 * Tingg's quirk into six adapters that do not have it.
 */
/**
 * What goes in the endpoint row's `secret` column.
 *
 * A string that says what it is, rather than a plausible-looking key somebody
 * might try to verify against. Wise carries an equivalent constant for the
 * same reason: its webhooks are RSA-signed, so a shared secret is meaningless
 * there too.
 */
export const TINGG_UNUSED_SECRET = 'unused-tingg-does-not-sign-webhooks';

export function tinggSignatureHeaders(
  _rawBody: string,
  _secret: string,
  _context: SigningContext,
): Record<string, string> {
  return {};
}
