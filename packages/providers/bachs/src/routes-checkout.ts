import type { FastifyInstance } from 'fastify';
import { PayboxError, type Customer, type IdFactory, type Metadata, type Payment } from '@paybox/shared';
import type { Job, PaymentEngine, Storage } from '@paybox/core';
import { PAYMENT_SIMULATE_JOB, type PaymentSimulator } from '@paybox/simulator';
import { createHash } from 'node:crypto';
import { fail } from './errors.js';
import type { Corridor } from './fees.js';
import { assertMetadata, notFound } from './http.js';
import { hexId, urlToken } from './ids.js';
import { checkoutLock, withLock } from './locks.js';
import { toDecimal, toMinor } from './money.js';
import { renderCheckoutPage, renderCheckoutResult } from './checkout-page.js';
import type { RouteContext } from './route-context.js';
import { PRICE_CURRENCIES } from './routes-catalog.js';
import { createCheckoutSchema } from './schemas.js';
import {
  corridorOf,
  serializeCheckout,
  serializeCheckoutCreated,
  serializePayment,
  sessionStatus,
} from './serializers.js';
import { bachsState, type StoredCheckout, type StoredLine } from './state.js';
import { paymentStatusOf } from './status.js';

const PROVIDER = 'bachs' as const;

/** The job that closes a checkout at `expires_at`. Registered by the composition root. */
export const BACHS_CHECKOUT_EXPIRE_JOB = 'bachs.checkout.expire';

/** "A sandbox payment ... finalizes on its own, about a second after the customer pays." */
const FINALIZE_DELAY_MS = 1_000;
/** How long expiry waits for money already being verified, comfortably past a finalisation. */
const EXPIRY_GRACE_MS = 60_000;

/** Every corridor Bachs offers, with the currency it charges (guides/checkout/checkout-sessions). */
export const CORRIDORS: Record<Corridor, { currency: string | null; method: 'card' | 'bank_transfer' | 'mobile_money' | 'crypto'; label: string }> = {
  USD_CARD: { currency: 'USD', method: 'card', label: 'Card (USD)' },
  NGN_CARD: { currency: 'NGN', method: 'card', label: 'Card (NGN)' },
  NGN_BANK_TRANSFER: { currency: 'NGN', method: 'bank_transfer', label: 'Bank transfer (NGN)' },
  MOMO_GHS: { currency: 'GHS', method: 'mobile_money', label: 'Mobile money (Ghana)' },
  MOMO_KES: { currency: 'KES', method: 'mobile_money', label: 'Mobile money (Kenya)' },
  MOMO_TZS: { currency: 'TZS', method: 'mobile_money', label: 'Mobile money (Tanzania)' },
  MOMO_UGX: { currency: 'UGX', method: 'mobile_money', label: 'Mobile money (Uganda)' },
  MOMO_XAF: { currency: 'XAF', method: 'mobile_money', label: 'Mobile money (Central Africa)' },
  MOMO_XOF: { currency: 'XOF', method: 'mobile_money', label: 'Mobile money (West Africa)' },
  MOMO_RWF: { currency: 'RWF', method: 'mobile_money', label: 'Mobile money (Rwanda)' },
  MOMO_MWK: { currency: 'MWK', method: 'mobile_money', label: 'Mobile money (Malawi)' },
  MOMO_ZMW: { currency: 'ZMW', method: 'mobile_money', label: 'Mobile money (Zambia)' },
  // "CRYPTO is one corridor covering every asset ... you are credited in USD."
  CRYPTO: { currency: 'USD', method: 'crypto', label: 'Crypto' },
};

export const CRYPTO_ASSETS = [
  'USDT_TRC20',
  'USDT_BEP20',
  'USDT_ERC20',
  'USDT_SOL',
  'USDC_BEP20',
  'ETH_ETH',
  'SOL_SOL',
  'BNB_BEP20',
] as const;

/** Minimum fixed checkout amount where Bachs publishes one (MerchantIntent.amount). */
const MINIMUMS: Record<string, number> = { NGN: 10_000, USD: 100 };

/**
 * Sandbox card numbers (integrate/sandbox, read 2026-10-10). "Any other card
 * number succeeds."
 */
const TEST_CARDS: Record<string, { failureCode: string; message: string }> = {
  '4000000000000002': { failureCode: 'card_declined', message: 'Your card was declined.' },
  '4000000000009995': { failureCode: 'insufficient_funds', message: 'Your card has insufficient funds.' },
  '4000000000000069': { failureCode: 'expired_card', message: 'Your card has expired.' },
  '4000000000000119': { failureCode: 'provider_error', message: 'An error occurred while processing your card.' },
};

/**
 * `success_url` "must be a public `http` or `https` address: `localhost` and
 * private network addresses are refused, in the sandbox too"
 * (guides/checkout/checkout-sessions). Reproduced, because an integration
 * that passes localhost fails against the real sandbox as well.
 */
export function assertPublicUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail('validation_failed', 'VALIDATION_ERROR', `${field}: must be an absolute http or https URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw fail('validation_failed', 'VALIDATION_ERROR', `${field}: must be an http or https URL.`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host);
  if (privateHost) {
    throw fail(
      'validation_failed',
      'VALIDATION_ERROR',
      `${field}: must be a public address; localhost and private network addresses are refused.`,
    );
  }
}

function assertHttpUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail('validation_failed', 'VALIDATION_ERROR', `${field}: must be an absolute http or https URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw fail('validation_failed', 'VALIDATION_ERROR', `${field}: must be an http or https URL.`);
  }
}

function notImplemented(what: string): PayboxError {
  return fail(
    'unsupported_operation',
    'NOT_IMPLEMENTED',
    `${what} is not yet supported by paybox's Bachs emulator. See docs/bachs.md for what is implemented.`,
  );
}

