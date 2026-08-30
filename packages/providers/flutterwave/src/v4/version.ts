import type { Metadata } from '@paybox/shared';

/**
 * Which Flutterwave API created a resource.
 *
 * Flutterwave ships two live APIs with different envelopes and different
 * webhook signature schemes, and paybox serves both under one provider id.
 * The engine has no concept of an API version -- it must not (spec §30) --
 * so the fact is recorded on the resource at creation, exactly as the WeWire
 * adapter records a payout's corridor, and the webhook formatter reads it
 * back to choose the shape and signature that match. Absent means v3.
 *
 * Prefixed `paybox_` like the other emulator-internal metadata keys, and
 * stripped from every `meta` the v4 API echoes (see `publicMeta`).
 */
export const API_VERSION_KEY = 'paybox_api_version';

export function markV4(metadata: Metadata): Metadata {
  return { ...metadata, [API_VERSION_KEY]: 'v4' };
}

export function isV4(resource: { metadata: Metadata }): boolean {
  return resource.metadata[API_VERSION_KEY] === 'v4';
}
