/**
 * Stripe's request encoding.
 *
 * Every Stripe endpoint takes `application/x-www-form-urlencoded` and nothing
 * else -- there is no JSON request body anywhere in their OpenAPI
 * specification (`stripe/openapi`, `openapi/spec3.json`, read 2026-08-28).
 * Nested structures travel as bracketed keys, which their own SDKs produce:
 *
 *   metadata[order_id]=1234
 *   payment_method_data[type]=card
 *   payment_method_data[card][number]=4242424242424242
 *   expand[]=customer
 *   expand[0]=latest_charge
 *
 * The app's shared form parser produces a flat map, so those arrive as literal
 * keys like `"payment_method_data[card][number]"`. This turns them back into
 * the nested object the route handlers and zod schemas expect.
 */

type Nested = Record<string, unknown>;

/**
 * Keys that must never be written through.
 *
 * Bracket-notation parsers are a classic prototype-pollution vector: a request
 * carrying `metadata[__proto__][isAdmin]=true` walks the parser straight onto
 * `Object.prototype` unless the key is refused. Nothing legitimate in Stripe's
 * API uses these names.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Split `a[b][c]` into `['a','b','c']`; a bare `a` into `['a']`. */
function pathOf(key: string): string[] {
  const head = key.indexOf('[');
  if (head === -1) return [key];
  const segments = [key.slice(0, head)];
  for (const match of key.slice(head).matchAll(/\[([^\]]*)\]/g)) {
    segments.push(match[1] ?? '');
  }
  return segments;
}

/**
 * An empty segment (`expand[]`) or a numeric one (`expand[0]`) means an array.
 * Stripe's SDKs emit both forms for the same field, so both have to work.
 */
function isArrayIndex(segment: string): boolean {
  return segment === '' || /^\d+$/.test(segment);
}

/** Where to write a segment on its parent: an array slot or an object key. */
function slotFor(node: Nested | unknown[], segment: string): string | number {
  if (Array.isArray(node)) return segment === '' ? node.length : Number(segment);
  return segment;
}

function write(node: Nested | unknown[], slot: string | number, value: unknown): void {
  if (Array.isArray(node)) {
    node[slot as number] = value;
  } else {
    (node as Nested)[slot as string] = value;
  }
}

function read(node: Nested | unknown[], slot: string | number): unknown {
  return Array.isArray(node) ? node[slot as number] : (node as Nested)[slot as string];
}

/**
 * Expand a flat form map into nested objects and arrays.
 *
 * Keys without brackets pass through untouched, so a provider sending flat
 * forms is unaffected. Conflicting shapes for one key -- `a=1` alongside
 * `a[b]=2` -- resolve to the nested form rather than throwing: a malformed
 * request should fail validation with a useful message, not a parser crash.
 */
export function expandFormBody(flat: Record<string, unknown>): Nested {
  const out: Nested = {};

  for (const [key, value] of Object.entries(flat)) {
    const segments = pathOf(key);
    if (segments.some((segment) => FORBIDDEN_KEYS.has(segment))) continue;

    if (segments.length === 1) {
      out[key] = value;
      continue;
    }

    let node: Nested | unknown[] = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const slot = slotFor(node, segments[i]!);
      const childShouldBeArray = isArrayIndex(segments[i + 1]!);
      const existing = read(node, slot);

      const child =
        existing !== null && typeof existing === 'object'
          ? (existing as Nested | unknown[])
          : childShouldBeArray
            ? []
            : {};
      write(node, slot, child);
      node = child;
    }

    write(node, slotFor(node, segments.at(-1)!), value);
  }

  return out;
}

/**
 * Stripe accepts `true`/`false` and `1`/`0` as booleans over form encoding.
 * Everything arrives as a string, so a schema that wants a boolean needs this.
 */
export function formBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}
