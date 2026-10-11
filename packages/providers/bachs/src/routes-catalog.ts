import type { FastifyInstance } from 'fastify';
import type { Customer, Product } from '@paybox/shared';
import { fail } from './errors.js';
import { mediaOf, replaceMedia } from './uploads.js';
import { assertMetadata, everyRow, newestFirst, notFound, readPage } from './http.js';
import { emailLock, withLock } from './locks.js';
import { hexId } from './ids.js';
import { toMinor } from './money.js';
import type { RouteContext } from './route-context.js';
import {
  createCustomerSchema,
  createProductSchema,
  listCustomersQuery,
  listProductsQuery,
  priceInputSchema,
  updateCustomerSchema,
  updateProductSchema,
  updatePriceSchema,
  billingAddressSchema,
} from './schemas.js';
import {
  customerName,
  pagination,
  serializeCustomer,
  serializeCustomerListItem,
  serializeProduct,
} from './serializers.js';
import type { StoredCustomer, StoredPrice, StoredProduct } from './state.js';
import type { z } from 'zod';

const PROVIDER = 'bachs' as const;

/** `PriceInput.currency` -- the currencies a Bachs price can be set in. */
export const PRICE_CURRENCIES = [
  'USD',
  'NGN',
  'GHS',
  'KES',
  'MWK',
  'RWF',
  'TZS',
  'UGX',
  'XAF',
  'XOF',
  'ZMW',
] as const;

function assertPriceCurrency(currency: string, field: string): string {
  const upper = currency.toUpperCase();
  if (!(PRICE_CURRENCIES as readonly string[]).includes(upper)) {
    throw fail(
      'unsupported_currency',
      'UNSUPPORTED_CURRENCY',
      `${field}: ${currency} is not in the active supported set.`,
    );
  }
  return upper;
}

const optionalMinor = (value: string | null | undefined, currency: string, field: string, allowZero = false) =>
  value === null || value === undefined ? null : toMinor(value, currency, field, { allowZero });

/**
 * `PriceInput` -> a stored price, applying its `oneOf`: a fixed price needs a
 * non-null amount and no bounds; a free price has neither; a custom price has
 * no fixed amount and optional preset and bounds. The messages follow Bachs'
 * one documented example: "price: amount is required for a fixed price."
 */
export function parsePrice(input: z.infer<typeof priceInputSchema>): StoredPrice {
  const currency = assertPriceCurrency(input.currency, 'price.currency');
  const priceType = input.price_type ?? 'fixed';
  const has = (value: unknown) => value !== null && value !== undefined;

  if (priceType === 'fixed') {
    if (!has(input.amount)) {
      throw fail('validation_failed', 'VALIDATION_ERROR', 'price: amount is required for a fixed price.');
    }
    if (has(input.preset_amount) || has(input.minimum_amount) || has(input.maximum_amount)) {
      throw fail(
        'validation_failed',
        'VALIDATION_ERROR',
        'price: preset_amount, minimum_amount and maximum_amount apply only to a custom price.',
      );
    }
  }
  if (priceType === 'free' && (has(input.amount) || has(input.preset_amount) || has(input.minimum_amount) || has(input.maximum_amount))) {
    throw fail('validation_failed', 'VALIDATION_ERROR', 'price: a free price takes no amount or bounds.');
  }
  if (priceType === 'custom' && has(input.amount)) {
    throw fail(
      'validation_failed',
      'VALIDATION_ERROR',
      'price: amount is not valid for a custom price; use preset_amount and the bounds.',
    );
  }

  const minimum = optionalMinor(input.minimum_amount, currency, 'price.minimum_amount', true);
  const maximum = optionalMinor(input.maximum_amount, currency, 'price.maximum_amount');
  const preset = optionalMinor(input.preset_amount, currency, 'price.preset_amount');
  if (minimum !== null && maximum !== null && minimum > maximum) {
    throw fail('validation_failed', 'VALIDATION_ERROR', 'price: minimum_amount cannot exceed maximum_amount.');
  }
  if (preset !== null && ((minimum !== null && preset < minimum) || (maximum !== null && preset > maximum))) {
    throw fail('validation_failed', 'VALIDATION_ERROR', 'price: preset_amount must lie within the bounds.');
  }

  return {
    currency,
    priceType,
    amount: priceType === 'fixed' ? toMinor(input.amount!, currency, 'price.amount') : null,
    preset,
    minimum,
    maximum,
    currencyOptions: parseCurrencyOptions(input.currency_options ?? [], currency, priceType),
  };
}

