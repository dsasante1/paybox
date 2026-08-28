import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface PayboxConfig {
  host: string;
  port: number;
  database: { path: string };
  seed: string;
  /** Frozen clocks make CI deterministic; developers usually want it flowing. */
  freezeClock: boolean;
  startAt: string | null;
  webhooks: {
    retry: {
      enabled: boolean;
      maxAttempts: number;
      /**
       * `exponential` (default) or `paystack`.
       *
       * Paystack's real ladder is hourly for ten hours, which is unhelpful
       * when you are watching it happen -- but costs nothing under a frozen
       * clock, where `paybox time advance 12h` runs it to exhaustion
       * instantly. That is exactly when you want the real timings.
       */
      schedule: 'exponential' | 'paystack';
    };
    timeoutMs: number;
  };
  providers: Record<string, { enabled: boolean }>;
  security: {
    /** Accept keys that are not sk_test_*. Never accepts sk_live_*. */
    allowAnyKey: boolean;
  };
  simulation: {
    autoAdvance: boolean;
    autoAdvanceDelayMs: number;
  };
  balance: {
    /** Refuse a transfer the balance cannot cover, as a provider would. */
    enforce: boolean;
    /**
     * Opening test float per currency, in minor units.
     *
     * Without it, a fresh emulator could not pay out until it had collected
     * something, which makes testing a payout flow needlessly circuitous. Set
     * it to 0 to start empty and exercise the insufficient-funds path from the
     * first transfer.
     */
    opening: number;
    /**
     * Flat transfer fee **override** per currency, in minor units.
     *
     * Empty by default, and deliberately so: the adapter applies the
     * provider's own published schedule, which is tiered by amount and split
     * by destination. Set a currency here only to pin your negotiated rate,
     * in which case it replaces the schedule outright for that currency.
     */
    transferFee: Record<string, number>;
  };
  logLevel: string;
}

const DEFAULTS: PayboxConfig = {
  // Loopback by default (spec §43). Binding wider takes a deliberate act.
  host: '127.0.0.1',
  port: 8080,
  database: { path: './data/paybox.db' },
  seed: 'paybox',
  freezeClock: false,
  startAt: null,
  webhooks: {
    retry: { enabled: true, maxAttempts: 5, schedule: 'exponential' },
    timeoutMs: 10_000,
  },
  providers: { paystack: { enabled: true } },
  security: { allowAnyKey: false },
  simulation: { autoAdvance: true, autoAdvanceDelayMs: 3_000 },
  // 10,000,000 minor units — NGN 100,000 or GHS 100,000. Large enough that a
  // payout test never trips over it by accident, small enough to drain
  // deliberately.
  balance: {
    enforce: true,
    opening: 10_000_000,
    // Empty: the provider's published schedule applies unless overridden.
    transferFee: {},
  },
  logLevel: 'info',
};

export interface LoadedConfig {
  config: PayboxConfig;
  /** Safety notices to print at startup (spec §29, §43). */
  warnings: string[];
  sourcePath: string | null;
}

