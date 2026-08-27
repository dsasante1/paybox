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
  PaymentSimulator,
  ScenarioRunner,
  SCENARIO_STEP_JOB,
  type SimulatedOutcome,
} from '@paybox/simulator';
import {
  WEBHOOK_DELIVERY_JOB,
  WebhookDispatcher,
  createRetryPolicy,
  type DeliveryTransport,
} from '@paybox/webhooks';
import { PaystackWebhookFormatter, generateLocalKeys, toPaystackStatus } from '@paybox/paystack';
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
  dispatcher: WebhookDispatcher;
  scheduler: Scheduler;
  network: NetworkSimulator;
  logger: PayboxLogger;
  keys: { secretKey: string; publicKey: string };
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
  const providerStatus: ProviderStatusResolver = (provider, status) =>
    provider === 'paystack' ? toPaystackStatus(status) : status;

  const engine = new PaymentEngine({ storage, clock, ids, bus, providerStatus });
  const simulator = new PaymentSimulator({ engine, clock });
  const scenarios = new ScenarioRunner({ storage, clock, ids, simulator, engine });
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
      maxAttempts: config.webhooks.retry.maxAttempts,
      jitter: () => random.fork('webhook-jitter').next(),
    }),
    timeoutMs: config.webhooks.timeoutMs,
    logger: {
      debug: (m, x) => logger.debug(m, x as Record<string, unknown>),
      warn: (m, x) => logger.warn(m, x as Record<string, unknown>),
    },
  });
  dispatcher.register(new PaystackWebhookFormatter());
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
  scheduler.register(PAYMENT_SIMULATE_JOB, async (job) => {
    const paymentId = String(job.payload.paymentId ?? '');
    const outcome = job.payload.outcome as SimulatedOutcome | undefined;
    if (!paymentId || !outcome) return;
    await simulator.apply(paymentId, outcome);
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
    dispatcher,
    scheduler,
    network,
    logger,
    keys,
    baseUrl,
    async shutdown() {
      await scheduler.stop();
      await storage.close();
    },
  };
}