function parseCurrencyOptions(
  options: NonNullable<z.infer<typeof priceInputSchema>['currency_options']>,
  primary: string,
  priceType: StoredPrice['priceType'],
): StoredPrice['currencyOptions'] {
  const seen = new Set<string>([primary]);
  return options.map((option, index) => {
    const currency = assertPriceCurrency(option.currency, `price.currency_options.${index}.currency`);
    if (seen.has(currency)) {
      throw fail(
        'validation_failed',
        'DUPLICATE_CURRENCY',
        `A price for ${currency} already exists. currency_options cannot repeat the primary currency or each other.`,
      );
    }
    seen.add(currency);
    const field = `price.currency_options.${index}`;
    if (priceType === 'fixed' && (option.amount === null || option.amount === undefined)) {
      throw fail('validation_failed', 'VALIDATION_ERROR', `${field}: amount is required for a fixed price.`);
    }
    return {
      currency,
      amount: priceType === 'fixed' ? toMinor(option.amount!, currency, `${field}.amount`) : null,
      preset: priceType === 'custom' ? optionalMinor(option.preset_amount, currency, `${field}.preset_amount`) : null,
      minimum: priceType === 'custom' ? optionalMinor(option.minimum_amount, currency, `${field}.minimum_amount`, true) : null,
      maximum: priceType === 'custom' ? optionalMinor(option.maximum_amount, currency, `${field}.maximum_amount`) : null,
    };
  });
}

