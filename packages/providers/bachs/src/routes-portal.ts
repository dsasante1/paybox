import type { FastifyInstance } from 'fastify';
import { PayboxError, type Customer } from '@paybox/shared';
import { assertNotExpired, cardFacts, TEST_CARDS, saveCard } from './cards.js';
import { fail } from './errors.js';
import { notFound } from './http.js';
import { hexId, portalToken } from './ids.js';
import { renderPortalExpired, renderPortalPage, type PortalSubscription } from './portal-page.js';
import type { RouteContext } from './route-context.js';
import type { StoredPortalSession } from './state.js';
import { invoiceStatusOf } from './status.js';
import { invoiceIdOf } from './billing.js';

const PROVIDER = 'bachs' as const;

/**
 * "Short-lived", and nothing more specific (guides/customer-portal/
 * create-portal-session). An hour of virtual time is paybox's figure, stated
 * in docs/bachs.md.
 */
const PORTAL_SESSION_MS = 3_600_000;

/**
 * The customer portal (guides/customer-portal/*, read 2026-10-10).
 *
 * `POST /v1/customers/{id}/portal-sessions` returns a URL whose token is the
 * credential; the `psn_` id "is not a credential and cannot be exchanged for
 * access". The page behind it is paybox's, like the hosted checkout, and
 * offers what an account with Bachs' default portal settings offers -- those
 * settings are dashboard-only, with no API:
 *
 *   on   view subscriptions, cancel (at period end, "By default the portal
 *        cancels at the end of the period"), undo a scheduled cancellation,
 *        invoice history, recovery payment for past_due/unpaid, view cards
 *   off  switching plans, adding or removing cards, editing name and phone
 */
