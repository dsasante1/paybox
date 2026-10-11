/**
 * Bachs' processing fees, as published (docs.bachs.io/for-you/fees, read
 * 2026-10-10). Pure arithmetic on integer minor units, rounded half-up, so a
 * payment's `fees`, `settlement_amount` and `processing_fee` are reproducible.
 *
 * Checked against Bachs' own worked examples: a ₦75,000.00 bank transfer
 * carries a ₦1,125.00 fee and settles ₦73,875.00 (collection.succeeded), and
 * a $29.00 card charge carries $1.85 (5% + $0.40; charge-a-saved-card).
 *
 * Not modelled: the extra 1.5% Bachs adds for an *international* USD card.
 * Nothing on a test card number says where it was issued, so every card here
 * is domestic. docs/bachs.md says so.
 */
export type Corridor =
  | 'USD_CARD'
  | 'NGN_CARD'
  | 'NGN_BANK_TRANSFER'
  | 'MOMO_GHS'
  | 'MOMO_KES'
  | 'MOMO_TZS'
  | 'MOMO_UGX'
  | 'MOMO_XAF'
  | 'MOMO_XOF'
  | 'MOMO_RWF'
  | 'MOMO_MWK'
  | 'MOMO_ZMW'
  | 'CRYPTO';

/** Percentage in basis points, plus a fixed part and a cap, all in minor units. */
interface FeeRule {
  bps: number;
  fixed: number;
  cap: number | null;
}

const RULES: Record<'card_usd' | 'card_ngn' | 'bank_ngn' | 'momo' | 'crypto', FeeRule> = {
  card_usd: { bps: 500, fixed: 40, cap: null },
  card_ngn: { bps: 200, fixed: 0, cap: null },
  bank_ngn: { bps: 150, fixed: 0, cap: 200_000 },
  momo: { bps: 350, fixed: 0, cap: null },
  crypto: { bps: 150, fixed: 0, cap: null },
};

function ruleFor(corridor: Corridor): FeeRule {
  if (corridor === 'USD_CARD') return RULES.card_usd;
  if (corridor === 'NGN_CARD') return RULES.card_ngn;
  if (corridor === 'NGN_BANK_TRANSFER') return RULES.bank_ngn;
  if (corridor === 'CRYPTO') return RULES.crypto;
  return RULES.momo;
}

/**
 * A deposit into the account's permanent virtual account: "1% capped at
 * NGN 300" (guides/virtual-accounts/overview), not the checkout transfer rate.
 */
export function virtualAccountFee(amount: number): number {
  return Math.min(Math.floor((amount * 100 + 5_000) / 10_000), 30_000);
}

/** The processing fee on `amount` minor units collected through `corridor`. */
export function processingFee(amount: number, corridor: Corridor): number {
  const rule = ruleFor(corridor);
  // Half-up on the basis-point product: (amount * bps + 5000) / 10000.
  const percentage = Math.floor((amount * rule.bps + 5_000) / 10_000);
  const fee = percentage + rule.fixed;
  return rule.cap === null ? fee : Math.min(fee, rule.cap);
}
