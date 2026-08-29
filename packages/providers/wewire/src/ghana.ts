import { PayboxError } from '@paybox/shared';

/**
 * The Ghana corridor's account codes and sandbox numbers.
 *
 * Transcribed verbatim from docs.wewire.com/ghana/ghana-codes and
 * /ghana/sandbox-test-numbers (read 2026-08-29). All codes are uppercase and
 * case-sensitive, which the docs state explicitly, so the lookups below do
 * not normalise case — a lowercase `mtn` is rejected here exactly as it would
 * be by WeWire.
 */

/** The three mobile-money operators. */
export const MOBILE_MONEY_CODES: Record<string, string> = {
  MTN: 'MTN Mobile Money',
  VOD: 'Telecel Cash (formerly Vodafone Cash)',
  ATM: 'AirtelTigo Money',
};

/** The 23 GhIPSS-participating banks. */
export const BANK_CODES: Record<string, string> = {
  ACC: 'Access Bank Ghana',
  ADB: 'Agricultural Development Bank',
  APB: 'ARB Apex Bank',
  BBG: 'Absa Bank Ghana (formerly Barclays)',
  BOA: 'Bank of Africa Ghana',
  BOG: 'Bank of Ghana',
  CAL: 'CalBank',
  CBG: 'Consolidated Bank Ghana',
  ECO: 'Ecobank Ghana',
  FAB: 'First Atlantic Bank',
  FBL: 'Fidelity Bank Ghana',
  FNG: 'FBNBank Ghana',
  GCB: 'GCB Bank',
  GTB: 'GTBank Ghana',
  NIB: 'National Investment Bank',
  PRU: 'Prudential Bank',
  REP: 'Republic Bank Ghana',
  SCB: 'Standard Chartered Bank Ghana',
  SSB: 'Société Générale Ghana',
  STA: 'Stanbic Bank Ghana',
  UBA: 'United Bank for Africa Ghana',
  UMB: 'Universal Merchant Bank',
  ZEN: 'Zenith Bank Ghana',
};

export type AfricaChannel = 'MOBILE_MONEY' | 'BANK';

/**
 * Validate a destination, reproducing WeWire's documented messages verbatim.
 *
 * The messages are quoted from its validation-error tables rather than
 * paraphrased, because a developer's test asserting on the message text
 * should pass here and in production alike.
 */
export function assertDestination(
  currency: string,
  channel: AfricaChannel,
  accountCode: string,
  accountNumber: string,
  options: { collection?: boolean } = {},
): void {
  const combination = (): never => {
    throw new PayboxError(
      'unsupported_currency',
      'This currency and channel combination is not supported yet.',
      { details: { wewireCode: 'VALIDATION_FAILED' } },
    );
  };

  if (currency !== 'GHS') combination();
  // Bank pay-in is explicitly not available on the collections endpoint.
  if (options.collection && channel === 'BANK') combination();

  const table = channel === 'MOBILE_MONEY' ? MOBILE_MONEY_CODES : BANK_CODES;
  if (!Object.prototype.hasOwnProperty.call(table, accountCode)) {
    throw new PayboxError('validation_failed', 'Unknown account code for this channel.', {
      details: { wewireCode: 'VALIDATION_FAILED', field: 'accountCode' },
    });
  }

  if (channel === 'MOBILE_MONEY') {
    if (!/^\d{10}$/.test(accountNumber)) {
      throw new PayboxError(
        'validation_failed',
        'accountNumber must be a 10-digit mobile money number',
        { details: { wewireCode: 'VALIDATION_FAILED', field: 'accountNumber' } },
      );
    }
    return;
  }

  if (!/^\d{1,32}$/.test(accountNumber)) {
    throw new PayboxError(
      'validation_failed',
      'accountNumber must contain only digits, up to 32 characters',
      { details: { wewireCode: 'VALIDATION_FAILED', field: 'accountNumber' } },
    );
  }
}

/**
 * The sandbox numbers that short-circuit to a known outcome.
 *
 * This is WeWire's own version of paybox's last-four-digits convention, and
 * it is better: the numbers are published, so a developer's existing sandbox
 * test suite drives the emulator with no changes at all. They take priority
 * over any `paybox_outcome` metadata for exactly that reason.
 */
const SANDBOX_OUTCOMES: Record<string, 'successful' | 'failed'> = {
  '0240000001': 'successful',
  '0240000002': 'failed',
  '0200000001': 'successful',
  '0200000002': 'failed',
  '0260000001': 'successful',
  '0260000002': 'failed',
};

/**
 * WeWire pairs each number with a network, and the docs warn that any other
 * digits "go through to the live operator". Requiring the pair to match keeps
 * a typo'd `accountCode` from silently inheriting a deterministic outcome.
 */
const SANDBOX_NETWORKS: Record<string, string> = {
  '0240000001': 'MTN',
  '0240000002': 'MTN',
  '0200000001': 'VOD',
  '0200000002': 'VOD',
  '0260000001': 'ATM',
  '0260000002': 'ATM',
};

export function sandboxOutcome(
  accountCode: string,
  accountNumber: string,
): 'successful' | 'failed' | null {
  if (SANDBOX_NETWORKS[accountNumber] !== accountCode) return null;
  return SANDBOX_OUTCOMES[accountNumber] ?? null;
}

/**
 * The name an account lookup resolves to.
 *
 * WeWire returns "the operator's record, formatted as they return it (often
 * in uppercase)". There is no real operator here, so the emulator derives a
 * stable name from the number: the same input always resolves to the same
 * name, which is what makes a test assertable. docs/wewire.md states plainly
 * that this is generated, not looked up.
 */
const FIRST = ['KOFI', 'AMA', 'KWAME', 'ABENA', 'YAW', 'AKOSUA', 'KOJO', 'AFUA'];
const LAST = ['MENSAH', 'OWUSU', 'BOATENG', 'ASANTE', 'ADDO', 'DARKO', 'OSEI', 'ANTWI'];

export function resolveAccountName(accountNumber: string): string {
  let hash = 0;
  for (const character of accountNumber) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const first = FIRST[hash % FIRST.length] ?? 'KOFI';
  const last = LAST[Math.floor(hash / FIRST.length) % LAST.length] ?? 'MENSAH';
  return `${first} ${last}`;
}
