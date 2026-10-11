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
  SUBSCRIPTION_TRIAL_ENDING_JOB,
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
import {
  FlutterwaveWebhookFormatter,
  flutterwaveAuthorizationMinter,
  generateFlutterwaveKeys,
  generateV4Credentials,
} from '@paybox/flutterwave';
import {
  BACHS_CHECKOUT_EXPIRE_JOB,
  BACHS_SUBSCRIPTION_RENEW_JOB,
  BACHS_SUBSCRIPTION_RETRY_JOB,
  BachsBilling,
  BachsTreasury,
  BACHS_PAYOUT_ADVANCE_JOB,
  BACHS_PAYOUT_SCHEDULE_JOB,
  BachsWebhookFormatter,
  createBachsExpiryHandler,
  generateBachsKeys,
  toBachsPaymentStatus,
} from '@paybox/bachs';
import { KoraWebhookFormatter, generateKoraKeys } from '@paybox/kora';
import { QuiddpayWebhookFormatter, generateQuiddpayKeys } from '@paybox/quiddpay';
import {
  TinggWebhookFormatter,
  generateTinggKeys,
  toTinggStatus,
  type TinggCredentials,
} from '@paybox/tingg';
import { WewireWebhookFormatter, generateWewireKeys } from '@paybox/wewire';
import { WiseWebhookFormatter, generateWiseKeys } from '@paybox/wise';
import type { PayboxConfig } from './config.js';
import { PayboxLogger, type LogEntry } from './logger.js';
import { NetworkSimulator } from './network.js';

export interface PayboxContext {
  config: PayboxConfig;
  storage: Storage;
  clock: VirtualClock;
  /** Seeded, and fresh on each start of a database; see `ids`. */
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
  /**
   * Flutterwave issues three keys, not two: the extra one is the 3DES
   * encryption key a direct card charge's payload is encrypted with.
   */
  flutterwaveKeys: { secretKey: string; publicKey: string; encryptionKey: string };
  /** v4 takes OAuth 2.0 client credentials, not an API key. */
  flutterwaveV4: { clientId: string; clientSecret: string };
  /** Kora's secret key doubles as the card-payload encryption key. */
  koraKeys: { secretKey: string; publicKey: string };
  /**
   * Quid Payments separates the two: the merchant API key authenticates
   * requests, and a distinct per-endpoint secret signs webhooks.
   */
  quiddpayKeys: { apiKey: string; signingSecret: string };
  /**
   * Tingg needs four: an `apiKey` header *and* OAuth client credentials on
   * Checkout 3.0, plus a username/password pair that Payouts takes in the
   * request body. One brand, two unrelated authentication schemes.
   */
  tinggKeys: TinggCredentials;
  /** WeWire has one key, sent verbatim in `ww-api-key`. */
  wewireKeys: { secretKey: string };
  /** Wise uses a bearer token; its webhooks are RSA-signed, not shared-secret. */
  wiseKeys: { apiToken: string };
  /**
   * Bachs has one secret key; webhook signing secrets are per endpoint and
   * minted when one is registered. The organization id is what every Bachs
   * webhook carries as `organization_id`.
   */
  bachsKeys: { secretKey: string; organizationId: string };
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

