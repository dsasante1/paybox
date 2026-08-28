import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  EventBus,
  PaymentEngine,
  Scheduler,
  VirtualClock,
  type ProviderStatusResolver,
  type Storage,
} from '@paybox/core';
import { openStorage } from '@paybox/storage';
import { createIdFactory, createRandom, type IdFactory, type Random } from '@paybox/shared';
import {
  PAYMENT_SIMULATE_JOB,
  REFUND_SETTLE_JOB,
  PaymentSimulator,
  ScenarioRunner,
  SCENARIO_STEP_JOB,
  SUBSCRIPTION_CHARGE_JOB,
  SUBSCRIPTION_INVOICE_JOB,
  SubscriptionRunner,
  type SimulatedOutcome,
} from '@paybox/simulator';
import {
  WEBHOOK_DELIVERY_JOB,
  WebhookDispatcher,
  createRetryPolicy,
  type DeliveryTransport,
} from '@paybox/webhooks';
import {
  PaystackWebhookFormatter,
  generateLocalKeys,
  paystackAuthorizationMinter,
  paystackRetrySchedule,
  PAYSTACK_TEST_MODE_MAX_ATTEMPTS,
  toPaystackStatus,
} from '@paybox/paystack';
import {
  StripeWebhookFormatter,
  generateStripeKeys,
  stripeAuthorizationMinter,
  stripeSetupAuthorizationMinter,
  toStripeStatus,
} from '@paybox/stripe';
import type { PayboxConfig } from './config.js';
import { PayboxLogger, type LogEntry } from './logger.js';
import { NetworkSimulator } from './network.js';

export interface PayboxContext {
  config: PayboxConfig;
  storage: Storage;
  clock: VirtualClock;
  random: Random;
  ids: IdFactory;
  bus: EventBus;
  engine: PaymentEngine;
  simulator: PaymentSimulator;
  scenarios: ScenarioRunner;
  subscriptions: SubscriptionRunner;
  dispatcher: WebhookDispatcher;
  scheduler: Scheduler;
  network: NetworkSimulator;
  logger: PayboxLogger;
  keys: { secretKey: string; publicKey: string };
  /** Per-provider local test credentials (spec §29). */
  stripeKeys: { secretKey: string; publishableKey: string };
  baseUrl: string;
  shutdown(): Promise<void>;
}

export interface BuildContextOptions {
  config: PayboxConfig;
  /** Overridden in tests to capture deliveries without binding a port. */
  transport?: DeliveryTransport;
  logSink?: (entry: LogEntry) => void;
}

/**
 * Composition root.
 *
 * Every dependency is constructed once, here, and passed down explicitly.
 * This is the whole of the wiring story — the reason the project needs no DI
 * container is that this function is the container, and it is 60 lines you can
 * read top to bottom.
 */
