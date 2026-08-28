import { describe, expect, it } from 'vitest';
import { expandFormBody, formBoolean } from '@paybox/stripe';

/**
 * Stripe's form encoding.
 *
 * Every Stripe endpoint takes `application/x-www-form-urlencoded` and nothing
 * else, with nested structures as bracketed keys. Verified against
 * `stripe/openapi` `openapi/spec3.json`, read 2026-08-28.
 */

describe('flat keys', () => {
  it('passes through untouched', () => {
    expect(expandFormBody({ amount: '2000', currency: 'usd' })).toEqual({
      amount: '2000',
      currency: 'usd',
    });
  });

  it('leaves an empty body empty', () => {
    expect(expandFormBody({})).toEqual({});
  });
});

describe('nested objects', () => {
  it('expands one level', () => {
    expect(expandFormBody({ 'metadata[order_id]': '1234' })).toEqual({
      metadata: { order_id: '1234' },
    });
  });

  it('expands several levels', () => {
    expect(
      expandFormBody({
        'payment_method_data[type]': 'card',
        'payment_method_data[card][number]': '4242424242424242',
        'payment_method_data[card][exp_month]': '12',
      }),
    ).toEqual({
      payment_method_data: {
        type: 'card',
        card: { number: '4242424242424242', exp_month: '12' },
      },
    });
  });

  it('keeps separate roots separate', () => {
    expect(
      expandFormBody({ 'a[x]': '1', 'b[x]': '2', c: '3' }),
    ).toEqual({ a: { x: '1' }, b: { x: '2' }, c: '3' });
  });
});

describe('arrays', () => {
  it('appends for the bracket form Stripe SDKs emit', () => {
    expect(
      expandFormBody({ 'expand[]': 'customer' }),
    ).toEqual({ expand: ['customer'] });
  });

  it('addresses slots for the indexed form', () => {
    expect(
      expandFormBody({ 'expand[0]': 'customer', 'expand[1]': 'latest_charge' }),
    ).toEqual({ expand: ['customer', 'latest_charge'] });
  });

  it('handles objects inside arrays', () => {
    expect(
      expandFormBody({
        'items[0][price]': 'price_123',
        'items[0][quantity]': '2',
        'items[1][price]': 'price_456',
      }),
    ).toEqual({
      items: [
        { price: 'price_123', quantity: '2' },
        { price: 'price_456' },
      ],
    });
  });
});

describe('prototype pollution', () => {
  // Bracket parsers are a classic vector; a request must not be able to reach
  // Object.prototype through one.
  it('drops __proto__ anywhere in the path', () => {
    const out = expandFormBody({
      '__proto__[polluted]': 'yes',
      'metadata[__proto__][polluted]': 'yes',
      'a[b][__proto__][polluted]': 'yes',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(JSON.stringify(out)).not.toContain('polluted');
  });

  it('drops constructor and prototype too', () => {
    expandFormBody({
      'constructor[prototype][polluted]': 'yes',
      'x[prototype][polluted]': 'yes',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('still accepts a legitimate key that merely contains the word', () => {
    expect(expandFormBody({ 'metadata[constructor_name]': 'Acme' })).toEqual({
      metadata: { constructor_name: 'Acme' },
    });
  });
});

describe('malformed input', () => {
  it('resolves a scalar/nested conflict to the nested form rather than throwing', () => {
    expect(() => expandFormBody({ a: '1', 'a[b]': '2' })).not.toThrow();
    expect(expandFormBody({ a: '1', 'a[b]': '2' })).toEqual({ a: { b: '2' } });
  });

  it('tolerates unbalanced brackets', () => {
    expect(() => expandFormBody({ 'a[b': '1', 'a]b': '2' })).not.toThrow();
  });
});

describe('booleans', () => {
  it('accepts both spellings Stripe sends', () => {
    expect(formBoolean('true')).toBe(true);
    expect(formBoolean('1')).toBe(true);
    expect(formBoolean('false')).toBe(false);
    expect(formBoolean('0')).toBe(false);
  });

  it('returns undefined for anything else, so a default can apply', () => {
    expect(formBoolean('yes')).toBeUndefined();
    expect(formBoolean(undefined)).toBeUndefined();
  });
});