export function registerPortalRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { storage, state, clock, ids, authenticate, billing } = ctx;

  fastify.post<{ Params: { customer_id: string } }>(
    '/v1/customers/:customer_id/portal-sessions',
    async (request, reply) => {
      authenticate(request);
      const customer = await storage.customers.byProviderCustomerId(PROVIDER, request.params.customer_id);
      if (!customer) throw notFound('Customer');
      const now = clock.nowISO();
      const session: StoredPortalSession = {
        id: hexId(ids, 'psn', 12),
        token: portalToken(ids),
        customerId: customer.id,
        expiresAt: new Date(clock.now() + PORTAL_SESSION_MS).toISOString(),
        createdAt: now,
      };
      await state.portals.put(session);
      await state.portals.indexToken(session.token, session.id);
      // `200`, not `201`, as published.
      return reply.status(200).send({ id: session.id, url: portalUrl(session.token) });
    },
  );

  const portalUrl = (token: string) => `${ctx.baseUrl}${ctx.basePath}/portal/s/${token}`;

  /** The live session behind a token, or null once it has expired. */
  async function sessionFor(token: string): Promise<{ session: StoredPortalSession; customer: Customer } | 'expired'> {
    const session = await state.portals.byToken(token);
    if (!session) throw notFound('Portal session');
    if (clock.now() >= Date.parse(session.expiresAt)) return 'expired';
    const customer = await storage.customers.byId(session.customerId);
    if (!customer) throw notFound('Portal session');
    return { session, customer };
  }

  async function page(token: string, customer: Customer, message: string | null, error: string | null) {
    const subscriptions: PortalSubscription[] = [];
    for (const stored of await state.subscriptions.all()) {
      if (stored.customerId !== customer.id || !stored.engineId) continue;
      const core = await storage.subscriptions.byId(stored.engineId);
      if (!core) continue;
      const record = await state.products.get(stored.productId);
      const product = record ? await storage.products.byId(record.engineId) : null;
      subscriptions.push({
        stored,
        status: billing.statusOf(stored, core),
        ending: stored.cancelAtPeriodEnd || core.status === 'non_renewing',
        productName: product?.name ?? stored.productId,
      });
    }
    const invoices = (await storage.invoices.list({ provider: PROVIDER, customerId: customer.id, limit: 100, offset: 0 })).items.map(
      (invoice) => ({
        id: invoiceIdOf(invoice.id),
        status: invoiceStatusOf(invoice.status),
        amount: invoice.amount,
        currency: invoice.currency,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        attempts: invoice.attemptCount,
      }),
    );
    const cards = [];
    const fallback = await state.paymentMethods.defaultFor(customer.id);
    for (const method of await state.paymentMethods.forCustomer(customer.id)) {
      const authorization = await storage.authorizations.byId(method.engineId);
      if (!authorization) continue;
      cards.push({
        id: method.id,
        brand: authorization.brand ?? 'card',
        last4: authorization.last4 ?? '',
        expiry: `${authorization.expMonth}/${authorization.expYear}`,
        isDefault: fallback?.id === method.id,
      });
    }
    return renderPortalPage({
      basePath: `${ctx.basePath}/portal/s/${encodeURIComponent(token)}`,
      email: customer.email,
      subscriptions: subscriptions.sort((a, b) => b.stored.createdAt.localeCompare(a.stored.createdAt) || (b.stored.seq ?? 0) - (a.stored.seq ?? 0)),
      invoices,
      cards,
      message,
      error,
    });
  }

  fastify.get<{ Params: { token: string } }>('/portal/s/:token', async (request, reply) => {
    const found = await sessionFor(request.params.token);
    const html = found === 'expired' ? renderPortalExpired() : await page(request.params.token, found.customer, null, null);
    return reply.type('text/html; charset=utf-8').send(html);
  });

  /** Run a portal action against a subscription the session's customer owns. */
  async function act(
    token: string,
    subscriptionId: string,
    action: (customer: Customer) => Promise<string>,
  ): Promise<string> {
    const found = await sessionFor(token);
    if (found === 'expired') return renderPortalExpired();
    const stored = await state.subscriptions.get(subscriptionId);
    // A session reaches its own customer's subscriptions and nothing else.
    if (!stored || stored.customerId !== found.customer.id) throw notFound('Subscription');
    try {
      const message = await action(found.customer);
      return page(token, found.customer, message, null);
    } catch (error) {
      if (error instanceof PayboxError) return page(token, found.customer, null, error.message);
      throw error;
    }
  }

  type Form = Record<string, string | undefined>;
  type Params = { token: string; subscription_id: string };

  fastify.post<{ Params: Params }>('/portal/s/:token/subscriptions/:subscription_id/cancel', async (request, reply) => {
    const html = await act(request.params.token, request.params.subscription_id, async () => {
      await billing.cancel(request.params.subscription_id, { atPeriodEnd: true, reason: null });
      return 'Your subscription will end at the close of the current period.';
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  fastify.post<{ Params: Params }>('/portal/s/:token/subscriptions/:subscription_id/resume', async (request, reply) => {
    const html = await act(request.params.token, request.params.subscription_id, async () => {
      await billing.undoCancel(request.params.subscription_id);
      return 'Your subscription will continue.';
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  /**
   * "Recovery payment for past_due/unpaid": a card, saved and made the
   * subscription's, charged for what is owed.
   */
  fastify.post<{ Params: Params; Body: Form }>(
    '/portal/s/:token/subscriptions/:subscription_id/pay',
    async (request, reply) => {
      const html = await act(request.params.token, request.params.subscription_id, async (customer) => {
        const subscriptionId = request.params.subscription_id;
        const status = await billing.withSubscription(subscriptionId, async (stored, core) => billing.statusOf(stored, core));
        if (status !== 'past_due' && status !== 'unpaid') {
          throw fail('invalid_state_transition', 'CHECKOUT_ERROR', 'Nothing is owed on this subscription.');
        }
        const form = request.body ?? {};
        const number = (form.card_number ?? '').replace(/\s+/g, '');
        if (!/^\d{12,19}$/.test(number)) throw fail('validation_failed', 'VALIDATION_ERROR', 'Enter a card number.');
        const refusal = TEST_CARDS[number];
        if (refusal) throw fail('validation_failed', 'PAYMENT_ERROR', refusal.message);
        const expMonth = form.exp_month ? Number(form.exp_month) : 12;
        const expYear = form.exp_year ? Number(form.exp_year) : new Date(clock.now()).getUTCFullYear() + 5;
        if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12 || !Number.isInteger(expYear)) {
          throw fail('validation_failed', 'VALIDATION_ERROR', 'Enter a valid expiry month and year.');
        }
        assertNotExpired(expMonth, expYear, clock.now());
        // Saved before the status is re-checked under the subscription's lock
        // (a customer's lock comes before a subscription's). If recovery ran
        // out in between, the card stays saved and the payment is refused --
        // as at Bachs, where completing the page saves the card.

        const method = await saveCard(
          { engine: ctx.engine, storage, state, clock, ids },
          {
            customer,
            facts: cardFacts(number, expMonth, expYear),
            currency: 'USD',
            paymentId: null,
          },
        );
        await billing.recoverWithCard(subscriptionId, method);
        const after = await billing.withSubscription(subscriptionId, async (stored, core) => billing.statusOf(stored, core));
        return after === 'active' ? 'Payment received. Your subscription is active again.' : 'The payment did not go through.';
      });
      return reply.type('text/html; charset=utf-8').send(html);
    },
  );
}
