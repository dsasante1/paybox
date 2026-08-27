import { z } from 'zod';

/**
 * Request schemas mirroring Paystack's documented bodies.
 *
 * Paystack accepts `amount` as either a string or a number of minor units, and
 * a good many integrations send the string form, so we accept both and
 * normalise -- rejecting the string would be an emulator-only failure the
 * developer would never hit in production.
 */
const minorAmount = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Amount must be a positive integer in the currency\'s minor unit.',
      });
      return z.NEVER;
    }
    return parsed;
  });

export const initializeSchema = z.object({
  email: z.string().email('A valid customer email is required.'),
  amount: minorAmount,
  currency: z.string().length(3).optional(),
  reference: z.string().min(1).max(100).optional(),
  callback_url: z.string().url().optional(),
  metadata: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  channels: z.array(z.string()).optional(),
  label: z.string().optional(),
});

export const chargeSchema = z.object({
  email: z.string().email(),
  amount: minorAmount,
  currency: z.string().length(3).optional(),
  reference: z.string().min(1).max(100).optional(),
  metadata: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  mobile_money: z
    .object({
      phone: z.string().min(6),
      provider: z.string().min(2),
    })
    .optional(),
  // A synthetic test card only. See packages/simulator/src/instruments.ts --
  // the emulator has no code path that could reach a real card network, and
  // `cvv` is accepted-and-discarded rather than rejected so that existing
  // integration code does not need editing to point at the emulator.
  card: z
    .object({
      number: z.string().min(12),
      expiry_month: z.string().optional(),
      expiry_year: z.string().optional(),
      cvv: z.string().optional(),
    })
    .optional(),
  bank: z
    .object({
      code: z.string(),
      account_number: z.string(),
    })
    .optional(),
});

export const refundSchema = z.object({
  transaction: z.union([z.string(), z.number()]).transform(String),
  amount: minorAmount.optional(),
  currency: z.string().length(3).optional(),
  customer_note: z.string().optional(),
  merchant_note: z.string().optional(),
});

export const customerSchema = z.object({
  email: z.string().email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  phone: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const recipientSchema = z.object({
  type: z.string().default('nuban'),
  name: z.string().min(1),
  account_number: z.string().min(4),
  bank_code: z.string().min(1),
  currency: z.string().length(3).default('NGN'),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const transferSchema = z.object({
  source: z.string().default('balance'),
  amount: minorAmount,
  recipient: z.string().min(1),
  reason: z.string().optional(),
  currency: z.string().length(3).optional(),
  reference: z.string().optional(),
});

export const checkoutPaySchema = z.object({
  method: z.enum(['card', 'mobile_money', 'bank']),
  card_number: z.string().optional(),
  phone: z.string().optional(),
  network: z.string().optional(),
});

/** Paystack accepts metadata as a JSON string; normalise to an object. */
export function normalizeMetadata(
  value: Record<string, unknown> | string | undefined,
): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw: value };
  }
}
