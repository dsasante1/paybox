import { PayboxError } from '@paybox/shared';

/**
 * Beneficiary-account validation, per settlement rail.
 *
 * WeWire is explicit that this happens at write time, not at payout time:
 * *"We check account details against the chosen settlement rail the moment
 * you create or update an account... We verify the IBAN checksum, the BIC
 * format, the sort code and account number combination, and the routing
 * number checksum, and we confirm the rail matches the currency. If a detail
 * is wrong, the request fails with a 400 that names the exact field."*
 * (docs.wewire.com/concepts/beneficiaries, read 2026-08-29.)
 *
 * Reproducing the checksums rather than accepting any well-formed string is
 * the difference between an emulator that catches a transposed IBAN digit and
 * one that hands the developer a green test and a failed payout in
 * production.
 */

export type SettlementRail = 'SEPA' | 'FPS' | 'CHAPS' | 'ACH' | 'WIRE' | 'SWIFT';

/** Which currency each rail settles in. */
const RAIL_CURRENCY: Record<SettlementRail, string | null> = {
  SEPA: 'EUR',
  FPS: 'GBP',
  CHAPS: 'GBP',
  ACH: 'USD',
  WIRE: 'USD',
  // SWIFT covers "other supported currencies", so it is not pinned to one.
  SWIFT: null,
};

function invalid(field: string, message: string): never {
  throw new PayboxError('validation_failed', message, {
    details: { wewireCode: 'VALIDATION_FAILED', field },
  });
}

/**
 * IBAN check: ISO 13616 structure plus the mod-97 checksum.
 *
 * Computed digit by digit rather than with BigInt so it works on any length
 * without an intermediate 34-digit number.
 */
export function isValidIban(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const code = character.charCodeAt(0);
    // A-Z becomes 10-35; digits stay themselves.
    const chunk = code >= 65 ? String(code - 55) : character;
    for (const digit of chunk) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** SWIFT/BIC: 8 or 11 characters, ISO 9362. */
export function isValidBic(value: string): boolean {
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(value.toUpperCase());
}

/** UK sort code: six digits, conventionally written `00-00-00`. */
export function isValidSortCode(value: string): boolean {
  return /^\d{6}$/.test(value.replace(/[\s-]/g, ''));
}

/**
 * ABA routing number: nine digits with the weighted 3-7-1 checksum.
 *
 * This is the check that catches a transposition, which a length test alone
 * would wave through.
 */
export function isValidRoutingNumber(value: string): boolean {
  const digits = value.replace(/\s+/g, '');
  if (!/^\d{9}$/.test(digits)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let total = 0;
  for (let index = 0; index < 9; index += 1) {
    total += Number(digits[index]) * (weights[index] as number);
  }
  return total % 10 === 0;
}

export interface AccountDetails {
  settlementRail: SettlementRail;
  currency: string;
  iban?: string | undefined;
  swiftBic?: string | undefined;
  sortCode?: string | undefined;
  accountNumber?: string | undefined;
  routingNumber?: string | undefined;
  accountCategory?: string | undefined;
}

/**
 * Validate one account against its rail, in WeWire's documented order:
 * the rail must match the currency, the required fields must be present, and
 * each must pass its own checksum.
 */
export function assertAccountDetails(details: AccountDetails): void {
  const expected = RAIL_CURRENCY[details.settlementRail];
  if (expected && expected !== details.currency) {
    invalid(
      'settlementRail',
      `settlementRail ${details.settlementRail} settles in ${expected}, not ${details.currency}.`,
    );
  }

  switch (details.settlementRail) {
    case 'SEPA': {
      if (!details.iban) invalid('iban', 'iban is required for SEPA.');
      if (!isValidIban(details.iban)) invalid('iban', 'iban failed its checksum.');
      return;
    }
    case 'FPS':
    case 'CHAPS': {
      if (!details.sortCode) invalid('sortCode', 'sortCode is required for this rail.');
      if (!details.accountNumber) {
        invalid('accountNumber', 'accountNumber is required for this rail.');
      }
      if (!isValidSortCode(details.sortCode)) invalid('sortCode', 'sortCode must be six digits.');
      if (!/^\d{8}$/.test(details.accountNumber)) {
        invalid('accountNumber', 'accountNumber must be eight digits on this rail.');
      }
      return;
    }
    case 'ACH':
    case 'WIRE': {
      if (!details.routingNumber) {
        invalid('routingNumber', 'routingNumber is required for this rail.');
      }
      if (!details.accountNumber) {
        invalid('accountNumber', 'accountNumber is required for this rail.');
      }
      if (!details.accountCategory) {
        invalid('accountCategory', 'accountCategory is required for this rail.');
      }
      if (!isValidRoutingNumber(details.routingNumber)) {
        invalid('routingNumber', 'routingNumber failed its ABA checksum.');
      }
      return;
    }
    case 'SWIFT': {
      if (!details.swiftBic) invalid('swiftBic', 'swiftBic is required for SWIFT.');
      if (!isValidBic(details.swiftBic)) invalid('swiftBic', 'swiftBic is not a valid BIC.');
      if (!details.iban && !details.accountNumber) {
        invalid('iban', 'SWIFT requires either iban or accountNumber.');
      }
      if (details.iban && !isValidIban(details.iban)) {
        invalid('iban', 'iban failed its checksum.');
      }
      return;
    }
  }
}
