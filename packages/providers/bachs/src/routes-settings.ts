import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail } from './errors.js';
import type { RouteContext } from './route-context.js';
import { CORRIDORS, CRYPTO_ASSETS } from './routes-checkout.js';
import { availableCurrencies, parseMethods, settingsOf, type StoredCheckoutSettings } from './settings.js';

const updateSettingsSchema = z.object({
  enabled_payment_methods: z.unknown().optional(),
  fee_preference: z.enum(['customer_pays', 'org_pays']).optional(),
});

const railsQuery = z.object({
  payment_method: z.enum(['CARD', 'CRYPTO', 'BANK_TRANSFER', 'MOBILE_MONEY']),
  currency: z.string().min(1),
  country_code: z.string().regex(/^[A-Za-z]{2}$/).optional(),
});

/** The mobile money currencies a checkout collects in (the MOMO_* corridors). */
const MOMO_CURRENCIES = Object.values(CORRIDORS)
  .filter((corridor) => corridor.method === 'mobile_money')
  .map((corridor) => corridor.currency!);

/**
 * listPaymentMethods. The published example shows two of the four methods
 * its rails enum names; `currencies` follow the documented collection lists
 * (bank transfer "collects in NGN only", where the example says NGN and USD).
 * `icon` is a display hint: the example's two are kept, and the other two
 * are paybox's.
 */
const PAYMENT_METHODS = [
  {
    id: 'CARD',
    display_name: 'Card',
    icon: 'card',
    description: 'Pay with a debit or credit card',
    type: 'fiat',
    enabled_by_default: true,
    currencies: ['USD', 'NGN'],
  },
  {
    id: 'BANK_TRANSFER',
    display_name: 'Bank Transfer',
    icon: 'bank',
    description: 'Pay via bank transfer',
    type: 'fiat',
    enabled_by_default: true,
    currencies: ['NGN'],
  },
  {
    id: 'MOBILE_MONEY',
    display_name: 'Mobile Money',
    icon: 'mobile_money',
    description: 'Pay with a mobile money wallet',
    type: 'fiat',
    enabled_by_default: true,
    currencies: MOMO_CURRENCIES,
  },
  {
    id: 'CRYPTO',
    display_name: 'Cryptocurrency',
    icon: 'crypto',
    description: 'Pay with supported crypto assets',
    type: 'crypto',
    enabled_by_default: true,
    currencies: [...CRYPTO_ASSETS],
  },
];

/** listPaymentRails: the one rail Bachs publishes. */
const RAILS: Array<{ method: string; currency: string; country: string; id: string; name: string }> = [
  { method: 'BANK_TRANSFER', currency: 'NGN', country: 'NG', id: 'bank_transfer_ng', name: 'Bank Transfer Nigeria' },
];

/** listSupportedCurrencies: the supported-currencies page's collection lists (the spec example adds ZAR and BTC). */
const SUPPORTED = {
  fiat: ['USD', 'NGN', 'GHS', 'KES', 'MWK', 'RWF', 'TZS', 'UGX', 'XAF', 'XOF', 'ZMW'],
  crypto: [...CRYPTO_ASSETS],
};

/**
 * Checkout settings and the collection listings.
 *
 * Sources (read 2026-10-10): the pinned OpenAPI document
 * (getCheckoutSettings, updateCheckoutSettings, listPaymentMethods,
 * listPaymentRails, listSupportedCurrencies), connect/processing-fees and
 * for-you/supported-currencies. docs/bachs.md records where they disagree.
 */
export function registerSettingsRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { state } = ctx;

  const view = (settings: StoredCheckoutSettings, organizationId: string) => ({
    organization_id: organizationId,
    enabled_payment_methods: settings.enabledPaymentMethods,
    fee_preference: settings.feePreference,
    available_currencies: availableCurrencies(),
  });

  fastify.get('/v1/accounts/checkout/settings', async (request, reply) => {
    const actor = await ctx.actor(request);
    return reply.send(view(await settingsOf(state, actor.account?.id ?? null), actor.id));
  });

  /**
   * "Replaces the stored map wholesale": a corridor not sent is off.
   * `fee_preference`, omitted, is kept.
   */
  fastify.put('/v1/accounts/checkout/settings', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = updateSettingsSchema.parse(request.body ?? {});
    if (body.enabled_payment_methods === undefined && body.fee_preference === undefined) {
      throw fail('validation_failed', 'VALIDATION_ERROR', 'Send enabled_payment_methods, fee_preference, or both.');
    }
    const account = actor.account?.id ?? null;
    const current = await settingsOf(state, account);
    const next: StoredCheckoutSettings = {
      ...current,
      ...(body.enabled_payment_methods !== undefined
        ? { enabledPaymentMethods: parseMethods(body.enabled_payment_methods) }
        : {}),
      ...(body.fee_preference ? { feePreference: body.fee_preference } : {}),
    };
    await state.checkoutSettings.put(next);
    return reply.send({
      organization_id: actor.id,
      enabled_payment_methods: next.enabledPaymentMethods,
      fee_preference: next.feePreference,
      message: 'Checkout settings updated successfully',
    });
  });

  fastify.get('/v1/payment-methods', async (request, reply) => {
    await ctx.actor(request);
    return reply.send({ payment_methods: PAYMENT_METHODS });
  });

  fastify.get('/v1/payment-methods/rails', async (request, reply) => {
    await ctx.actor(request);
    const query = railsQuery.parse(request.query);
    const currency = query.currency.toUpperCase();
    const country = query.country_code?.toUpperCase() ?? null;
    const rails = RAILS.filter(
      (rail) =>
        rail.method === query.payment_method && rail.currency === currency && (country === null || rail.country === country),
    ).map((rail) => ({ id: rail.id, name: rail.name, active: true }));
    return reply.send({ payment_method: query.payment_method, currency, country_code: country, rails });
  });

  fastify.get('/v1/currencies/supported', async (request, reply) => {
    await ctx.actor(request);
    return reply.send(SUPPORTED);
  });
}
