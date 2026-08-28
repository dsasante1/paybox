/**
 * Paystack's published transfer fee schedules.
 *
 * Transcribed 2026-08-28 from Paystack's **pricing pages**, one per country:
 * <https://paystack.com/pricing> (NG), `/gh/pricing`, `/za/pricing`,
 * `/ke/pricing`, `/ci/pricing`.
 *
 * ⚠️ These are a *commercial* source, not the API contract. Unlike the pinned
 * OpenAPI spec, a pricing page carries no version, no changelog and no
 * stability guarantee, and a merchant may have negotiated different rates
 * entirely. Everything here will go stale silently. `balance.transferFee` in
 * config overrides it per currency, and docs/paystack.md says all of this
 * plainly rather than presenting these numbers as verified behaviour.
 *
 * All amounts are integer minor units, like everything else in the emulator:
 * the pages quote major units, so NGN 10 is written 1_000 here.
 */

/** Where the money is going. Derived from the transfer recipient's type. */
export type TransferDestination = 'bank' | 'mobile_money';

interface Tier {
  /** Inclusive upper bound in minor units; null means "and above". */
  upTo: number | null;
  fee: number;
}

interface CurrencySchedule {
  /** Applied when the destination has no schedule of its own. */
  bank: readonly Tier[];
  mobileMoney?: readonly Tier[];
  /**
   * Whether a failed transfer keeps the fee.
   *
   * South Africa's page says "ZAR 3 per transfer (failed or successful)", so
   * there the fee is spent whatever happens. Everywhere else the reservation
   * is released in full.
   */
  chargedOnFailure?: boolean;
}

const SCHEDULES: Record<string, CurrencySchedule> = {
  // "Transfers of NGN 5,000 and below: NGN 10 | between NGN 5,001 and
  // NGN 50,000: NGN 25 | above NGN 50,000: NGN 50"
  NGN: {
    bank: [
      { upTo: 500_000, fee: 1_000 },
      { upTo: 5_000_000, fee: 2_500 },
      { upTo: null, fee: 5_000 },
    ],
  },
  // "Transfers to Mobile Money: GHS 1 | Transfers to bank accounts: GHS 8"
  GHS: {
    bank: [{ upTo: null, fee: 800 }],
    mobileMoney: [{ upTo: null, fee: 100 }],
  },
  // "ZAR 3 per transfer (failed or successful)"
  ZAR: {
    bank: [{ upTo: null, fee: 300 }],
    chargedOnFailure: true,
  },
  // Kenya publishes three ladders: M-PESA wallet, M-PESA Paybill/Till, and
  // bank. A transfer recipient's type cannot distinguish a wallet from a
  // Paybill/Till -- both are `mobile_money` -- so the wallet ladder is used
  // for both, and docs/paystack.md records the limitation.
  KES: {
    bank: [
      { upTo: 1_000_000, fee: 8_000 },
      { upTo: 5_000_000, fee: 12_000 },
      { upTo: 99_999_900, fee: 14_000 },
      { upTo: null, fee: 35_000 },
    ],
    mobileMoney: [
      { upTo: 150_000, fee: 2_000 },
      { upTo: 2_000_000, fee: 4_000 },
      { upTo: null, fee: 6_000 },
    ],
  },
};

/** Recipient type (Paystack's documented enum) -> destination. */
export function destinationForRecipientType(type: string): TransferDestination {
  return type === 'mobile_money' ? 'mobile_money' : 'bank';
}

/**
 * The fee Paystack would hold for this transfer.
 *
 * `override` is the configured flat rate for the currency; when present it
 * wins outright, because a merchant who has entered their negotiated rate
 * knows better than a marketing page.
 */
export function paystackTransferFee(input: {
  amount: number;
  currency: string;
  destination: TransferDestination;
  override?: number | undefined;
  enabled?: boolean;
}): number {
  if (input.enabled === false) return 0;
  if (input.override !== undefined) return Math.max(0, Math.trunc(input.override));

  const schedule = SCHEDULES[input.currency.toUpperCase()];
  if (!schedule) return 0;

  const tiers =
    input.destination === 'mobile_money' && schedule.mobileMoney
      ? schedule.mobileMoney
      : schedule.bank;

  for (const tier of tiers) {
    if (tier.upTo === null || input.amount <= tier.upTo) return tier.fee;
  }
  return tiers.at(-1)?.fee ?? 0;
}

/** False only where the provider keeps the fee on a failed transfer. */
export function transferFeeRefundable(currency: string): boolean {
  return SCHEDULES[currency.toUpperCase()]?.chargedOnFailure !== true;
}
