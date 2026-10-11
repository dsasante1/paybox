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
  // Bachs' mobile-money corridors reach six markets the other adapters do
  // not. Supporting a currency is only knowing its exponent; it converts
  // nothing.
  'TZS',
  'UGX',
  'XAF',
  'RWF',
  'MWK',
  'ZMW',
] as const;

export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Currencies with no minor unit. Amounts for these are whole numbers. */
// UGX and RWF are exponent 0 in ISO 4217 but are deliberately not listed:
// Bachs prints every amount with two decimals, and Tingg's schema converts
// major units with a fixed x100, so both treat them as two-place currencies
// on the wire. Listing them here would make Tingg store a UGX amount at 100x
// its value. XOF and XAF predate that and stay.
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
