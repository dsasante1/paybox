import { fail } from './errors.js';
import { processingFeeIn, type Corridor } from './fees.js';
import { CORRIDORS, CRYPTO_ASSETS } from './routes-checkout.js';
import type { BachsState } from './state.js';

/**
 * Checkout settings (getCheckoutSettings / updateCheckoutSettings): which
 * corridors an owner's checkouts offer, and who bears Bachs' processing fee.
 * Per owner: the platform's, and each account's under `X-Account-Id`. A
 * direct charge uses the account's; a destination charge, the platform's
 * own sale, uses the platform's.
 */
export interface MethodSetting {
  enabled: boolean;
  /** CRYPTO only: which assets are on. */
  currencies?: Record<string, boolean>;
}

export interface StoredCheckoutSettings {
  account?: string;
  enabledPaymentMethods: Record<string, MethodSetting>;
  feePreference: 'org_pays' | 'customer_pays';
}

/** "In sandbox, every payment method is available": everything on, the merchant paying the fee. */
export function defaultSettings(account: string | null): StoredCheckoutSettings {
  return {
    ...(account ? { account } : {}),
    enabledPaymentMethods: Object.fromEntries(
      (Object.keys(CORRIDORS) as Corridor[]).map((corridor) => [
        corridor,
        corridor === 'CRYPTO'
          ? { enabled: true, currencies: Object.fromEntries(CRYPTO_ASSETS.map((asset) => [asset, true])) }
          : { enabled: true },
      ]),
    ),
    feePreference: 'org_pays',
  };
}

export async function settingsOf(state: BachsState, account: string | null): Promise<StoredCheckoutSettings> {
  return (await state.checkoutSettings.get(account)) ?? defaultSettings(account);
}

/** The crypto assets an owner takes. */
export function enabledAssets(settings: StoredCheckoutSettings): string[] {
  const crypto = settings.enabledPaymentMethods.CRYPTO;
  if (!crypto?.enabled) return [];
  return CRYPTO_ASSETS.filter((asset) => crypto.currencies?.[asset] ?? true);
}

/**
 * The corridors an owner's checkouts may offer. A corridor left out of the
 * stored map is off (an update "replaces the stored map wholesale"), and
 * "CRYPTO enabled with every asset false offers nothing".
 */
export function enabledCorridors(settings: StoredCheckoutSettings): Corridor[] {
  return (Object.keys(CORRIDORS) as Corridor[]).filter((corridor) => {
    if (!settings.enabledPaymentMethods[corridor]?.enabled) return false;
    return corridor !== 'CRYPTO' || enabledAssets(settings).length > 0;
  });
}

/** `available_currencies`: what each corridor collects in. */
export function availableCurrencies(): Record<string, string[]> {
  return Object.fromEntries(
    (Object.keys(CORRIDORS) as Corridor[]).map((corridor) => [
      corridor,
      corridor === 'CRYPTO' ? [...CRYPTO_ASSETS].sort() : [CORRIDORS[corridor].currency!],
    ]),
  );
}

/** Validate an `enabled_payment_methods` map: known corridors, each with `enabled`, assets only on CRYPTO. */
export function parseMethods(value: unknown): Record<string, MethodSetting> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('validation_failed', 'VALIDATION_ERROR', 'enabled_payment_methods: must be an object of corridors.');
  }
  const out: Record<string, MethodSetting> = {};
  for (const [corridor, raw] of Object.entries(value as Record<string, unknown>)) {
    const field = `enabled_payment_methods.${corridor}`;
    if (!Object.hasOwn(CORRIDORS, corridor)) throw fail('validation_failed', 'VALIDATION_ERROR', `${field}: unknown corridor.`);
    const entry = raw as { enabled?: unknown; currencies?: unknown } | null;
    if (!entry || typeof entry.enabled !== 'boolean') {
      throw fail('validation_failed', 'VALIDATION_ERROR', `${field}.enabled: required, a boolean.`);
    }
    if (entry.currencies !== undefined) {
      if (corridor !== 'CRYPTO') {
        throw fail('validation_failed', 'VALIDATION_ERROR', `${field}.currencies: only CRYPTO takes currencies.`);
      }
      if (!entry.currencies || typeof entry.currencies !== 'object' || Array.isArray(entry.currencies)) {
        throw fail('validation_failed', 'VALIDATION_ERROR', `${field}.currencies: an object of assets to booleans.`);
      }
      const assets = entry.currencies as Record<string, unknown>;
      for (const [asset, on] of Object.entries(assets)) {
        if (!(CRYPTO_ASSETS as readonly string[]).includes(asset) || typeof on !== 'boolean') {
          throw fail('validation_failed', 'VALIDATION_ERROR', `${field}.currencies.${asset}: an asset and a boolean.`);
        }
      }
      out[corridor] = { enabled: entry.enabled, currencies: assets as Record<string, boolean> };
    } else {
      out[corridor] = { enabled: entry.enabled };
    }
  }
  return out;
}

/**
 * What the customer pays on top when the owner passes the fee on: "the fee is
 * computed on the base amount and added on top" -- 29.00 becomes 30.85 on a
 * USD card. Zero when the owner absorbs it.
 */
export function feeOnTop(settings: StoredCheckoutSettings, base: number, currency: string, corridor: Corridor): number {
  return settings.feePreference === 'customer_pays' ? processingFeeIn(base, currency, corridor) : 0;
}

/** `fee_handling` on the account object, for `fee_preference`. */
export function feeHandlingOf(settings: StoredCheckoutSettings): 'account_pays_fee' | 'customer_pays_fee' {
  return settings.feePreference === 'customer_pays' ? 'customer_pays_fee' : 'account_pays_fee';
}
