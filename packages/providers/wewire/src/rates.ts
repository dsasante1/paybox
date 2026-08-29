import { PayboxError } from '@paybox/shared';

/**
 * The FX rate table (spec §22, §30).
 *
 * `CLAUDE.md` states a non-negotiable: *"No FX conversion ever happens;
 * `formatAmount` is display-only."* WeWire and Wise are both FX-centric, so
 * that invariant is worth restating precisely rather than quietly relaxing.
 *
 * What it protects against is the engine **inventing** a rate, or money
 * losing precision by round-tripping through a float. Neither happens here:
 *
 *   - The rate lives in this table, in the adapter, exactly like Paystack's
 *     status vocabulary or Stripe's fee schedule. Core never sees it.
 *   - A conversion is recorded as two integer minor-unit amounts -- a debit
 *     in the source currency and a credit in the destination -- with the rate
 *     stored alongside as metadata. The ledger stays integers end to end.
 *   - `getBalance` still folds per currency. There is no cross-currency
 *     arithmetic anywhere in core.
 *
 * So the engine still never converts. The adapter quotes, and the ledger
 * records what was quoted. docs/wewire.md says exactly this.
 *
 * ## Why the rates are fixed
 *
 * WeWire refreshes on a 30-minute cycle from its liquidity providers. paybox
 * cannot: a rate that moved between two runs would make the same inputs
 * produce different output, which is the one property this project will not
 * trade away. The mid rates below are plausible round numbers, not market
 * data, and `docs/wewire.md` says so in as many words.
 */

/** Mid rates against USD. Every pair is derived from these two lookups. */
const MID_TO_USD: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  GHS: 0.065,
  NGN: 0.00065,
  KES: 0.0077,
  ZAR: 0.055,
};

/**
 * WeWire's spread, applied symmetrically around the mid.
 *
 * *"The difference between the bid and ask rates is known as the spread."*
 * The real figure is not published, so 0.5% is a documented stand-in rather
 * than a claim about WeWire's pricing.
 */
const SPREAD = 0.005;

export const WEWIRE_CURRENCIES = Object.keys(MID_TO_USD);

/** Source wallets WeWire supports for offshore payouts today. */
export const PAYOUT_SOURCE_CURRENCIES = ['USD', 'GBP', 'EUR'] as const;

export interface Quote {
  /** How much of `destination` one unit of `base` buys, at the mid. */
  mid: number;
  /** What WeWire pays for the base currency. */
  bid: number;
  /** What WeWire charges for it. */
  ask: number;
}

export function quote(base: string, destination: string): Quote {
  const from = MID_TO_USD[base];
  const to = MID_TO_USD[destination];
  if (from === undefined || to === undefined) {
    throw new PayboxError(
      'unsupported_currency',
      `No rate for ${base}/${destination}. Supported: ${WEWIRE_CURRENCIES.join(', ')}.`,
      { details: { wewireCode: 'CURRENCY_NOT_SUPPORTED' } },
    );
  }
  const mid = from / to;
  return {
    mid: round(mid),
    bid: round(mid * (1 - SPREAD)),
    ask: round(mid * (1 + SPREAD)),
  };
}

/** Every ordered pair, for `GET /v1/rates`. */
export function allPairs(): { base: string; destination: string; quote: Quote }[] {
  const pairs: { base: string; destination: string; quote: Quote }[] = [];
  for (const base of WEWIRE_CURRENCIES) {
    for (const destination of WEWIRE_CURRENCIES) {
      if (base === destination) continue;
      pairs.push({ base, destination, quote: quote(base, destination) });
    }
  }
  return pairs;
}

/**
 * Convert an integer minor-unit amount at the quoted rate.
 *
 * The only place a rate is ever applied. It takes integers and returns
 * integers -- the float exists for exactly one multiplication and is rounded
 * away before anything is stored.
 */
export function convertMinor(
  amountMinor: number,
  base: string,
  destination: string,
  exponentDelta: number,
): { amount: number; rate: number } {
  const rate = quote(base, destination).bid;
  const converted = Math.round(amountMinor * rate * 10 ** exponentDelta);
  return { amount: converted, rate };
}

/** Rates are quoted to six significant decimals, which covers NGN/USD. */
function round(value: number): number {
  return Number(value.toPrecision(8));
}