/** Corridors that can charge a checkout without converting anything. */
function corridorsFor(currencies: readonly string[]): Corridor[] {
  return (Object.keys(CORRIDORS) as Corridor[]).filter((corridor) => {
    const currency = CORRIDORS[corridor].currency;
    return currency !== null && currencies.includes(currency);
  });
}

export function registerCheckoutRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { engine, storage, state, clock, ids, authenticate } = ctx;

  const checkoutUrl = (checkout: StoredCheckout) => `${ctx.baseUrl}${ctx.basePath}/c/${checkout.token}`;

  async function loadCheckout(id: string): Promise<StoredCheckout> {
    const checkout = await state.checkouts.get(id);
    if (!checkout) throw notFound('Checkout session');
    return checkout;
  }

  async function paymentOf(checkout: StoredCheckout): Promise<Payment | null> {
    return checkout.paymentId ? storage.payments.byId(checkout.paymentId) : null;
  }

  /* --------------------------- create a session --------------------------- */

  fastify.post('/v1/checkout-sessions', async (request, reply) => {
    authenticate(request);
    const body = createCheckoutSchema.parse(request.body ?? {});

    if (body.save_payment_method) throw notImplemented('save_payment_method (saved cards)');
    if (body.platform_fee || body.transfer_data) throw notImplemented('Connect split payments');
    if (Boolean(body.product_cart) === Boolean(body.pricing)) {
      throw fail(
        'validation_failed',
        'VALIDATION_ERROR',
        'Provide exactly one pricing source: product_cart or pricing. Never both, and never neither.',
      );
    }
    // A reference is "unique per organization for good": the check and the
    // index are serialised per reference so two concurrent creates cannot
    // both take it.
    const create = async () => {
      const successUrl = body.success_url ?? body.return_url ?? null;
      if (successUrl) assertPublicUrl(successUrl, 'success_url');
      // `format: uri`. It is shown to the payer as a link, so anything but an
      // http(s) URL is refused; unlike success_url it may be private.
      if (body.cancel_url) assertHttpUrl(body.cancel_url, 'cancel_url');
      assertMetadata(body.metadata, 10_240);
      if (body.reference && (await state.checkouts.referenceTaken(body.reference))) {
        throw fail(
          'duplicate_reference',
          'CONFLICT',
          `A checkout session with reference "${body.reference}" already exists.`,
        );
      }

      const priced = body.product_cart ? await priceCart(body.product_cart) : pricePricing(body.pricing!);

      // A free checkout needs no way to pay; anything else needs at least one.
      const free = priced.priceType === 'free';
      const currencies = [priced.currency, ...Object.keys(priced.currencyOptions)];
      let corridors = free ? [] : corridorsFor(currencies);
      if (!free && corridors.length === 0) {
        throw fail(
          'validation_failed',
          'CHECKOUT_HAS_NO_PAYMENT_METHOD',
          `Nothing can be offered on this checkout: no payment method charges ${currencies.join(', ')}.`,
        );
      }
      if (body.payment_method_types && !free) {
        const unknown = body.payment_method_types.filter((value) => !(value in CORRIDORS));
        if (unknown.length > 0) {
          throw fail(
            'validation_failed',
            'VALIDATION_ERROR',
            `payment_method_types: unknown corridor(s) ${unknown.join(', ')}.`,
          );
        }
        corridors = corridors.filter((corridor) => body.payment_method_types!.includes(corridor));
        if (corridors.length === 0) {
          throw fail(
            'validation_failed',
            'CHECKOUT_RESTRICTION_LEAVES_NO_PAYMENT_METHOD',
            'Your payment_method_types narrowed the checkout to nothing that is available.',
          );
        }
      }
      const billingCurrency = body.billing_currency ? body.billing_currency.toUpperCase() : null;
      if (billingCurrency) {
        if (!currencies.includes(billingCurrency)) {
          throw fail(
            'validation_failed',
            'BILLING_CURRENCY_NOT_AVAILABLE',
            `Nothing in the checkout is priced in ${billingCurrency}. Request one of: ${currencies.join(', ')}.`,
          );
        }
        corridors = corridors.filter((corridor) => CORRIDORS[corridor].currency === billingCurrency);
        if (!free && corridors.length === 0) {
          throw fail(
            'validation_failed',
            'BILLING_CURRENCY_HAS_NO_PAYMENT_METHOD',
            `No payment method on this checkout can charge ${billingCurrency}.`,
          );
        }
      }

      const customer = await resolveCustomer(body.customer ?? null);
      const now = clock.nowISO();
      const checkout: StoredCheckout = {
        id: hexId(ids, 'chk'),
        token: urlToken(ids),
        paymentId: null,
        status: 'open',
        sessionMode: 'CART',
        source: body.product_cart ? 'cart' : 'pricing',
        priceType: priced.priceType,
        currency: priced.currency,
        amount: priced.amount,
        preset: priced.preset,
        minimum: priced.minimum,
        maximum: priced.maximum,
        currencyOptions: priced.currencyOptions,
        lines: priced.lines,
        corridors,
        billingCurrency,
        customerId: customer?.customer.id ?? null,
        customerDetails: customer
          ? { email: customer.customer.email, name: customer.name }
          : null,
        customerCreation: body.customer_creation ?? 'if_required',
        successUrl,
        cancelUrl: body.cancel_url ?? null,
        reference: body.reference ?? null,
        metadata: body.metadata ?? {},
        expiresAt: new Date(clock.now() + (body.expires_in_minutes ?? 60) * 60_000).toISOString(),
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      // The expiry job first: if the process stops before the session is
      // stored, the job finds nothing and does nothing, whereas a stored session
      // with no job would stay open for good. Both under the checkout's lock,
      // which the expiry handler takes too, so a job that is somehow already
      // due cannot run between them and find nothing.
      await withLock(checkoutLock(checkout.id), async () => {
        await storage.jobs.enqueue({
          id: ids.next('job'),
          kind: BACHS_CHECKOUT_EXPIRE_JOB,
          payload: { checkoutId: checkout.id },
          status: 'ready',
          runAt: checkout.expiresAt,
          attempt: 0,
          maxAttempts: 1,
          leaseExpiresAt: null,
          lastError: null,
          groupKey: `bachs-checkout:${checkout.id}`,
          createdAt: now,
          updatedAt: now,
        });
        await state.checkouts.put(checkout);
        await state.checkouts.indexToken(checkout.token, checkout.id);
        if (checkout.reference) await state.checkouts.indexReference(checkout.reference, checkout.id);
      });
      return serializeCheckoutCreated(checkout, checkoutUrl(checkout));
    };
    const created = body.reference
      ? await withLock(`checkout-reference:${body.reference}`, create)
      : await create();
    return reply.status(201).send(created);
  });

  interface Priced {
    priceType: StoredCheckout['priceType'];
    currency: string;
    amount: number | null;
    preset: number | null;
    minimum: number | null;
    maximum: number | null;
    currencyOptions: Record<string, number>;
    lines: StoredLine[];
  }

  async function priceCart(
    cart: NonNullable<ReturnType<typeof createCheckoutSchema.parse>['product_cart']>,
  ): Promise<Priced> {
    const lines: StoredLine[] = [];
    let currency: string | null = null;
    const optionSets: Array<Record<string, number>> = [];
    let custom: { preset: number | null; minimum: number | null; maximum: number | null } | null = null;

    for (const [index, item] of cart.entries()) {
      const stored = await state.products.get(item.product_id);
      const product = stored ? await storage.products.byId(stored.engineId) : null;
      if (!stored || !product) {
        throw fail('validation_failed', 'PRODUCT_NOT_FOUND', `Product ${item.product_id} not found.`);
      }
      if (stored.archivedAt) {
        throw fail(
          'validation_failed',
          'PRODUCT_ARCHIVED',
          `Product ${item.product_id} is archived and cannot be used for new checkouts.`,
        );
      }
      if (stored.billingCycle) throw notImplemented('A subscription checkout (a recurring product in the cart)');

      const price = stored.price;
      if (currency !== null && currency !== price.currency) {
        throw fail(
          'validation_failed',
          'CART_CURRENCY_MISMATCH',
          'All products in a multi-item checkout must share the same base currency.',
        );
      }
      currency = price.currency;
      const quantity = item.quantity ?? 1;

      // An ad hoc override replaces the catalog price for this checkout only.
      const override = item.pricing ?? null;
      const priceType = override?.price_type ?? (override ? 'fixed' : price.priceType);
      const field = `product_cart.${index}`;

      if (priceType === 'fixed') {
        if (item.amount !== null && item.amount !== undefined) {
          throw fail(
            'validation_failed',
            'FIXED_AMOUNT_OVERRIDE_NOT_ALLOWED',
            `${field}.amount: an amount was set for a FIXED-priced product. Remove it from the line item.`,
          );
        }
        const unit = override
          ? toMinor(override.amount ?? '', price.currency, `${field}.pricing.amount`)
          : price.amount!;
        lines.push(line(product.name, item.product_id, quantity, unit, price.currency, 'fixed', null, null));
        optionSets.push(
          override
            ? {}
            : Object.fromEntries(
                price.currencyOptions
                  .filter((option) => option.amount !== null)
                  .map((option) => [option.currency, option.amount! * quantity]),
              ),
        );
      } else if (priceType === 'free') {
        lines.push(line(product.name, item.product_id, quantity, 0, price.currency, 'free', null, null));
        optionSets.push({});
      } else {
        const minimum = override
          ? (override.minimum_amount ? toMinor(override.minimum_amount, price.currency, `${field}.pricing.minimum_amount`, { allowZero: true }) : null)
          : price.minimum;
        const maximum = override
          ? (override.maximum_amount ? toMinor(override.maximum_amount, price.currency, `${field}.pricing.maximum_amount`) : null)
          : price.maximum;
        const preset = item.amount
          ? toMinor(item.amount, price.currency, `${field}.amount`)
          : override?.preset_amount
            ? toMinor(override.preset_amount, price.currency, `${field}.pricing.preset_amount`)
            : price.preset;
        if (preset !== null && ((minimum !== null && preset < minimum) || (maximum !== null && preset > maximum))) {
          throw fail('validation_failed', 'VALIDATION_ERROR', `${field}.amount: must lie within the price's bounds.`);
        }
        custom = { preset, minimum, maximum };
        lines.push(line(product.name, item.product_id, quantity, preset ?? 0, price.currency, 'custom', minimum, maximum));
        optionSets.push({});
      }
    }

    const fixedTotal = lines.filter((entry) => entry.priceType !== 'custom').reduce((sum, entry) => sum + entry.unitAmount * entry.quantity, 0);
    const hasCustom = lines.some((entry) => entry.priceType === 'custom');
    // A currency option is usable only if every line names a price in it.
    const shared = Object.keys(optionSets[0] ?? {}).filter((cur) => optionSets.every((set) => cur in set));
    const currencyOptions = hasCustom
      ? {}
      : Object.fromEntries(shared.map((cur) => [cur, optionSets.reduce((sum, set) => sum + set[cur]!, 0)]));

    return {
      priceType: hasCustom ? 'custom' : fixedTotal === 0 ? 'free' : 'fixed',
      currency: currency!,
      amount: hasCustom ? null : fixedTotal,
      preset: custom?.preset ?? null,
      minimum: custom?.minimum ?? null,
      maximum: custom?.maximum ?? null,
      currencyOptions,
      lines,
    };
  }

  function line(
    productName: string,
    productId: string,
    quantity: number,
    unitAmount: number,
    currency: string,
    priceType: StoredLine['priceType'],
    minimum: number | null,
    maximum: number | null,
  ): StoredLine {
    return { productId, productName, quantity, unitAmount, currency, priceType, minimum, maximum };
  }

  function pricePricing(pricing: NonNullable<ReturnType<typeof createCheckoutSchema.parse>['pricing']>): Priced {
    const currency = pricing.currency.toUpperCase();
    if (!(PRICE_CURRENCIES as readonly string[]).includes(currency)) {
      throw fail('validation_failed', 'UNSUPPORTED_CURRENCY', `pricing.currency: ${pricing.currency} is not a supported fiat currency.`);
    }
    const priceType = pricing.price_type ?? (pricing.amount !== undefined ? 'fixed' : 'custom');
    const options: Record<string, number> = {};
    for (const [cur, value] of Object.entries(pricing.currency_options ?? {})) {
      const upper = cur.toUpperCase();
      if (upper === currency) {
        throw fail('validation_failed', 'VALIDATION_ERROR', 'pricing.currency_options cannot include `currency` itself.');
      }
      if (!(PRICE_CURRENCIES as readonly string[]).includes(upper)) {
        throw fail('validation_failed', 'VALIDATION_ERROR', `pricing.currency_options: ${cur} is not a supported fiat currency.`);
      }
      options[upper] = toMinor(value, upper, `pricing.currency_options.${cur}`);
    }

    if (priceType === 'fixed') {
      if (pricing.amount === undefined) {
        throw fail('validation_failed', 'VALIDATION_ERROR', 'pricing: amount is required for a fixed price.');
      }
      const amount = toMinor(pricing.amount, currency, 'pricing.amount');
      const minimum = MINIMUMS[currency];
      if (minimum !== undefined && amount < minimum) {
        throw fail(
          'validation_failed',
          'VALIDATION_ERROR',
          `pricing.amount: the minimum for ${currency} is ${toDecimal(minimum, currency)}.`,
        );
      }
      return { priceType, currency, amount, preset: null, minimum: null, maximum: null, currencyOptions: options, lines: [] };
    }
    if (priceType === 'free') {
      return { priceType, currency, amount: 0, preset: null, minimum: null, maximum: null, currencyOptions: {}, lines: [] };
    }
    const optional = (value: string | undefined, field: string, allowZero = false) =>
      value === undefined ? null : toMinor(value, currency, field, { allowZero });
    return {
      priceType: 'custom',
      currency,
      amount: null,
      preset: optional(pricing.preset_amount, 'pricing.preset_amount'),
      minimum: optional(pricing.minimum_amount, 'pricing.minimum_amount', true),
      maximum: optional(pricing.maximum_amount, 'pricing.maximum_amount'),
      currencyOptions: {},
      lines: [],
    };
  }

  /** `customer` on the request: an existing record by id, or created/matched by email. */
  async function resolveCustomer(
    input: { customer_id: string } | { email: string; name?: string | null; phone_number?: string | null } | null,
  ): Promise<{ customer: Customer; name: string | null } | null> {
    if (!input) return null;
    if ('customer_id' in input) {
      const customer = await storage.customers.byProviderCustomerId(PROVIDER, input.customer_id);
      if (!customer) throw notFound('Customer');
      const stored = await state.customers.get(customer.providerCustomerId);
      return { customer, name: stored?.name ?? null };
    }
    // "Bachs creates or matches a customer for you. The same email is never duplicated."
    const existing = await storage.customers.byEmail(PROVIDER, input.email);
    if (existing) {
      const stored = await state.customers.get(existing.providerCustomerId);
      return { customer: existing, name: stored?.name ?? null };
    }
    const created = await ctx.customers.create({
      email: input.email,
      name: input.name ?? null,
      phone: input.phone_number ?? null,
      metadata: {},
      address: null,
    });
    return { customer: created.customer, name: created.stored.name };
  }

  /* ---------------------------- read a session ---------------------------- */

  fastify.get<{ Params: { checkout_id: string } }>(
    '/v1/checkout-sessions/:checkout_id',
    async (request, reply) => {
      authenticate(request);
      const checkout = await loadCheckout(request.params.checkout_id);
      const payment = await paymentOf(checkout);
      return reply.send(await renderSession(checkout, payment));
    },
  );

  async function renderSession(checkout: StoredCheckout, payment: Payment | null) {
    const customer = checkout.customerId ? await storage.customers.byId(checkout.customerId) : null;
    const name = customer ? ((await state.customers.get(customer.providerCustomerId))?.name ?? null) : null;
    const refunds = payment ? await ctx.paymentContext(payment) : null;
    return serializeCheckout(checkout, payment, {
      customer: customer
        ? { id: customer.providerCustomerId, email: customer.email, name }
        : { id: null, email: checkout.customerDetails?.email ?? null, name: checkout.customerDetails?.name ?? null },
      charge: payment && refunds ? serializePayment(payment, refunds) : null,
    });
  }

  /* ----------------------------- hosted page ----------------------------- */

  async function loadByToken(token: string): Promise<StoredCheckout> {
    const checkout = await state.checkouts.byToken(token);
    // A payer's browser gets no detail beyond "not found".
    if (!checkout) throw notFound('Checkout');
    return checkout;
  }

  async function page(checkout: StoredCheckout, error: string | null = null): Promise<string> {
    const payment = await paymentOf(checkout);
    const status = sessionStatus(checkout, payment);
    if (status !== 'open') {
      return renderCheckoutResult({
        checkout,
        payment,
        status,
        basePath: ctx.basePath,
        redirectUrl:
          status === 'completed' && checkout.successUrl
            ? withCheckoutId(checkout.successUrl, checkout.id)
            : status !== 'completed'
              ? checkout.cancelUrl
              : null,
      });
    }
    return renderCheckoutPage({ checkout, payment, basePath: ctx.basePath, error });
  }

  fastify.get<{ Params: { token: string } }>('/c/:token', async (request, reply) => {
    const checkout = await loadByToken(request.params.token);
    return reply.type('text/html; charset=utf-8').send(await page(checkout));
  });

  /** Run a hosted-page action, re-rendering the page with the error if it fails. */
  /**
   * Run a hosted-page action, re-rendering the page with the error if it fails.
   *
   * Under the checkout's lock, against a copy read *inside* it: the expiry job
   * takes the same lock, so an action can never write back a session the job
   * has just closed, nor the job close one an action is half-way through.
   */
  async function act(
    token: string,
    action: (checkout: StoredCheckout) => Promise<void>,
  ): Promise<string> {
    const found = await loadByToken(token);
    return withLock(checkoutLock(found.id), async () => {
      const checkout = await adoptOrphanPayment(storage, state, (await state.checkouts.get(found.id)) ?? found);
      try {
        await action(checkout);
      } catch (error) {
        if (error instanceof PayboxError || (error instanceof Error && 'issues' in error)) {
          return page((await state.checkouts.get(checkout.id)) ?? checkout, error.message);
        }
        throw error;
      }
      return page((await state.checkouts.get(checkout.id)) ?? checkout);
    });
  }

  type Form = Record<string, string | undefined>;

  fastify.post<{ Params: { token: string }; Body: Form }>('/c/:token/identify', async (request, reply) => {
    const html = await act(request.params.token, (checkout) => identify(checkout, request.body ?? {}));
    return reply.type('text/html; charset=utf-8').send(html);
  });

  fastify.post<{ Params: { token: string }; Body: Form }>('/c/:token/amount', async (request, reply) => {
    const html = await act(request.params.token, (checkout) => chooseAmount(checkout, request.body ?? {}));
    return reply.type('text/html; charset=utf-8').send(html);
  });

  fastify.post<{ Params: { token: string } }>('/c/:token/complete', async (request, reply) => {
    const html = await act(request.params.token, (checkout) => completeFree(checkout));
    return reply.type('text/html; charset=utf-8').send(html);
  });

  fastify.post<{ Params: { token: string }; Body: Form }>('/c/:token/pay', async (request, reply) => {
    const html = await act(request.params.token, (checkout) => pay(checkout, request.body ?? {}));
    return reply.type('text/html; charset=utf-8').send(html);
  });

  fastify.post<{ Params: { token: string }; Body: Form }>('/c/:token/simulate', async (request, reply) => {
    const html = await act(request.params.token, (checkout) => testControl(checkout, request.body ?? {}));
    return reply.type('text/html; charset=utf-8').send(html);
  });

  function assertOpen(checkout: StoredCheckout, payment: Payment | null): void {
    const status = sessionStatus(checkout, payment);
    if (status !== 'open') {
      throw fail('invalid_state_transition', 'CHECKOUT_ERROR', `This checkout is ${status}.`);
    }
    if (clock.now() >= Date.parse(checkout.expiresAt)) {
      throw fail('invalid_state_transition', 'CHECKOUT_ERROR', 'This checkout has expired.');
    }
  }

  async function save(checkout: StoredCheckout): Promise<StoredCheckout> {
    const next = { ...checkout, updatedAt: clock.nowISO() };
    await state.checkouts.put(next);
    return next;
  }

  /**
   * A guest identifies themselves. With `customer_creation: always` they join
   * the directory -- matched by email to a customer already held -- and
   * otherwise their identity is kept on `customer_details` only.
   */
  async function identify(checkout: StoredCheckout, form: Form): Promise<void> {
    assertOpen(checkout, await paymentOf(checkout));
    const email = (form.email ?? '').trim();
    const name = (form.name ?? '').trim() || null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw fail('validation_failed', 'VALIDATION_ERROR', 'Enter a valid email address.');
    }
    let customerId = checkout.customerId;
    if (checkout.customerCreation === 'always' && !customerId) {
      const existing = await storage.customers.byEmail(PROVIDER, email);
      customerId = existing
        ? existing.id
        : (await ctx.customers.create({ email, name, phone: null, metadata: {}, address: null })).customer.id;
    }
    await save({ ...checkout, customerId, customerDetails: { email, name } });
  }

  /** The payer picks a pay-what-you-want amount, within the price's bounds. */
  async function chooseAmount(checkout: StoredCheckout, form: Form): Promise<void> {
    if (checkout.paymentId) throw fail('invalid_state_transition', 'CHECKOUT_ERROR', 'The amount is already fixed for this checkout.');
    assertOpen(checkout, null);
    const amount = toMinor((form.amount ?? '').trim(), checkout.currency, 'amount', { allowZero: true });
    if ((checkout.minimum !== null && amount < checkout.minimum) || (checkout.maximum !== null && amount > checkout.maximum)) {
      throw fail(
        'validation_failed',
        'VALIDATION_ERROR',
        `Choose an amount between ${toDecimal(checkout.minimum ?? 0, checkout.currency)} and ${
          checkout.maximum === null ? 'any amount' : toDecimal(checkout.maximum, checkout.currency)
        }.`,
      );
    }
    const fixed = checkout.lines.filter((entry) => entry.priceType !== 'custom').reduce((sum, entry) => sum + entry.unitAmount * entry.quantity, 0);
    // The chosen amount is the pay-what-you-want line's whole contribution,
    // so it lands on that line as a single unit price.
    const first = checkout.lines.findIndex((entry) => entry.priceType === 'custom');
    const lines = checkout.lines.map((entry, index) =>
      index === first ? { ...entry, quantity: 1, unitAmount: amount } : entry,
    );
    const total = checkout.source === 'cart' ? fixed + amount : amount;
    await save({ ...checkout, amount: total, lines });
  }

  /**
   * Complete a free checkout. "A free checkout sends only `checkout.completed`"
   * and creates no charge, so there is no payment for the event to hang on --
   * it is recorded against the checkout itself, in one transaction with the
   * status change.
   */
  async function completeFree(checkout: StoredCheckout): Promise<void> {
    assertOpen(checkout, null);
    if ((checkout.amount ?? 0) !== 0 || checkout.paymentId) {
      throw fail('invalid_state_transition', 'CHECKOUT_ERROR', 'This checkout needs a payment.');
    }
    if (!checkout.customerDetails) {
      throw fail('validation_failed', 'VALIDATION_ERROR', 'Enter your email address first.');
    }
    const now = clock.nowISO();
    const next: StoredCheckout = { ...checkout, status: 'completed', completedAt: now, updatedAt: now };
    await engine.recordEvent({
      provider: PROVIDER,
      type: 'checkout.completed',
      resourceType: 'checkout',
      resourceId: checkout.id,
      data: { checkout_id: checkout.id },
      apply: (tx) => tx.providerState.put(PROVIDER, `checkout:${checkout.id}`, JSON.stringify(next), now),
    });
  }

  /** Start (or retry) an attempt on the chosen corridor. */
  async function pay(checkout: StoredCheckout, form: Form): Promise<void> {
    let payment = await paymentOf(checkout);
    assertOpen(checkout, payment);
    if (!checkout.customerDetails) {
      throw fail('validation_failed', 'VALIDATION_ERROR', 'Enter your email address first.');
    }
    if (checkout.amount === null) {
      throw fail('validation_failed', 'CUSTOM_AMOUNT_REQUIRED', 'Choose an amount first.');
    }
    const corridor = form.corridor as Corridor | undefined;
    if (!corridor || !checkout.corridors.includes(corridor)) {
      throw fail('validation_failed', 'PAYMENT_METHOD_NOT_ALLOWED', 'Choose one of the payment methods this checkout offers.');
    }
    const info = CORRIDORS[corridor];
    const currency = info.currency!;
    const amount = currency === checkout.currency ? checkout.amount : checkout.currencyOptions[currency];
    if (amount === undefined) {
      throw fail('validation_failed', 'PAYMENT_METHOD_NOT_ALLOWED', `This checkout is not priced in ${currency}.`);
    }

    // Validate what the corridor needs before creating anything.
    const details: Metadata = { corridor };
    let cardOutcome: (typeof TEST_CARDS)[string] | undefined;
    if (info.method === 'card') {
      const number = (form.card_number ?? '').replace(/\s+/g, '');
      if (!/^\d{12,19}$/.test(number)) {
        throw fail('validation_failed', 'VALIDATION_ERROR', 'Enter a card number.');
      }
      // The number decides the outcome and is then dropped: only the brand
      // and last four are kept, and the security code is never read at all
      // (spec §29).
      cardOutcome = TEST_CARDS[number];
      details.brand = number.startsWith('4') ? 'visa' : number.startsWith('5') ? 'mastercard' : 'card';
      details.last4 = number.slice(-4);
    } else if (info.method === 'mobile_money') {
      const phone = (form.phone_number ?? '').trim();
      if (!/^\+?\d{8,15}$/.test(phone)) {
        throw fail('validation_failed', 'VALIDATION_ERROR', 'Enter the mobile money number to prompt.');
      }
      details.phone_number = phone;
      details.provider = (form.provider ?? 'MTN').toUpperCase();
    } else if (info.method === 'crypto') {
      const asset = form.asset ?? '';
      if (!(CRYPTO_ASSETS as readonly string[]).includes(asset)) {
        throw fail('validation_failed', 'VALIDATION_ERROR', 'Choose an asset and network.');
      }
      details.asset = asset;
      details.address = depositAddress(checkout.id, asset);
    } else {
      details.virtual_account = {
        id: null,
        // "Sandbox numbers ... start with 90."
        account_number: `90${createHash('sha256').update(checkout.id).digest('hex').replace(/\D/g, '').padEnd(8, '0').slice(0, 8)}`,
        bank_name: 'Sandbox Test Bank',
        type: 'one_time',
        expires_at: checkout.expiresAt,
      };
    }

    if (!payment) {
      payment = await engine.createPayment({
        provider: PROVIDER,
        amount,
        currency,
        reference: checkout.id,
        providerTransactionId: hexId(ids, 'ch'),
        customerId: checkout.customerId,
        callbackUrl: checkout.successUrl,
        paymentMethod: info.method === 'bank_transfer' ? 'bank_transfer' : info.method,
        paymentMethodDetails: details,
        metadata: { checkout_id: checkout.id },
        status: 'created',
      });
      await state.checkouts.indexPayment(payment.id, checkout.id);
      checkout = await save({ ...checkout, paymentId: payment.id, paymentSeq: await state.nextSeq() });
    } else {
      if (payment.currency !== currency) {
        throw fail(
          'validation_failed',
          'PAYMENT_METHOD_NOT_ALLOWED',
          `This checkout's charge is in ${payment.currency}; choose a method that charges ${payment.currency}.`,
        );
      }
      if (payment.status !== 'failed' && payment.status !== 'created') {
        throw fail(
          'invalid_state_transition',
          'CHECKOUT_ERROR',
          'A payment attempt is already in progress. Finish it, or let it fail, before trying another method.',
        );
      }
    }

    const retry = payment.status === 'failed';
    const method = info.method === 'bank_transfer' ? 'bank_transfer' : info.method;
    if (info.method === 'card') {
      payment = await engine.transitionPayment(payment.id, 'processing', {
        retry,
        paymentMethod: method,
        paymentMethodDetails: details,
      });
      if (cardOutcome) {
        // A refused card fails at once; only success waits for the sandbox's second.
        await engine.transitionPayment(payment.id, 'failed', {
          failureCode: cardOutcome.failureCode,
          failureMessage: cardOutcome.message,
        });
      } else {
        await finalizeLater(payment.id, 'success');
      }
      return;
    }
    if (info.method === 'mobile_money') {
      // The prompt is on the payer's handset: approving it is the next step.
      await engine.transitionPayment(payment.id, 'requires_action', {
        retry,
        paymentMethod: method,
        paymentMethodDetails: details,
      });
      return;
    }
    // Bank transfer and crypto wait for money to arrive at what the page shows.
    await engine.transitionPayment(payment.id, 'pending', {
      retry,
      paymentMethod: method,
      paymentMethodDetails: details,
    });
  }

  /** Schedule the sandbox's "finalizes on its own, about a second after the customer pays". */
  async function finalizeLater(paymentId: string, outcome: 'success'): Promise<void> {
    const now = clock.nowISO();
    await storage.jobs.enqueue({
      id: ids.next('job'),
      kind: PAYMENT_SIMULATE_JOB,
      payload: { paymentId, outcome },
      status: 'ready',
      runAt: new Date(clock.now() + FINALIZE_DELAY_MS).toISOString(),
      attempt: 0,
      maxAttempts: 1,
      leaseExpiresAt: null,
      lastError: null,
      groupKey: `payment:${paymentId}`,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * The sandbox's test controls for rails a card number cannot steer.
   *
   * Bachs says "use the test controls on the sandbox checkout page to make
   * the payment succeed, fail, or arrive underpaid" and describes them no
   * further, so these are paybox's, labelled as such on the page.
   */
  async function testControl(checkout: StoredCheckout, form: Form): Promise<void> {
    const payment = await paymentOf(checkout);
    if (!payment) throw fail('invalid_state_transition', 'CHECKOUT_ERROR', 'Start a payment first.');
    const corridor = corridorOf(payment);
    const action = form.action ?? '';
    const details = { ...payment.paymentMethodDetails };
    const status = paymentStatusOf(payment);

    // A bank transfer that lands after the checkout expired still completes it
    // (checkout.expired: "Expiry is not always final").
    if (action === 'late_transfer') {
      if (corridor !== 'NGN_BANK_TRANSFER' || payment.status !== 'expired') {
        throw fail('invalid_state_transition', 'CHECKOUT_ERROR', 'Only an expired bank-transfer checkout can receive a late transfer.');
      }
      await engine.transitionPayment(payment.id, 'successful', {
        reversal: true,
        providerStatus: 'succeeded',
        paymentMethodDetails: { ...details, ...transferSender(checkout, payment.amount) },
        eventData: { late_transfer: true },
      });
      return;
    }

    assertOpen(checkout, payment);
    switch (action) {
      case 'succeed': {
        if (payment.status === 'requires_action' || payment.status === 'pending') {
          await engine.transitionPayment(payment.id, 'processing', {
            paymentMethodDetails:
              corridor === 'NGN_BANK_TRANSFER' ? { ...details, ...transferSender(checkout, payment.amount) } : details,
          });
          await finalizeLater(payment.id, 'success');
          return;
        }
        throw fail('invalid_state_transition', 'CHECKOUT_ERROR', 'There is no payment waiting to succeed.');
      }
      case 'fail': {
        if (!['pending', 'requires_action', 'processing'].includes(payment.status)) {
          throw fail('invalid_state_transition', 'CHECKOUT_ERROR', 'There is no payment attempt to fail.');
        }
        await engine.transitionPayment(payment.id, 'failed', {
          failureCode: corridor === 'CRYPTO' || corridor === 'NGN_BANK_TRANSFER' ? 'provider_error' : 'authorization_rejected',
          failureMessage:
            corridor === 'NGN_BANK_TRANSFER'
              ? 'The transfer could not be confirmed.'
              : corridor === 'CRYPTO'
                ? 'The crypto payment failed.'
                : 'The customer did not approve the payment.',
        });
        return;
      }
      case 'short_transfer':
      case 'underpaid': {
        if (action === 'short_transfer' && corridor !== 'NGN_BANK_TRANSFER') break;
        if (action === 'underpaid' && corridor !== 'CRYPTO') break;
        if (payment.status !== 'pending') {
          throw fail('invalid_state_transition', 'CHECKOUT_ERROR', 'Nothing is waiting for funds.');
        }
        const paid = Math.floor(payment.amount / 2);
        await engine.transitionPayment(payment.id, 'processing', {
          providerStatus: 'underpaid',
          paymentMethodDetails: {
            ...details,
            amount_paid: paid,
            ...(action === 'short_transfer' ? transferSender(checkout, paid) : {}),
          },
        });
        return;
      }
      case 'overpaid': {
        if (corridor !== 'CRYPTO' || payment.status !== 'pending') break;
        // At least one minor unit over, however small the charge.
        const received = payment.amount + Math.max(1, Math.round(payment.amount / 10));
        await engine.transitionPayment(payment.id, 'processing', { paymentMethodDetails: details });
        await engine.transitionPayment(payment.id, 'successful', {
          providerStatus: 'overpaid',
          paymentMethodDetails: { ...details, amount_paid: received },
        });
        // Settlement credits the requested amount; the balance holds what
        // actually arrived, so the excess is credited too.
        await engine.creditBalance({
          provider: PROVIDER,
          currency: payment.currency,
          amount: received - payment.amount,
          reason: 'overpayment',
          resourceId: payment.id,
        });
        return;
      }
      case 'send_rest':
      case 'accept_underpayment': {
        if (status !== 'underpaid') break;
        await engine.transitionPayment(payment.id, 'successful', {
          providerStatus: action === 'accept_underpayment' ? 'accepted' : 'succeeded',
          paymentMethodDetails:
            action === 'send_rest' ? { ...details, amount_paid: payment.amount } : details,
        });
        if (action === 'accept_underpayment') {
          // Accepted as final at what was paid: settlement credited the full
          // requested amount, so the shortfall comes back off.
          const paid = Number(details.amount_paid ?? 0);
          await engine.debitBalance({
            provider: PROVIDER,
            currency: payment.currency,
            amount: payment.amount - paid,
            reason: 'underpayment_accepted',
            resourceId: payment.id,
          });
        }
        return;
      }
      default:
        break;
    }
    throw fail('validation_failed', 'VALIDATION_ERROR', `The test control "${action}" does not apply to this payment.`);
  }
}

/** Who a sandbox bank transfer came from: synthetic, like every account here (spec §29). */
function transferSender(checkout: StoredCheckout, amount: number): Metadata {
  const digest = createHash('sha256').update(`sender:${checkout.id}:${amount}`).digest('hex').replace(/\D/g, '');
  return {
    sender_name: 'PAYBOX TEST PAYER',
    sender_bank: 'Sandbox Test Bank',
    sender_bank_code: '000',
    sender_account_number: digest.padEnd(10, '0').slice(0, 10),
    session_id: digest.padEnd(30, '0').slice(0, 30),
    narration: checkout.reference ?? checkout.id,
  };
}

/** A deposit address shaped like the asset's network. Synthetic; nothing listens on it. */
function depositAddress(checkoutId: string, asset: string): string {
  const hex = createHash('sha256').update(`address:${checkoutId}:${asset}`).digest('hex');
  if (asset.endsWith('_TRC20')) return `T${hex.slice(0, 33)}`;
  if (asset.endsWith('_SOL')) return hex.slice(0, 44);
  return `0x${hex.slice(0, 40)}`;
}

export function withCheckoutId(url: string, checkoutId: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('checkout_id', checkoutId);
  return parsed.toString();
}

/**
 * Close a checkout at `expires_at`. Registered as `bachs.checkout.expire`.
 *
 * One handler for every shape a session can be in when its time runs out:
 * no payment at all (an event against the checkout itself), an attempt still
 * in flight (the payment expires), or a last attempt that failed (the
 * payment, terminal at `failed`, lapses to `expired` through the engine's
 * explicit reversal hatch so `checkout.expired` still fires).
 */
export function createBachsExpiryHandler(options: {
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  storage: Storage;
  clock: { nowISO(): string };
  ids: IdFactory;
}) {
  return async (job: Job): Promise<void> => {
    const checkoutId = String(job.payload.checkoutId ?? '');
    const grace = job.payload.grace === true;
    await withLock(checkoutLock(checkoutId), () => expire(checkoutId, grace));
  };

  async function expire(checkoutId: string, grace: boolean): Promise<void> {
    const state = bachsState(options.storage, () => options.clock.nowISO());
    const stored = await state.checkouts.get(checkoutId);
    if (!stored) return;
    const checkout = await adoptOrphanPayment(options.storage, state, stored);

    if (!checkout.paymentId) {
      if (checkout.status !== 'open') return;
      const now = options.clock.nowISO();
      const next: StoredCheckout = { ...checkout, status: 'expired', updatedAt: now };
      await options.engine.recordEvent({
        provider: PROVIDER,
        type: 'checkout.expired',
        resourceType: 'checkout',
        resourceId: checkout.id,
        data: { checkout_id: checkout.id },
        apply: (tx) => tx.providerState.put(PROVIDER, `checkout:${checkout.id}`, JSON.stringify(next), now),
      });
      return;
    }

    const payment = await options.storage.payments.byId(checkout.paymentId);
    if (!payment) return;
    // Every state still waiting on money. `authorized` is not one Bachs
    // reaches, but paybox's own tooling can put a payment there, and the
    // session must not then stay open forever.
    // Money already on its way is not stopped by the clock: "A payment that
    // was already on its way ... can still complete" (checkout-expired). A
    // card or transfer being verified settles a second later, so it gets a
    // grace period and one more look; whatever has not settled by then, or
    // has failed meanwhile, closes with the checkout. An underpayment is
    // money held short, and closes at once.
    if (payment.status === 'processing' && paymentStatusOf(payment) !== 'underpaid' && !grace) {
      const now = options.clock.nowISO();
      await options.storage.jobs.enqueue({
        id: options.ids.next('job'),
        kind: BACHS_CHECKOUT_EXPIRE_JOB,
        payload: { checkoutId, grace: true },
        status: 'ready',
        runAt: new Date(Date.parse(now) + EXPIRY_GRACE_MS).toISOString(),
        attempt: 0,
        maxAttempts: 1,
        leaseExpiresAt: null,
        lastError: null,
        groupKey: `bachs-checkout:${checkoutId}`,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    if (['created', 'pending', 'processing', 'requires_action', 'authorized'].includes(payment.status)) {
      await options.simulator.expire(payment.id);
      return;
    }
    if (payment.status === 'failed') {
      await options.engine.transitionPayment(payment.id, 'expired', {
        reversal: true,
        failureCode: 'transaction_timeout',
        failureMessage: 'The checkout expired after its last payment attempt failed.',
        eventData: { lapsed: true },
      });
    }
  }
}

/**
 * Re-link a payment the engine committed but the checkout never recorded.
 *
 * `pay()` creates the payment and then writes the checkout; a crash between
 * the two would otherwise leave a session that can never be paid (every
 * retry collides with the payment's unique reference, the checkout's own
 * id) and a payment nothing ever expires. The reference makes it findable.
 */
async function adoptOrphanPayment(
  storage: Storage,
  state: ReturnType<typeof bachsState>,
  checkout: StoredCheckout,
): Promise<StoredCheckout> {
  if (checkout.paymentId) return checkout;
  const orphan = await storage.payments.byReference(PROVIDER, checkout.id);
  if (!orphan) return checkout;
  await state.checkouts.indexPayment(orphan.id, checkout.id);
  const adopted: StoredCheckout = { ...checkout, paymentId: orphan.id, paymentSeq: await state.nextSeq() };
  await state.checkouts.put(adopted);
  return adopted;
}
