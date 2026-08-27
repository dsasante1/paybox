/**
 * Currency handling (spec §17).
 *
 * We never convert. The amount the developer supplied is the amount we store
 * and the amount we echo back. The only thing we need to know per-currency is
 * the number of minor units, so that formatting for the dashboard and the
 * checkout page is correct.
 */
export const SUPPORTED_CURRENCIES = [
  'GHS',
  'NGN',
  'USD',
  'KES',
  'ZAR',
  'GBP',
  'EUR',
  'XOF',
  'EGP',
] as const;

export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Currencies with no minor unit. Amounts for these are whole numbers. */
const ZERO_DECIMAL = new Set(['XOF', 'XAF', 'JPY', 'KRW']);

export function minorUnitExponent(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function isSupportedCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value.toUpperCase());
}

/**
 * Format minor units for human display. 10000 GHS-minor -> "GHS 100.00".
 * Display only -- never feed this back into an amount field.
 */
export function formatAmount(minor: number, currency: string): string {
  const exp = minorUnitExponent(currency);
  const major = minor / 10 ** exp;
  return `${currency.toUpperCase()} ${major.toFixed(exp)}`;
}
