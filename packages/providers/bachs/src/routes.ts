import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import type { Clock, IdFactory, Payment } from '@paybox/shared';
import type { PaymentEngine, Storage } from '@paybox/core';
import type { PaymentSimulator } from '@paybox/simulator';
import type { WebhookDispatcher } from '@paybox/webhooks';
import { assertBachsCredentials } from './auth.js';
import { bachsErrorBody, toBachsError } from './errors.js';
import { registerIdempotency, registerResponseHeaders } from './http.js';
import { uuidFrom } from './ids.js';
import type { RouteContext } from './route-context.js';
import { registerCatalogRoutes } from './routes-catalog.js';
import { BachsDisputes } from './disputes.js';
import { registerDisputeRoutes } from './routes-disputes.js';
import { UPLOAD_MAX_BYTES } from './uploads.js';
import { registerCheckoutRoutes } from './routes-checkout.js';
import { registerPaymentRoutes } from './routes-payments.js';
import { registerWebhookRoutes } from './routes-webhooks.js';
import { BachsBilling, invoiceIdOf, type RecoveryMode } from './billing.js';
import { refundRecord } from './refunds.js';
import { registerBillingRoutes } from './routes-billing.js';
import { registerMoneyOutRoutes } from './routes-money-out.js';
import { BachsTreasury } from './treasury.js';
import { registerPortalRoutes } from './routes-portal.js';
import { customerName, type PaymentContext, type PaymentInvoiceInfo } from './serializers.js';
import { bachsState, type StoredRefund } from './state.js';

export interface BachsPluginOptions {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  storage: Storage;
  clock: Clock;
  ids: IdFactory;
  dispatcher: WebhookDispatcher;
  organizationId: string;
  baseUrl: string;
  basePath: string;
  allowAnyKey?: boolean;
  /** What happens when subscription recovery runs out; a dashboard-only setting at Bachs. */
  subscriptionRecovery?: RecoveryMode;
}

/**
 * Bachs-compatible HTTP surface (spec §13, §33).
 *
 * Registered as its own encapsulated plugin with its own error serialiser, so
 * a Bachs request is never answered in another provider's envelope. Routes
 * translate requests into engine calls and back; no payment behaviour lives
 * here (spec §30).
 *
 * Sources, pinned: the OpenAPI document at docs.bachs.io/docs/openapi/
 * openapi.json (sha256 9c2265585c2b…4810) for every REST shape, and the
 * event pages under docs.bachs.io/guides/webhooks/events/ for webhook
 * payloads, all read 2026-10-10. Where the two disagree, docs/bachs.md says
 * which one paybox follows and why.
 *
 * Two audiences, as at Bachs:
 *
 *   merchant  `/v1/**`, Bearer `sk_sandbox_…`.
 *   payer     `/c/:token/**`, the hosted checkout, and `/portal/s/:token/**`,
 *             the customer portal. Unauthenticated -- a payer's browser holds
 *             no key -- and addressed by an unguessable token that the
 *             merchant API never exposes except inside `checkout_url` or a
 *             portal session's `url`.
 */
export const bachsPlugin: FastifyPluginAsync<BachsPluginOptions> = async (fastify, options) => {
  const { engine, storage, clock, ids } = options;
  const state = bachsState(storage, () => clock.nowISO());

  fastify.setErrorHandler((error, _request, reply) => {
    const mapped = toBachsError(error);
    return reply.status(mapped.status).send(mapped.body);
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send(bachsErrorBody('NOT_FOUND', `Unknown endpoint (${request.method} ${request.url.split('?')[0]}).`)),
  );

  // "Every response, success or error, includes an x-request-id header." A
  // UUID, as in Bachs' example. Derived from a request counter rather than
  // drawn from `ids`: a read must not move any id minted after it, or a
  // client that polls its own checkout would break same-seed replay.
  let requests = 0;
  registerResponseHeaders(fastify, {
    clock,
    requestId: () => uuidFrom(`request:${options.organizationId}:${(requests += 1)}`),
  });
  registerIdempotency(fastify, { state, clock });
  // File uploads are multipart; registered here so the parser exists only in
  // Bachs' scope. Each route checks its own, smaller, limit.
  await fastify.register(multipart, { limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 10 } });

  const authenticate = (request: FastifyRequest): string =>
    assertBachsCredentials(request.headers.authorization, { allowAnyKey: options.allowAnyKey ?? false });

  const billing = new BachsBilling({
    engine,
    storage,
    clock,
    ids,
    recovery: options.subscriptionRecovery ?? 'cancel',
  });

  async function invoiceInfo(engineId: string | null): Promise<PaymentInvoiceInfo | null> {
    if (!engineId) return null;
    const invoice = await storage.invoices.byId(engineId);
    if (!invoice) return null;
    const record = await state.invoices.get(engineId);
    return {
      invoice_id: invoiceIdOf(invoice.id),
      number: invoice.number,
      subscription_id: record?.subscriptionId ?? null,
      period_start: invoice.periodStart,
      period_end: invoice.periodEnd,
      kind: record?.kind ?? (invoice.billingReason === 'subscription_update' ? 'proration' : 'cycle'),
    };
  }

  async function paymentContext(payment: Payment): Promise<PaymentContext> {
    const checkout = await state.checkouts.byPayment(payment.id);
    const meta = await state.paymentMeta.get(payment.id);
    const customer = payment.customerId ? await storage.customers.byId(payment.customerId) : null;
    const refunds: StoredRefund[] = [];
    let hasLiveRefund = false;
    for (const refund of await storage.refunds.listByPayment(payment.id)) {
      refunds.push(await refundRecord(state, refund, payment));
      if (refund.status !== 'failed') hasLiveRefund = true;
    }
    return {
      checkout,
      meta,
      invoice: await invoiceInfo(meta?.invoiceEngineId ?? null),
      customer: customer
        ? {
            email: customer.email,
            name: customerName(customer, await state.customers.get(customer.providerCustomerId)),
          }
        : checkout?.customerDetails
          ? { email: checkout.customerDetails.email, name: checkout.customerDetails.name }
          : null,
      refunds,
      history: await storage.events.listByResource(payment.id),
      hasLiveRefund,
    };
  }

  const treasury = new BachsTreasury({ engine, storage, clock, ids });
  const ctx: RouteContext = {
    engine,
    simulator: options.simulator,
    storage,
    clock,
    ids,
    state,
    dispatcher: options.dispatcher,
    organizationId: options.organizationId,
    baseUrl: options.baseUrl,
    basePath: options.basePath,
    authenticate,
    paymentContext,
    billing,
    treasury,
    disputes: new BachsDisputes({ engine, storage, clock, ids, treasury }),
    productTotals: () => Promise.reject(new Error('catalog routes not registered')),
    // Replaced by the catalog routes, which own customer creation.
    customers: {
      create: () => Promise.reject(new Error('customer routes not registered')),
      update: () => Promise.reject(new Error('customer routes not registered')),
    },
  };

  registerCatalogRoutes(fastify, ctx);
  registerCheckoutRoutes(fastify, ctx);
  registerPaymentRoutes(fastify, ctx);
  registerBillingRoutes(fastify, ctx);
  registerMoneyOutRoutes(fastify, ctx);
  registerDisputeRoutes(fastify, ctx);
  registerPortalRoutes(fastify, ctx);
  registerWebhookRoutes(fastify, ctx);
};

/** Register the plugin under its own prefix, as the composition root does. */
export async function registerBachs(
  fastify: FastifyInstance,
  options: BachsPluginOptions,
): Promise<void> {
  await fastify.register(bachsPlugin, { ...options, prefix: options.basePath });
}
