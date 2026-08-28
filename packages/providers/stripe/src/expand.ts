import { PayboxError } from '@paybox/shared';
import { expandFormBody } from './form.js';

/**
 * Stripe's `expand[]` (spec §13, §33).
 *
 * Every Stripe response returns related objects as bare id strings. `expand[]`
 * asks for the object itself in that slot instead:
 *
 *   expand[]=customer                 an invoice's `customer` becomes the object
 *   expand[]=data.customer            the same, for every row of a list
 *   expand[]=latest_invoice.payment_intent   two levels down
 *
 * Implemented as a walk over the *serialised* response rather than as a flag
 * threaded through every serializer. That is what keeps it one mechanism
 * instead of forty: each route already returns Stripe's exact shape, and this
 * only ever replaces a string with the object that string names.
 *
 * Verified against `stripe/openapi` `openapi/spec3.json` (API version
 * 2026-08-26.dahlia, read 2026-08-28) and docs.stripe.com/api/expanding_objects.
 */

/**
 * Stripe refuses more than four levels of nesting, and says so rather than
 * silently truncating. Matched here because a developer who hits the ceiling
 * locally should hit the same ceiling in production.
 */
export const MAX_EXPAND_DEPTH = 4;

/**
 * Resolve one Stripe id to its serialised object, or null when it cannot be
 * resolved.
 *
 * Returning null rather than throwing is deliberate: an id that does not
 * resolve leaves the string in place. An expansion is a request for *more*
 * detail, and failing to supply it must never turn a successful response into
 * an error.
 */
export type ExpandLoader = (id: string) => Promise<unknown | null>;

/** Pull `expand` out of a parsed body or a bracketed query string. */
export function expandPaths(source: unknown): string[] {
  if (source === null || typeof source !== 'object') return [];
  const record = source as Record<string, unknown>;
  // A POST body has already been through `expandFormBody`; a query string has
  // not, so `expand[]=customer` is still the literal key "expand[]" there.
  const value = 'expand' in record ? record.expand : expandFormBody(record).expand;

  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** `a.b.c` -> `['a','b','c']`, dropping the empty segments a stray dot leaves. */
function segmentsOf(path: string): string[] {
  return path.split('.').filter((segment) => segment.length > 0);
}

/**
 * Refuse an over-deep expansion.
 *
 * Separate from `applyExpansions` so it can run as request validation. An
 * error raised while serialising a response arrives after the handler has
 * already produced one, and Fastify answers that from its default serialiser
 * rather than the adapter's -- handing a Stripe client a Fastify-shaped error.
 */
export function assertExpandDepth(paths: readonly string[]): void {
  for (const path of paths) {
    const depth = segmentsOf(path).length;
    if (depth <= MAX_EXPAND_DEPTH) continue;
    throw new PayboxError(
      'validation_failed',
      `You cannot expand more than ${MAX_EXPAND_DEPTH} levels of an object. ` +
        `'${path}' is ${depth} levels deep.`,
    );
  }
}

/**
 * Replace id strings with objects at each requested path.
 *
 * Mutates `target` in place and returns it. Paths that name a field the
 * response does not carry, or that name a null, are no-ops -- paybox's objects
 * are a documented subset of Stripe's, and erroring on a field this emulator
 * simply does not model would break integrations for no benefit. docs/stripe.md
 * records the difference; the depth limit is still enforced, because that one
 * is a real ceiling a developer needs to feel.
 */
export async function applyExpansions(
  target: unknown,
  paths: readonly string[],
  load: ExpandLoader,
): Promise<unknown> {
  if (target === null || typeof target !== 'object') return target;

  for (const path of new Set(paths)) {
    const segments = segmentsOf(path);
    // Over-deep paths are rejected by `assertExpandDepth` during request
    // validation. Skipping rather than throwing here keeps this pass total:
    // it also runs over the *error* body when validation rejected something,
    // and a second throw there would escape the adapter's error serialiser.
    if (segments.length === 0 || segments.length > MAX_EXPAND_DEPTH) continue;
    await walk(target, segments, load);
  }

  return target;
}

async function walk(node: unknown, segments: string[], load: ExpandLoader): Promise<void> {
  if (node === null || typeof node !== 'object') return;

  // A list's `data` is an array, so `data.customer` means "for every row".
  if (Array.isArray(node)) {
    for (const item of node) await walk(item, segments, load);
    return;
  }

  const [head, ...rest] = segments;
  if (head === undefined) return;
  const record = node as Record<string, unknown>;
  if (!(head in record)) return;
  let value = record[head];

  // Naming a nested path expands the levels above it too: at Stripe,
  // `expand[]=latest_charge.customer` returns the charge object *and* the
  // customer inside it, not a customer hanging off a bare id string. So an
  // intermediate segment that is still an id gets resolved before descending.
  if (typeof value === 'string') {
    const expanded = await load(value);
    if (expanded !== null && expanded !== undefined) {
      record[head] = expanded;
      value = expanded;
    }
  }

  if (rest.length > 0) {
    await walk(value, rest, load);
    return;
  }

  if (typeof value !== 'object' || value === null) return;

  // `expand[]=lines` on an array of ids expands each entry.
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== 'string') continue;
      const expanded = await load(entry);
      if (expanded !== null && expanded !== undefined) value[index] = expanded;
    }
  }
}
