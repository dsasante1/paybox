import { PayboxError } from '@paybox/shared';

/**
 * The FX rate table.
 *
 * Wise is a rate-first product: you quote a pair, then move money across it.
 * The reasoning for a **fixed** table rather than a live one is set out in
 * `docs/architecture.md` and is the same as WeWire's — a rate that moved
 * between two runs would make the same inputs produce different output, and
 * determinism is the property this project will not trade away.
 *
 * The rate lives here, in the adapter, exactly as Paystack's status vocabulary
 * lives in its own. Core never sees it and has no path that could produce one.
 * A conversion is recorded as two integer minor-unit amounts plus the rate
 * that produced them, so the ledger stays integers end to end.
 *
 * These are plausible round numbers, **not market data**. `docs/wise.md` says
 * so in as many words.
 */
const MID_TO_USD: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  AUD: 0.66,
  CAD: 0.73,
  JPY: 0.0067,
  SGD: 0.74,
  INR: 0.012,
  NGN: 0.00065,
  GHS: 0.065,
};

export const WISE_CURRENCIES = Object.keys(MID_TO_USD);

/**
 * Wise quotes a single mid-market `rate` and charges a visible fee, rather
 * than a bid/ask spread — that transparency is the company's whole pitch, and
 * `GET /rates` returns one `rate` per pair with no bid or ask
 * (`rateGet`, Wise Platform API OpenAPI 3.1.0, `2026Q3`, read 2026-08-29).
 *
 * paybox therefore has no spread here, unlike the WeWire adapter. Adding one
 * would misrepresent how Wise prices.
 */
export function rateFor(source: string, target: string): number {
  const from = MID_TO_USD[source];
  const to = MID_TO_USD[target];
  if (from === undefined || to === undefined) {
    throw new PayboxError(
      'unsupported_currency',
      `No rate for ${source}/${target}. Supported: ${WISE_CURRENCIES.join(', ')}.`,
      { details: { wiseCode: 'NOT_VALID', field: 'targetCurrency' } },
    );
  }
  return Number((from / to).toPrecision(8));
}

export function allRates(): { source: string; target: string; rate: number }[] {
  const rates: { source: string; target: string; rate: number }[] = [];
  for (const source of WISE_CURRENCIES) {
    for (const target of WISE_CURRENCIES) {
      if (source === target) continue;
      rates.push({ source, target, rate: rateFor(source, target) });
    }
  }
  return rates;
}

/**
 * Convert an integer minor-unit amount at the quoted rate.
 *
 * The only place a rate is ever applied. Integers in, integers out — the
 * float exists for one multiplication and is rounded away before anything is
 * stored.
 */
export function convertMinor(
  amountMinor: number,
  rate: number,
  exponentDelta: number,
): number {
  return Math.round(amountMinor * rate * 10 ** exponentDelta);
}

/**
 * Wise's fee, which paybox does not model.
 *
 * Wise's real pricing is a percentage plus a fixed component that varies by
 * corridor and pay-in method, published per route. Inventing a schedule would
 * produce numbers a developer might build against and that would be wrong
 * everywhere. Zero is the honest answer and `docs/wise.md` states it.
 */
export const WISE_FEE_MINOR = 0;