export function loadConfig(options: { configPath?: string; cwd?: string } = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const candidates = options.configPath
    ? [resolve(cwd, options.configPath)]
    : [resolve(cwd, 'paybox.yml'), resolve(cwd, 'paybox.yaml')];

  let fromFile: Partial<PayboxConfig> = {};
  let sourcePath: string | null = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    fromFile = (parseYaml(readFileSync(candidate, 'utf8')) ?? {}) as Partial<PayboxConfig>;
    sourcePath = candidate;
    break;
  }

  const env = process.env;
  const config: PayboxConfig = {
    ...DEFAULTS,
    ...fromFile,
    host: env.PAYBOX_HOST ?? fromFile.host ?? DEFAULTS.host,
    port: Number(env.PAYBOX_PORT ?? fromFile.port ?? DEFAULTS.port),
    database: {
      path: env.PAYBOX_DATABASE ?? fromFile.database?.path ?? DEFAULTS.database.path,
    },
    seed: env.PAYBOX_SEED ?? fromFile.seed ?? DEFAULTS.seed,
    freezeClock: boolFrom(env.PAYBOX_FREEZE_CLOCK, fromFile.freezeClock ?? DEFAULTS.freezeClock),
    startAt: env.PAYBOX_START_AT ?? fromFile.startAt ?? DEFAULTS.startAt,
    webhooks: {
      retry: {
        enabled: boolFrom(
          env.PAYBOX_WEBHOOK_RETRY,
          fromFile.webhooks?.retry?.enabled ?? DEFAULTS.webhooks.retry.enabled,
        ),
        maxAttempts: Number(
          env.PAYBOX_WEBHOOK_MAX_ATTEMPTS ??
            fromFile.webhooks?.retry?.maxAttempts ??
            DEFAULTS.webhooks.retry.maxAttempts,
        ),
        schedule:
          (env.PAYBOX_WEBHOOK_SCHEDULE as 'paystack' | undefined) ??
          fromFile.webhooks?.retry?.schedule ??
          DEFAULTS.webhooks.retry.schedule,
      },
      timeoutMs: Number(
        env.PAYBOX_WEBHOOK_TIMEOUT_MS ?? fromFile.webhooks?.timeoutMs ?? DEFAULTS.webhooks.timeoutMs,
      ),
    },
    providers: { ...DEFAULTS.providers, ...(fromFile.providers ?? {}) },
    security: {
      allowAnyKey: boolFrom(
        env.PAYBOX_ALLOW_ANY_KEY,
        fromFile.security?.allowAnyKey ?? DEFAULTS.security.allowAnyKey,
      ),
    },
    simulation: {
      autoAdvance: boolFrom(
        env.PAYBOX_AUTO_ADVANCE,
        fromFile.simulation?.autoAdvance ?? DEFAULTS.simulation.autoAdvance,
      ),
      autoAdvanceDelayMs: Number(
        env.PAYBOX_AUTO_ADVANCE_MS ??
          fromFile.simulation?.autoAdvanceDelayMs ??
          DEFAULTS.simulation.autoAdvanceDelayMs,
      ),
    },
    balance: {
      enforce: boolFrom(
        env.PAYBOX_ENFORCE_BALANCE,
        fromFile.balance?.enforce ?? DEFAULTS.balance.enforce,
      ),
      opening: Number(
        env.PAYBOX_OPENING_BALANCE ?? fromFile.balance?.opening ?? DEFAULTS.balance.opening,
      ),
      transferFee: { ...(fromFile.balance?.transferFee ?? {}) },
    },
    logLevel: env.PAYBOX_LOG_LEVEL ?? fromFile.logLevel ?? DEFAULTS.logLevel,
  };

  return { config, warnings: safetyWarnings(config), sourcePath };
}

/** True when we are almost certainly inside a container (spec §26 vs §43). */
export function inContainer(): boolean {
  return (
    process.env.PAYBOX_IN_CONTAINER === '1' ||
    existsSync('/.dockerenv') ||
    existsSync('/run/.containerenv')
  );
}

/**
 * Startup safety notices.
 *
 * §26 (ship a Docker image) and §43 (bind loopback only) genuinely conflict:
 * a container that binds 127.0.0.1 is unreachable from the host. We resolve it
 * by detecting the container case and softening the notice there, so the
 * warning stays meaningful everywhere it actually matters instead of becoming
 * noise that everyone learns to ignore.
 */
function safetyWarnings(config: PayboxConfig): string[] {
  const warnings: string[] = [];

  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    if (inContainer()) {
      warnings.push(
        `Bound to ${config.host} inside a container. Publish the port only to trusted networks.`,
      );
    } else {
      warnings.push(
        `SECURITY: bound to ${config.host}, not loopback. Anyone who can reach this ` +
          'machine can create and settle payments in your emulator. Use 127.0.0.1 unless ' +
          'you specifically need remote access.',
      );
    }
  }

  if (config.security.allowAnyKey) {
    warnings.push(
      'PAYBOX_ALLOW_ANY_KEY is on: non-test API keys will be accepted. ' +
        'Live keys (sk_live_*) are still refused.',
    );
  }

  return warnings;
}

function boolFrom(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
