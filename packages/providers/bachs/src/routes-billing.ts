import type { FastifyInstance } from 'fastify';
import type { Subscription } from '@paybox/shared';
import { resolveCard } from './cards.js';
import { fail } from './errors.js';
import { mediaOf } from './uploads.js';
import { assertMetadata, newestFirst, notFound, readPage } from './http.js';
import { hexId } from './ids.js';
import { toMinor } from './money.js';
import { canConvert } from './rates.js';
import { hasCapability } from './accounts.js';
import { feeOnTop, settingsOf } from './settings.js';
import { owns, ownerField, type Actor } from './actor.js';
import type { RouteContext } from './route-context.js';
import {
  cancelSubscriptionSchema,
  createChargeSchema,
  createProductGroupSchema,
  getProductGroupQuery,
  listProductGroupsQuery,
  listSubscriptionsQuery,
  updateProductGroupSchema,
  updateSubscriptionSchema,
} from './schemas.js';
import {
  pagination,
  serializePayment,
  serializeProduct,
  serializeProductGroup,
  serializeSubscription,
  type SubscriptionView,
} from './serializers.js';
import type { StoredProductGroup, StoredSubscription } from './state.js';

const PROVIDER = 'bachs' as const;

/**
 * Subscriptions, product groups and off-session charges.
 *
 * Shapes from the pinned OpenAPI document (listSubscriptions,
 * getSubscription, updateSubscription, cancelSubscription, the five
 * product-group operations, createCharge); behaviour from
 * guides/subscriptions/* and guides/payments/charge-a-saved-card, all read
 * 2026-10-10. There is no create-subscription endpoint: "You don't create
 * subscriptions directly" -- a checkout with a recurring product does.
 */
