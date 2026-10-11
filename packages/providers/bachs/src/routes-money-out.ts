import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Transfer } from '@paybox/shared';
import { fail } from './errors.js';
import { assertMetadata, everyRow, newestFirst, notFound, readPage } from './http.js';
import { hexId } from './ids.js';
import { withLock } from './locks.js';
import { toDecimal, toMinor } from './money.js';
import { decimalCurrency, hasRate, isHeld, isStablecoin, STABLECOINS } from './rates.js';
import { BANKS, MOMO_COUNTRIES, PAYOUT_SUPPORTED, resolveAccountName } from './reference.js';
import { directCharge, owns, ownerField, ownerKey, ownsTransfer, type Actor } from './actor.js';
import { hasCapability } from './accounts.js';
import type { RouteContext } from './route-context.js';
import { serializePayment } from './serializers.js';
import type { StoredDestination, StoredSchedule, StoredVirtualAccount } from './state.js';
import { MOMO_PROVIDERS, payoutFacts, payoutIdOf, withdrawalFee } from './treasury.js';

const PROVIDER = 'bachs' as const;

/**
 * Money out: payout destinations, quotes, payouts, payout schedules,
 * conversions, the account's virtual account, and the reference lists they
 * need.
 *
 * Shapes from the pinned OpenAPI document; behaviour from
 * guides/payouts/*, connect/{payouts, testing}, for-you/fees and
 * guides/virtual-accounts/overview, read 2026-10-10. Transfers are not here:
 * they move money only between a platform and its connected accounts, so
 * they arrive with Connect.
 */

const decimal = z.string();
const metadata = z.record(z.string(), z.unknown());

const bankAddress = z.object({
  line1: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  country: z.string().max(2).optional(),
});

/** Every routing field `CreatePayoutDestinationRequest` and its update accept. */
const routingFields = {
  account_number: z.string().max(50).optional(),
  bank_code: z.string().max(20).optional(),
  account_name: z.string().max(255).optional(),
  bank_name: z.string().max(255).optional(),
  phone_number: z.string().max(20).optional(),
  mobile_provider: z.string().max(50).optional(),
  wallet_address: z.string().max(255).optional(),
  network: z.string().max(50).optional(),
  sort_code: z.string().max(12).optional(),
  iban: z.string().max(50).optional(),
  swift_bic: z.string().max(20).optional(),
  routing_number: z.string().max(15).optional(),
  bank_address: bankAddress.optional(),
  institution_number: z.string().max(8).optional(),
  transit_number: z.string().max(10).optional(),
  interac_email: z.string().max(255).optional(),
  scheme: z.string().optional(),
};
const ROUTING_KEYS = Object.keys(routingFields);
/** Changing one of these "sends the destination back to pending_review". */
const REVIEWED_KEYS = ['account_number', 'bank_code', 'wallet_address', 'network', 'phone_number'];

const destinationType = z.enum(['bank_account', 'mobile_money', 'crypto_wallet']);

const createDestinationSchema = z.object({
  name: z.string().max(255).optional(),
  label: z.string().max(255).optional(),
  currency: z.string().max(10),
  type: destinationType.optional(),
  destination_type: destinationType.optional(),
  metadata: metadata.optional(),
  ...routingFields,
});

const updateDestinationSchema = z.object({
  name: z.string().min(1).max(255).nullable().optional(),
  is_default: z.boolean().optional(),
  // A restatement repeats the POST shape; what a destination *is* cannot change.
  currency: z.string().max(10).optional(),
  type: destinationType.optional(),
  destination_type: destinationType.optional(),
  metadata: metadata.optional(),
  ...routingFields,
});

const listDestinationsQuery = z.object({
  currency: z.string().optional(),
  status: z.enum(['pending_review', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
});

const payoutQuoteSchema = z.object({
  from_currency: z.string(),
  to_currency: z.string(),
  amount: decimal,
  payout_method: z.string().optional(),
});

const createPayoutSchema = z.object({
  destination: z.string(),
  amount: decimal.nullable().optional(),
  quote_id: z.string().nullable().optional(),
  reference: z.string().max(128).nullable().optional(),
  metadata: metadata.nullable().optional(),
});

const listPayoutsQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  status_filter: z.enum(['requested', 'pending', 'processing', 'approved', 'rejected', 'completed', 'failed']).optional(),
});

const WEEKDAY = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const scheduleSchema = z
  .object({
    interval: z.enum(['manual', 'instant', 'daily', 'weekly', 'monthly']),
    weekly_payout_days: z.array(WEEKDAY).min(1).optional(),
    monthly_payout_days: z.array(z.number().int().min(1).max(31)).min(1).optional(),
    anchor_hour_utc: z.number().int().min(0).max(23).optional(),
    payout_currency: z.string().optional(),
    minimum_amount: decimal.nullable().optional(),
  })
  .passthrough();
const settingsSchema = z.object({ schedule_by_currency: z.record(z.string(), scheduleSchema).optional() });

