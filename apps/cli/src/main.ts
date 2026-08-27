#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import type { Payment, PayboxEvent, Refund } from '@paybox/shared';
import type { Job, WebhookDelivery, WebhookEndpoint } from '@paybox/core';
import { CliError, PayboxClient } from './client.js';
import { heading, keyValue, money, shortTime, statusColour, table } from './render.js';

const DEFAULT_URL = process.env.PAYBOX_URL ?? 'http://127.0.0.1:8080';

const program = new Command()
  .name('paybox')
  .description('Local payment infrastructure emulator')
  .version('0.1.0')
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
    output({ health, overview }, () =>
      [
        heading('paybox'),
        keyValue([
          ['url', api.baseUrl],
          ['version', health.version],
          ['time', health.time],
          ['clock', health.clock.mode === 'frozen' ? pc.yellow('frozen') : 'system'],
        ]),
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
  .option('-n, --limit <n>', 'how many', '25')
  .action(async (options: { status?: string; limit: string }) => {
    const query = new URLSearchParams({ limit: options.limit });
    if (options.status) query.set('status', options.status);
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
    // Fetch the local test key rather than making the user paste it: the CLI
    // and the emulator are the same trust domain, and these keys are fake.
    const { keys } = await api.get<{ keys: { secretKey: string } }>('/api/providers');
    const headers = {
      authorization: `Bearer ${keys.secretKey}`,
      'content-type': 'application/json',
    };

    // Goes through the provider's own endpoint, so the resulting payment is
    // indistinguishable from one the developer's application created.
    const useCharge = Boolean(options.method);
    const path = useCharge
      ? `/${options.provider}/charge`
      : `/${options.provider}/transaction/initialize`;
    const body: Record<string, unknown> = {
      email: options.email,
      amount: Number(options.amount),
      currency: options.currency,
      ...(options.reference ? { reference: options.reference } : {}),
      ...(options.method === 'mobile_money'
        ? { mobile_money: { phone: '0550000000', provider: 'mtn' } }
        : {}),
      ...(options.method === 'card' ? { card: { number: '4000 0000 0000 0000' } } : {}),
      ...(options.method === 'bank' ? { bank: { code: '058', account_number: '0000000000' } } : {}),
    };

    const response = await fetch(`${api.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { status: boolean; message: string; data?: Record<string, unknown> };
    if (!result.status) throw new CliError(result.message);

    const reference = String(result.data?.reference ?? '');
    const { items } = await api.get<{ items: Payment[] }>(
      `/api/payments?reference=${encodeURIComponent(reference)}&limit=1`,
    );
    const created = items[0];

    output(result.data, () =>
      [
        `${pc.green('✓')} ${reference} → ${statusColour(created?.status ?? 'created')}`,
        created ? `  ${pc.dim('id')}         ${created.id}` : '',
        result.data?.authorization_url
          ? `  ${pc.dim('checkout')}   ${String(result.data.authorization_url)}`
          : '',
        result.data?.display_text ? `  ${pc.dim('prompt')}     ${String(result.data.display_text)}` : '',
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
  .option('--secret <secret>', 'signing secret (defaults to the local test key)')
  .action(async (url: string, options: { provider: string; secret?: string }) => {
    const endpoint = await client().post<WebhookEndpoint>('/api/webhooks/endpoints', {
      url,
      provider: options.provider,
      ...(options.secret ? { secret: options.secret } : {}),
    });
    process.stdout.write(
      `${pc.green('✓')} ${endpoint.url}\n  ${pc.dim('signing secret')}  ${endpoint.secret}\n`,
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
    process.stdout.write(
      `${pc.green('✓')} ${delivery.id} → ${statusColour(delivery.status)} ` +
        `(attempt ${delivery.attempt}/${delivery.maxAttempts})\n`,
    );
  });

webhook
  .command('replay <id>')
  .description('Send the identical signed payload again as a brand-new delivery')
  .action(async (id: string) => {
    const delivery = await client().post<WebhookDelivery>(`/api/webhooks/deliveries/${id}/replay`);
    process.stdout.write(
      `${pc.green('✓')} New delivery ${delivery.id} replaying ${delivery.replayOfDeliveryId}\n`,
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
  .action(async (options: Record<string, string>) => {
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
    process.stdout.write(
      `${pc.green('✓')} Running "${name}" — ${run.steps} steps, completing at ${run.completesAt}.\n` +
        pc.dim('  Use `paybox time advance` to fast-forward through it.\n'),
    );
  });

const time = program.command('time').description('Control virtual time');

time
  .command('freeze')
  .description('Freeze the clock')
  .action(async () => {
    const state = await client().post<{ now: number }>('/api/time', { action: 'freeze' });
    process.stdout.write(`${pc.green('✓')} Clock frozen at ${new Date(state.now).toISOString()}\n`);
  });

time
  .command('unfreeze')
  .description('Resume the clock')
  .action(async () => {
    await client().post('/api/time', { action: 'unfreeze' });
    process.stdout.write(`${pc.green('✓')} Clock resumed.\n`);
  });

time
  .command('advance <duration>')
  .description('Advance virtual time, e.g. 30s, 5m, 2h — runs every job that comes due')
  .action(async (duration: string) => {
    const state = await client().post<{ now: number }>('/api/time', {
      action: 'advance',
      value: duration,
    });
    process.stdout.write(
      `${pc.green('✓')} Advanced ${duration} → ${new Date(state.now).toISOString()}\n`,
    );
  });

const network = program.command('network').description('Simulate network conditions');

network
  .command('latency <ms>')
  .description('Add latency to provider responses')
  .action(async (ms: string) => {
    await client().post('/api/network', { latencyMs: Number(ms) });
    process.stdout.write(`${pc.green('✓')} Provider responses delayed by ${ms}ms.\n`);
  });

network
  .command('failure <rate>')
  .description('Fail a fraction of provider requests, 0..1')
  .action(async (rate: string) => {
    await client().post('/api/network', { failureRate: Number(rate) });
    process.stdout.write(`${pc.yellow('⚠')} ${Number(rate) * 100}% of provider requests will fail.\n`);
  });

network
  .command('reset')
  .description('Clear network simulation')
  .action(async () => {
    await client().delete('/api/network');
    process.stdout.write(`${pc.green('✓')} Network simulation cleared.\n`);
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
  id: string;
  enabled: boolean;
  basePath: string;
  status: string;
}