export function registerBillingRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { storage, state, clock, billing } = ctx;

  /** A subscription is its customer's owner's ("customer.subscription.*" originate on the account). */
  async function ownedSubscription(actor: Actor, id: string): Promise<StoredSubscription> {
    const stored = await state.subscriptions.get(id);
    const customer = stored ? await storage.customers.byId(stored.customerId) : null;
    if (!stored || !customer || (customer.subaccountId ?? null) !== actor.pot) throw notFound('Subscription');
    return stored;
  }

  /** Everything a subscription's serialisers need. */
  async function view(stored: StoredSubscription, core?: Subscription | null): Promise<SubscriptionView | null> {
    const subscription = core ?? (await storage.subscriptions.byId(stored.engineId));
    const customer = await storage.customers.byId(stored.customerId);
    if (!subscription || !customer) return null;
    const productRecord = await state.products.get(stored.productId);
    return {
      core: subscription,
      stored,
      status: billing.statusOf(stored, subscription),
      customer,
      customerRecord: await state.customers.get(customer.providerCustomerId),
      product: productRecord ? await storage.products.byId(productRecord.engineId) : null,
      productRecord,
    };
  }

  async function render(id: string) {
    const stored = await state.subscriptions.get(id);
    const built = stored ? await view(stored) : null;
    if (!built) throw notFound('Subscription');
    return serializeSubscription(built);
  }

  /* ------------------------------ subscriptions ----------------------------- */

  fastify.get('/v1/subscriptions', async (request, reply) => {
    const actor = await ctx.actor(request);
    const query = listSubscriptionsQuery.parse(request.query);
    const { limit, offset } = readPage(query, 50);
    let customerId: string | null = null;
    if (query.customer_id) {
      const customer = await storage.customers.byProviderCustomerId(PROVIDER, query.customer_id);
      // An unknown customer has no subscriptions rather than being an error.
      customerId = customer?.id ?? '';
    }
    const views: SubscriptionView[] = [];
    for (const stored of await state.subscriptions.all()) {
      if (!stored.engineId) continue;
      if (customerId !== null && stored.customerId !== customerId) continue;
      const built = await view(stored);
      if (!built || (built.customer.subaccountId ?? null) !== actor.pot) continue;
      if (query.status && built.status !== query.status) continue;
      views.push(built);
    }
    // "newest first"
    views.sort((a, b) => newestFirst(a.stored, b.stored));
    const page = views.slice(offset, offset + limit);
    return reply.send({
      items: page.map(serializeSubscription),
      pagination: pagination(views.length, limit, offset, page.length),
    });
  });

  fastify.get<{ Params: { subscription_id: string } }>('/v1/subscriptions/:subscription_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    await ownedSubscription(actor, request.params.subscription_id);
    return reply.send(await render(request.params.subscription_id));
  });

  fastify.patch<{ Params: { subscription_id: string } }>(
    '/v1/subscriptions/:subscription_id',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const body = updateSubscriptionSchema.parse(request.body ?? {});
      const id = request.params.subscription_id;
      await ownedSubscription(actor, id);

      // "Send exactly one intent per request ... Combining intents returns 400."
      const intents = (['product_id', 'trial_end', 'payment_method_id', 'metadata'] as const).filter(
        (key) => body[key] !== undefined,
      );
      if (intents.length !== 1) {
        throw fail(
          'validation_failed',
          'VALIDATION_ERROR',
          intents.length === 0
            ? 'Send exactly one of product_id, trial_end, payment_method_id or metadata.'
            : `Send exactly one intent per request; got ${intents.join(', ')}.`,
        );
      }
      if (body.proration_behavior !== undefined && body.product_id === undefined) {
        throw fail('validation_failed', 'VALIDATION_ERROR', 'proration_behavior applies only to a plan change (product_id).');
      }

      if (body.product_id !== undefined) {
        const behaviour = body.proration_behavior ?? 'invoice_now';
        if (behaviour !== 'invoice_now' && behaviour !== 'next_cycle' && behaviour !== 'none') {
          throw fail(
            'validation_failed',
            'PRORATION_BEHAVIOR_NOT_SUPPORTED',
            `proration_behavior "${behaviour}" is not supported. Use invoice_now, next_cycle or none.`,
          );
        }
        const stored = (await state.subscriptions.get(id))!;
        const target = await targetPlan(body.product_id, stored, actor);
        await billing.changePlan(id, { ...target, behaviour });
      } else if (body.trial_end !== undefined) {
        const at = Date.parse(body.trial_end);
        if (Number.isNaN(at)) {
          throw fail('validation_failed', 'VALIDATION_ERROR', 'trial_end: must be an ISO 8601 date-time.');
        }
        await billing.moveTrial(id, new Date(at).toISOString());
      } else if (body.payment_method_id !== undefined) {
        await billing.changePaymentMethod(id, body.payment_method_id);
      } else {
        if (body.metadata !== '') assertMetadata(body.metadata);
        await billing.updateMetadata(id, body.metadata!);
      }
      return reply.send(await render(id));
    },
  );

  /**
   * The product a plan change moves to. "The price is resolved from the
   * product for the subscription's currency."
   */
  async function targetPlan(productId: string, stored: StoredSubscription, actor: Actor) {
    const record = await state.products.get(productId);
    const product = record && owns(actor, record.account) ? await storage.products.byId(record.engineId) : null;
    if (!record || !product || record.archivedAt) {
      throw fail('validation_failed', 'PRODUCT_NOT_FOUND', `Product ${productId} does not exist or is archived.`);
    }
    if (!record.billingCycle) {
      throw fail('validation_failed', 'SUBSCRIPTION_PRICE_NOT_RECURRING', 'A subscription needs a recurring price.');
    }
    // "The target product must bill at the same interval as the subscription."
    if (
      record.billingCycle.interval !== stored.cycle.interval ||
      record.billingCycle.frequency !== stored.cycle.frequency
    ) {
      throw fail(
        'validation_failed',
        'SUBSCRIPTION_PLAN_INTERVAL_MISMATCH',
        "The target product's interval must match the subscription's.",
      );
    }
    const price = record.price;
    const option =
      price.currency === stored.currency
        ? { amount: price.amount }
        : price.currencyOptions.find((entry) => entry.currency === stored.currency);
    if (!option) {
      throw fail(
        'validation_failed',
        'PLAN_NOT_PRICED_IN_CURRENCY',
        `The target product has no price in ${stored.currency}.`,
      );
    }
    if (price.priceType !== 'fixed' || !option.amount) {
      throw fail(
        'validation_failed',
        'INVALID_SUBSCRIPTION_PRICE',
        'The price is not valid for a subscription. It must be recurring with a positive amount.',
      );
    }
    return {
      productId,
      productName: product.name,
      productEngineId: product.id,
      unitAmount: option.amount,
      cycle: record.billingCycle,
    };
  }

  fastify.delete<{ Params: { subscription_id: string } }>(
    '/v1/subscriptions/:subscription_id',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const body = cancelSubscriptionSchema.parse(request.body ?? {});
      const id = request.params.subscription_id;
      await ownedSubscription(actor, id);
      await billing.cancel(id, {
        atPeriodEnd: body.cancel_at_period_end ?? false,
        reason: body.reason ?? null,
      });
      return reply.send(await render(id));
    },
  );

  /* ------------------------------ product groups ---------------------------- */

  async function productViews(group: StoredProductGroup, includeArchived: boolean) {
    const organizationId = group.account ?? ctx.organizationId;
    const views = [];
    for (const productId of group.productIds) {
      const record = await state.products.get(productId);
      const product = record ? await storage.products.byId(record.engineId) : null;
      if (!record || !product) continue;
      if (record.archivedAt && !includeArchived) continue;
      views.push(
        serializeProduct(product, record, {
          organizationId,
          ...(await ctx.productTotals(productId)),
          media: await mediaOf(state, record, `${ctx.baseUrl}${ctx.basePath}`),
        }),
      );
    }
    return views;
  }

  /** "Every ID must be a product on your own account". */
  async function assertProducts(actor: Actor, productIds: string[]): Promise<void> {
    for (const productId of productIds) {
      const record = await state.products.get(productId);
      if (!record || !owns(actor, record.account)) {
        throw fail(
          'validation_failed',
          'INVALID_PRODUCT_REFERENCE',
          `A product ID is invalid or belongs to another merchant: ${productId}.`,
        );
      }
    }
  }

  async function loadGroup(actor: Actor, id: string): Promise<StoredProductGroup> {
    const group = await state.groups.get(id);
    if (!group || !owns(actor, group.account)) throw notFound('Product group');
    return group;
  }

  fastify.post('/v1/product-groups', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = createProductGroupSchema.parse(request.body);
    await assertProducts(actor, body.product_ids);
    const now = clock.nowISO();
    const group: StoredProductGroup = {
      ...ownerField(actor),
      seq: await state.nextSeq(),
      id: hexId(ctx.ids, 'pgrp', 20),
      name: body.name,
      productIds: body.product_ids,
      createdAt: now,
      updatedAt: now,
    };
    await state.groups.put(group);
    return reply.status(201).send(serializeProductGroup(group, actor.id, await productViews(group, false)));
  });

  fastify.get('/v1/product-groups', async (request, reply) => {
    const actor = await ctx.actor(request);
    const query = listProductGroupsQuery.parse(request.query);
    const { limit, offset } = readPage(query, 20);
    const groups = (await state.groups.all()).filter((group) => owns(actor, group.account)).sort(newestFirst);
    const page = groups.slice(offset, offset + limit);
    const items = [];
    for (const group of page) {
      items.push(serializeProductGroup(group, actor.id, await productViews(group, false)));
    }
    return reply.send({ pagination: pagination(groups.length, limit, offset, items.length), items });
  });

  fastify.get<{ Params: { group_id: string } }>('/v1/product-groups/:group_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const query = getProductGroupQuery.parse(request.query);
    const group = await loadGroup(actor, request.params.group_id);
    return reply.send(
      serializeProductGroup(group, actor.id, await productViews(group, query.include_archived === 'true')),
    );
  });

  fastify.patch<{ Params: { group_id: string } }>('/v1/product-groups/:group_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = updateProductGroupSchema.parse(request.body ?? {});
    const group = await loadGroup(actor, request.params.group_id);
    if (body.product_ids) await assertProducts(actor, body.product_ids);
    const next: StoredProductGroup = {
      ...group,
      ...(body.name !== undefined ? { name: body.name } : {}),
      // "What you send becomes the complete list and the display order".
      ...(body.product_ids !== undefined ? { productIds: body.product_ids } : {}),
      updatedAt: clock.nowISO(),
    };
    await state.groups.put(next);
    return reply.send(serializeProductGroup(next, actor.id, await productViews(next, false)));
  });

  fastify.delete<{ Params: { group_id: string } }>('/v1/product-groups/:group_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    await loadGroup(actor, request.params.group_id);
    // "Member products are not affected."
    await state.groups.delete(request.params.group_id);
    return reply.status(204).send();
  });

  /* --------------------------- off-session charges -------------------------- */

  /**
   * `POST /v1/charges` (beta). "This always answers with a payment, never an
   * error, when the card is refused": `201` with `processing`, settled a
   * second later by `collection.succeeded`, or already `failed`.
   */
  fastify.post('/v1/charges', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = createChargeSchema.parse(request.body);
    assertMetadata(body.metadata);
    const customer = await storage.customers.byProviderCustomerId(PROVIDER, body.customer);
    if (!customer || (customer.subaccountId ?? null) !== actor.pot) throw notFound('Customer');
    const currency = body.currency.toUpperCase();
    // "Cards collect in USD and NGN only"; another currency converts into the
    // card's own, and only those two are on the rate table.
    if (!canConvert(currency, 'USD')) {
      throw fail(
        'validation_failed',
        'PAYMENT_METHOD_NOT_ENABLED',
        `Your account cannot take card payments in ${currency}.`,
      );
    }
    const amount = toMinor(body.amount, currency);
    const { method, authorization } = await resolveCard(
      { storage, state, clock },
      customer,
      body.payment_method ?? null,
    );
    // An account's card charge needs its card capability for the card's currency.
    const capability = method.currency === 'NGN' ? 'ngn_card_collection' : 'card_collection';
    if (!hasCapability(actor.account, capability)) {
      throw fail('validation_failed', 'PAYMENT_METHOD_NOT_ENABLED', `This account's ${capability} capability is not active.`);
    }
    const payment = await billing.chargeCard({
      customer,
      method,
      authorization,
      amount,
      currency,
      meta: {
        billingReason: 'purchase',
        channel: 'api',
        subscriptionId: null,
        invoiceEngineId: null,
        reference: body.reference ?? null,
        description: body.description ?? null,
        metadata: body.metadata ?? {},
      },
      settle: 'later',
      // The account's fee preference: "when your account passes the fee to
      // the customer, the card is charged more than this".
      feeOnTop: feeOnTop(
        await settingsOf(state, actor.account?.id ?? null),
        amount,
        currency,
        method.currency === 'NGN' ? 'NGN_CARD' : 'USD_CARD',
      ),
    });
    return reply.status(201).send(serializePayment(payment, await ctx.paymentContext(payment)));
  });
}