  // Virtual time survives a restart on the same database: the clock resumes
  // where it was recorded, unless PAYBOX_START_AT has changed since -- which
  // is how a developer deliberately moves to another date, and still works.
  // A fresh database (and :memory:, always fresh) starts as it always has.
  //
  // "Changed" means a different instant, not a different spelling of one:
  // `…00Z` and `…00.000Z`, or a number in paybox.yml, are the same start, and
  // treating them as a change would rewind the clock -- the very bug this
  // prevents. A recorded state that cannot be used (a hand-edited row) is
  // ignored rather than allowed to stop the server starting.
  const configuredStartAt = normaliseStartAt(config.startAt);
  // A row the driver cannot even read (an integer past 2^53) counts as none.
  const recorded = await storage.clock.get().catch(() => null);
  const resume =
    recorded &&
    normaliseStartAt(recorded.configuredStartAt) === configuredStartAt &&
    usableClockState(recorded.state)
      ? recorded.state
      : null;
  const clock = new VirtualClock({
    ...(config.startAt ? { startAt: config.startAt } : {}),
    ...(resume ? { resume } : {}),
    frozen: config.freezeClock,
  });
  const recordClock = () => {
    // The clock's own instant, never a scheduler job's scoped override.
    const state = clock.state();
    return storage.clock.put({
      state,
      configuredStartAt,
      updatedAt: new Date(state.now).toISOString(),
    });
  };
  await recordClock();
  // Each change is recorded in order, and shutdown waits for the last one,
  // so an advance right before a restart is not lost. A failed write must
  // not fail the change itself.
  let clockWrites: Promise<void> = Promise.resolve();
  clock.onChange(() => {
    clockWrites = clockWrites.then(recordClock).catch((error: unknown) => {
      // Said out loud: an unrecorded clock rewinds on the next restart, and
      // that should not be a mystery.
      logger.warn('Could not record the virtual clock; a restart may not resume it', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  const random = createRandom(config.seed);
  // Ids continue across a restart rather than replay. Every id is drawn from
  // a stream seeded by PAYBOX_SEED, and each boot used to start it from the
  // beginning -- minting, first, the ids the previous boot minted first, which
  // the database already holds ("UNIQUE constraint failed"). So the database
  // counts its boots (migration 0023), and a boot after the first mints from a
  // stream of its own. A fresh database, and :memory:, mint exactly what they
  // always have; the same seed and the same restarts mint the same ids.
  //
  // Local credentials stay on the seed's own stream on every boot: Tingg's
  // and Flutterwave v4's are matched exactly, and stored webhook secrets were
  // derived from them, so a restart must never change them.
  const keyIds = createIdFactory(random);
  //
  // A start is counted when the context is built, before the server binds:
  // a start that then fails (the port taken) still counts. Same seed, same
  // starts, same ids -- failed ones included.
  const priorBoots = await storage.idState.recordBoot({
    now: clock.nowISO(),
    // Read before this boot recorded its own clock.
    clockRecorded: recorded !== null,
  });
  // The per-start stream. Anything that mints a stored value -- an id, a
  // generated reference -- draws from it or from `ids`; streams that only
  // decide delays and chances keep using `random`.
  const bootRandom = priorBoots === 0 ? random : random.fork(`boot-${priorBoots}`);
  const ids = priorBoots === 0 ? keyIds : createIdFactory(bootRandom);
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
    // Tingg's status vocabulary is numeric -- 130 pending, 183 successful,
    // 180 rejected -- so the stored providerStatus is a decimal string.
    if (provider === 'tingg') return toTinggStatus(status);
    // Bachs' payment object: `succeeded`, `created`, `processing`, ...
    if (provider === 'bachs') return toBachsPaymentStatus(status);
    return status;
  };

  // Which channels mint a reusable authorization is also provider knowledge,
  // injected the same way and for the same reason as the status mapping above.
  const mintAuthorization = (payment: Parameters<typeof paystackAuthorizationMinter>[0]) => {
    if (payment.provider === 'paystack') return paystackAuthorizationMinter(payment);
    if (payment.provider === 'stripe') return stripeAuthorizationMinter(payment);
    if (payment.provider === 'flutterwave') return flutterwaveAuthorizationMinter(payment);
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
  dispatcher.register(new FlutterwaveWebhookFormatter({ version: 'v3' }));
  dispatcher.register(new KoraWebhookFormatter());
  dispatcher.register(new QuiddpayWebhookFormatter());
  // Tingg is the only formatter that declares its own retry ladder and its
  // own idea of what counts as a delivery. See providers/tingg/src/webhook.ts.
  dispatcher.register(new TinggWebhookFormatter());
  dispatcher.register(new WewireWebhookFormatter());
  dispatcher.register(new WiseWebhookFormatter());
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
  scheduler.register(SUBSCRIPTION_TRIAL_ENDING_JOB, subscriptions.handleTrialEndingJob);
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

  /**
   * Settle a queued payout, the way a settlement rail eventually would.
   *
   * WeWire returns `PENDING` and settles asynchronously, so the outcome has
   * to arrive on its own — and a scheduled job is the only thing
   * `paybox time advance` can drive. The outcome is decided when the job is
   * enqueued (from WeWire's published sandbox numbers), never here, so the
   * answer is fixed before the clock moves.
   */
  scheduler.register('transfer.settle', async (job) => {
    const transferId = String(job.payload.transferId ?? '');
    const outcome = String(job.payload.outcome ?? 'successful') as 'successful' | 'failed';
    if (!transferId) return;

    const transfer = await engine.getTransfer(transferId);
    // It may have been settled by hand from the CLI in the meantime.
    if (!transfer || (transfer.status !== 'pending' && transfer.status !== 'processing')) return;

    if (transfer.status === 'pending') await engine.transitionTransfer(transferId, 'processing');
    await engine.transitionTransfer(transferId, outcome, {
      ...(outcome === 'failed'
        ? { failureReason: String(job.payload.reason ?? 'The rail rejected the transfer') }
        : {}),
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

  const keys = generateLocalKeys(keyIds.token(20));
  const stripeKeys = generateStripeKeys(keyIds.token(20));
  const flutterwaveKeys = generateFlutterwaveKeys(keyIds.token(20));
  const koraKeys = generateKoraKeys(keyIds.token(20));
  const quiddpayKeys = generateQuiddpayKeys(keyIds.token(20));
  const tinggKeys = generateTinggKeys(keyIds.token(20));
  const wewireKeys = generateWewireKeys(keyIds.token(20));
  const wiseKeys = generateWiseKeys(keyIds.token(20));
  const flutterwaveV4 = generateV4Credentials(keyIds.token(20));
  // From a stream of its own: drawing from the seed's id stream here would
  // shift every id minted after startup on a database's first boot.
  const bachsKeys = generateBachsKeys(createIdFactory(random.fork('bachs-keys')).token(20));
  // Registered here rather than with the others because its envelope carries
  // the organization id derived just above. The dispatcher looks formatters
  // up per event, so the order of registration does not matter.
  dispatcher.register(new BachsWebhookFormatter({ organizationId: bachsKeys.organizationId }));
  // Bachs owns its checkout's expiry: one job closes the session whatever it
  // holds -- no payment, an attempt in flight, or a last attempt that failed
  // -- and backstops a paid checkout's completion work. Bachs owns its
  // billing too: renewals and recovery retries are its own
  // jobs, never the shared SubscriptionRunner's (providers/bachs/src/
  // billing.ts says why). A checkout's completion work -- saving the card,
  // starting the subscription -- follows the payment's success event, so it
  // happens however the payment was settled. `payment.successful` handlers
  // run before the dispatcher's catch-all, so `checkout.completed` is built
  // after the subscription it names exists.
  const bachsBilling = new BachsBilling({
    engine,
    storage,
    clock,
    ids,
    recovery: config.bachs.subscriptionRecovery,
  });
  scheduler.register(BACHS_SUBSCRIPTION_RENEW_JOB, bachsBilling.handleRenewJob);
  scheduler.register(BACHS_SUBSCRIPTION_RETRY_JOB, bachsBilling.handleRetryJob);
  bus.on('payment.successful', bachsBilling.onPaymentSuccessful);
  // Bachs holds USD and NGN only: whatever a payment or refund moved in any
  // other currency, on any path, is swept into USD as soon as it lands
  // (providers/bachs/src/treasury.ts). Payouts advance and schedules run as
  // Bachs' own jobs.
  const bachsTreasury = new BachsTreasury({ engine, storage, clock, ids });
  bus.on('payment.successful', bachsTreasury.onMoneyMoved);
  bus.on('refund.successful', bachsTreasury.onMoneyMoved);
  bus.on('refund.failed', bachsTreasury.onMoneyMoved);
  bus.on('transfer.failed', bachsTreasury.onPayoutFailed);
  scheduler.register(BACHS_PAYOUT_ADVANCE_JOB, bachsTreasury.handleAdvanceJob);
  scheduler.register(BACHS_PAYOUT_SCHEDULE_JOB, bachsTreasury.handleScheduleJob);
  scheduler.register(
    BACHS_CHECKOUT_EXPIRE_JOB,
    createBachsExpiryHandler({ engine, simulator, storage, clock, ids, billing: bachsBilling }),
  );

  return {
    config,
    storage,
    clock,
    // The per-start stream: a provider that generates stored values from it
    // (WeWire's fallback references) must not repeat them after a restart.
    random: bootRandom,
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
    flutterwaveKeys,
    flutterwaveV4,
    koraKeys,
    quiddpayKeys,
    tinggKeys,
    wewireKeys,
    wiseKeys,
    bachsKeys,
    baseUrl,
    async shutdown() {
      await scheduler.stop();
      await clockWrites;
      await storage.close();
    },
  };
}

/**
 * A start instant in one canonical spelling, or null when none is set. An
 * unparseable value is kept as written: the clock refuses it at construction,
 * which is the error the developer should see.
 */
function normaliseStartAt(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return String(value);
  return new Date(ms).toISOString();
}

/** The largest instant a Date can hold (ECMA-262 §21.4.1.1). */
const MAX_DATE_MS = 8.64e15;

function usableClockState(state: { now: number; offsetMs: number }): boolean {
  return (
    Number.isFinite(state.now) &&
    Math.abs(state.now) <= MAX_DATE_MS &&
    Number.isFinite(state.offsetMs) &&
    Math.abs(state.offsetMs) <= MAX_DATE_MS
  );
}
