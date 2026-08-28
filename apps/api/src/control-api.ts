import type { FastifyPluginAsync } from 'fastify';
import { PayboxError, formatAmount, type PaymentStatus } from '@paybox/shared';
import { parseDuration } from '@paybox/core';
import type { SimulatedOutcome } from '@paybox/simulator';
import type { PayboxContext } from './context.js';

/**
 * The emulator's own control plane (spec §21-§24, §39-§42).
 *
 * Everything the dashboard and the CLI can do goes through these routes. The
 * CLI is a thin client over exactly this API rather than a second entry point
 * into the engine — one implementation, one set of semantics, no drift.
 */
export const controlApiPlugin: FastifyPluginAsync<{ context: PayboxContext }> = async (
  fastify,
  { context },
) => {
  const { engine, simulator, storage, clock, scenarios, dispatcher, network, logger } = context;

  fastify.setErrorHandler((raw: unknown, _request, reply) => {
    const error = raw as Error & { validation?: unknown };
    if (error instanceof PayboxError) {
      return reply.status(error.httpStatus === 200 ? 400 : error.httpStatus).send({
        error: error.code,
        message: error.message,
        details: error.details,
      });
    }
    if ((error as { validation?: unknown }).validation) {
      return reply.status(400).send({ error: 'validation_failed', message: error.message });
    }
    logger.error('control_api.unhandled', { message: error.message });
    return reply.status(500).send({ error: 'internal_error', message: error.message });
  });

  /* ---------------- health & overview ---------------- */

  fastify.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0',
    time: clock.nowISO(),
    clock: clock.state(),
  }));

  fastify.get('/overview', async () => {
    const [payments, deliveries, recent] = await Promise.all([
      storage.payments.countByStatus(),
      storage.webhooks.countDeliveriesByStatus(),
      storage.events.list({ limit: 20 }),
    ]);
    const total = Object.values(payments).reduce((sum, n) => sum + n, 0);
    return {
      payments: {
        total,
        successful: payments.successful ?? 0,
        pending: (payments.pending ?? 0) + (payments.processing ?? 0) + (payments.requires_action ?? 0),
        failed: payments.failed ?? 0,
        refunded: (payments.refunded ?? 0) + (payments.partially_refunded ?? 0),
        byStatus: payments,
      },
      webhooks: {
        succeeded: deliveries.succeeded ?? 0,
        failed: (deliveries.failed ?? 0) + (deliveries.exhausted ?? 0),
        pending: (deliveries.pending ?? 0) + (deliveries.delivering ?? 0),
        byStatus: deliveries,
      },
      recentActivity: recent.items,
      clock: clock.state(),
      network: network.profile,
      webhookChaos: dispatcher.getChaos(),
    };
  });

  /**
   * Which providers exist, and how far each is actually implemented.
   *
   * Honesty about coverage is a product requirement (spec §31), not a
   * disclaimer: never report a capability we have not implemented. The
   * `implemented` set is the single place that judgement lives, so a new
   * adapter cannot be announced here without being added deliberately.
   */
  const IMPLEMENTED: Record<string, { status: string; keys: Record<string, string> }> = {
    paystack: { status: 'partial', keys: context.keys },
    stripe: { status: 'partial', keys: context.stripeKeys },
  };

  fastify.get('/providers', async () => ({
    providers: Object.entries(context.config.providers).map(([id, cfg]) => ({
      id,
      enabled: cfg.enabled,
      basePath: `/${id}`,
      status: IMPLEMENTED[id]?.status ?? 'not_implemented',
      docs: `/docs/${id}`,
      ...(IMPLEMENTED[id] ? { keys: IMPLEMENTED[id]!.keys } : {}),
    })),
    // Kept for the CLI, which reads a single secret to talk to Paystack.
    keys: context.keys,
  }));

  /* ---------------- payments ---------------- */

  fastify.get<{
    Querystring: {
      status?: PaymentStatus;
      provider?: string;
      reference?: string;
      limit?: string;
      offset?: string;
    };
  }>('/payments', async (request) => {
    const { limit, offset, status, provider, reference } = request.query;
    return storage.payments.list({
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
      ...(status ? { status } : {}),
      ...(provider ? { provider: provider as 'paystack' } : {}),
      ...(reference ? { reference } : {}),
    });
  });

  fastify.get<{ Params: { id: string } }>('/payments/:id', async (request) => {
    const payment = await requirePayment(request.params.id);
    const [timeline, refunds, deliveries] = await Promise.all([
      engine.getTimeline(payment.id),
      storage.refunds.listByPayment(payment.id),
      storage.webhooks.listDeliveries({ limit: 100 }),
    ]);
    const eventIds = new Set(timeline.map((e) => e.id));
    return {
      payment,
      formattedAmount: formatAmount(payment.amount, payment.currency),
      timeline,
      refunds,
      webhookDeliveries: deliveries.items.filter((d) => eventIds.has(d.eventId)),
    };
  });

  fastify.get<{ Params: { id: string } }>('/payments/:id/timeline', async (request) => {
    const payment = await requirePayment(request.params.id);
    return { events: await engine.getTimeline(payment.id) };
  });

  fastify.post<{ Params: { id: string }; Body: { outcome?: SimulatedOutcome; immediate?: boolean } }>(
    '/payments/:id/simulate',
    async (request) => {
      const payment = await requirePayment(request.params.id);
      const outcome = request.body?.outcome ?? 'success';
      return simulator.apply(payment.id, outcome, { immediate: request.body?.immediate ?? false });
    },
  );

  for (const action of ['cancel', 'expire', 'authorize', 'capture'] as const) {
    fastify.post<{ Params: { id: string } }>(`/payments/:id/${action}`, async (request) => {
      const payment = await requirePayment(request.params.id);
      return simulator[action](payment.id);
    });
  }

  fastify.post<{ Params: { id: string }; Body: { approved?: boolean } }>(
    '/payments/:id/authenticate',
    async (request) => {
      const payment = await requirePayment(request.params.id);
      return simulator.completeAuthentication(payment.id, request.body?.approved ?? true);
    },
  );

  fastify.post<{ Params: { id: string }; Body: { amount?: number; reason?: string; settle?: boolean } }>(
    '/payments/:id/refund',
    async (request) => {
      const payment = await requirePayment(request.params.id);
      const refund = await engine.createRefund({
        paymentId: payment.id,
        ...(request.body?.amount ? { amount: request.body.amount } : {}),
        reason: request.body?.reason ?? null,
      });
      // Refunds settle asynchronously at every provider we emulate, but the
      // dashboard button wants a finished refund, so allow an explicit settle.
      if (request.body?.settle !== false) {
        return engine.transitionRefund(refund.id, 'successful');
      }
      return refund;
    },
  );

  /* ---------------- refunds, transfers, customers ---------------- */

  fastify.get('/refunds', async () => storage.refunds.list({ limit: 100 }));
  fastify.get('/transfers', async () => storage.transfers.list({ limit: 100 }));
  fastify.get('/customers', async () => storage.customers.list({ limit: 100 }));

  fastify.post<{ Params: { id: string }; Body: { status?: 'successful' | 'failed' } }>(
    '/transfers/:id/settle',
    async (request) => {
      const target = request.body?.status ?? 'successful';
      await engine.transitionTransfer(request.params.id, 'processing');
      return engine.transitionTransfer(request.params.id, target);
    },
  );

  /* ---------------- dedicated virtual accounts ---------------- */

  fastify.get('/dedicated-accounts', async () =>
    storage.dedicatedAccounts.list({ limit: 100 }),
  );

  /**
   * Simulate money landing in a dedicated virtual account (spec §11).
   *
   * This is an **emulator-only control**, not a Paystack endpoint: in
   * production the credit arrives because someone made a bank transfer, and
   * there is no API that makes one happen. Without it a DVA could be created
   * but never paid into, which would make the whole feature untestable.
   *
   * The credit walks the ordinary state machine, so it appends the same
   * events and fires the same `charge.success` webhook as any other payment.
   */
  fastify.post<{
    Params: { id: string };
    Body: { amount?: number; currency?: string; reference?: string; senderName?: string };
  }>('/dedicated-accounts/:id/credit', async (request, reply) => {
    const account =
      (await storage.dedicatedAccounts.byId(request.params.id)) ??
      (await storage.dedicatedAccounts.byAccountNumber('paystack', request.params.id));
    if (!account) {
      throw new PayboxError('not_found', `No dedicated account ${request.params.id}.`);
    }

    const amount = Number(request.body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new PayboxError(
        'validation_failed',
        'A positive integer amount in minor units is required.',
      );
    }

    const customer = await storage.customers.byId(account.customerId);
    const payment = await engine.createPayment({
      provider: account.provider,
      amount,
      currency: request.body?.currency ?? account.currency,
      ...(request.body?.reference ? { reference: request.body.reference } : {}),
      customerId: account.customerId,
      paymentMethod: 'bank_transfer',
      paymentMethodDetails: {
        account_number: account.accountNumber,
        account_name: account.accountName,
        bank: account.bankName,
        sender_name: request.body?.senderName ?? 'TEST SENDER',
      },
      metadata: { email: customer?.email, dedicated_account_id: account.id },
      status: 'pending',
    });

    const settled = await simulator.succeed(payment.id);
    return reply.status(201).send(settled);
  });

  /* ---------------- authorizations, plans, subscriptions ---------------- */

  fastify.get('/authorizations', async () => storage.authorizations.list({ limit: 100 }));

  fastify.get('/plans', async () => storage.plans.list({ limit: 100 }));

  fastify.get<{ Querystring: { status?: string } }>('/subscriptions', async (request) =>
    storage.subscriptions.list({
      limit: 100,
      ...(request.query.status ? { status: request.query.status as 'active' } : {}),
    }),
  );

  fastify.get<{ Params: { id: string } }>('/subscriptions/:id', async (request) => {
    const subscription = await storage.subscriptions.byId(request.params.id);
    if (!subscription) {
      throw new PayboxError('not_found', `No subscription ${request.params.id}.`);
    }
    return {
      subscription,
      plan: await storage.plans.byId(subscription.planId),
      invoices: await storage.invoices.listBySubscription(subscription.id),
    };
  });

  fastify.post<{ Params: { id: string }; Body: { status?: string } }>(
    '/subscriptions/:id/disable',
    async (request) =>
      engine.transitionSubscription(
        request.params.id,
        (request.body?.status ?? 'non_renewing') as 'non_renewing',
      ),
  );

  fastify.get('/invoices', async () => storage.invoices.list({ limit: 100 }));

  /* ---------------- marketplace ---------------- */

  fastify.get('/subaccounts', async () => storage.subaccounts.list({ limit: 100 }));

  fastify.get('/splits', async () => storage.splits.list({ limit: 100 }));

  fastify.get<{ Querystring: { currency?: string } }>('/balance', async (request) => {
    const currencies = await storage.ledger.currencies('paystack');
    const listed = request.query.currency
      ? [request.query.currency.toUpperCase()]
      : currencies.length > 0
        ? currencies
        : ['NGN'];
    return {
      balances: await Promise.all(
        listed.map(async (currency) => ({
          currency,
          balance: await engine.getBalance('paystack', currency),
        })),
      ),
    };
  });

  fastify.get('/balance/ledger', async () => storage.ledger.list({ limit: 100 }));

  /**
   * Top up the test float.
   *
   * Emulator-only, and deliberately so: there is no provider API that puts
   * money in your balance out of nowhere. It exists so a payout test can be
   * set up without first staging a collection.
   */
  fastify.post<{ Body: { amount?: number; currency?: string; reason?: string } }>(
    '/balance/credit',
    async (request, reply) => {
      const amount = Number(request.body?.amount);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new PayboxError(
          'validation_failed',
          'A positive integer amount in minor units is required.',
        );
      }
      const entry = await engine.creditBalance({
        provider: 'paystack',
        currency: request.body?.currency ?? 'NGN',
        amount,
        reason: request.body?.reason ?? 'manual_credit',
      });
      return reply.status(201).send(entry);
    },
  );

  /* ---------------- disputes ---------------- */

  fastify.get<{ Querystring: { status?: string } }>('/disputes', async (request) =>
    storage.disputes.list({
      limit: 100,
      ...(request.query.status ? { status: request.query.status as 'resolved' } : {}),
    }),
  );

  fastify.post<{
    Body: { paymentId?: string; category?: string; refundAmount?: number; message?: string };
  }>('/disputes', async (request, reply) => {
    const paymentId = String(request.body?.paymentId ?? '');
    if (!paymentId) throw new PayboxError('validation_failed', 'A paymentId is required.');
    const dispute = await engine.createDispute({
      paymentId,
      ...(request.body?.category ? { category: request.body.category } : {}),
      ...(request.body?.refundAmount !== undefined
        ? { refundAmount: request.body.refundAmount }
        : {}),
      ...(request.body?.message ? { message: request.body.message } : {}),
    });
    await engine.scheduleDisputeReminder(dispute);
    return reply.status(201).send(dispute);
  });

  fastify.post<{
    Params: { id: string };
    Body: { resolution?: string; message?: string; refundAmount?: number };
  }>('/disputes/:id/resolve', async (request) =>
    engine.resolveDispute(request.params.id, {
      resolution: (request.body?.resolution ?? 'merchant-accepted') as 'declined',
      message: request.body?.message ?? 'Resolved from the CLI',
      ...(request.body?.refundAmount !== undefined
        ? { refundAmount: request.body.refundAmount }
        : {}),
    }),
  );

  /* ---------------- events ---------------- */

  fastify.get<{ Querystring: { limit?: string; type?: string; resourceId?: string } }>(
    '/events',
    async (request) =>
      storage.events.list({
        limit: request.query.limit ? Number(request.query.limit) : 100,
        ...(request.query.type ? { type: request.query.type } : {}),
        ...(request.query.resourceId ? { resourceId: request.query.resourceId } : {}),
      }),
  );

  fastify.post<{ Params: { id: string } }>('/events/:id/replay', async (request) => ({
    deliveries: await dispatcher.replayEvent(request.params.id),
  }));

  /* ---------------- webhooks ---------------- */

  fastify.get('/webhooks/endpoints', async () => ({
    endpoints: await storage.webhooks.listEndpoints(),
  }));

  fastify.post<{
    Body: { url: string; provider?: string; secret?: string; eventTypes?: string[]; description?: string };
  }>('/webhooks/endpoints', async (request, reply) => {
    const body = request.body;
    if (!body?.url) throw new PayboxError('validation_failed', 'A webhook url is required.');
    const now = clock.nowISO();
    const endpoint = await storage.webhooks.createEndpoint({
      id: context.ids.next('whe'),
      provider: (body.provider ?? 'paystack') as 'paystack',
      url: body.url,
      secret: body.secret ?? context.keys.secretKey,
      enabled: true,
      eventTypes: body.eventTypes ?? [],
      description: body.description ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return reply.status(201).send(endpoint);
  });

  fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/webhooks/endpoints/:id',
    async (request) =>
      storage.webhooks.updateEndpoint(request.params.id, {
        ...(request.body as Record<string, never>),
        updatedAt: clock.nowISO(),
      }),
  );

  fastify.delete<{ Params: { id: string } }>('/webhooks/endpoints/:id', async (request, reply) => {
    await storage.webhooks.deleteEndpoint(request.params.id);
    return reply.status(204).send();
  });

  fastify.get<{ Querystring: { status?: string; limit?: string } }>(
    '/webhooks/deliveries',
    async (request) =>
      storage.webhooks.listDeliveries({
        limit: request.query.limit ? Number(request.query.limit) : 100,
        ...(request.query.status ? { status: request.query.status as 'pending' } : {}),
      }),
  );

  fastify.get<{ Params: { id: string } }>('/webhooks/deliveries/:id', async (request) => {
    const delivery = await storage.webhooks.deliveryById(request.params.id);
    if (!delivery) throw new PayboxError('not_found', `No delivery ${request.params.id}.`);
    return delivery;
  });

  fastify.post<{ Params: { id: string } }>('/webhooks/deliveries/:id/retry', async (request) =>
    dispatcher.retryNow(request.params.id),
  );

  fastify.post<{ Params: { id: string } }>('/webhooks/deliveries/:id/replay', async (request) =>
    dispatcher.replay(request.params.id),
  );

  fastify.get('/webhooks/chaos', async () => dispatcher.getChaos());
  fastify.post<{ Body: Record<string, unknown> }>('/webhooks/chaos', async (request) =>
    dispatcher.setChaos(request.body as never),
  );

  // Mirrors DELETE /network. Without it, the only way back to a clean slate is
  // knowing to POST each field as null, and the asymmetry between the two
  // chaos surfaces is a trap.
  fastify.delete('/webhooks/chaos', async () => dispatcher.resetChaos());

  /* ---------------- network simulation ---------------- */

  fastify.get('/network', async () => network.profile);
  fastify.post<{ Body: { latencyMs?: number; failureRate?: number; failureStatus?: number } }>(
    '/network',
    async (request) => network.update(request.body ?? {}),
  );
  fastify.delete('/network', async () => network.reset());

  /* ---------------- time control (spec §39) ---------------- */

  fastify.get('/time', async () => clock.state());

  fastify.post<{ Body: { action: string; value?: string | number } }>('/time', async (request) => {
    const { action, value } = request.body ?? { action: '' };
    switch (action) {
      case 'freeze':
        return clock.freeze(value as number | undefined);
      case 'unfreeze':
        return clock.unfreeze();
      case 'advance': {
        const state = clock.advance(parseDuration(value ?? '0s'));
        // Draining here rather than waiting for the next poll is what makes
        // `advance` synchronous from the caller's point of view: by the time
        // this returns, every job that came due has already run.
        await context.scheduler.settle();
        await context.scheduler.drain();
        return state;
      }
      case 'set':
        return clock.set(value as string);
      default:
        throw new PayboxError(
          'invalid_request',
          'action must be one of freeze, unfreeze, advance, set.',
        );
    }
  });

  /* ---------------- scenarios (spec §12) ---------------- */

  fastify.get('/scenarios', async () => ({ scenarios: scenarios.list() }));

  fastify.post<{ Body: { scenario: string; paymentId: string } }>(
    '/scenarios/run',
    async (request) => {
      const { scenario, paymentId } = request.body ?? { scenario: '', paymentId: '' };
      return scenarios.run(scenario, paymentId);
    },
  );

  fastify.post<{ Body: { yaml: string } }>('/scenarios', async (request) =>
    scenarios.registerFromYaml(request.body?.yaml ?? ''),
  );

  /* ---------------- jobs, logs, lifecycle ---------------- */

  fastify.get<{ Querystring: { status?: string } }>('/jobs', async (request) =>
    storage.jobs.list({
      limit: 100,
      ...(request.query.status ? { status: request.query.status as 'ready' } : {}),
    }),
  );

  fastify.get<{ Querystring: { limit?: string } }>('/logs', async (request) => ({
    logs: logger.recent(request.query.limit ? Number(request.query.limit) : 200),
  }));

  /**
   * Seed data (spec §28).
   *
   * Every seeded record is produced by driving the real engine, so the
   * resulting rows carry genuine event timelines rather than being pasted in.
   * A payment seeded here is indistinguishable from one an application made.
   */
  fastify.post('/seed', async () => {
    const created: Record<string, string> = {};

    const succeeded = await engine.createPayment({
      provider: 'paystack',
      amount: 25_000,
      currency: 'GHS',
      reference: `seed_success_${context.ids.token(6)}`,
      paymentMethod: 'card',
      paymentMethodDetails: { bin: '400000', last4: '0000', brand: 'visa' },
      status: 'pending',
    });
    await simulator.apply(succeeded.id, 'success');
    created.successful = succeeded.id;

    const declined = await engine.createPayment({
      provider: 'paystack',
      amount: 7_500,
      currency: 'GHS',
      reference: `seed_declined_${context.ids.token(6)}`,
      paymentMethod: 'card',
      status: 'pending',
    });
    await simulator.apply(declined.id, 'insufficient_funds');
    created.failed = declined.id;

    const awaiting = await engine.createPayment({
      provider: 'paystack',
      amount: 12_000,
      currency: 'GHS',
      reference: `seed_momo_${context.ids.token(6)}`,
      paymentMethod: 'mobile_money',
      paymentMethodDetails: { phone: '0550000000', network: 'mtn', country: 'GH' },
      status: 'pending',
      expiresInMs: 10 * 60_000,
    });
    await engine.transitionPayment(awaiting.id, 'requires_action');
    created.awaitingAuthorization = awaiting.id;

    const refundable = await engine.createPayment({
      provider: 'paystack',
      amount: 40_000,
      currency: 'GHS',
      reference: `seed_refund_${context.ids.token(6)}`,
      paymentMethod: 'card',
      status: 'pending',
    });
    await simulator.apply(refundable.id, 'success');
    const refund = await engine.createRefund({ paymentId: refundable.id, amount: 15_000 });
    await engine.transitionRefund(refund.id, 'successful');
    created.partiallyRefunded = refundable.id;

    const transfer = await engine.createTransfer({
      provider: 'paystack',
      amount: 50_000,
      currency: 'GHS',
      recipientName: 'Seed Recipient',
      recipientAccount: '0000000000',
      recipientBankCode: '058',
      status: 'pending',
    });
    created.transfer = transfer.id;

    logger.info('emulator.seeded', created);
    return { seeded: created };
  });

  fastify.post('/reset', async () => {
    await storage.reset();
    logger.warn('emulator.reset', {});
    return { status: 'reset' };
  });

  async function requirePayment(handle: string) {
    const payment =
      (await storage.payments.byId(handle)) ??
      (await storage.payments.byReference('paystack', handle));
    if (!payment) throw new PayboxError('not_found', `No payment matching "${handle}".`);
    return payment;
  }
};
