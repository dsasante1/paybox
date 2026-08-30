#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import type {
  Authorization,
  Dispute,
  Invoice,
  Payment,
  PayboxEvent,
  Plan,
  Refund,
  Subscription,
} from '@paybox/shared';
import type { Job, WebhookDelivery, WebhookEndpoint } from '@paybox/core';
import {
  VERSION,
  entriesByStatus,
  renderSummaryLine,
  toRows,
  type CoverageManifest,
} from '@paybox/shared';
import { PAYSTACK_COVERAGE } from '@paybox/paystack';
import { STRIPE_COVERAGE } from '@paybox/stripe';
import { FLUTTERWAVE_V3_COVERAGE, FLUTTERWAVE_V4_COVERAGE } from '@paybox/flutterwave';
import { KORA_COVERAGE } from '@paybox/kora';
import { WEWIRE_COVERAGE } from '@paybox/wewire';
import { WISE_COVERAGE } from '@paybox/wise';
import { CliError, PayboxClient } from './client.js';
import {
  heading,
  keyValue,
  money,
  shortDateTime,
  shortTime,
  statusColour,
  table,
} from './render.js';

const DEFAULT_URL = process.env.PAYBOX_URL ?? 'http://127.0.0.1:8080';

const program = new Command()
  .name('paybox')
  .description('Local payment infrastructure emulator')
  .version(VERSION)
  .option('--url <url>', 'emulator base URL', DEFAULT_URL)
  .option('--json', 'print raw JSON instead of tables', false);

const client = () => new PayboxClient(program.opts<{ url: string }>().url);
const asJson = () => program.opts<{ json: boolean }>().json;

