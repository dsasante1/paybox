import { PayboxError } from '@paybox/shared';

/**
 * Quid Payments is Ghana-only, and its published `CurrencyEnum` has exactly
 * one member. A session in anything else is rejected at the boundary rather
 * than converted — paybox never performs FX (spec §6).
 */
export const QUIDDPAY_CURRENCY = 'GHS';

/**
 * The three rails Quid collects on, published as `RailEnum`.
 *
 * Card is deliberately absent, and not because paybox has not got to it: Quid
 * states "Card payments are not supported. Merchants must not submit card
 * data." Where a provider does not do something, neither does paybox.
 */
export const QUIDDPAY_RAILS = ['momo', 'bank_transfer', 'cash'] as const;
export type QuiddpayRail = (typeof QUIDDPAY_RAILS)[number];

/**
 * Mobile-money networks, published as `NetworkEnum` with these exact ids and
 * labels (`docs.quiddpayments.com/openapi.json`, read 2026-09-15). Quid's
 * payout guide is explicit that the payer selects the current network and the
 * integration must not infer it from the number, so nothing here guesses.
 */
export const MOMO_NETWORKS = [
  { id: 'mtn', name: 'MTN MoMo' },
  { id: 'telecel', name: 'Telecel Cash' },
  { id: 'at', name: 'AT Money' },
] as const;

/**
 * The checkout-side operator names, published as `OperatorEnum`.
 *
 * Quid carries **two** vocabularies for one concept: hosted checkout takes an
 * `operator` (`MTN`, `VODAFONE`, `AIRTEL_TIGO`, `AIRTEL`, `TIGO`) while
 * payouts take a `network` (`mtn`, `telecel`, `at`). The lists do not even
 * correspond one-to-one — the checkout list still carries the pre-rename
 * `VODAFONE` and the split `AIRTEL`/`TIGO` entries. Both are reproduced as
 * published, and `networkForOperator` is the only place they meet.
 */
export const CHECKOUT_OPERATORS = ['MTN', 'VODAFONE', 'AIRTEL_TIGO', 'AIRTEL', 'TIGO'] as const;
export type CheckoutOperator = (typeof CHECKOUT_OPERATORS)[number];

/** Checkout's `operator` -> the payout side's `network`. */
export function networkForOperator(operator: string): string {
  switch (operator.toUpperCase()) {
    case 'MTN':
      return 'mtn';
    case 'VODAFONE':
      // Vodafone Ghana became Telecel Ghana in 2023. Quid's checkout enum
      // still says VODAFONE and its payout enum says telecel; this is where
      // that history is absorbed.
      return 'telecel';
    case 'AIRTEL_TIGO':
    case 'AIRTEL':
    case 'TIGO':
      return 'at';
    default:
      return 'mtn';
  }
}

export function networkName(id: string): string {
  return MOMO_NETWORKS.find((network) => network.id === id)?.name ?? id;
}

/**
 * The bank directory.
 *
 * Real Ghanaian institutions under slug ids of the form Quid's payout guide
 * gives as its worked example (`gcb-bank`). Real names and real ids so a
 * payload copied out of a developer's own code works here unchanged — but
 * nothing is ever resolved against a real institution, and no account number
 * here belongs to anyone (spec §29).
 *
 * Quid publishes no full directory, so this list is paybox's. docs/quiddpay.md
 * says so rather than implying the emulator knows Quid's real coverage.
 */
export const GHANA_BANKS = [
  { id: 'gcb-bank', display_name: 'GCB Bank' },
  { id: 'absa-ghana', display_name: 'Absa Bank Ghana' },
  { id: 'ecobank-ghana', display_name: 'Ecobank Ghana' },
  { id: 'stanbic-ghana', display_name: 'Stanbic Bank Ghana' },
  { id: 'fidelity-bank', display_name: 'Fidelity Bank Ghana' },
  { id: 'cal-bank', display_name: 'CalBank' },
  { id: 'zenith-ghana', display_name: 'Zenith Bank Ghana' },
  { id: 'adb-bank', display_name: 'Agricultural Development Bank' },
] as const;

export function bankName(id: string): string {
  return GHANA_BANKS.find((bank) => bank.id === id)?.display_name ?? id;
}

export function isKnownBank(id: string): boolean {
  return GHANA_BANKS.some((bank) => bank.id === id);
}

/**
 * Where a cash deposit can be made.
 *
 * Quid's `PublicCheckoutOptions` carries `cash_instruments` and
 * `branch_payment_methods` without publishing their contents, so these are
 * paybox's, shaped to the published `BranchOption` and `ChoiceOption`
 * components.
 */
export const CASH_INSTRUMENTS = [
  { value: 'cash', label: 'Cash' },
  { value: 'cheque', label: 'Cheque' },
] as const;

export const BRANCH_PAYMENT_METHODS = [
  { id: 'accra-central', name: 'Accra Central', code: 'ACC-001' },
  { id: 'kumasi-adum', name: 'Kumasi Adum', code: 'KSI-001' },
  { id: 'takoradi-market-circle', name: 'Takoradi Market Circle', code: 'TDI-001' },
] as const;

/**
 * The payout fee, in pesewas.
 *
 * **paybox's own schedule, not Quid's.** Quid's guide says to review the fee
 * from `POST /api/v1/payouts/quote` and never publishes the numbers behind it,
 * so there is nothing to transcribe. A fixed table is used rather than a
 * percentage of a moving rate for the same reason `providers/wewire/rates.ts`
 * is fixed: a fee that varied would break determinism, and the same request
 * plus the same seed must produce byte-identical output.
 *
 * What *is* faithful is the shape around it: the fee is quoted, the quote
 * reserves nothing, and `max_fee_minor` caps what the merchant will accept.
 */
const BANK_FEE_MINOR = 250;
const MOMO_FEE_MINOR = 100;

export function payoutFee(accountType: string): number {
  return accountType === 'momo' ? MOMO_FEE_MINOR : BANK_FEE_MINOR;
}

/** How long Quid's payout quote stands. Its own guide: a preview, not a lock. */
export const QUOTE_TTL_MS = 15 * 60_000;

/** Default checkout-session lifetime when the caller names none. */
export const SESSION_TTL_MS = 30 * 60_000;

/** How long a cash deposit slip stands before a teller can no longer take it. */
export const CASH_SLIP_TTL_MS = 24 * 60 * 60_000;

/**
 * Normalise a Ghanaian mobile number to the `+233` form Quid returns.
 *
 * Quid's payout guide: "Use a Ghana mobile number such as 0241234567 or
 * +233241234567; the API returns +233 format." Both accepted, one echoed.
 */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+233')) return digits;
  if (digits.startsWith('233')) return `+${digits}`;
  if (digits.startsWith('0')) return `+233${digits.slice(1)}`;
  return `+233${digits}`;
}

/** The last four digits, for the masked echo on account verification. */
export function phoneLast4(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.slice(-4).padStart(4, '0');
}

export function assertCurrency(code: string | undefined): string {
  const currency = (code ?? QUIDDPAY_CURRENCY).toUpperCase();
  if (currency !== QUIDDPAY_CURRENCY) {
    throw new PayboxError(
      'unsupported_currency',
      `Quid Payments settles in ${QUIDDPAY_CURRENCY} only; ${currency} is not supported.`,
    );
  }
  return currency;
}
