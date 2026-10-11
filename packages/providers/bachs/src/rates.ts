import { minorUnitExponent } from '@paybox/shared';

/**
 * Bachs' exchange rates, fixed.
 *
 * Bachs converts at "the prevailing rate" (charge-a-saved-card,
 * any-currency-checkout, payouts; read 2026-10-10), which moves; a moving rate
 * would break paybox's same-seed, same-output promise. So every rate is a
 * constant, and docs/bachs.md lists them.
 *
 * Bachs holds balances in USD and NGN only; a collection in any other
 * currency "is converted when it settles" into USD, and international payouts
 * are funded from USD. So every rate here is expressed against the dollar:
 * units of the currency per one US dollar, as a whole number of
 * hundred-thousandths so that GBP's 0.79 is exact. 1,500 NGN is the figure
 * Bachs' own worked examples use most often; the rest are round figures of
 * the right magnitude, chosen for this emulator and not taken from Bachs.
 * Stablecoins are one dollar.
 *
 * Amounts stay integer minor units on both sides (CLAUDE.md: the engine never
 * converts). The adapter quotes, and the engine records what was quoted.
 */
const SCALE = 100_000n;

const PER_USD: Record<string, bigint> = {
  USD: 100_000n,
  NGN: 150_000_000n,
  GHS: 1_500_000n,
  KES: 13_000_000n,
  TZS: 260_000_000n,
  UGX: 370_000_000n,
  XAF: 60_000_000n,
  XOF: 60_000_000n,
  RWF: 140_000_000n,
  MWK: 175_000_000n,
  ZMW: 2_600_000n,
  GBP: 79_000n,
  EUR: 92_000n,
  CAD: 137_000n,
};

/** The eight stablecoin payout codes; each is one US dollar. */
export const STABLECOINS = [
  'USDT_TRC20',
  'USDT_BEP20',
  'USDT_ERC20',
  'USDT_SOL',
  'USDC_ERC20',
  'USDC_BEP20',
  'USDC_SOL',
  'USDC_BASE',
] as const;

export const NGN_PER_USD = 1_500;

/** The two currencies a Bachs balance can be held in. */
export const HELD = ['USD', 'NGN'] as const;

export function isHeld(currency: string): boolean {
  return (HELD as readonly string[]).includes(currency);
}

export function isStablecoin(code: string): boolean {
  return (STABLECOINS as readonly string[]).includes(code);
}

function perUsd(currency: string): bigint {
  if (isStablecoin(currency)) return SCALE;
  const rate = PER_USD[currency];
  if (rate === undefined) throw new Error(`No Bachs rate for ${currency}.`);
  return rate;
}

/** Minor-unit exponent, with stablecoins at two places like the dollar. */
function exponent(currency: string): number {
  return isStablecoin(currency) ? 2 : minorUnitExponent(currency);
}

/** Stablecoin codes print like dollars: two places. */
export function decimalCurrency(code: string): string {
  return isStablecoin(code) ? 'USD' : code;
}

export function hasRate(currency: string): boolean {
  return isStablecoin(currency) || currency in PER_USD;
}

/** Kept for the card-currency check: the two currencies a card bills in. */
export function canConvert(from: string, to: string): boolean {
  return isHeld(from) && isHeld(to);
}

/**
 * Convert minor units of `from` into minor units of `to`, rounded half-up on
 * the magnitude, exactly (BigInt, no float).
 */
export function convertMinor(amount: number, from: string, to: string): number {
  if (from === to) return amount;
  const sign = amount < 0 ? -1n : 1n;
  const magnitude = BigInt(Math.abs(amount));
  // amount / 10^ef / (pf/S) * (pt/S) * 10^et
  const numerator = magnitude * perUsd(to) * 10n ** BigInt(exponent(to));
  const denominator = perUsd(from) * 10n ** BigInt(exponent(from));
  const rounded = (numerator * 2n + denominator) / (2n * denominator);
  return Number(sign * rounded);
}

/**
 * "1 from_currency = X to_currency", as Bachs prints it: two decimal places
 * where the figure allows (`"1500.00"`), more where it would otherwise read
 * as zero (`"0.000667"`).
 */
export function exchangeRate(from: string, to: string): string {
  const scaled = (perUsd(to) * 1_000_000n * 2n + perUsd(from)) / (2n * perUsd(from));
  const value = Number(scaled) / 1_000_000;
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(6);
}