export function registerCatalogRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { engine, storage, state, authenticate } = ctx;

  /* -------------------------------- products -------------------------------- */

  async function loadProduct(id: string): Promise<{ product: Product; stored: StoredProduct }> {
    const stored = await state.products.get(id);
    const product = stored ? await storage.products.byId(stored.engineId) : null;
    if (!stored || !product) throw notFound('Product');
    return { product, stored };
  }

  /** Running totals: completed payments whose checkout carried this product. */
  async function productTotals(productId: string): Promise<{ totalPayments: number; totalAmount: number }> {
    let totalPayments = 0;
    let totalAmount = 0;
    for (const checkout of await state.checkouts.all()) {
      if (!checkout.paymentId) continue;
      const lines = checkout.lines.filter((line) => line.productId === productId);
      if (lines.length === 0) continue;
      const payment = await storage.payments.byId(checkout.paymentId);
      if (!payment || !['successful', 'refunded', 'partially_refunded'].includes(payment.status)) continue;
      totalPayments += 1;
      totalAmount += lines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0);
    }
    return { totalPayments, totalAmount };
  }

  ctx.productTotals = productTotals;

  async function renderProduct(product: Product, stored: StoredProduct) {
    return serializeProduct(product, stored, {
      organizationId: ctx.organizationId,
      ...(await productTotals(stored.id)),
      media: await mediaOf(state, stored, `${ctx.baseUrl}${ctx.basePath}`),
    });
  }

  fastify.post('/v1/products', async (request, reply) => {
    authenticate(request);
    const body = createProductSchema.parse(request.body);
    assertMetadata(body.metadata);
    const price = parsePrice(body.price);
    if (body.trial_period && !body.billing_cycle) {
      throw fail(
        'validation_failed',
        'TRIAL_REQUIRES_RECURRING',
        'A trial is only valid on a recurring product. Remove the trial or make it recurring.',
      );
    }
    const id = hexId(ctx.ids, 'prod', 20);
    const product = await engine.createProduct({
      provider: PROVIDER,
      name: body.name,
      description: body.description ?? null,
      providerProductId: id,
      metadata: body.metadata ?? {},
    });
    const stored: StoredProduct = {
      id,
      engineId: product.id,
      seq: await state.nextSeq(),
      price,
      billingCycle: body.billing_cycle ?? null,
      trialPeriod: body.trial_period ?? null,
      archivedAt: null,
    };
    await state.products.put(stored);
    return reply.status(201).send(await renderProduct(product, stored));
  });

  fastify.get<{ Params: { product_id: string } }>('/v1/products/:product_id', async (request, reply) => {
    authenticate(request);
    const { product, stored } = await loadProduct(request.params.product_id);
    return reply.send(await renderProduct(product, stored));
  });

  fastify.patch<{ Params: { product_id: string } }>('/v1/products/:product_id', async (request, reply) => {
    authenticate(request);
    const body = updateProductSchema.parse(request.body ?? {});
    const { product, stored } = await loadProduct(request.params.product_id);
    if (body.metadata) assertMetadata(body.metadata);

    let billingCycle = stored.billingCycle;
    if (body.billing_cycle !== undefined) {
      // "A billing_cycle is immutable once set."
      if (stored.billingCycle && JSON.stringify(body.billing_cycle) !== JSON.stringify(stored.billingCycle)) {
        throw fail(
          'validation_failed',
          'RECURRING_INTERVAL_IMMUTABLE',
          '`recurring_interval` cannot change once set. Create a new product instead.',
        );
      }
      billingCycle = body.billing_cycle;
    }
    const trialPeriod = body.trial_period !== undefined ? body.trial_period : stored.trialPeriod;
    if (trialPeriod && !billingCycle) {
      throw fail(
        'validation_failed',
        'TRIAL_REQUIRES_RECURRING',
        'A trial is only valid on a recurring product. Remove the trial or make it recurring.',
      );
    }

    const price = body.price ? updatePrice(stored.price, body.price) : stored.price;
    // Media is checked, and attached, before anything about the product is written.
    const media =
      body.media !== undefined ? await replaceMedia(state, stored, body.media, ctx.clock.nowISO()) : stored.media;
    const updated = await storage.products.update(product.id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      // "Replace the product's key-value metadata."
      ...(body.metadata !== undefined ? { metadata: body.metadata ?? {} } : {}),
      updatedAt: ctx.clock.nowISO(),
    });
    const next: StoredProduct = { ...stored, price, billingCycle, trialPeriod, ...(media ? { media } : {}) };
    await state.products.put(next);
    return reply.send(await renderProduct(updated, next));
  });

  function updatePrice(current: StoredPrice, patch: z.infer<typeof updatePriceSchema>): StoredPrice {
    let amount = current.amount;
    if (patch.amount !== undefined && patch.amount !== null) {
      if (current.priceType !== 'fixed') {
        throw fail(
          'validation_failed',
          'VALIDATION_ERROR',
          'price: amount can be changed only on a fixed-price product.',
        );
      }
      amount = toMinor(patch.amount, current.currency, 'price.amount');
    }
    const currencyOptions =
      patch.currency_options === undefined || patch.currency_options === null
        ? current.currencyOptions
        : parseCurrencyOptions(patch.currency_options, current.currency, current.priceType);
    return { ...current, amount, currencyOptions };
  }

  for (const action of ['archive', 'unarchive'] as const) {
    fastify.post<{ Params: { product_id: string } }>(
      `/v1/products/:product_id/${action}`,
      async (request, reply) => {
        authenticate(request);
        const { product, stored } = await loadProduct(request.params.product_id);
        // Both are idempotent: archiving an archived product succeeds.
        const archivedAt = action === 'archive' ? (stored.archivedAt ?? ctx.clock.nowISO()) : null;
        const changed = archivedAt !== stored.archivedAt;
        const updated = changed
          ? await storage.products.update(product.id, {
              active: archivedAt === null,
              updatedAt: ctx.clock.nowISO(),
            })
          : product;
        const next = { ...stored, archivedAt };
        if (changed) await state.products.put(next);
        return reply.send(await renderProduct(updated, next));
      },
    );
  }

  fastify.get('/v1/products', async (request, reply) => {
    authenticate(request);
    const query = listProductsQuery.parse(request.query);
    const { limit, offset } = readPage(query, 20);
    const includeArchived = query.include_archived === 'true';
    // Newest first; archived ones hidden unless asked for.
    const all = await everyRow((page) => storage.products.list({ provider: PROVIDER, ...page }));
    const rows: Array<{ product: Product; stored: StoredProduct }> = [];
    for (const product of all) {
      const stored = await state.products.get(product.providerProductId);
      if (!stored) continue;
      if (stored.archivedAt && !includeArchived) continue;
      rows.push({ product, stored });
    }
    rows.sort((a, b) =>
      newestFirst({ seq: a.stored.seq, createdAt: a.product.createdAt }, { seq: b.stored.seq, createdAt: b.product.createdAt }),
    );
    const page = rows.slice(offset, offset + limit);
    return reply.send({
      items: await Promise.all(page.map(({ product, stored }) => renderProduct(product, stored))),
      pagination: pagination(rows.length, limit, offset, page.length),
    });
  });

  /* -------------------------------- customers -------------------------------- */

  async function loadCustomer(id: string): Promise<{ customer: Customer; stored: StoredCustomer | null }> {
    const customer = await storage.customers.byProviderCustomerId(PROVIDER, id);
    if (!customer) throw notFound('Customer');
    return { customer, stored: await state.customers.get(id) };
  }

  /**
   * A supplied address replaces the stored one in full -- "This is not a
   * merge" -- and needs `line1` and a real two-letter `country`; an all-empty
   * object is refused in favour of an explicit null.
   */
  function parseAddress(
    address: z.infer<typeof billingAddressSchema> | null | undefined,
  ): Record<string, unknown> | null | undefined {
    if (address === undefined) return undefined;
    if (address === null) return null;
    const values = Object.values(address).filter((value) => value !== null && value !== undefined && value !== '');
    if (values.length === 0) {
      throw fail(
        'validation_failed',
        'VALIDATION_ERROR',
        'billing_address: an all-empty address is rejected; send null to clear it.',
      );
    }
    if (!address.line1 || !address.country) {
      throw fail(
        'validation_failed',
        'VALIDATION_ERROR',
        'billing_address: line1 and country are required whenever an address is supplied.',
      );
    }
    if (!/^[A-Z]{2}$/.test(address.country)) {
      throw fail(
        'validation_failed',
        'VALIDATION_ERROR',
        'billing_address.country must be an ISO-3166-1 alpha-2 code.',
      );
    }
    return {
      line1: address.line1,
      line2: address.line2 ?? null,
      city: address.city ?? null,
      state: address.state ?? null,
      postal_code: address.postal_code ?? null,
      country: address.country,
    };
  }

  function splitName(name: string | null | undefined): { firstName: string | null; lastName: string | null } {
    if (!name) return { firstName: null, lastName: null };
    const [first, ...rest] = name.split(' ');
    return { firstName: first || null, lastName: rest.join(' ') || null };
  }

  /**
   * Create or match by email. "Creating a customer with an email that already
   * exists returns the existing customer with your changes applied, so that
   * call emits `customer.updated` rather than `customer.created`"
   * (guides/webhooks/events/customer-updated).
   */
  fastify.post('/v1/customers', async (request, reply) => {
    authenticate(request);
    const body = createCustomerSchema.parse(request.body);
    if (body.metadata) assertMetadata(body.metadata);
    const address = parseAddress(body.billing_address);
    const { customer, stored } = await upsertCustomer(
      {
        email: body.email,
        name: body.name ?? null,
        phone: body.phone_number ?? null,
        metadata: body.metadata ?? {},
        address: address ?? null,
      },
      {
        // Only the fields sent are applied to an existing customer.
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.phone_number !== undefined ? { phone_number: body.phone_number } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        ...(address !== undefined ? { address } : {}),
      },
    );
    return reply.status(201).send(serializeCustomer(customer, stored));
  });

  fastify.get<{ Params: { customer_id: string } }>('/v1/customers/:customer_id', async (request, reply) => {
    authenticate(request);
    const { customer, stored } = await loadCustomer(request.params.customer_id);
    return reply.send(serializeCustomer(customer, stored));
  });

  fastify.patch<{ Params: { customer_id: string } }>('/v1/customers/:customer_id', async (request, reply) => {
    authenticate(request);
    const body = updateCustomerSchema.parse(request.body ?? {});
    if (body.metadata) assertMetadata(body.metadata);
    const { customer } = await loadCustomer(request.params.customer_id);
    const address = parseAddress(body.billing_address);
    const changingEmail = Boolean(body.email && body.email !== customer.email);
    const apply = async () => {
      if (changingEmail && (await storage.customers.byEmail(PROVIDER, body.email!))) {
        throw fail('duplicate_reference', 'CONFLICT', 'Another customer already uses this email address.');
      }
      return applyCustomerUpdate(customer, {
      ...(body.email ? { email: body.email } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.phone_number !== undefined ? { phone_number: body.phone_number } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata ?? {} } : {}),
      ...(address !== undefined ? { address } : {}),
      });
    };
    // Taking an email is check-then-write; serialise it per email.
    const updated = changingEmail ? await withLock(emailLock(body.email!), apply) : await apply();
    return reply.send(serializeCustomer(updated.customer, updated.stored));
  });

  fastify.get('/v1/customers', async (request, reply) => {
    authenticate(request);
    const query = listCustomersQuery.parse(request.query);
    const { limit, offset } = readPage(query, 50);
    // "Search by customer email or name", where `name` is the full name. The
    // shared repository searches the first and last name columns one at a
    // time, so "Jane Doe" would match neither; filter on the name Bachs was
    // actually given. Listed newest first by creation order.
    const needle = query.search?.toLowerCase() ?? null;
    const everyone = await everyRow((page) => storage.customers.list({ provider: PROVIDER, ...page }));
    const matches: Array<{ customer: Customer; stored: StoredCustomer | null }> = [];
    for (const customer of everyone) {
      const stored = await state.customers.get(customer.providerCustomerId);
      const name = customerName(customer, stored) ?? '';
      if (!needle || customer.email.toLowerCase().includes(needle) || name.toLowerCase().includes(needle)) {
        matches.push({ customer, stored });
      }
    }
    matches.sort((a, b) =>
      newestFirst({ seq: a.stored?.seq, createdAt: a.customer.createdAt }, { seq: b.stored?.seq, createdAt: b.customer.createdAt }),
    );
    const page = matches.slice(offset, offset + limit);
    return reply.send({
      items: page.map(({ customer, stored }) => serializeCustomerListItem(customer, stored)),
      pagination: pagination(matches.length, limit, offset, page.length),
    });
  });

  /**
   * Create a customer, or match the one that already has this email.
   *
   * "Creating a customer with an email that already exists returns the
   * existing customer with your changes applied" (customer-updated). `update`
   * is what to apply when one exists; null means match without changing it,
   * which is what a checkout does. Serialised per email, because the check
   * and the create are separate calls and the engine quietly returns the
   * existing customer to the loser of a race.
   *
   * The Bachs-only fields are written *before* the engine call, because
   * `customer.created` is published from inside it and the webhook has to
   * carry the name and address the merchant just sent.
   */
  async function upsertCustomer(
    input: {
      email: string;
      name: string | null;
      phone: string | null;
      metadata: Record<string, unknown>;
      address: Record<string, unknown> | null;
    },
    update: Parameters<typeof applyCustomerUpdate>[1] | null,
  ): Promise<{ customer: Customer; stored: StoredCustomer }> {
    return withLock(emailLock(input.email), async () => {
      const existing = await storage.customers.byEmail(PROVIDER, input.email);
      if (existing) {
        if (update) return applyCustomerUpdate(existing, update);
        return { customer: existing, stored: (await state.customers.get(existing.providerCustomerId)) ?? orphanRecord(existing) };
      }
      const id = hexId(ctx.ids, 'cust');
      const draft: StoredCustomer = {
        id,
        engineId: '',
        seq: await state.nextSeq(),
        name: input.name,
        billingAddress: input.address,
      };
      await state.customers.put(draft);
      let customer: Customer;
      try {
        customer = await engine.createCustomer({
          provider: PROVIDER,
          email: input.email,
          ...splitName(input.name),
          phone: input.phone,
          metadata: input.metadata,
          providerCustomerId: id,
        });
      } catch (error) {
        await state.customers.delete(id);
        throw error;
      }
      if (customer.providerCustomerId !== id) {
        // The engine matched an existing customer after all; this draft is not one.
        await state.customers.delete(id);
        if (update) return applyCustomerUpdate(customer, update);
        return { customer, stored: (await state.customers.get(customer.providerCustomerId)) ?? orphanRecord(customer) };
      }
      const stored = { ...draft, engineId: customer.id };
      await state.customers.put(stored);
      return { customer, stored };
    });
  }

  /** A record for a customer paybox's own tooling created, which has none. */
  function orphanRecord(customer: Customer): StoredCustomer {
    return {
      id: customer.providerCustomerId,
      engineId: customer.id,
      name: [customer.firstName, customer.lastName].filter(Boolean).join(' ') || null,
      billingAddress: null,
    };
  }

  async function applyCustomerUpdate(
    customer: Customer,
    patch: {
      email?: string;
      name?: string | null;
      phone_number?: string | null;
      metadata?: Record<string, unknown>;
      address?: Record<string, unknown> | null;
    },
  ): Promise<{ customer: Customer; stored: StoredCustomer }> {
    const previous = await state.customers.get(customer.providerCustomerId);
    const stored: StoredCustomer = {
      id: customer.providerCustomerId,
      engineId: customer.id,
      ...(previous?.seq !== undefined ? { seq: previous.seq } : {}),
      name: patch.name !== undefined ? patch.name : (previous?.name ?? null),
      billingAddress: patch.address !== undefined ? patch.address : (previous?.billingAddress ?? null),
    };
    await state.customers.put(stored);
    const updated = await engine.updateCustomer(
      customer.id,
      {
        ...(patch.email ? { email: patch.email } : {}),
        ...(patch.name !== undefined ? splitName(patch.name) : {}),
        ...(patch.phone_number !== undefined ? { phone: patch.phone_number } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      },
      { event: true },
    );
    return { customer: updated, stored };
  }

  ctx.customers = {
    // Checkout and the hosted page create or match by email, changing nothing on a match.
    create: (input) => upsertCustomer(input, null),
    update: applyCustomerUpdate,
  };
}