const conversionQuoteSchema = z.object({ from_currency: z.string(), to_currency: z.string(), amount: decimal });
const conversionSchema = z.object({
  from_currency: z.string(),
  to_currency: z.string(),
  amount: decimal,
  quote_id: z.string(),
});
const listConversionsQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  from_currency: z.string().optional(),
  to_currency: z.string().optional(),
  status: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});

const virtualAccountSchema = z.object({ currency: z.string().length(3) });
const depositSchema = z.object({
  amount: decimal,
  sender_name: z.string().max(255).optional(),
  sender_bank: z.string().max(255).optional(),
  sender_account_number: z.string().max(20).optional(),
  narration: z.string().max(255).optional(),
});

/** Rails a destination currency has (global-payouts, "Prepare your destination details"). */
const BANK_CURRENCIES = ['NGN', 'GHS', 'KES', 'UGX', 'TZS', 'GBP', 'EUR', 'USD', 'CAD'];
const MOMO_CURRENCIES = Object.keys(MOMO_PROVIDERS);

/** One owner's default destination for one currency is set under this. */
const defaultLock = (destination: StoredDestination) =>
  `destination-default:${ownerKey(destination.account, destination.currency)}`;

export function registerMoneyOutRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { engine, storage, state, clock, ids, treasury } = ctx;

  /* ------------------------------ destinations ------------------------------ */

  async function serializeDestination(destination: StoredDestination) {
    const isDefault = (await state.destinations.defaultFor(destination.currency, destination.account))?.id === destination.id;
    const r = destination.routing;
    const field = (key: string) => (r[key] as string | undefined) ?? null;
    return {
      id: destination.id,
      name: destination.name,
      type: destination.type,
      currency: destination.currency,
      status: destination.status,
      status_reason: destination.statusReason,
      is_usable: destination.status === 'approved' && !destination.deleted,
      is_default: isDefault && !destination.deleted,
      account_number: field('account_number'),
      account_name: field('account_name'),
      bank_code: field('bank_code'),
      bank_name: field('bank_name'),
      phone_number: field('phone_number'),
      mobile_provider: field('mobile_provider'),
      wallet_address: field('wallet_address'),
      network: field('network'),
      reviewed_at: destination.reviewedAt,
      created_at: destination.createdAt,
      updated_at: destination.updatedAt,
      sort_code: field('sort_code'),
      iban: field('iban'),
      swift_bic: field('swift_bic'),
      routing_number: field('routing_number'),
      bank_address: (r.bank_address as Record<string, unknown> | undefined) ?? null,
      institution_number: field('institution_number'),
      transit_number: field('transit_number'),
      interac_email: field('interac_email'),
      scheme: field('scheme'),
    };
  }

  /** The type a currency implies, when the request left it out. */
  function inferType(currency: string): StoredDestination['type'] {
    if (isStablecoin(currency)) return 'crypto_wallet';
    const bank = BANK_CURRENCIES.includes(currency);
    const momo = MOMO_CURRENCIES.includes(currency);
    if (bank && momo) {
      throw fail(
        'validation_failed',
        'DESTINATION_TYPE_REQUIRED',
        `${currency} has more than one payout rail; send type (bank_account or mobile_money).`,
      );
    }
    if (bank) return 'bank_account';
    if (momo) return 'mobile_money';
    throw fail('validation_failed', 'CURRENCY_NOT_SUPPORTED', `There is no payout rail for ${currency}.`);
  }

  /** The required fields per type and route, normalised; the routing record stored. */
  function validateRouting(currency: string, type: StoredDestination['type'], input: Record<string, unknown>) {
    const routing: Record<string, unknown> = {};
    for (const key of ROUTING_KEYS) if (input[key] !== undefined) routing[key] = input[key];
    const missing = (keys: string[]) => keys.filter((key) => routing[key] === undefined || routing[key] === '');
    const invalid = (detail: string) => fail('validation_failed', 'BANK_ROUTING_DETAILS_INVALID', detail);
    if (type === 'crypto_wallet') {
      if (!isStablecoin(currency)) throw fail('validation_failed', 'CURRENCY_NOT_SUPPORTED', `${currency} has no crypto rail.`);
      if (missing(['wallet_address']).length > 0) {
        throw fail('validation_failed', 'VALIDATION_ERROR', 'wallet_address: required for a crypto wallet.');
      }
      routing.network ??= currency.split('_')[1] ?? null;
      return routing;
    }
    if (type === 'mobile_money') {
      if (!MOMO_CURRENCIES.includes(currency)) {
        throw fail('validation_failed', 'CURRENCY_NOT_SUPPORTED', `${currency} has no mobile money rail.`);
      }
      const gaps = missing(['phone_number', 'mobile_provider']);
      if (gaps.length > 0) throw fail('validation_failed', 'VALIDATION_ERROR', `${gaps.join(', ')}: required for mobile money.`);
      // "A network outside this list is accepted when you save the
      // destination, but the payout fails when it is sent."
      return routing;
    }
    if (!BANK_CURRENCIES.includes(currency)) {
      throw fail('validation_failed', 'CURRENCY_NOT_SUPPORTED', `${currency} has no bank rail.`);
    }
    const scheme = routing.scheme as string | undefined;
    const required: Record<string, string[]> = {
      GBP: ['account_name', 'bank_name', 'sort_code', 'account_number'],
      EUR: ['account_name', 'bank_name', 'iban', 'swift_bic'],
      USD: ['scheme', 'account_name', 'bank_name', 'routing_number', 'account_number', 'bank_address'],
      CAD:
        scheme === 'interac_email'
          ? ['scheme', 'account_name', 'interac_email']
          : ['scheme', 'account_name', 'bank_name', 'institution_number', 'transit_number', 'account_number'],
    };
    const gaps = missing(required[currency] ?? ['bank_code', 'account_number']);
    if (gaps.length > 0) throw invalid(`Missing bank details for ${currency}: ${gaps.join(', ')}.`);
    if (currency === 'USD') {
      if (!['ach', 'wire', 'rtp'].includes(String(scheme))) throw invalid('scheme: one of ach, wire, rtp.');
      if (!/^\d{9}$/.test(String(routing.routing_number))) throw invalid('routing_number: nine digits.');
      if ((routing.bank_address as { country?: string }).country !== 'US') throw invalid('bank_address.country: must be US.');
    }
    if (currency === 'CAD' && !['eft', 'interac_account', 'interac_email'].includes(String(scheme))) {
      throw invalid('scheme: one of eft, interac_account, interac_email.');
    }
    if (currency === 'GBP') {
      const sortCode = String(routing.sort_code).replace(/[\s-]/g, '');
      if (!/^\d{6}$/.test(sortCode)) throw invalid('sort_code: six digits.');
      routing.sort_code = sortCode;
    }
    if (currency === 'EUR' && ![8, 11].includes(String(routing.swift_bic).length)) {
      throw invalid('swift_bic: 8 or 11 characters.');
    }
    if (currency === 'NGN') {
      // "For NGN the bank resolves the name, and a supplied value is ignored."
      const bank = (BANKS.NG ?? []).find((entry) => entry.code === routing.bank_code);
      if (!bank || !/^\d{10}$/.test(String(routing.account_number))) {
        throw invalid('bank_code and account_number: a listed Nigerian bank and a ten-digit account number.');
      }
      routing.bank_name = bank.name;
      routing.account_name = resolveAccountName(String(routing.account_number), String(routing.bank_code));
    }
    return routing;
  }

  async function loadDestination(actor: Actor, id: string): Promise<StoredDestination> {
    const destination = await state.destinations.get(id);
    if (!destination || !owns(actor, destination.account)) throw notFound('Payout destination');
    return destination;
  }

  fastify.post('/v1/payouts/destinations', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = createDestinationSchema.parse(request.body);
    assertMetadata(body.metadata);
    const currency = body.currency.toUpperCase();
    const type = body.type ?? body.destination_type ?? inferType(currency);
    const routing = validateRouting(currency, type, body);
    const now = clock.nowISO();
    const destination: StoredDestination = {
      ...ownerField(actor),
      seq: await state.nextSeq(),
      id: hexId(ids, 'pd', 16),
      name: body.name ?? body.label ?? null,
      type,
      currency,
      // "Sandbox destinations are approved automatically."
      status: 'approved',
      statusReason: null,
      deleted: false,
      routing,
      metadata: body.metadata ?? {},
      reviewedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await withLock(defaultLock(destination), async () => {
      await state.destinations.put(destination);
      // "The first destination an account registers for a currency becomes
      // that currency's default once it is usable."
      if (!(await state.destinations.defaultFor(currency, destination.account))) {
        await state.destinations.setDefault(currency, destination.id, destination.account);
      }
    });
    return reply.status(201).send(await serializeDestination(destination));
  });

  fastify.get('/v1/payouts/destinations', async (request, reply) => {
    const actor = await ctx.actor(request);
    const query = listDestinationsQuery.parse(request.query);
    const { limit, offset } = readPage(query, 20);
    const matches = (await state.destinations.all())
      .filter((entry) => owns(actor, entry.account))
      .filter((entry) => !query.currency || entry.currency === query.currency.toUpperCase())
      .filter((entry) => !query.status || entry.status === query.status)
      .sort(newestFirst);
    const page = matches.slice(offset, offset + limit);
    return reply.send({
      destinations: await Promise.all(page.map(serializeDestination)),
      total: matches.length,
      limit,
      offset,
    });
  });

  fastify.get<{ Params: { destination_id: string } }>('/v1/payouts/destinations/:destination_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    return reply.send(await serializeDestination(await loadDestination(actor, request.params.destination_id)));
  });

  fastify.patch<{ Params: { destination_id: string } }>('/v1/payouts/destinations/:destination_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = updateDestinationSchema.parse(request.body ?? {});
    assertMetadata(body.metadata);
    const current = await loadDestination(actor, request.params.destination_id);
    if (current.deleted) throw notFound('Payout destination');
    const type = body.type ?? body.destination_type;
    if ((body.currency !== undefined && body.currency.toUpperCase() !== current.currency) || (type !== undefined && type !== current.type)) {
      throw fail(
        'validation_failed',
        'VALIDATION_ERROR',
        'A destination keeps its currency and type. Create a new destination for another currency or rail.',
      );
    }
    const restating = ROUTING_KEYS.some((key) => (body as Record<string, unknown>)[key] !== undefined);
    if (body.name === undefined && body.is_default === undefined && body.metadata === undefined && !restating) {
      throw fail(
        'validation_failed',
        'VALIDATION_ERROR',
        'Send name, is_default, metadata, or the destination restated in full.',
      );
    }
    const now = clock.nowISO();
    let next: StoredDestination = {
      ...current,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      updatedAt: now,
    };
    let reviewed = false;
    if (restating) {
      // "Omitted routing fields fall back to what is already stored."
      const merged = { ...current.routing, ...Object.fromEntries(ROUTING_KEYS.filter((k) => (body as Record<string, unknown>)[k] !== undefined).map((k) => [k, (body as Record<string, unknown>)[k]])) };
      const routing = validateRouting(current.currency, current.type, merged);
      reviewed = REVIEWED_KEYS.some((key) => routing[key] !== current.routing[key]);
      // Back to review, which the sandbox approves at once.
      next = { ...next, routing, ...(reviewed ? { status: 'approved' as const, reviewedAt: now } : {}) };
    }
    await withLock(defaultLock(current), async () => {
      await state.destinations.put(next);
      // `is_default` "is ignored when the same request also sends the
      // destination back for review".
      if (body.is_default !== undefined && !reviewed) {
        if (body.is_default) await state.destinations.setDefault(current.currency, current.id, current.account);
        else if ((await state.destinations.defaultFor(current.currency, current.account))?.id === current.id) {
          await state.destinations.clearDefault(current.currency, current.account);
        }
      }
    });
    return reply.send(await serializeDestination(next));
  });

  fastify.delete<{ Params: { destination_id: string } }>('/v1/payouts/destinations/:destination_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const current = await loadDestination(actor, request.params.destination_id);
    // Deactivated already: there is nothing left to delete.
    if (current.deleted) throw notFound('Payout destination');
    await withLock(defaultLock(current), async () => {
      await state.destinations.put({ ...current, deleted: true, updatedAt: clock.nowISO() });
      if ((await state.destinations.defaultFor(current.currency, current.account))?.id === current.id) {
        await state.destinations.clearDefault(current.currency, current.account);
      }
    });
    return reply.send({ id: current.id, deleted: true });
  });

  /* -------------------------------- payouts -------------------------------- */

  fastify.post('/v1/payouts/quotes', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = payoutQuoteSchema.parse(request.body);
    const from = body.from_currency.toUpperCase();
    const to = body.to_currency.toUpperCase();
    if (!isHeld(from)) {
      throw fail('validation_failed', 'PAYOUT_SOURCE_CURRENCY_UNSUPPORTED', `Payouts are funded from USD or NGN, not ${from}.`);
    }
    if (from === to || isStablecoin(to)) {
      throw fail('validation_failed', 'VALIDATION_ERROR', `A ${from} to ${to} payout needs no quote; send amount on the payout.`);
    }
    // "International bank and mobile money routes must be funded from USD."
    if (from === 'NGN') {
      throw fail('validation_failed', 'PAYOUT_SOURCE_CURRENCY_UNSUPPORTED', `NGN cannot fund a ${to} payout; quote from USD.`);
    }
    if (!hasRate(to) || !(BANK_CURRENCIES.includes(to) || MOMO_CURRENCIES.includes(to))) {
      throw fail('validation_failed', 'PAYOUT_CURRENCY_NOT_ENABLED', `There is no payout route to ${to}.`);
    }
    const fromAmount = toMinor(body.amount, from, 'amount');
    const rail = /mobile/i.test(body.payout_method ?? '') ? 'mobile_money' : 'bank_account';
    const fee = withdrawalFee(from, rail, fromAmount);
    if (fee >= fromAmount) throw fail('validation_failed', 'VALIDATION_ERROR', 'amount: must be more than the withdrawal fee.');
    // The fee depends on the rail; a payout to a destination of another rail
    // is refused rather than charged the wrong fee.
    const quote = await treasury.createQuote({ kind: 'payout', from, to, fromAmount, fee, rail, owner: actor });
    return reply.status(201).send({
      quote_id: quote.id,
      from_currency: quote.fromCurrency,
      to_currency: quote.toCurrency,
      from_amount: toDecimal(quote.fromAmount, from),
      to_amount: toDecimal(quote.toAmount, to),
      exchange_rate: quote.rate,
      expires_at: quote.expiresAt,
    });
  });

  fastify.post('/v1/payouts', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = createPayoutSchema.parse(request.body);
    assertMetadata(body.metadata);
    const destination = await state.destinations.get(body.destination);
    if (!destination || destination.deleted || !owns(actor, destination.account)) {
      throw fail('not_found', 'DESTINATION_NOT_FOUND', `No payout destination ${body.destination} on this account.`);
    }
    if (destination.status === 'pending_review') {
      throw fail('validation_failed', 'DESTINATION_PENDING_REVIEW', 'This destination is still being reviewed.');
    }
    if (destination.status === 'rejected') throw fail('validation_failed', 'DESTINATION_REJECTED', 'This destination was rejected.');
    const create = async () => {
      if (body.reference && (await state.payouts.referenceTaken(body.reference, actor.account?.id ?? null))) {
        throw fail('duplicate_reference', 'CONFLICT', `A payout with reference "${body.reference}" already exists.`);
      }
      const amountCurrency = isStablecoin(destination.currency) ? 'USD' : destination.currency;
      return treasury.createPayout({
        destination,
        amount: body.amount ? toMinor(body.amount, amountCurrency, 'amount') : null,
        quoteId: body.quote_id ?? null,
        reference: body.reference ?? null,
        metadata: body.metadata ?? {},
        owner: actor,
      });
    };
    const transfer = body.reference
      ? await withLock(`payout-reference:${ownerKey(actor.account?.id ?? null, body.reference)}`, create)
      : await create();
    // `200`, not `201`, as published.
    return reply.status(200).send(serializePayout(transfer));
  });

  async function bachsPayouts(actor: Actor): Promise<Transfer[]> {
    const transfers = await everyRow((page) => storage.transfers.list(page));
    return transfers
      .filter((transfer) => transfer.provider === PROVIDER && transfer.metadata.bachs_payout && ownsTransfer(actor, transfer))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  fastify.get('/v1/payouts', async (request, reply) => {
    const actor = await ctx.actor(request);
    const query = listPayoutsQuery.parse(request.query);
    const { limit, offset } = readPage(query, 50);
    let payouts = await bachsPayouts(actor);
    if (query.status_filter) payouts = payouts.filter((transfer) => payoutStatus(transfer) === query.status_filter);
    return reply.send({ total: payouts.length, items: payouts.slice(offset, offset + limit).map(serializePayout) });
  });

  // Registered before `/v1/payouts/:withdrawal_id` matters only for
  // readability: Fastify prefers a static segment over a parameter anyway.
  fastify.get('/v1/payouts/mobile-money-providers', async (request, reply) => {
    await ctx.actor(request);
    const query = z.object({ country_code: z.string().optional() }).parse(request.query);
    return reply.send(momoProviders(query.country_code ?? 'GH'));
  });

  fastify.get<{ Params: { withdrawal_id: string } }>('/v1/payouts/:withdrawal_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const engineId = await state.payouts.engineIdOf(request.params.withdrawal_id);
    // The index is written just after the payout; a payout that outlived it
    // (a crash in between) is still found by its id.
    const transfer = engineId
      ? await storage.transfers.byId(engineId)
      : ((await bachsPayouts(actor)).find((entry) => payoutIdOf(entry.id) === request.params.withdrawal_id) ?? null);
    if (!transfer || !ownsTransfer(actor, transfer)) throw notFound('Payout');
    return reply.send(serializePayout(transfer));
  });

  /* -------------------------------- schedules ------------------------------- */

  function serializeSchedule(schedule: StoredSchedule) {
    return {
      currency: schedule.currency,
      payout_currency: schedule.payoutCurrency,
      interval: schedule.interval,
      weekly_payout_days: schedule.weeklyDays,
      monthly_payout_days: schedule.monthlyDays,
      anchor_hour_utc: schedule.anchorHour,
      minimum_amount: schedule.minimum === null ? null : toDecimal(schedule.minimum, schedule.currency),
      next_run_at: schedule.nextRunAt,
      last_run_at: schedule.lastRunAt,
      last_withdrawal_id: schedule.lastWithdrawalId,
      disabled_reason: schedule.disabledReason,
    };
  }

  async function settings(actor: Actor) {
    const all = (await state.schedules.all())
      .filter((entry) => owns(actor, entry.account))
      .sort((a, b) => a.currency.localeCompare(b.currency));
    return { schedule_by_currency: Object.fromEntries(all.map((entry) => [entry.currency, serializeSchedule(entry)])) };
  }

  fastify.get('/v1/balance_settings', async (request, reply) => {
    const actor = await ctx.actor(request);
    return reply.send(await settings(actor));
  });

  fastify.post('/v1/balance_settings', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = settingsSchema.parse(request.body ?? {});
    const entries = Object.entries(body.schedule_by_currency ?? {});
    const prepared: StoredSchedule[] = [];
    for (const [key, input] of entries) {
      const currency = key.toUpperCase();
      const field = (name: string) => `schedule_by_currency.${key}.${name}`;
      const invalid = (detail: string) => fail('validation_failed', 'VALIDATION_ERROR', detail);
      if (!isHeld(currency)) throw invalid(`${field('currency')}: a schedule governs a held balance, USD or NGN.`);
      // "The legacy fields `cadence`, `enabled` and `anchor_day` are rejected."
      for (const legacy of ['cadence', 'enabled', 'anchor_day']) {
        if (legacy in input) throw invalid(`${field(legacy)}: no longer accepted.`);
      }
      if (input.weekly_payout_days && input.interval !== 'weekly') {
        throw invalid(`${field('weekly_payout_days')}: only on a weekly interval.`);
      }
      if (input.monthly_payout_days && input.interval !== 'monthly') {
        throw invalid(`${field('monthly_payout_days')}: only on a monthly interval.`);
      }
      const payoutCurrency = (input.payout_currency ?? currency).toUpperCase();
      if (payoutCurrency !== currency) {
        // "Converting out of a local settlement currency is rejected here
        // rather than at run time."
        if (currency !== 'USD') throw invalid(`${field('payout_currency')}: only a USD balance can pay out in another currency.`);
        const routable = isStablecoin(payoutCurrency) || BANK_CURRENCIES.includes(payoutCurrency) || MOMO_CURRENCIES.includes(payoutCurrency);
        if (!hasRate(payoutCurrency) || !routable) {
          throw invalid(`${field('payout_currency')}: there is no payout route to ${payoutCurrency}.`);
        }
      }
      const prior = await state.schedules.get(currency, actor.account?.id ?? null);
      const automatic = input.interval !== 'manual' && input.interval !== 'instant';
      prepared.push({
        ...ownerField(actor),
        currency,
        payoutCurrency,
        interval: input.interval,
        weeklyDays: input.interval === 'weekly' ? [...new Set(input.weekly_payout_days ?? ['monday'])] : null,
        monthlyDays: input.interval === 'monthly' ? [...new Set(input.monthly_payout_days ?? [1])].sort((a, b) => a - b) : null,
        anchorHour: automatic ? (input.anchor_hour_utc ?? 10) : null,
        minimum: input.minimum_amount ? toMinor(input.minimum_amount, currency, field('minimum_amount')) : null,
        nextRunAt: null,
        lastRunAt: prior?.lastRunAt ?? null,
        lastWithdrawalId: prior?.lastWithdrawalId ?? null,
        // "Setting an automatic interval again clears the failure count."
        disabledReason: null,
        failures: 0,
        version: prior?.version ?? 0,
      });
    }
    for (const schedule of prepared) await treasury.saveSchedule(schedule);
    return reply.send(await settings(actor));
  });

  /* ------------------------------- conversions ------------------------------ */

  function assertSettlementPair(from: string, to: string): void {
    if (!isHeld(from) || !isHeld(to) || from === to) {
      throw fail('validation_failed', 'QUOTE_ERROR', 'Conversions are between settlement currencies only: USD <-> NGN.');
    }
  }

  fastify.post('/v1/conversions/quotes', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = conversionQuoteSchema.parse(request.body);
    const from = body.from_currency.toUpperCase();
    const to = body.to_currency.toUpperCase();
    assertSettlementPair(from, to);
    const quote = await treasury.createQuote({
      kind: 'conversion',
      from,
      to,
      fromAmount: toMinor(body.amount, from),
      fee: 0,
      owner: actor,
    });
    return reply.status(201).send({
      quote_id: quote.id,
      from_currency: from,
      to_currency: to,
      from_amount: toDecimal(quote.fromAmount, from),
      to_amount: toDecimal(quote.toAmount, to),
      exchange_rate: quote.rate,
      expires_at: quote.expiresAt,
    });
  });

  function serializeConversion(conversion: NonNullable<Awaited<ReturnType<typeof state.conversions.get>>>) {
    return {
      conversion_id: conversion.id,
      status: conversion.status,
      from_currency: conversion.fromCurrency,
      to_currency: conversion.toCurrency,
      from_amount: toDecimal(conversion.fromAmount, conversion.fromCurrency),
      to_amount: toDecimal(conversion.toAmount, conversion.toCurrency),
      exchange_rate: conversion.rate,
      quote_id: conversion.quoteId,
      metadata: conversion.metadata,
      created_at: conversion.createdAt,
    };
  }

  fastify.post('/v1/conversions', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = conversionSchema.parse(request.body);
    const from = body.from_currency.toUpperCase();
    const to = body.to_currency.toUpperCase();
    assertSettlementPair(from, to);
    const conversion = await treasury.executeConversion({
      quoteId: body.quote_id,
      from,
      to,
      amount: toMinor(body.amount, from),
      owner: actor,
    });
    return reply.status(201).send(serializeConversion(conversion));
  });

  fastify.get('/v1/conversions', async (request, reply) => {
    const actor = await ctx.actor(request);
    const query = listConversionsQuery.parse(request.query);
    const { limit, offset } = readPage(query, 50);
    const matches = (await state.conversions.all())
      .filter((entry) => owns(actor, entry.account))
      .filter((entry) => !query.from_currency || entry.fromCurrency === query.from_currency.toUpperCase())
      .filter((entry) => !query.to_currency || entry.toCurrency === query.to_currency.toUpperCase())
      .filter((entry) => !query.status || entry.status === query.status)
      .filter((entry) => !query.start_date || entry.createdAt >= query.start_date)
      .filter((entry) => !query.end_date || entry.createdAt <= query.end_date)
      .sort(newestFirst);
    return reply.send({ total: matches.length, limit, offset, items: matches.slice(offset, offset + limit).map(serializeConversion) });
  });

  fastify.get<{ Params: { conversion_id: string } }>('/v1/conversions/:conversion_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const conversion = await state.conversions.get(request.params.conversion_id);
    if (!conversion || !owns(actor, conversion.account)) throw notFound('Conversion');
    return reply.send(serializeConversion(conversion));
  });

  /* ---------------------------- virtual accounts ---------------------------- */

  const serializeVirtualAccount = (account: StoredVirtualAccount) => ({
    id: account.id,
    currency: account.currency,
    account_number: account.accountNumber,
    bank_name: account.bankName,
    bank_code: account.bankCode,
    status: account.status,
    created_at: account.createdAt,
  });

  fastify.post('/v1/virtual-accounts', async (request, reply) => {
    const actor = await ctx.actor(request);
    const owner = actor.account?.id ?? null;
    const body = virtualAccountSchema.parse(request.body);
    const currency = body.currency.toUpperCase();
    if (currency !== 'NGN') {
      throw fail('validation_failed', 'VIRTUAL_ACCOUNT_CURRENCY_NOT_SUPPORTED', `Virtual accounts are NGN only, not ${currency}.`);
    }
    // The VA guide: issued for an account only with its `virtual_accounts` capability.
    if (!hasCapability(actor.account, 'virtual_accounts')) {
      throw fail('authentication_failed', 'FORBIDDEN', 'This account cannot hold a virtual account: virtual_accounts is not active.');
    }
    // "Calling it again returns the same number with 200."
    const account = await withLock(`virtual-account:${ownerKey(owner, currency)}`, async () => {
      const existing = await state.virtualAccounts.get(currency, owner);
      if (existing) return existing;
      const id = hexId(ids, 'va', 12);
      const digits = createHash('sha256').update(`va:${id}`).digest('hex').replace(/\D/g, '').padEnd(8, '0');
      const created: StoredVirtualAccount = {
        ...ownerField(actor),
        id,
        currency,
        // "A sandbox number ... starts with 90 and its bank is Sandbox Test Bank."
        accountNumber: `90${digits.slice(0, 8)}`,
        bankName: 'Sandbox Test Bank',
        bankCode: '000',
        status: 'active',
        createdAt: clock.nowISO(),
      };
      await state.virtualAccounts.put(created);
      await state.virtualAccounts.indexId(id, currency, owner);
      return created;
    });
    return reply.status(200).send(serializeVirtualAccount(account));
  });

  fastify.get('/v1/virtual-accounts', async (request, reply) => {
    const actor = await ctx.actor(request);
    const query = z.object({ currency: z.string().length(3).optional() }).parse(request.query);
    const account = await state.virtualAccounts.get((query.currency ?? 'NGN').toUpperCase(), actor.account?.id ?? null);
    if (!account) throw notFound('Virtual account');
    return reply.send(serializeVirtualAccount(account));
  });

  /**
   * paybox's test control: a bank transfer into the account's virtual
   * account. Bachs says "there is no way to simulate a deposit into it today",
   * so this is paybox's, and labelled so. A deposit is a payment like any
   * other -- `collection.succeeded` with no checkout -- carrying the virtual
   * account fee (1%, capped at NGN 300).
   */
  fastify.post<{ Params: { virtual_account_id: string } }>(
    '/v1/virtual-accounts/:virtual_account_id/deposits',
    async (request, reply) => {
      const actor = await ctx.actor(request);
      const body = depositSchema.parse(request.body);
      const account = await state.virtualAccounts.byId(request.params.virtual_account_id);
      if (!account || !owns(actor, account.account)) throw notFound('Virtual account');
      const amount = toMinor(body.amount, account.currency, 'amount');
      const chargeId = hexId(ids, 'ch');
      const sender = createHash('sha256').update(`deposit:${chargeId}`).digest('hex').replace(/\D/g, '').padEnd(30, '0');
      let payment = await engine.createPayment({
        provider: PROVIDER,
        // A deposit into an account's virtual account is that account's money.
        ...directCharge(actor),
        amount,
        currency: account.currency,
        reference: chargeId,
        providerTransactionId: chargeId,
        paymentMethod: 'bank_transfer',
        paymentMethodDetails: {
          corridor: 'NGN_BANK_TRANSFER',
          sender_name: body.sender_name ?? 'PAYBOX TEST PAYER',
          sender_bank: body.sender_bank ?? 'Sandbox Test Bank',
          sender_bank_code: '000',
          sender_account_number: body.sender_account_number ?? sender.slice(0, 10),
          session_id: sender.slice(0, 30),
          narration: body.narration ?? null,
          virtual_account: {
            id: account.id,
            account_number: account.accountNumber,
            bank_name: account.bankName,
            type: 'permanent',
            expires_at: null,
          },
        },
        metadata: {},
        status: 'pending',
      });
      await state.paymentMeta.put(payment.id, {
        seq: await state.nextSeq(),
        billingReason: 'purchase',
        channel: 'virtual_account',
        subscriptionId: null,
        invoiceEngineId: null,
        reference: null,
        description: body.narration ?? null,
        metadata: {},
        conversion: null,
      });
      // "An NGN deposit is available immediately."
      payment = await engine.transitionPayment(payment.id, 'processing');
      payment = await engine.transitionPayment(payment.id, 'successful');
      return reply.status(201).send(serializePayment(payment, await ctx.paymentContext(payment)));
    },
  );

  /* -------------------------------- reference -------------------------------- */

  fastify.get('/v1/currencies/payout-supported', async (request, reply) => {
    await ctx.actor(request);
    return reply.send({ fiat: PAYOUT_SUPPORTED, crypto: [...STABLECOINS] });
  });

  fastify.get('/v1/reference/banks', async (request, reply) => {
    await ctx.actor(request);
    const query = z.object({ country: z.string().length(2).optional() }).parse(request.query);
    // "Falls back to the platform's country": a sandbox account here is Nigerian.
    const country = (query.country ?? 'NG').toUpperCase();
    return reply.send({ country, banks: BANKS[country] ?? [] });
  });

  fastify.get('/v1/reference/momo', async (request, reply) => {
    await ctx.actor(request);
    const query = z.object({ country: z.string().optional(), country_code: z.string().optional() }).parse(request.query);
    return reply.send(momoProviders(query.country ?? query.country_code ?? 'GH'));
  });

  fastify.post('/v1/misc/bank-accounts/resolve', async (request, reply) => {
    await ctx.actor(request);
    const body = z
      .object({ account_number: z.string(), bank_code: z.string(), country: z.string().length(2).optional() })
      .parse(request.body);
    const country = (body.country ?? 'NG').toUpperCase();
    const bank = (BANKS[country] ?? []).find((entry) => entry.code === body.bank_code);
    // "A `false` here is not an HTTP error."
    if (!bank || !['NG', 'GH'].includes(country) || !/^\d{10,13}$/.test(body.account_number)) {
      return reply.send({
        resolved: false,
        account_name: null,
        account_number: body.account_number,
        message: 'The account could not be resolved.',
      });
    }
    return reply.send({
      resolved: true,
      account_name: resolveAccountName(body.account_number, body.bank_code),
      account_number: body.account_number,
      message: null,
    });
  });
}

