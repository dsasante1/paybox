import type { CoverageManifest } from '@paybox/shared';

/**
 * What the Kora adapter actually serves (spec §31).
 *
 * Generated from the routes the plugin registers and kept in step by
 * `tests/coverage-drift.test.ts`, which fails if this list and the router
 * disagree in either direction. That is what makes the coverage table in
 * `docs/kora.md` a contract rather than a promise: a route added without an entry
 * here, or an entry left behind after a route is removed, breaks the build.
 *
 * The *prose* in that file -- why something is partial, what differs from the
 * real provider -- stays in Markdown, where it belongs.
 */
export const KORA_COVERAGE: CoverageManifest = {
  id: 'kora',
  label: 'Kora',
  basePath: '/kora',
  docs: 'docs/kora.md',
  entries: [
    { method: 'GET', path: '/merchant/api/v1/balances', status: 'partial' },
    { method: 'GET', path: '/merchant/api/v1/balances/history', status: 'compatible' },
    { method: 'GET', path: '/merchant/api/v1/charges/:reference', status: 'compatible' },
    { method: 'POST', path: '/merchant/api/v1/charges/bank-transfer', status: 'compatible' },
    { method: 'POST', path: '/merchant/api/v1/charges/card', status: 'partial' },
    { method: 'POST', path: '/merchant/api/v1/charges/card/authorize', status: 'compatible' },
    { method: 'POST', path: '/merchant/api/v1/charges/card/resend-otp', status: 'partial' },
    { method: 'POST', path: '/merchant/api/v1/charges/initialize', status: 'compatible' },
    { method: 'POST', path: '/merchant/api/v1/charges/mobile-money', status: 'compatible' },
    { method: 'POST', path: '/merchant/api/v1/charges/mobile-money/authorize', status: 'compatible' },
    { method: 'POST', path: '/merchant/api/v1/charges/mobile-money/sandbox/authorize-stk', status: 'compatible' },
    { method: 'GET', path: '/checkout/:ref', status: 'emulator-only' },
    { method: 'POST', path: '/checkout/:ref/pay', status: 'emulator-only', note: 'The hosted page’s own form. Not provider surface.' },
    { method: 'GET', path: '/merchant/api/v1/misc/banks', status: 'partial' },
    { method: 'POST', path: '/merchant/api/v1/misc/banks/resolve', status: 'partial' },
    { method: 'GET', path: '/merchant/api/v1/misc/mobile-money', status: 'partial' },
    { method: 'GET', path: '/merchant/api/v1/pay-ins', status: 'compatible' },
    { method: 'GET', path: '/merchant/api/v1/payouts', status: 'compatible' },
    { method: 'GET', path: '/merchant/api/v1/refunds', status: 'partial' },
    { method: 'GET', path: '/merchant/api/v1/refunds/:reference', status: 'partial' },
    { method: 'POST', path: '/merchant/api/v1/refunds/initiate', status: 'compatible' },
    { method: 'GET', path: '/merchant/api/v1/transactions/:reference', status: 'compatible' },
    { method: 'GET', path: '/merchant/api/v1/transactions/bulk/:reference', status: 'compatible' },
    { method: 'GET', path: '/merchant/api/v1/transactions/bulk/:reference/payout', status: 'compatible' },
    { method: 'POST', path: '/merchant/api/v1/transactions/disburse', status: 'compatible' },
    { method: 'POST', path: '/merchant/api/v1/transactions/disburse/bulk', status: 'compatible' },
    { method: 'POST', path: '/merchant/api/v1/virtual-bank-account', status: 'partial' },
    { method: 'GET', path: '/merchant/api/v1/virtual-bank-account/:reference', status: 'compatible' },
    { method: 'POST', path: '/merchant/api/v1/virtual-bank-account/sandbox/credit', status: 'compatible' },
  ],
};
