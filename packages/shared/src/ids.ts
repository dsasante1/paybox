import type { Random } from './random.js';

/**
 * Identifier generation (deterministic under a fixed seed).
 *
 * Canonical ids are prefixed so that a bare id in a log line or a dashboard
 * URL is self-describing. Provider-facing ids (Paystack's `CUS_...`, Stripe's
 * `pi_...`) are NOT generated here -- each adapter mints those in its own
 * house style, because the shape is part of the API contract we are emulating.
 */
export const ID_PREFIXES = [
  'pay', // payment
  'evt', // event
  'ref', // refund
  'trf', // transfer
  'cus', // customer
  'aut', // stored authorization
  'set', // instrument setup (card-on-file, no charge)
  'dva', // dedicated virtual account
  'pln', // plan
  'prd', // product
  'sub', // subscription
  'sui', // subscription item
  'inv', // invoice
  'ivi', // invoice line item
  'sac', // subaccount
  'spl', // transaction split
  'led', // balance ledger entry
  'dsp', // dispute
  'whd', // webhook delivery
  'whe', // webhook endpoint
  'job', // scheduled job
  'run', // scenario run
  'req', // request log entry
  'ben', // beneficiary payout account (WeWire)
  'qte', // FX quote (Wise)
  'bal', // named balance account (Wise)
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

// Crockford base32 minus the ambiguous glyphs (i, l, o, u).
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_BODY_LENGTH = 22;

export interface IdFactory {
  next(prefix: IdPrefix): string;
  /** Raw token with no prefix -- for provider-specific id shapes. */
  token(length: number): string;
}

export function createIdFactory(random: Random): IdFactory {
  const stream = random.fork('ids');
  return {
    next(prefix: IdPrefix): string {
      let body = '';
      for (let i = 0; i < ID_BODY_LENGTH; i++) {
        body += ALPHABET[stream.int(0, ALPHABET.length - 1)];
      }
      return `${prefix}_${body}`;
    },
    token(length: number): string {
      let out = '';
      for (let i = 0; i < length; i++) {
        out += ALPHABET[stream.int(0, ALPHABET.length - 1)];
      }
      return out;
    },
  };
}

export function isPayboxId(value: string, prefix?: IdPrefix): boolean {
  const match = /^([a-z]{3})_([0-9a-hjkmnp-tv-z]+)$/.exec(value);
  if (!match) return false;
  if (prefix && match[1] !== prefix) return false;
  return (ID_PREFIXES as readonly string[]).includes(match[1]!);
}
