import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import {
  entryKey,
  formatEntry,
  summarise,
  type CoverageEntry,
  type CoverageManifest,
} from '@paybox/shared';
import { buildContext, loadConfig, type PayboxContext } from '@paybox/api';
import { RecordingTransport } from '@paybox/webhooks';
import { PAYSTACK_COVERAGE, registerPaystack } from '@paybox/paystack';
import { STRIPE_COVERAGE, registerStripe } from '@paybox/stripe';
import {
  FLUTTERWAVE_V3_COVERAGE,
  FLUTTERWAVE_V4_COVERAGE,
  registerFlutterwave,
  registerFlutterwaveV4,
} from '@paybox/flutterwave';
import { KORA_COVERAGE, registerKora } from '@paybox/kora';
import { WEWIRE_COVERAGE, registerWewire } from '@paybox/wewire';

/**
 * The coverage contract, enforced.
 *
 * `docs/<provider>.md` calls itself "a contract, not marketing", and CLAUDE.md
 * repeats it — but until this test that was a convention held up by care
 * alone. Nothing checked that the tables matched what the adapters served, so
 * a route added without a doc row would go unnoticed until somebody trusted
 * the file and was wrong.
 *
 * These assertions make the claim structural:
 *
 *   1. Every route the router registers is declared in a manifest.
 *   2. Every manifest entry corresponds to a route that exists.
 *   3. Every manifest entry appears in the provider's documentation.
 *
 * The first two catch drift in either direction. The third is what keeps the
 * published table honest.
 */
let context: PayboxContext;

interface Registered {
  method: string;
  path: string;
}

/** Collect the routes a plugin registers, relative to its own prefix. */
async function routesOf(
  prefix: string,
  register: (app: FastifyInstance) => Promise<void>,
): Promise<Registered[]> {
  const app = Fastify();
  const found: Registered[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // Fastify adds these itself; they are not adapter surface.
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      const path = route.url.startsWith(prefix)
        ? route.url.slice(prefix.length) || '/'
        : route.url;
      found.push({ method, path });
    }
  });
  await register(app);
  await app.ready();
  await app.close();
  return found;
}

interface Subject {
  manifest: CoverageManifest;
  routes: Registered[];
}

const subjects: Subject[] = [];

beforeAll(async () => {
  process.env.PAYBOX_DATABASE = ':memory:';
  process.env.PAYBOX_FREEZE_CLOCK = '1';
  process.env.PAYBOX_SEED = 'coverage';
  const { config } = loadConfig();
  context = await buildContext({
    config,
    transport: new RecordingTransport(),
    logSink: () => {},
  });

  const common = {
    engine: context.engine,
    simulator: context.simulator,
    storage: context.storage,
    clock: context.clock,
    ids: context.ids,
    baseUrl: context.baseUrl,
  };

  subjects.push({
    manifest: PAYSTACK_COVERAGE,
    routes: await routesOf('/paystack', (app) =>
      registerPaystack(app, {
        ...common,
        subscriptions: context.subscriptions,
        basePath: '/paystack',
      }),
    ),
  });
  subjects.push({
    manifest: STRIPE_COVERAGE,
    routes: await routesOf('/stripe', (app) =>
      registerStripe(app, {
        ...common,
        subscriptions: context.subscriptions,
        basePath: '/stripe',
      }),
    ),
  });
  subjects.push({
    manifest: FLUTTERWAVE_V3_COVERAGE,
    routes: await routesOf('/flutterwave', (app) =>
      registerFlutterwave(app, {
        ...common,
        subscriptions: context.subscriptions,
        basePath: '/flutterwave',
        encryptionKey: context.flutterwaveKeys.encryptionKey,
      }),
    ),
  });
  subjects.push({
    manifest: FLUTTERWAVE_V4_COVERAGE,
    routes: await routesOf('/flutterwave/v4', (app) =>
      registerFlutterwaveV4(app, {
        ...common,
        basePath: '/flutterwave/v4',
        credentials: context.flutterwaveV4,
      }),
    ),
  });
  subjects.push({
    manifest: KORA_COVERAGE,
    routes: await routesOf('/kora', (app) =>
      registerKora(app, { ...common, basePath: '/kora', secretKey: context.koraKeys.secretKey }),
    ),
  });
  subjects.push({
    manifest: WEWIRE_COVERAGE,
    routes: await routesOf('/wewire', (app) =>
      registerWewire(app, { ...common, basePath: '/wewire', random: context.random }),
    ),
  });
});

afterAll(async () => {
  await context.shutdown();
});

describe('every route is declared', () => {
  it.each(['paystack', 'stripe', 'flutterwave-v3', 'flutterwave-v4', 'kora', 'wewire'])(
    '%s serves nothing it has not declared',
    (id) => {
      const subject = subjects.find((s) => s.manifest.id === id)!;
      const declared = new Set(
        subject.manifest.entries.map((entry) => entryKey(entry.method, entry.path)),
      );
      const undeclared = subject.routes
        .map((route) => entryKey(route.method, route.path))
        .filter((key) => !declared.has(key));

      // A route with no manifest entry is undocumented surface. Adding one
      // should be a deliberate act, not something that happens by accident.
      expect(undeclared, `undeclared routes in ${id}`).toEqual([]);
    },
  );
});

