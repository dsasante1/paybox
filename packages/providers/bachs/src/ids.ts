import { createHash } from 'node:crypto';
import type { IdFactory } from '@paybox/shared';

/**
 * Bachs-shaped identifiers.
 *
 * Bachs' ids are a type prefix and a lowercase hex body. The worked examples
 * in its docs vary in length, but ids taken from a real sandbox carry 32 hex
 * characters -- `ch_ff10c7a1b6b4427caf347d748fd4a183` (docs.bachs.io changelog,
 * read 2026-10-10) and the 32-hex `cust_` and `evt_` ids beside it -- so that
 * is the length used here. The API standards page says to "treat IDs as
 * opaque; do not parse them", so the length is a matter of looking right, not
 * of contract.
 *
 * paybox's own ids are base32 from the seeded stream. A hex body is derived
 * from a token of that stream, which keeps every id deterministic under
 * `PAYBOX_SEED` without the adapter reaching for a second random source.
 */
function hexFrom(seed: string, length: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

export function hexId(ids: IdFactory, prefix: string, length = 32): string {
  return `${prefix}_${hexFrom(ids.token(26), length)}`;
}

/**
 * An id derived from something already unique rather than drawn: a Bachs id
 * for a core row (an invoice's `inv_` from its core id) that every reader can
 * recompute, so nothing has to be indexed before the row's own events fire.
 */
export function derivedId(prefix: string, seed: string, length = 32): string {
  return `${prefix}_${hexFrom(seed, length)}`;
}

/** The portal URL's credential: 22 mixed-case alphanumerics, like Bachs' example. */
export function portalToken(ids: IdFactory): string {
  const digest = createHash('sha256').update(`portal:${ids.token(26)}`).digest();
  let out = '';
  for (let i = 0; i < 22; i++) out += BASE62[digest[i]! % 62];
  return out;
}

/**
 * A refund id.
 *
 * The spec's own `RefundResponse` example is a UUID
 * (`b7f2c41a-9d38-4e6b-8c15-2a7d0e934f61`); the property example says
 * `rfnd_…` and the webhook pages say `ref_…`. The REST shape wins under
 * docs/bachs.md's source rule, so a refund id is a version-4-shaped UUID.
 */
export function refundId(ids: IdFactory): string {
  return uuidFrom(ids.token(26));
}

/** A version-4-shaped UUID derived from `seed`. */
export function uuidFrom(seed: string): string {
  const hex = hexFrom(seed, 32);
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * The token at the end of a hosted checkout URL.
 *
 * Bachs' URLs read `https://checkout.bachs.io/c/Tb5rHn8YkQ2vXpL`: fifteen
 * mixed-case alphanumerics, unrelated to the `chk_` id. It is the only thing
 * that addresses a checkout from a payer's browser, which holds no API key, so
 * it must not be guessable from anything the merchant API returns.
 */
export function urlToken(ids: IdFactory): string {
  const digest = createHash('sha256').update(ids.token(26)).digest();
  let out = '';
  for (let i = 0; i < 15; i++) out += BASE62[digest[i]! % 62];
  return out;
}

/**
 * A webhook event id, derived rather than stored.
 *
 * One canonical event can become several Bachs events -- a paid checkout is
 * both `checkout.completed` and `collection.succeeded` -- and every one of
 * them has to keep its id across a resend, because Bachs tells subscribers to
 * "use the `id` field to deduplicate deliveries". Hashing the canonical event
 * id with the Bachs type gives each a stable, distinct id with nothing to
 * persist.
 */
export function eventId(canonicalEventId: string, type: string): string {
  return `evt_${hexFrom(`${canonicalEventId}:${type}`, 32)}`;
}

/** `acct_7KpQ2mNv4XbR9dLc`: sixteen mixed-case alphanumerics. */
export function organizationId(token: string): string {
  const digest = createHash('sha256').update(`organization:${token}`).digest();
  let out = '';
  for (let i = 0; i < 16; i++) out += BASE62[digest[i]! % 62];
  return `acct_${out}`;
}

/** A webhook signing secret: `whsec_` and 64 hex characters (createWebhookEndpoint). */
export function signingSecret(ids: IdFactory): string {
  return generateBachsWebhookSecret(ids.token(26));
}

/** The same shape from a caller's own token, for endpoints registered outside the adapter. */
export function generateBachsWebhookSecret(token: string): string {
  return `whsec_${hexFrom(token, 64)}`;
}

/**
 * A dispute's Bachs id. One the adapter opened carries its own `dsp_` id; one
 * opened by paybox's generic tooling has a bare token, and is given an id of
 * Bachs' shape derived from its core id, which every reader can recompute.
 */
export function disputeIdOf(dispute: { id: string; providerDisputeId: string }): string {
  return dispute.providerDisputeId.startsWith('dsp_')
    ? dispute.providerDisputeId
    : derivedId('dsp', `dispute:${dispute.id}`, 12);
}

/** A prefix and `length` mixed-case alphanumerics: `acct_3Wq8ZfT1yHnJ5sVe`, `al_kQ2v…`. */
export function alnumId(ids: IdFactory, prefix: string, length: number): string {
  const digest = createHash('sha512').update(ids.token(26)).digest();
  let out = '';
  for (let i = 0; i < length; i++) out += BASE62[digest[i]! % 62];
  return `${prefix}_${out}`;
}
