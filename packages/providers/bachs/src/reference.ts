import { createHash } from 'node:crypto';

/**
 * Reference data for payouts (api-reference/reference, payments, misc; read
 * 2026-10-10).
 *
 * Bachs publishes the shape of these lists and a two-bank example, not their
 * contents, so the banks here are a representative set with their published
 * NIP codes, plus Bachs' own sandbox test banks -- 999 and 998 are the codes
 * its payout test destinations use (connect/testing). docs/bachs.md says so.
 */
export const BANKS: Record<string, Array<{ name: string; code: string }>> = {
  NG: [
    { name: 'Access Bank', code: '044' },
    { name: 'First Bank of Nigeria', code: '011' },
    { name: 'Guaranty Trust Bank', code: '058' },
    { name: 'Providus Bank', code: '101' },
    { name: 'Sterling Bank', code: '232' },
    { name: 'United Bank for Africa', code: '033' },
    { name: 'Zenith Bank', code: '057' },
    { name: 'Sandbox Test Bank (payouts complete)', code: '999' },
    { name: 'Sandbox Test Bank (payouts fail)', code: '998' },
  ],
  GH: [
    { name: 'Absa Bank Ghana', code: 'GH030100' },
    { name: 'Ecobank Ghana', code: 'GH130100' },
    { name: 'GCB Bank', code: 'GH040100' },
    { name: 'Stanbic Bank Ghana', code: 'GH190100' },
  ],
  KE: [
    { name: 'Equity Bank', code: '68' },
    { name: 'KCB Bank', code: '01' },
  ],
  TZ: [
    { name: 'CRDB Bank', code: 'CORUTZTZ' },
    { name: 'NMB Bank', code: 'NMIBTZTZ' },
  ],
  UG: [
    { name: 'Stanbic Bank Uganda', code: 'SBICUGKX' },
    { name: 'Centenary Bank', code: 'CERBUGKA' },
  ],
};

/** Mobile-money networks per country, as the payouts guide lists them. */
export const MOMO_COUNTRIES: Record<string, string[]> = {
  GH: ['AIRTEL', 'MTN', 'VODAFONE'],
  KE: ['AIRTEL', 'SAFARICOM', 'T-KASH'],
  TZ: ['Airtel Tanzania', 'Halopesa', 'Tigo', 'Vodacom'],
};

/** `listPayoutSupportedCurrencies` `fiat`, verbatim from the spec's example. */
export const PAYOUT_SUPPORTED = ['NGN', 'GHS', 'KES', 'TZS', 'UGX', 'GBP', 'USD', 'CAD', 'EUR'];

const FIRST = ['ADA', 'CHIDI', 'EMEKA', 'FOLA', 'IFE', 'KEMI', 'NGOZI', 'TUNDE', 'UCHE', 'YEMI'];
const LAST = ['ADEYEMI', 'BALOGUN', 'EZE', 'NWOSU', 'OKAFOR', 'OKONKWO', 'OLADIPO', 'OSAGIE'];

/**
 * The name a bank "resolves" for an account. Synthetic and stable -- the
 * same account always resolves to the same name -- and obviously a test name
 * for Bachs' own sandbox banks.
 */
export function resolveAccountName(accountNumber: string, bankCode: string): string {
  if (bankCode === '999' || bankCode === '998') return 'PAYBOX SANDBOX PAYEE';
  const digest = createHash('sha256').update(`resolve:${bankCode}:${accountNumber}`).digest();
  return `${FIRST[digest[0]! % FIRST.length]} ${LAST[digest[1]! % LAST.length]}`;
}
