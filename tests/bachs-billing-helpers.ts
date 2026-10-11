import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';

/**
 * Shared set-up for the Bachs billing suites: an app on an in-memory database
 * with a frozen clock, and one webhook endpoint that receives every event.
 *
 * The endpoint is registered beneath the API, the way paybox's control API
 * does, because `payment_method.saved` is not in Bachs' subscribable
 * `event_types` enum (docs/bachs.md) and so cannot be asked for through it.
 */
export interface BachsBilling {
  app: FastifyInstance;
  context: PayboxContext;
  transport: RecordingTransport;
  close(): Promise<void>;
}

export const START = '2026-06-14T12:00:00.000Z';

export async function startBachs(env: Record<string, string> = {}): Promise<BachsBilling> {
  process.env.PAYBOX_DATABASE = env.PAYBOX_DATABASE ?? ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_START_AT = env.PAYBOX_START_AT ?? START;
  process.env.PAYBOX_SEED = 'bachs-billing';
  if (env.PAYBOX_BACHS_SUBSCRIPTION_RECOVERY) {
    process.env.PAYBOX_BACHS_SUBSCRIPTION_RECOVERY = env.PAYBOX_BACHS_SUBSCRIPTION_RECOVERY;
  } else {
    delete process.env.PAYBOX_BACHS_SUBSCRIPTION_RECOVERY;
  }
  const transport = new RecordingTransport();
  const { config } = loadConfig();
  const context = await buildContext({ config, transport, logSink: () => {} });
  const app = await buildApp(context);
  await app.ready();
  const now = context.clock.nowISO();
  // A restart on the same database finds it already there.
  if (!(await context.storage.webhooks.endpointById('whe_all'))) await context.storage.webhooks.createEndpoint({
    id: 'whe_all',
    provider: 'bachs',
    url: 'https://merchant.example.com/webhooks/bachs',
    secret: 'whsec_all',
    enabled: true,
    eventTypes: [],
    description: null,
    createdAt: now,
    updatedAt: now,
  });
  return {
    app,
    context,
    transport,
    async close() {
      await app.close();
      await context.shutdown();
      delete process.env.PAYBOX_BACHS_SUBSCRIPTION_RECOVERY;
    },
  };
}

export function client(env: BachsBilling) {
  const auth = () => ({
    authorization: `Bearer ${env.context.bachsKeys.secretKey}`,
    'content-type': 'application/json',
  });
  const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
    env.app.inject({ method: 'POST', url: `/bachs${url}`, headers: { ...auth(), ...headers }, payload: (body ?? {}) as object });
  const patch = (url: string, body: unknown) =>
    env.app.inject({ method: 'PATCH', url: `/bachs${url}`, headers: auth(), payload: body as object });
  const del = (url: string, body?: unknown) =>
    env.app.inject({
      method: 'DELETE',
      url: `/bachs${url}`,
      headers: body === undefined ? { authorization: auth().authorization } : auth(),
      ...(body === undefined ? {} : { payload: body as object }),
    });
  const get = (url: string) =>
    env.app.inject({ method: 'GET', url: `/bachs${url}`, headers: { authorization: auth().authorization } });
  const pagePost = (path: string, form: Record<string, string>) =>
    env.app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(form).toString(),
    });
  const pageGet = (path: string) => env.app.inject({ method: 'GET', url: path });
  const advance = async (value: string) => {
    const response = await env.app.inject({ method: 'POST', url: '/api/time', payload: { action: 'advance', value } });
    expect(response.statusCode, response.body).toBe(200);
  };

  async function product(
    price: Record<string, unknown> = { currency: 'USD', amount: '10.00' },
    extra: Record<string, unknown> = { billing_cycle: { interval: 'month', frequency: 1 } },
    name = 'Pro plan',
  ): Promise<string> {
    const response = await post('/v1/products', { name, price, ...extra });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function customer(email = 'jane@example.com', name = 'Jane Doe'): Promise<string> {
    const response = await post('/v1/customers', { email, name });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().customer_id as string;
  }

  /** Create a checkout and return its id and hosted-page path. */
  async function checkout(body: Record<string, unknown>): Promise<{ id: string; path: string }> {
    const response = await post('/v1/checkout-sessions', body);
    expect(response.statusCode, response.body).toBe(201);
    const json = response.json();
    return { id: json.checkout_id, path: new URL(json.checkout_url).pathname };
  }

  /** Pay a checkout by card and let the sandbox's second pass. */
  async function payByCard(path: string, number = '4242424242424242') {
    const paid = await pagePost(`${path}/pay`, { corridor: 'USD_CARD', card_number: number });
    expect(paid.statusCode, paid.body).toBe(200);
    await advance('1s');
  }

  /** A customer's subscriptions, newest first. */
  async function subscriptionsOf(customerId: string) {
    const response = await get(`/v1/subscriptions?customer_id=${customerId}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().items as Array<Record<string, any>>;
  }

  /** Subscribe `customerId` to `productId` by card; returns the subscription. */
  async function subscribe(productId: string, customerId: string, card = '4242424242424242') {
    const session = await checkout({ product_cart: [{ product_id: productId }], customer: { customer_id: customerId } });
    await payByCard(session.path, card);
    const [subscription] = await subscriptionsOf(customerId);
    expect(subscription).toBeDefined();
    return { subscription: subscription!, checkout: session };
  }

  /** Save a card without charging; returns its pm_ id. */
  async function saveCard(customerId: string, number = '4242424242424242') {
    const session = await checkout({ customer: { customer_id: customerId }, save_payment_method: true, success_url: 'https://shop.example.com/saved' });
    const saved = await pagePost(`${session.path}/pay`, { corridor: 'USD_CARD', card_number: number });
    expect(saved.statusCode, saved.body).toBe(200);
    const events = await sent(env, 'payment_method.saved');
    return events[events.length - 1]!.data.payment_method_id as string;
  }

  return { post, patch, del, get, pagePost, pageGet, advance, product, customer, checkout, payByCard, subscriptionsOf, subscribe, saveCard };
}

/**
 * Every Bachs event of `type`, oldest first, as built and stored when the
 * change happened -- the exact body each delivery carries. Reading the store
 * rather than the transport means a test need not advance the clock to let
 * delivery jobs run.
 */
export async function sent(env: BachsBilling, type: string) {
  const rows = await env.context.storage.providerState.listByPrefix('bachs', 'event:');
  return rows
    .map((row) => JSON.parse(row.value) as { seq: number; type: string; payload: { id: string; type: string; data: Record<string, any> } })
    .filter((entry) => entry.type === type)
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => entry.payload);
}