function output(value: unknown, render: () => string): void {
  process.stdout.write(asJson() ? `${JSON.stringify(value, null, 2)}\n` : `${render()}\n`);
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

program
  .command('start')
  .description('Start the emulator')
  .option('-p, --port <port>', 'port to listen on')
  .option('-H, --host <host>', 'interface to bind (default 127.0.0.1)')
  .option('-d, --database <path>', 'SQLite file, or :memory:')
  .option('--freeze', 'start with the clock frozen (deterministic runs)', false)
  .option('--seed <seed>', 'PRNG seed — identical seeds produce identical ids')
  .action(async (options: Record<string, string | boolean>) => {
    // Imported lazily so the rest of the CLI does not pay for loading the
    // server, its database driver and every provider adapter.
    const { loadConfig } = await import('@paybox/api');
    const { buildContext } = await import('@paybox/api');
    const { buildApp, printBanner } = await import('@paybox/api');

    if (options.port) process.env.PAYBOX_PORT = String(options.port);
    if (options.host) process.env.PAYBOX_HOST = String(options.host);
    if (options.database) process.env.PAYBOX_DATABASE = String(options.database);
    if (options.seed) process.env.PAYBOX_SEED = String(options.seed);
    if (options.freeze) process.env.PAYBOX_FREEZE_CLOCK = '1';

    const { config, warnings, sourcePath } = loadConfig();
    const context = await buildContext({ config });
    const app = await buildApp(context);
    context.scheduler.start();

    const stop = async () => {
      await app.close();
      await context.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());

    await app.listen({ host: config.host, port: config.port });
    printBanner({ context, warnings, sourcePath });
  });

program
  .command('status')
  .description('Show emulator status')
  .action(async () => {
    const api = client();
    const health = await api.get<{ version: string; time: string; clock: { mode: string } }>(
      '/api/health',
    );
    const overview = await api.get<OverviewResponse>('/api/overview');
    const { providers } = await api.get<{ providers: ProviderInfo[] }>('/api/providers');
    // Every credential the emulator issued, flattened one per line. The
    // adapters' "see `paybox status`" errors and the README both point here.
    const credentials: [string, string][] = [];
    for (const provider of providers) {
      for (const [name, value] of Object.entries(provider.keys ?? {})) {
        if (typeof value === 'string') credentials.push([`${provider.id} ${name}`, value]);
        else if (value && typeof value === 'object') {
          for (const [inner, secret] of Object.entries(value as Record<string, string>)) {
            credentials.push([`${provider.id} ${name} ${inner}`, secret]);
          }
        }
      }
    }
    output({ health, overview, providers }, () =>
      [
        heading('paybox'),
        keyValue([
          ['url', api.baseUrl],
          ['version', health.version],
          ['time', health.time],
          ['clock', health.clock.mode === 'frozen' ? pc.yellow('frozen') : 'system'],
        ]),
        heading('Test credentials (local only — not real keys)'),
        keyValue(credentials),
        heading('Payments'),
        keyValue([
          ['total', String(overview.payments.total)],
          ['successful', pc.green(String(overview.payments.successful))],
          ['pending', pc.yellow(String(overview.payments.pending))],
          ['failed', pc.red(String(overview.payments.failed))],
        ]),
        heading('Webhooks'),
        keyValue([
          ['delivered', pc.green(String(overview.webhooks.succeeded))],
          ['failed', pc.red(String(overview.webhooks.failed))],
          ['pending', pc.yellow(String(overview.webhooks.pending))],
        ]),
      ].join('\n'),
    );
  });

/**
 * Every adapter's manifest, in the order the banner lists them.
 *
 * These are the same objects `tests/coverage-drift.test.ts` checks against the
 * router, so what this command prints cannot disagree with what the emulator
 * actually serves.
 */
const MANIFESTS: readonly CoverageManifest[] = [
  PAYSTACK_COVERAGE,
  STRIPE_COVERAGE,
  FLUTTERWAVE_V3_COVERAGE,
  FLUTTERWAVE_V4_COVERAGE,
  KORA_COVERAGE,
  WEWIRE_COVERAGE,
  WISE_COVERAGE,
];

program
  .command('coverage')
  .description('What each provider adapter actually implements')
  .argument('[provider]', 'show every endpoint for one adapter, e.g. kora')
  .option('--json', 'machine-readable output', false)
  .action((provider: string | undefined, options: { json: boolean }) => {
    // Commander hands a `--json` written after the subcommand to the program's
    // own `--json` option, so honour both spellings.
    if (options.json || asJson()) {
      process.stdout.write(`${JSON.stringify(toRows(MANIFESTS), null, 2)}\n`);
      return;
    }

    if (!provider) {
      process.stdout.write(heading('Coverage'));
      for (const row of toRows(MANIFESTS)) {
        process.stdout.write(`  ${renderSummaryLine(row)}\n`);
      }
      process.stdout.write(
        `\n  ${pc.dim('Every adapter is partial. Run')} paybox coverage <provider> ` +
          `${pc.dim('for the detail,')}\n  ${pc.dim('or read the file each one names for why.')}\n`,
      );
      return;
    }

    const manifest = MANIFESTS.find(
      (candidate) => candidate.id === provider || candidate.id.startsWith(`${provider}-`),
    );
    if (!manifest) {
      throw new CliError(
        `Unknown provider "${provider}". Known: ${MANIFESTS.map((m) => m.id).join(', ')}.`,
      );
    }

    process.stdout.write(heading(`${manifest.label} — ${manifest.docs}`));
    for (const status of ['compatible', 'partial', 'emulator-only'] as const) {
      const entries = entriesByStatus(manifest, status);
      if (entries.length === 0) continue;
      const colour =
        status === 'compatible' ? pc.green : status === 'partial' ? pc.yellow : pc.cyan;
      process.stdout.write(`\n  ${colour(status)} (${entries.length})\n`);
      for (const entry of entries) {
        process.stdout.write(
          `    ${entry.endpoint}${entry.note ? pc.dim(`  — ${entry.note}`) : ''}\n`,
        );
      }
    }
    process.stdout.write(
      `\n  ${pc.dim(`Why each one is partial is in ${manifest.docs}.`)}\n`,
    );
  });

program
  .command('reset')
  .description('Delete all local state (payments, events, webhooks)')
  .option('-y, --yes', 'skip the confirmation prompt', false)
  .action(async (options: { yes: boolean }) => {
    if (!options.yes && process.stdin.isTTY) {
      throw new CliError('This deletes every payment, event and webhook. Re-run with --yes.');
    }
    await client().post('/api/reset');
    process.stdout.write(`${pc.green('✓')} Local state cleared.\n`);
  });

program
  .command('seed')
  .description('Generate representative test data (spec §28)')
  .action(async () => {
    const { seeded } = await client().post<{ seeded: Record<string, string> }>('/api/seed');
    output(seeded, () =>
      `${pc.green('✓')} Seeded:\n` +
      Object.entries(seeded)
        .map(([kind, id]) => `  ${pc.dim(kind.padEnd(22))}  ${id}`)
        .join('\n'),
    );
  });

program
  .command('logs')
  .description('Print recent structured logs')
  .option('-n, --lines <n>', 'how many entries', '50')
  .action(async (options: { lines: string }) => {
    const { logs } = await client().get<{ logs: Array<Record<string, unknown>> }>(
      `/api/logs?limit=${options.lines}`,
    );
    output(logs, () => logs.map((l) => JSON.stringify(l)).join('\n'));
  });

/* ------------------------------------------------------------------ *
 * Payments
 * ------------------------------------------------------------------ */

const payment = program.command('payment').description('Inspect and drive payments');

payment
  .command('list')
  .description('List payments')
  .option('-s, --status <status>', 'filter by canonical status')
  .option('-p, --provider <provider>', 'filter by provider')
  .option('-n, --limit <n>', 'how many', '25')
  .action(async (options: { status?: string; provider?: string; limit: string }) => {
    const query = new URLSearchParams({ limit: options.limit });
    if (options.status) query.set('status', options.status);
    if (options.provider) query.set('provider', options.provider);
    const { items } = await client().get<{ items: Payment[] }>(`/api/payments?${query}`);
    output(items, () =>
      items.length === 0
        ? pc.dim('No payments yet.')
        : table(
            ['ID', 'REFERENCE', 'PROVIDER', 'AMOUNT', 'METHOD', 'STATUS', 'CREATED'],
            items.map((p) => [
              pc.dim(p.id),
              p.reference,
              p.provider,
              money(p.amount, p.currency),
              p.paymentMethod ?? '—',
              statusColour(p.status),
              shortTime(p.createdAt),
            ]),
          ),
    );
  });

payment
  .command('get <id>')
  .description('Show one payment with its full timeline')
  .action(async (id: string) => {
    const detail = await client().get<PaymentDetail>(`/api/payments/${id}`);
    output(detail, () => {
      const p = detail.payment;
      return [
        heading(`Payment ${p.reference}`),
        keyValue([
          ['id', p.id],
          ['provider', p.provider],
          ['amount', money(p.amount, p.currency)],
          ['status', statusColour(p.status)],
          ['provider status', p.providerStatus],
          ['method', p.paymentMethod ?? '—'],
          ['refunded', money(p.amountRefunded, p.currency)],
          ...(p.failureCode ? ([['failure', pc.red(`${p.failureCode}: ${p.failureMessage}`)]] as Array<[string, string]>) : []),
        ]),
        heading('Timeline'),
        detail.timeline
          .map((e) => `  ${pc.dim(shortTime(e.createdAt))}  ${e.type}`)
          .join('\n'),
        detail.webhookDeliveries.length > 0
          ? heading('Webhook deliveries') +
            table(
              ['EVENT', 'STATUS', 'HTTP', 'ATTEMPTS'],
              detail.webhookDeliveries.map((w) => [
                w.eventType,
                statusColour(w.status),
                String(w.responseStatus ?? '—'),
                `${w.attempt}/${w.maxAttempts}`,
              ]),
            )
          : '',
      ].join('\n');
    });
  });

/**
 * Creating a payment differs per provider, so each contributes its own recipe.
 *
 * The CLI goes through the provider's real endpoint rather than the control
 * plane, so the resulting payment is indistinguishable from one the
 * developer's own application created -- which means it has to speak each
 * provider's wire format, including Stripe's form encoding.
 */
interface CreateRecipe {
  path: string;
  contentType: string;
  body: string;
  /** Pull the handle and any follow-up link out of the provider's response. */
  read(json: Record<string, unknown>): {
    /** What to show the user: the provider's own handle for the payment. */
    handle: string;
    /** How to find the row afterwards. Providers differ; see below. */
    lookup: { by: 'reference' | 'id'; value: string };
    checkoutUrl?: string | undefined;
    prompt?: string | undefined;
    error?: string | undefined;
  };
}

function paystackRecipe(options: Record<string, string>): CreateRecipe {
  const useCharge = Boolean(options.method);
  const body: Record<string, unknown> = {
    email: options.email,
    amount: Number(options.amount),
    currency: options.currency,
    ...(options.reference ? { reference: options.reference } : {}),
    ...(options.method === 'mobile_money'
      ? { mobile_money: { phone: '0550000000', provider: 'mtn' } }
      : {}),
    ...(options.method === 'card' ? { card: { number: '4000 0000 0000 0000' } } : {}),
    ...(options.method === 'bank'
      ? { bank: { code: '058', account_number: '0000000000' } }
      : {}),
  };
  return {
    path: useCharge ? '/paystack/charge' : '/paystack/transaction/initialize',
    contentType: 'application/json',
    body: JSON.stringify(body),
    read: (json) => {
      const data = (json.data ?? {}) as Record<string, unknown>;
      const reference = String(data.reference ?? '');
      return {
        handle: reference,
        // Paystack's reference is developer-facing and is what paybox stores.
        lookup: { by: 'reference', value: reference },
        ...(json.status === false ? { error: String(json.message ?? 'Request failed') } : {}),
        ...(data.authorization_url ? { checkoutUrl: String(data.authorization_url) } : {}),
        ...(data.display_text ? { prompt: String(data.display_text) } : {}),
      };
    },
  };
}

function stripeRecipe(options: Record<string, string>): CreateRecipe {
  // Stripe takes form encoding and nothing else, and a PaymentIntent with no
  // payment method is the closest analogue to "give me a checkout link".
  const fields = new URLSearchParams({
    amount: String(Number(options.amount)),
    currency: (options.currency ?? 'usd').toLowerCase(),
  });
  if (options.method && options.method !== 'card') {
    throw new CliError(
      `Stripe supports --method card only; received "${options.method}".`,
    );
  }
  if (options.method === 'card') {
    fields.set('confirm', 'true');
    fields.set('payment_method_data[type]', 'card');
    fields.set('payment_method_data[card][number]', '4242424242424242');
  }
  return {
    path: '/stripe/v1/payment_intents',
    contentType: 'application/x-www-form-urlencoded',
    body: fields.toString(),
    read: (json) => {
      const error = json.error as { message?: string } | undefined;
      if (error) {
        return {
          handle: '',
          lookup: { by: 'id', value: '' },
          error: error.message ?? 'Request failed',
        };
      }
      // Stripe has no developer-facing reference: `pi_...` is the handle, and
      // it maps to the payment's *id*, not the generated reference paybox
      // assigns when the caller supplies none.
      const id = String(json.id ?? '');
      return { handle: id, lookup: { by: 'id', value: id.replace(/^pi_/, 'pay_') } };
    },
  };
}

const CREATE_RECIPES: Record<string, (options: Record<string, string>) => CreateRecipe> = {
  paystack: paystackRecipe,
  stripe: stripeRecipe,
};

payment
  .command('create')
  .description('Create a payment through the provider API, as your application would')
  .option('--provider <provider>', 'provider id', 'paystack')
  .requiredOption('--amount <minor>', 'amount in minor units (e.g. 10000 = GHS 100.00)')
  .option('--currency <code>', 'currency', 'GHS')
  .option('--method <method>', 'card | mobile_money | bank — omit for a checkout link')
  .option('--reference <ref>', 'your own reference')
  .option('--email <email>', 'customer email', 'test@paybox.local')
  .action(async (options: Record<string, string>) => {
    const api = client();
    const provider = options.provider ?? 'paystack';
    const build = CREATE_RECIPES[provider];
    if (!build) {
      throw new CliError(
        `paybox cannot create payments for "${provider}". Implemented: ${Object.keys(
          CREATE_RECIPES,
        ).join(', ')}.`,
      );
    }

    // Fetch the provider's own local test key rather than making the user
    // paste it: the CLI and the emulator are the same trust domain, and these
    // keys are fake.
    const { providers, keys } = await api.get<{
      providers: { id: string; keys?: { secretKey: string } }[];
      keys: { secretKey: string };
    }>('/api/providers');
    const secretKey =
      providers.find((p) => p.id === provider)?.keys?.secretKey ?? keys.secretKey;

    const recipe = build(options);
    const response = await fetch(`${api.baseUrl}${recipe.path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': recipe.contentType,
      },
      body: recipe.body,
    });

    const json = (await response.json()) as Record<string, unknown>;
    const result = recipe.read(json);
    if (result.error) throw new CliError(result.error);

    // `/api/payments/:id` wraps the row alongside its timeline; the list
    // endpoint returns rows directly. Unwrap so both paths yield a Payment.
    const created =
      result.lookup.by === 'id'
        ? await api
            .get<{ payment: Payment }>(`/api/payments/${result.lookup.value}`)
            .then((detail) => detail.payment)
            .catch(() => undefined)
        : (
            await api.get<{ items: Payment[] }>(
              `/api/payments?reference=${encodeURIComponent(result.lookup.value)}&limit=1`,
            )
          ).items[0];

    output(json, () =>
      [
        `${pc.green('✓')} ${result.handle} → ${statusColour(created?.status ?? 'created')}`,
        created ? `  ${pc.dim('id')}         ${created.id}` : '',
        result.checkoutUrl ? `  ${pc.dim('checkout')}   ${result.checkoutUrl}` : '',
        result.prompt ? `  ${pc.dim('prompt')}     ${result.prompt}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  });

const SIMULATIONS = [
  'success',
  'declined',
  'insufficient_funds',
  'expired_card',
  'authentication_required',
  'authentication_failed',
  'timeout',
  'processing_error',
  'customer_rejected',
  'network_error',
] as const;

payment
  .command('success <id>')
  .description('Drive a payment to success through real state transitions')
  .action(async (id: string) => {
    const result = await client().post<Payment>(`/api/payments/${id}/simulate`, {
      outcome: 'success',
    });
    printPaymentResult(result);
  });

payment
  .command('fail <id>')
  .description('Fail a payment')
  .option('--reason <reason>', `one of: ${SIMULATIONS.slice(1).join(', ')}`, 'declined')
  .action(async (id: string, options: { reason: string }) => {
    if (!(SIMULATIONS as readonly string[]).includes(options.reason)) {
      throw new CliError(`Unknown reason "${options.reason}". Try one of: ${SIMULATIONS.join(', ')}`);
    }
    printPaymentResult(
      await client().post<Payment>(`/api/payments/${id}/simulate`, { outcome: options.reason }),
    );
  });

for (const action of ['cancel', 'expire', 'authorize', 'capture'] as const) {
  payment
    .command(`${action} <id>`)
    .description(`${action[0]!.toUpperCase()}${action.slice(1)} a payment`)
    .action(async (id: string) => {
      printPaymentResult(await client().post<Payment>(`/api/payments/${id}/${action}`));
    });
}

payment
  .command('approve <id>')
  .description('Approve a pending authentication (3-D Secure or mobile-money prompt)')
  .action(async (id: string) => {
    printPaymentResult(
      await client().post<Payment>(`/api/payments/${id}/authenticate`, { approved: true }),
    );
  });

payment
  .command('reject <id>')
  .description('Reject a pending authentication, as a customer declining the prompt')
  .action(async (id: string) => {
    printPaymentResult(
      await client().post<Payment>(`/api/payments/${id}/authenticate`, { approved: false }),
    );
  });

payment
  .command('refund <id>')
  .description('Refund a payment, fully or in part')
  .option('--amount <minor>', 'partial amount in minor units')
  .option('--reason <reason>', 'reason recorded on the refund')
  .action(async (id: string, options: { amount?: string; reason?: string }) => {
    const refund = await client().post<Refund>(`/api/payments/${id}/refund`, {
      ...(options.amount ? { amount: Number(options.amount) } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    });
    output(refund, () =>
      `${pc.green('✓')} Refund ${refund.id} — ${money(refund.amount, refund.currency)} ` +
      `(${statusColour(refund.status)})`,
    );
  });

function printPaymentResult(p: Payment): void {
  process.stdout.write(
    asJson()
      ? `${JSON.stringify(p, null, 2)}\n`
      : `${pc.green('✓')} ${p.reference} → ${statusColour(p.status)}` +
        `${p.failureCode ? pc.dim(` (${p.failureCode})`) : ''}\n`,
  );
}

/* ------------------------------------------------------------------ *
 * Webhooks
 * ------------------------------------------------------------------ */

const webhook = program.command('webhook').description('Inspect, retry and replay webhooks');

webhook
  .command('endpoints')
  .description('List registered webhook endpoints')
  .action(async () => {
    const { endpoints } = await client().get<{ endpoints: WebhookEndpoint[] }>(
      '/api/webhooks/endpoints',
    );
    output(endpoints, () =>
      endpoints.length === 0
        ? pc.dim('No endpoints. Add one with `paybox webhook add <url>`.')
        : table(
            ['ID', 'PROVIDER', 'URL', 'ENABLED'],
            endpoints.map((e) => [pc.dim(e.id), e.provider, e.url, e.enabled ? '✓' : '✗']),
          ),
    );
  });

webhook
  .command('add <url>')
  .description('Register a webhook endpoint')
  .option('--provider <provider>', 'provider id', 'paystack')
  .option('--secret <secret>', "signing secret (default: one shaped the way this provider's verifier expects)")
  .action(async (url: string, options: { provider: string; secret?: string }) => {
    const endpoint = await client().post<WebhookEndpoint>('/api/webhooks/endpoints', {
      url,
      provider: options.provider,
      ...(options.secret ? { secret: options.secret } : {}),
    });
    output(
      endpoint,
      () => `${pc.green('✓')} ${endpoint.url}\n  ${pc.dim('signing secret')}  ${endpoint.secret}`,
    );
  });

webhook
  .command('list')
  .description('List webhook deliveries')
  .option('-s, --status <status>', 'pending | succeeded | failed | exhausted')
  .option('-n, --limit <n>', 'how many', '25')
  .action(async (options: { status?: string; limit: string }) => {
    const query = new URLSearchParams({ limit: options.limit });
    if (options.status) query.set('status', options.status);
    const { items } = await client().get<{ items: WebhookDelivery[] }>(
      `/api/webhooks/deliveries?${query}`,
    );
    output(items, () =>
      items.length === 0
        ? pc.dim('No deliveries yet.')
        : table(
            ['ID', 'EVENT', 'STATUS', 'HTTP', 'ATTEMPTS', 'DURATION', 'NEXT RETRY'],
            items.map((w) => [
              pc.dim(w.id),
              w.eventType,
              statusColour(w.status),
              String(w.responseStatus ?? '—'),
              `${w.attempt}/${w.maxAttempts}`,
              w.durationMs === null ? '—' : `${w.durationMs}ms`,
              shortTime(w.nextRetryAt),
            ]),
          ),
    );
  });

webhook
  .command('retry <id>')
  .description('Retry a delivery in place, granting one more attempt')
  .action(async (id: string) => {
    const delivery = await client().post<WebhookDelivery>(`/api/webhooks/deliveries/${id}/retry`);
    output(
      delivery,
      () =>
        `${pc.green('✓')} ${delivery.id} → ${statusColour(delivery.status)} ` +
        `(attempt ${delivery.attempt}/${delivery.maxAttempts})`,
    );
  });

webhook
  .command('replay <id>')
  .description('Send the identical signed payload again as a brand-new delivery')
  .action(async (id: string) => {
    const delivery = await client().post<WebhookDelivery>(`/api/webhooks/deliveries/${id}/replay`);
    output(
      delivery,
      () => `${pc.green('✓')} New delivery ${delivery.id} replaying ${delivery.replayOfDeliveryId}`,
    );
  });

webhook
  .command('fail')
  .description('Force webhook deliveries to fail (spec §10)')
  .argument('[outcome]', 'http_500 | http_400 | http_429 | timeout | connection_refused | malformed_response | off', 'http_500')
  .action(async (outcome: string) => {
    const chaos = await client().post<Record<string, unknown>>('/api/webhooks/chaos', {
      forceOutcome: outcome === 'off' ? null : outcome,
    });
    output(chaos, () =>
      outcome === 'off'
        ? `${pc.green('✓')} Webhook failure simulation disabled.`
        : `${pc.yellow('⚠')} Every webhook delivery will now return ${outcome}.`,
    );
  });

webhook
  .command('chaos')
  .description('Configure duplicate and out-of-order delivery')
  .option('--duplicate <bool>', 'deliver every webhook twice')
  .option('--out-of-order <bool>', 'randomise delivery order within a window')
  .option('--failure-rate <rate>', 'fraction of deliveries that fail, 0..1')
  .option('--reset', 'turn every chaos setting off', false)
  .action(async (options: Record<string, string | boolean>) => {
    if (options.reset) {
      const cleared = await client().delete('/api/webhooks/chaos');
      output(cleared, () => `${pc.green('✓')} Webhook chaos cleared.`);
      return;
    }
    const body: Record<string, unknown> = {};
    if (options.duplicate !== undefined) body.duplicate = options.duplicate === 'true';
    if (options.outOfOrder !== undefined) body.outOfOrder = options.outOfOrder === 'true';
    if (options.failureRate !== undefined) body.failureRate = Number(options.failureRate);
    output(await client().post('/api/webhooks/chaos', body), () => `${pc.green('✓')} Applied.`);
  });

/* ------------------------------------------------------------------ *
 * Events, scenarios, time, network
 * ------------------------------------------------------------------ */

program
  .command('events')
  .description('List recent events')
  .option('-n, --limit <n>', 'how many', '30')
  .action(async (options: { limit: string }) => {
    const { items } = await client().get<{ items: PayboxEvent[] }>(
      `/api/events?limit=${options.limit}`,
    );
    output(items, () =>
      table(
        ['TIME', 'TYPE', 'RESOURCE', 'TRANSITION'],
        items.map((e) => [
          pc.dim(shortTime(e.createdAt)),
          e.type,
          pc.dim(e.resourceId),
          e.previousStatus ? `${e.previousStatus} → ${e.currentStatus}` : '—',
        ]),
      ),
    );
  });

const scenario = program.command('scenario').description('Run reusable payment scenarios');

scenario
  .command('list')
  .description('List available scenarios')
  .action(async () => {
    const { scenarios } = await client().get<{ scenarios: ScenarioSummary[] }>('/api/scenarios');
    output(scenarios, () =>
      table(
        ['NAME', 'STEPS', 'DESCRIPTION'],
        scenarios.map((s) => [s.name, String(s.steps.length), pc.dim(s.description ?? '')]),
      ),
    );
  });

scenario
  .command('run <name> <paymentId>')
  .description('Run a scenario against a payment')
  .action(async (name: string, paymentId: string) => {
    const run = await client().post<{ steps: number; completesAt: string }>('/api/scenarios/run', {
      scenario: name,
      paymentId,
    });
    output(
      run,
      () =>
        `${pc.green('✓')} Running "${name}" — ${run.steps} steps, completing at ${run.completesAt}.\n` +
        pc.dim('  Use `paybox time advance` to fast-forward through it.'),
    );
  });

const time = program.command('time').description('Control virtual time');

time
  .command('freeze')
  .description('Freeze the clock')
  .action(async () => {
    const state = await client().post<{ now: number }>('/api/time', { action: 'freeze' });
    output(state, () => `${pc.green('✓')} Clock frozen at ${new Date(state.now).toISOString()}`);
  });

time
  .command('unfreeze')
  .description('Resume the clock')
  .action(async () => {
    const state = await client().post<{ now: number }>('/api/time', { action: 'unfreeze' });
    output(state, () => `${pc.green('✓')} Clock resumed.`);
  });

time
  .command('advance <duration>')
  .description('Advance virtual time, e.g. 30s, 5m, 2h — runs every job that comes due')
  .action(async (duration: string) => {
    const state = await client().post<{ now: number }>('/api/time', {
      action: 'advance',
      value: duration,
    });
    output(
      state,
      () => `${pc.green('✓')} Advanced ${duration} → ${new Date(state.now).toISOString()}`,
    );
  });

const network = program.command('network').description('Simulate network conditions');

network
  .command('latency <ms>')
  .description('Add latency to provider responses')
  .action(async (ms: string) => {
    const profile = await client().post('/api/network', { latencyMs: Number(ms) });
    output(profile, () => `${pc.green('✓')} Provider responses delayed by ${ms}ms.`);
  });

network
  .command('failure <rate>')
  .description('Fail a fraction of provider requests, 0..1')
  .action(async (rate: string) => {
    const profile = await client().post('/api/network', { failureRate: Number(rate) });
    output(
      profile,
      () => `${pc.yellow('⚠')} ${Number(rate) * 100}% of provider requests will fail.`,
    );
  });

network
  .command('reset')
  .description('Clear network simulation')
  .action(async () => {
    const profile = await client().delete('/api/network');
    output(profile, () => `${pc.green('✓')} Network simulation cleared.`);
  });

program
  .command('provider')
  .description('List providers and their coverage')
  .action(async () => {
    const info = await client().get<{ providers: ProviderInfo[]; keys: Record<string, string> }>(
      '/api/providers',
    );
    output(info, () =>
      table(
        ['PROVIDER', 'ENABLED', 'BASE PATH', 'COVERAGE'],
        info.providers.map((p) => [
          p.id,
          p.enabled ? '✓' : '✗',
          p.basePath,
          p.status === 'partial' ? pc.yellow(p.status) : pc.dim(p.status),
        ]),
      ),
    );
  });

/* ------------------------------------------------------------------ *
 * Recurring billing
 * ------------------------------------------------------------------ */

const plan = program.command('plan').description('Inspect subscription plans');

plan
  .command('list')
  .description('List plans')
  .action(async () => {
    const { items } = await client().get<{ items: Plan[] }>('/api/plans');
    output(items, () =>
      items.length === 0
        ? pc.dim('No plans. Create one through a provider API (POST /paystack/plan or /stripe/v1/prices).')
        : table(
            ['CODE', 'NAME', 'AMOUNT', 'INTERVAL', 'LIMIT'],
            items.map((p) => [
              p.providerPlanCode,
              p.name,
              money(p.amount, p.currency),
              p.interval,
              p.invoiceLimit === 0 ? pc.dim('unlimited') : String(p.invoiceLimit),
            ]),
          ),
    );
  });

const subscription = program
  .command('subscription')
  .description('Inspect and control subscriptions');

subscription
  .command('list')
  .description('List subscriptions')
  .option('--status <status>', 'filter by canonical status')
  .action(async (options: { status?: string }) => {
    const query = options.status ? `?status=${encodeURIComponent(options.status)}` : '';
    const { items } = await client().get<{ items: Subscription[] }>(
      `/api/subscriptions${query}`,
    );
    output(items, () =>
      items.length === 0
        ? pc.dim('No subscriptions.')
        : table(
            ['ID', 'STATUS', 'AMOUNT', 'INVOICES', 'NEXT PAYMENT'],
            items.map((sub) => [
              sub.id,
              statusColour(sub.status),
              money(sub.amount, sub.currency),
              sub.invoiceLimit === 0
                ? String(sub.invoiceCount)
                : `${sub.invoiceCount}/${sub.invoiceLimit}`,
              sub.nextPaymentDate ? shortDateTime(sub.nextPaymentDate) : pc.dim('—'),
            ]),
          ),
    );
  });

subscription
  .command('get <id>')
  .description('Show a subscription and its billing history')
  .action(async (id: string) => {
    const detail = await client().get<{
      subscription: Subscription;
      plan: Plan | null;
      invoices: Invoice[];
    }>(`/api/subscriptions/${id}`);

    output(detail, () => {
      const { subscription: sub, invoices } = detail;
      const lines = [
        heading('Subscription'),
        keyValue([
          ['id', sub.id],
          ['code', sub.providerSubscriptionCode],
          ['status', statusColour(sub.status)],
          ['plan', detail.plan?.name ?? sub.planId],
          ['amount', money(sub.amount, sub.currency)],
          ['started', shortDateTime(sub.startDate)],
          ['next', sub.nextPaymentDate ? shortDateTime(sub.nextPaymentDate) : '—'],
        ]),
        '',
        heading(`Invoices (${invoices.length})`),
      ];
      lines.push(
        invoices.length === 0
          ? pc.dim('None raised yet.')
          : table(
              ['PERIOD', 'AMOUNT', 'STATUS', 'PAID'],
              invoices.map((invoice) => [
                shortDateTime(invoice.periodStart),
                money(invoice.amount, invoice.currency),
                statusColour(invoice.status),
                invoice.paidAt ? shortDateTime(invoice.paidAt) : pc.dim('—'),
              ]),
            ),
      );
      return lines.join('\n');
    });
  });

subscription
  .command('disable <id>')
  .description('Stop a subscription renewing')
  .action(async (id: string) => {
    const updated = await client().post<Subscription>(`/api/subscriptions/${id}/disable`);
    output(updated, () => `${pc.green('✓')} Subscription ${id} is now ${updated.status}.`);
  });

program
  .command('authorizations')
  .description('List stored authorizations')
  .action(async () => {
    const { items } = await client().get<{ items: Authorization[] }>('/api/authorizations');
    output(items, () =>
      items.length === 0
        ? pc.dim('No stored authorizations. Charge a card to mint one.')
        : table(
            ['CODE', 'CHANNEL', 'LAST4', 'REUSABLE', 'ACTIVE'],
            items.map((a) => [
              a.providerAuthorizationCode,
              a.channel,
              a.last4 ?? pc.dim('—'),
              a.reusable ? pc.green('yes') : pc.dim('no'),
              a.active ? pc.green('yes') : pc.red('no'),
            ]),
          ),
    );
  });

/* ------------------------------------------------------------------ *
 * Balance
 * ------------------------------------------------------------------ */

const balance = program.command('balance').description('Inspect and top up the balance');

balance
  .command('show', { isDefault: true })
  .description('Show the balance per currency')
  .action(async () => {
    const { balances } = await client().get<{
      balances: { currency: string; balance: number }[];
    }>('/api/balance');
    output(balances, () =>
      table(
        ['CURRENCY', 'BALANCE'],
        balances.map((b) => [b.currency, money(b.balance, b.currency)]),
      ),
    );
  });

balance
  .command('credit <amount>')
  .description('Add test funds, in minor units (emulator-only)')
  .option('--currency <currency>', 'currency to credit', 'NGN')
  .option('--reason <reason>', 'ledger reason', 'manual_credit')
  .action(async (amount: string, options: { currency: string; reason: string }) => {
    const entry = await client().post<{ amount: number; currency: string }>(
      '/api/balance/credit',
      { amount: Number(amount), currency: options.currency, reason: options.reason },
    );
    output(entry, () =>
      `${pc.green('✓')} Credited ${money(entry.amount, entry.currency)} to the test balance.`,
    );
  });

/* ------------------------------------------------------------------ *
 * Disputes
 * ------------------------------------------------------------------ */

const dispute = program.command('dispute').description('Open and resolve chargebacks');

dispute
  .command('list')
  .description('List disputes')
  .action(async () => {
    const { items } = await client().get<{ items: Dispute[] }>('/api/disputes');
    output(items, () =>
      items.length === 0
        ? pc.dim('No disputes.')
        : table(
            ['ID', 'STATUS', 'AMOUNT', 'CATEGORY', 'DUE'],
            items.map((d) => [
              d.id,
              statusColour(d.status),
              money(d.refundAmount, d.currency),
              d.category,
              shortDateTime(d.dueAt),
            ]),
          ),
    );
  });

dispute
  .command('open <paymentId>')
  .description('Open a dispute against a payment (emulator-only)')
  .option('--category <category>', 'dispute category', 'chargeback')
  .option('--amount <amount>', 'disputed amount in minor units')
  .action(async (paymentId: string, options: { category: string; amount?: string }) => {
    const created = await client().post<Dispute>('/api/disputes', {
      paymentId,
      category: options.category,
      ...(options.amount ? { refundAmount: Number(options.amount) } : {}),
    });
    output(created, () =>
      `${pc.green('✓')} Dispute ${created.id} opened; response due ${shortDateTime(created.dueAt)}.`,
    );
  });

dispute
  .command('resolve <id>')
  .description('Resolve a dispute')
  .option('--decline', 'decline it instead of accepting', false)
  .option('--message <message>', 'reason for the resolution', 'Resolved from the CLI')
  .option('--amount <amount>', 'refund amount in minor units')
  .action(
    async (id: string, options: { decline: boolean; message: string; amount?: string }) => {
      const resolved = await client().post<Dispute>(`/api/disputes/${id}/resolve`, {
        resolution: options.decline ? 'declined' : 'merchant-accepted',
        message: options.message,
        ...(options.amount ? { refundAmount: Number(options.amount) } : {}),
      });
      output(resolved, () =>
        `${pc.green('✓')} Dispute ${id} resolved as ${resolved.resolution}.`,
      );
    },
  );

program
  .command('jobs')
  .description('Show the scheduled job queue')
  .action(async () => {
    const { items } = await client().get<{ items: Job[] }>('/api/jobs');
    output(items, () =>
      items.length === 0
        ? pc.dim('No jobs queued.')
        : table(
            ['KIND', 'STATUS', 'RUN AT', 'ATTEMPT'],
            items.map((j) => [
              j.kind,
              statusColour(j.status),
              j.runAt,
              `${j.attempt}/${j.maxAttempts}`,
            ]),
          ),
    );
  });

/* ------------------------------------------------------------------ */

async function run(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${pc.red('✗')} ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

void run();

interface OverviewResponse {
  payments: { total: number; successful: number; pending: number; failed: number };
  webhooks: { succeeded: number; failed: number; pending: number };
}
interface PaymentDetail {
  payment: Payment;
  timeline: PayboxEvent[];
  refunds: Refund[];
  webhookDeliveries: WebhookDelivery[];
}
interface ScenarioSummary {
  name: string;
  description?: string;
  steps: unknown[];
}
interface ProviderInfo {
  /** Every credential the adapter issued, as /api/providers reports them. */
  keys?: Record<string, unknown>;
  id: string;
  enabled: boolean;
  basePath: string;
  status: string;
}