function momoProviders(country: string) {
  const code = country.toUpperCase();
  return { country: code, providers: (MOMO_COUNTRIES[code] ?? []).map((name) => ({ name, country: code })) };
}

/** Bachs' four payout statuses, from the core transfer's. */
export function payoutStatus(transfer: Transfer): 'pending' | 'processing' | 'completed' | 'failed' {
  switch (transfer.status) {
    case 'processing':
      return 'processing';
    case 'successful':
      return 'completed';
    case 'failed':
    case 'cancelled':
    case 'reversed':
      return 'failed';
    default:
      return 'pending';
  }
}

/** `PayoutResponse`: "the one shape across create, retrieve and list". Amount and currency are what arrives. */
export function serializePayout(transfer: Transfer) {
  const facts = payoutFacts(transfer);
  const status = payoutStatus(transfer);
  const terminal = status === 'completed' || status === 'failed';
  return {
    id: payoutIdOf(transfer.id),
    status,
    amount: toDecimal(facts.destinationAmount, decimalCurrency(facts.destinationCurrency)),
    currency: facts.destinationCurrency,
    source_currency: facts.sourceCurrency,
    fee: toDecimal(facts.fee, facts.sourceCurrency),
    total_debited: toDecimal(facts.totalDebited, facts.sourceCurrency),
    destination: facts.destination,
    reference: facts.reference,
    failure_reason: status === 'failed' ? (transfer.failureReason ?? facts.failureReason) : null,
    created_at: transfer.createdAt,
    completed_at: terminal ? transfer.updatedAt : null,
  };
}

