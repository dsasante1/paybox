import { PayboxError } from '@paybox/shared';

/**
 * Countries, currencies and payment options.
 *
 * ## Tingg carries two country vocabularies, and they disagree
 *
 * Checkout 3.0 documents `country_code` as a "3-digit ISO country code" and
 * its samples send `KEN`. Payouts documents `countryCode` and its samples send
 * `KE`. Same company, same transaction, two encodings -- and a merchant
 * collecting and disbursing in Kenya writes both. Preserved rather than
 * normalised, for the same reason Flutterwave's two envelopes are: smoothing
 * it over here would hide a real integration hazard.
 *
 * Verified 2026-09-20 at docs.tingg.africa/docs/checkout-v3-express-checkout
 * (`"country_code": "KEN"`), /reference/combined-checkout-charge (`"KEN"`),
 * /reference/postpayment (`"countryCode": "KE"`), /reference/querybill (`"TZ"`)
 * and /reference/validateaccount (`"GH"`).
 *
 * ## The list is paybox's, not Tingg's
 *
 * Tingg claims collection across 25 African countries and payouts across 35,
 * and publishes no machine-readable list of either. These five are the ones
 * that appear in worked examples across the pages read above. docs/tingg.md
 * says so plainly rather than implying the emulator knows Tingg's real
 * coverage.
 */
export interface TinggCountry {
  /** Checkout's `country_code`. */
  alpha3: string;
  /** Payouts' `countryCode`. */
  alpha2: string;
  name: string;
  currency: string;
  /** Dialling prefix, for normalising an msisdn to E.164 without a plus. */
  dialling: string;
}

export const TINGG_COUNTRIES: readonly TinggCountry[] = [
  { alpha3: 'KEN', alpha2: 'KE', name: 'Kenya', currency: 'KES', dialling: '254' },
  { alpha3: 'NGA', alpha2: 'NG', name: 'Nigeria', currency: 'NGN', dialling: '234' },
  { alpha3: 'GHA', alpha2: 'GH', name: 'Ghana', currency: 'GHS', dialling: '233' },
  { alpha3: 'TZA', alpha2: 'TZ', name: 'Tanzania', currency: 'TZS', dialling: '255' },
  { alpha3: 'UGA', alpha2: 'UG', name: 'Uganda', currency: 'UGX', dialling: '256' },
];

/** Accepts either encoding, because Tingg's own products accept different ones. */
export function findCountry(code: string): TinggCountry | null {
  const value = code.trim().toUpperCase();
  return (
    TINGG_COUNTRIES.find((c) => c.alpha3 === value || c.alpha2 === value) ?? null
  );
}

export function assertCountry(code: string): TinggCountry {
  const country = findCountry(code);
  if (!country) {
    throw new PayboxError(
      'invalid_request',
      `Unsupported country "${code}". paybox implements ${TINGG_COUNTRIES.map((c) => c.alpha3).join(', ')} — see docs/tingg.md.`,
    );
  }
  return country;
}

/**
 * Currencies these countries settle in.
 *
 * TZS and UGX are not in `SUPPORTED_CURRENCIES` in `@paybox/shared`, which is
 * a display-formatting list rather than a gate. Tingg quotes both in its own
 * samples (`"currencyCode": "TZS"`), so refusing them would be paybox
 * inventing a restriction the provider does not have.
 */
export const TINGG_CURRENCIES = TINGG_COUNTRIES.map((country) => country.currency);

export function assertCurrency(code: string, country: TinggCountry): string {
  const value = code.trim().toUpperCase();
  if (value !== country.currency) {
    throw new PayboxError(
      'unsupported_currency',
      `${country.name} settles in ${country.currency}; "${value}" was supplied. ` +
        'paybox never converts between currencies.',
    );
  }
  return value;
}

/**
 * Payment option codes.
 *
 * `payment_option_code` selects the rail, and Tingg's codes are **merchant
 * configured**: the integration dashboard page describes activating options
 * per service, and no complete list is published anywhere paybox could read.
 * The only code appearing in a worked example is `SAFKE` (Safaricom Kenya),
 * in /reference/combined-checkout-charge.
 *
 * So the adapter accepts *any* code rather than policing a list it does not
 * have, and classifies the handful it can attest. An unrecognised code is
 * treated as mobile money, which is Tingg's dominant rail in every market its
 * own examples use -- and docs/tingg.md records that this default is paybox's
 * inference, not Tingg's contract.
 */
export const TINGG_PAYMENT_OPTIONS: Record<string, { method: 'mobile_money' | 'card' | 'bank_transfer'; label: string }> = {
  SAFKE: { method: 'mobile_money', label: 'M-PESA (Safaricom Kenya)' },
};

export type TinggMethod = 'mobile_money' | 'card' | 'bank_transfer';

export function methodForOption(code: string | null | undefined): TinggMethod {
  if (!code) return 'mobile_money';
  return TINGG_PAYMENT_OPTIONS[code.trim().toUpperCase()]?.method ?? 'mobile_money';
}

export function optionLabel(code: string | null | undefined): string {
  if (!code) return 'Mobile money';
  return TINGG_PAYMENT_OPTIONS[code.trim().toUpperCase()]?.label ?? code;
}

/**
 * An msisdn in the shape Tingg's samples use: E.164 digits, no leading plus.
 *
 * Its express-checkout page says "Phone in E.164 format" and every sample is
 * bare digits (`254700000000`), so a `+` is stripped rather than rejected --
 * a developer whose own data carries one should not have to strip it first.
 */
export function normaliseMsisdn(value: string, country: TinggCountry): string {
  const digits = value.replace(/\D/g, '');
  if (digits.startsWith(country.dialling)) return digits;
  return `${country.dialling}${digits.replace(/^0+/, '')}`;
}

/** Never echo more than the tail of a payer's number. */
export function msisdnLast4(value: string): string {
  return value.replace(/\D/g, '').slice(-4);
}

/** How long a checkout stays payable when the caller names no `due_date`. */
export const CHECKOUT_TTL_MS = 12 * 60 * 60 * 1_000;