export async function buildContext(options: BuildContextOptions): Promise<PayboxContext> {
  const { config } = options;

  if (config.database.path !== ':memory:') {
    mkdirSync(dirname(resolve(config.database.path)), { recursive: true });
  }
  const { storage } = await openStorage({ database: config.database.path });

  const clock = new VirtualClock({
    ...(config.startAt ? { startAt: config.startAt } : {}),
    frozen: config.freezeClock,
  });
  const random = createRandom(config.seed);
  const ids = createIdFactory(random);
  const bus = new EventBus();
  const logger = new PayboxLogger({
    clock,
    level: config.logLevel as 'info',
    ...(options.logSink ? { sink: options.logSink } : {}),
  });

  const baseUrl = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;

  // Each adapter contributes its own canonical -> provider status mapping.
  // The engine only sees a function, so it stays provider-agnostic (spec §30).
  const providerStatus: ProviderStatusResolver = (provider, status) => {
    if (provider === 'paystack') return toPaystackStatus(status);
    if (provider === 'stripe') return toStripeStatus(status);
    return status;
  };

  // Which channels mint a reusable authorization is also provider knowledge,
  // injected the same way and for the same reason as the status mapping above.
  const mintAuthorization = (payment: Parameters<typeof paystackAuthorizationMinter>[0]) => {
    if (payment.provider === 'paystack') return paystackAuthorizationMinter(payment);
    if (payment.provider === 'stripe') return stripeAuthorizationMinter(payment);
    return null;
  };

  /**
   * The instrument a completed setup leaves behind.
   *
   * Only Stripe models a setup as its own resource today; Paystack reaches
   * card-on-file by charging and keeping the code it returns, which the
   * payment-path minter already covers.
   */
  const mintSetupAuthorization = (setup: Parameters<typeof stripeSetupAuthorizationMinter>[0]) =>
    setup.provider === 'stripe' ? stripeSetupAuthorizationMinter(setup) : null;

  const engine = new PaymentEngine({
    storage,
    clock,
    ids,
    bus,
    providerStatus,
    mintAuthorization,
    mintSetupAuthorization,
    enforceBalance: config.balance.enforce,
    openingBalance: config.balance.opening,
  });
  const simulator = new PaymentSimulator({ engine, clock });
  const scenarios = new ScenarioRunner({ storage, clock, ids, simulator, engine });
  const subscriptions = new SubscriptionRunner({
    storage,
    clock,
    ids,
    simulator,
    engine,
    // Paystack raises the invoice three days ahead; Stripe finalises about an
    // hour after creating it. Hardcoding either would land the other's
    // invoice webhook at the wrong time.
    invoiceLeadMs: { paystack: 3 * 24 * 60 * 60_000, stripe: 60 * 60_000 },
  });
  const network = new NetworkSimulator(random);

  const dispatcher = new WebhookDispatcher({
    storage,
    clock,
    ids,
    random,
    baseUrl,
    ...(options.transport ? { transport: options.transport } : {}),
    retry: createRetryPolicy({
      enabled: config.webhooks.retry.enabled,
      // Paystack's own ladder is a fixed ten attempts; overriding maxAttempts
      // alongside it would produce a schedule that is neither.
      maxAttempts:
        config.webhooks.retry.schedule === 'paystack'
          ? PAYSTACK_TEST_MODE_MAX_ATTEMPTS
          : config.webhooks.retry.maxAttempts,
      ...(config.webhooks.retry.schedule === 'paystack'
        ? { backoff: (attempt: number) => paystackRetrySchedule(attempt, 'test') }
        : {}),
      jitter: () => random.fork('webhook-jitter').next(),
    }),
    timeoutMs: config.webhooks.timeoutMs,
    logger: {
      debug: (m, x) => logger.debug(m, x as Record<string, unknown>),
      warn: (m, x) => logger.warn(m, x as Record<string, unknown>),
    },
  });
  dispatcher.register(new PaystackWebhookFormatter());
  dispatcher.register(new StripeWebhookFormatter({ basePath: '/stripe' }));
  dispatcher.attachTo(bus);

  // Structured event log (spec §42) and a bus-level error boundary, so a
  // failing subscriber can never roll back a committed state change.
  bus.onAny((event) => {
    logger.info(event.type, {
      provider: event.provider,
      resource_id: event.resourceId,
      event_id: event.id,
      status: event.currentStatus,
    });
  });
  bus.onError((error, event) => {
    logger.error('event.handler_failed', {
      event_id: event.id,
      type: event.type,
      message: error instanceof Error ? error.message : String(error),
    });
  });

  const scheduler = new Scheduler({
    storage,
    clock,
    logger: {
      debug: (m, x) => logger.debug(m, x as Record<string, unknown>),
      warn: (m, x) => logger.warn(m, x as Record<string, unknown>),
      error: (m, x) => logger.error(m, x as Record<string, unknown>),
    },
  });

  scheduler.register(WEBHOOK_DELIVERY_JOB, dispatcher.handleJob);
  scheduler.register(SCENARIO_STEP_JOB, scenarios.handleJob);
  scheduler.register(SUBSCRIPTION_INVOICE_JOB, subscriptions.handleInvoiceJob);
  scheduler.register(SUBSCRIPTION_CHARGE_JOB, subscriptions.handleChargeJob);
  scheduler.register(PAYMENT_SIMULATE_JOB, async (job) => {
    const paymentId = String(job.payload.paymentId ?? '');
    const outcome = job.payload.outcome as SimulatedOutcome | undefined;
    if (!paymentId || !outcome) return;
    await simulator.apply(paymentId, outcome);
  });
  /**
   * The deadline reminder a provider sends before a dispute expires.
   *
   * A scheduled job rather than a timer, so "nobody answered in time" is one
   * `paybox time advance` away.
   */
  /**
   * Settle a queued refund, the way a refund processor eventually would.
   *
   * Walks pending -> processing -> outcome rather than jumping, so the
   * intermediate `refund.processing` webhook actually fires. A refund that
   * lands in `needs_attention` stops there and waits for bank details.
   */
  scheduler.register(REFUND_SETTLE_JOB, async (job) => {
    const refundId = String(job.payload.refundId ?? '');
    const outcome = String(job.payload.outcome ?? 'successful') as
      | 'successful'
      | 'failed'
      | 'needs_attention';
    if (!refundId) return;

    const refund = await storage.refunds.byId(refundId);
    // Someone may have settled it by hand from the CLI in the meantime.
    if (!refund || refund.status !== 'pending') return;

    await engine.transitionRefund(refundId, 'processing');
    if (outcome === 'needs_attention') {
      await engine.transitionRefund(refundId, 'needs_attention');
      return;
    }
    await engine.transitionRefund(refundId, outcome);
  });

  scheduler.register('dispute.remind', async (job) => {
    const disputeId = String(job.payload.disputeId ?? '');
    const dispute = await engine.getDispute(disputeId);
    // Nothing to remind anyone about once it has been settled.
    if (!dispute || dispute.status === 'resolved') return;
    await engine.transitionDispute(dispute.id, 'awaiting_bank_feedback', {
      eventType: 'dispute.reminder',
    });
  });

  scheduler.register('payment.expire', async (job) => {
    const paymentId = String(job.payload.paymentId ?? '');
    const payment = await engine.getPayment(paymentId);
    // Only expire something still in flight — the payment may well have
    // settled between the job being scheduled and becoming due.
    if (!payment) return;
    if (!['created', 'pending', 'processing', 'requires_action'].includes(payment.status)) return;
    await simulator.expire(paymentId);
  });

  const keys = generateLocalKeys(ids.token(20));
  const stripeKeys = generateStripeKeys(ids.token(20));

  return {
    config,
    storage,
    clock,
    random,
    ids,
    bus,
    engine,
    simulator,
    scenarios,
    subscriptions,
    dispatcher,
    scheduler,
    network,
    logger,
    keys,
    stripeKeys,
    baseUrl,
    async shutdown() {
      await scheduler.stop();
      await storage.close();
    },
  };
}
