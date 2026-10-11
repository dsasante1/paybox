import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Actor } from './actor.js';
import { fail } from './errors.js';
import { assertMetadata, notFound, readPage } from './http.js';
import { toMinor } from './money.js';
import type { RouteContext } from './route-context.js';
import { pagination } from './serializers.js';
import {
  accountsByPot,
  connectTransfers,
  platformFees,
  transferIdOf,
  transferView,
  type PlatformFeeView,
  type TransferView,
} from './transfers.js';

/** `CreateTransferRequest`. */
const createTransferSchema = z.object({
  destination: z.string().min(1),
  amount: z.string(),
  currency: z.string().min(3).max(10),
  description: z.string().max(500).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  transfer_group: z.string().max(255).nullable().optional(),
});

const listTransfersQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  connected_account_id: z.string().optional(),
  kind: z.string().optional(),
});

const listFeesQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  charge: z.string().optional(),
});

/** The balances a transfer can move: "never converts", and only held currencies are held. */
const TRANSFER_CURRENCIES = ['USD', 'NGN'];

/**
 * Transfers and platform fees. Neither is scoped by `X-Account-Id` the way
 * other resources are: both are read by either party ("any transfer the
 * platform was party to"; "both the account a fee was collected from and the
 * platform that earned it can list it").
 */
export function registerConnectMoneyRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { storage, state, treasury } = ctx;
  const platformId = ctx.organizationId;

  /** What the actor is a party to. */
  const party = (actor: Actor, view: { source: string; destination: string }) =>
    !actor.account || view.source === actor.id || view.destination === actor.id;

  async function visibleTransfers(actor: Actor): Promise<TransferView[]> {
    const pots = await accountsByPot(state);
    const views: TransferView[] = [];
    for (const transfer of await connectTransfers(storage)) {
      const view = await transferView(transfer, storage, state, platformId, pots);
      if (party(actor, view)) views.push(view);
    }
    return views;
  }

  /* -------------------------------- transfers -------------------------------- */

  fastify.post('/v1/transfers', async (request, reply) => {
    const actor = await ctx.actor(request);
    const body = createTransferSchema.parse(request.body);
    assertMetadata(body.metadata);
    const currency = body.currency.toUpperCase();
    if (!TRANSFER_CURRENCIES.includes(currency)) {
      throw fail('validation_failed', 'VALIDATION_ERROR', `currency: a transfer moves ${TRANSFER_CURRENCIES.join(' or ')}.`);
    }
    const amount = toMinor(body.amount, currency, 'amount');
    let destination = null;
    if (actor.account) {
      // "Recovery = second transfer: X-Account-Id + destination: self."
      // Account to account is two transfers through the platform.
      if (body.destination !== 'self') {
        throw fail(
          'invalid_request',
          'BAD_REQUEST',
          'A connected account can only transfer back to its platform: send destination "self".',
        );
      }
    } else {
      if (body.destination === 'self') {
        throw fail('invalid_request', 'BAD_REQUEST', '"self" sends an account\'s money back; send it with X-Account-Id.');
      }
      destination = await state.accounts.get(body.destination);
      // "Other platform's → 404, not 403."
      if (!destination || destination.parent !== platformId) throw notFound('Account');
    }
    const transfer = await treasury.createTransfer({
      source: actor,
      destination,
      amount,
      currency,
      description: body.description ?? null,
      metadata: body.metadata ?? {},
      transferGroup: body.transfer_group ?? null,
    });
    return reply.status(201).send(await transferView(transfer, storage, state, platformId));
  });

  fastify.get('/v1/transfers', async (request, reply) => {
    const actor = await ctx.actor(request);
    const query = listTransfersQuery.parse(request.query);
    if (query.kind !== undefined && query.kind !== 'payout' && query.kind !== 'manual') {
      throw fail('invalid_request', 'BAD_REQUEST', 'kind: payout or manual.');
    }
    const { limit, offset } = readPage(query, 50);
    let views = await visibleTransfers(actor);
    if (query.kind) views = views.filter((view) => view.kind === query.kind);
    if (query.connected_account_id) {
      const id = query.connected_account_id;
      views = views.filter((view) => view.source === id || view.destination === id);
    }
    const page = views.slice(offset, offset + limit);
    return reply.send({ items: page, pagination: pagination(views.length, limit, offset, page.length) });
  });

  fastify.get<{ Params: { transfer_id: string } }>('/v1/transfers/:transfer_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const pots = await accountsByPot(state);
    for (const transfer of await connectTransfers(storage)) {
      if (transferIdOf(transfer.id) !== request.params.transfer_id) continue;
      const view = await transferView(transfer, storage, state, platformId, pots);
      if (party(actor, view)) return reply.send(view);
    }
    throw notFound('Transfer');
  });

  /* ------------------------------ platform fees ------------------------------ */

  async function visibleFees(actor: Actor): Promise<PlatformFeeView[]> {
    const fees = await platformFees(storage, state, platformId);
    return actor.account ? fees.filter((fee) => fee.collected_from === actor.id) : fees;
  }

  fastify.get('/v1/platform_fees', async (request, reply) => {
    const actor = await ctx.actor(request);
    const query = listFeesQuery.parse(request.query);
    const { limit, offset } = readPage(query, 50);
    let fees = await visibleFees(actor);
    if (query.charge) fees = fees.filter((fee) => fee.charge === query.charge);
    const page = fees.slice(offset, offset + limit);
    return reply.send({ items: page, pagination: pagination(fees.length, limit, offset, page.length) });
  });

  fastify.get<{ Params: { fee_id: string } }>('/v1/platform_fees/:fee_id', async (request, reply) => {
    const actor = await ctx.actor(request);
    const fee = (await visibleFees(actor)).find((entry) => entry.id === request.params.fee_id);
    if (!fee) throw notFound('Platform fee');
    return reply.send(fee);
  });
}