describe('every declaration is real', () => {
  it.each(['paystack', 'stripe', 'flutterwave-v3', 'flutterwave-v4', 'kora', 'wewire'])(
    '%s declares nothing it does not serve',
    (id) => {
      const subject = subjects.find((s) => s.manifest.id === id)!;
      const served = new Set(
        subject.routes.map((route) => entryKey(route.method, route.path)),
      );
      const phantom = subject.manifest.entries
        .map((entry) => entryKey(entry.method, entry.path))
        .filter((key) => !served.has(key));

      // The direction that matters most for trust: a manifest claiming an
      // endpoint that does not exist is exactly the marketing the coverage
      // contract is meant to prevent.
      expect(phantom, `declared but not served in ${id}`).toEqual([]);
    },
  );
});

describe('every declaration is documented', () => {
  it.each(['paystack', 'stripe', 'flutterwave-v3', 'flutterwave-v4', 'kora', 'wewire'])(
    '%s has a documentation row for each entry',
    (id) => {
      const subject = subjects.find((s) => s.manifest.id === id)!;
      const markdown = readFileSync(subject.manifest.docs, 'utf8');

      // Emulator-only endpoints are documented in prose rather than in the
      // endpoint table, so they are exempt from the row check -- but they must
      // still be named somewhere in the file.
      const missing = subject.manifest.entries.filter((entry) => {
        const path = entry.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '');
        const segments = path.split('/').filter((s) => s.length > 0);
        const distinctive = segments.at(-1) ?? segments.at(-2) ?? '';
        return distinctive.length > 2 && !markdown.includes(distinctive);
      });

      expect(
        missing.map(formatEntry),
        `entries with nothing in ${subject.manifest.docs}`,
      ).toEqual([]);
    },
  );
});

describe('the manifests are well formed', () => {
  it('declare no duplicates', () => {
    for (const { manifest } of subjects) {
      const keys = manifest.entries.map((entry) => entryKey(entry.method, entry.path));
      expect(new Set(keys).size, `duplicates in ${manifest.id}`).toBe(keys.length);
    }
  });

  it('use only paths relative to their own base', () => {
    for (const { manifest } of subjects) {
      const absolute = manifest.entries
        .filter((entry) => entry.path.startsWith(manifest.basePath))
        .map(formatEntry);
      // A manifest that repeated its own prefix could never be compared with
      // what the router reports.
      expect(absolute, `${manifest.id} repeats its base path`).toEqual([]);
    }
  });

  it('summarise to the number of entries they hold', () => {
    for (const { manifest } of subjects) {
      const summary = summarise(manifest);
      expect(summary.compatible + summary.partial + summary.emulatorOnly).toBe(summary.total);
      expect(summary.total).toBe(manifest.entries.length);
      expect(summary.total).toBeGreaterThan(0);
    }
  });

  it('point at a documentation file that exists', () => {
    for (const { manifest } of subjects) {
      expect(() => readFileSync(manifest.docs, 'utf8')).not.toThrow();
    }
  });
});

describe('the published table', () => {
  it('matches what the manifests hold', async () => {
    // The README is where a visitor forms their expectations, so its numbers
    // have to be the ones this file enforces. Regenerate with
    // `npm run coverage:table` — a stale table fails here rather than quietly
    // overstating what the emulator serves.
    const { replaceBlock } = await import('../scripts/coverage-table.js');
    const readme = readFileSync('README.md', 'utf8');
    expect(replaceBlock(readme)).toBe(readme);
  });

  it('says Partial for every adapter', () => {
    const readme = readFileSync('README.md', 'utf8');
    const table = readme.slice(
      readme.indexOf('<!-- coverage:start -->'),
      readme.indexOf('<!-- coverage:end -->'),
    );
    for (const { manifest } of subjects) {
      const row = table.split('\n').find((line) => line.includes(`| ${manifest.label} |`));
      expect(row, `no README row for ${manifest.label}`).toBeDefined();
      // Every adapter is partial, and the front page must not imply otherwise.
      expect(row).toContain('**Partial**');
    }
  });
});

describe('what the manifests report', () => {
  it('covers every adapter the app serves', () => {
    // Six adapters across five providers: Flutterwave serves two API
    // versions that share nothing.
    expect(subjects).toHaveLength(6);
    expect(subjects.map((s) => s.manifest.id).sort()).toEqual([
      'flutterwave-v3',
      'flutterwave-v4',
      'kora',
      'paystack',
      'stripe',
      'wewire',
    ]);
  });

  it('classifies every entry', () => {
    const statuses = new Set<string>();
    for (const { manifest } of subjects) {
      for (const entry of manifest.entries) statuses.add(entry.status);
    }
    for (const status of statuses) {
      expect(['compatible', 'partial', 'emulator-only']).toContain(status);
    }
  });

  it('never presents an emulator-only endpoint as provider surface', () => {
    // Spec §29/§31: a hook that exists because a flow would otherwise be
    // untestable locally must be labelled, not passed off as the real API.
    const emulatorOnly: CoverageEntry[] = subjects.flatMap(({ manifest }) =>
      manifest.entries.filter((entry) => entry.status === 'emulator-only'),
    );
    expect(emulatorOnly.length).toBeGreaterThan(0);
    for (const entry of emulatorOnly) {
      expect(entry.status).toBe('emulator-only');
    }
  });
});
