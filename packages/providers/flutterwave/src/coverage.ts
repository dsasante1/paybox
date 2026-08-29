import type { CoverageManifest } from '@paybox/shared';

/**
 * What the Flutterwave v3 adapter actually serves (spec §31).
 *
 * Generated from the routes the plugin registers and kept in step by
 * `tests/coverage-drift.test.ts`, which fails if this list and the router
 * disagree in either direction. That is what makes the coverage table in
 * `docs/flutterwave.md` a contract rather than a promise: a route added without an entry
 * here, or an entry left behind after a route is removed, breaks the build.
 *
 * The *prose* in that file -- why something is partial, what differs from the
 * real provider -- stays in Markdown, where it belongs.
 */
export const FLUTTERWAVE_V3_COVERAGE: CoverageManifest = {
  id: 'flutterwave-v3',
  label: 'Flutterwave v3',
  basePath: '/flutterwave',
  docs: 'docs/flutterwave.md',
  entries: [
    { method: 'GET', path: '/3ds/:ref', status: 'emulator-only' },
    { method: 'GET', path: '/checkout/:ref', status: 'emulator-only' },
    { method: 'POST', path: '/checkout/:ref/pay', status: 'emulator-only', note: 'The hosted page’s own form. Not provider surface.' },
    { method: 'GET', path: '/v3/banks/:country', status: 'partial' },
    { method: 'POST', path: '/v3/charges', status: 'compatible' },
    { method: 'GET', path: '/v3/customers', status: 'partial' },
    { method: 'GET', path: '/v3/payment-plans', status: 'partial' },
    { method: 'POST', path: '/v3/payment-plans', status: 'partial' },
    { method: 'GET', path: '/v3/payment-plans/:id', status: 'partial' },
    { method: 'PUT', path: '/v3/payment-plans/:id', status: 'partial' },
    { method: 'POST', path: '/v3/payments', status: 'compatible' },
    { method: 'GET', path: '/v3/refunds', status: 'partial' },
    { method: 'GET', path: '/v3/subaccounts', status: 'partial' },
    { method: 'POST', path: '/v3/subaccounts', status: 'partial' },
    { method: 'GET', path: '/v3/subaccounts/:id', status: 'partial' },
    { method: 'POST', path: '/v3/tokenized-charges', status: 'compatible' },
    { method: 'GET', path: '/v3/transactions', status: 'partial' },
    { method: 'POST', path: '/v3/transactions/:id/refund', status: 'compatible' },
    { method: 'GET', path: '/v3/transactions/:id/verify', status: 'compatible' },
    { method: 'GET', path: '/v3/transactions/verify_by_reference', status: 'compatible' },
    { method: 'GET', path: '/v3/transfers', status: 'compatible' },
    { method: 'POST', path: '/v3/transfers', status: 'compatible' },
    { method: 'GET', path: '/v3/transfers/:id', status: 'compatible' },
    { method: 'POST', path: '/v3/validate-charge', status: 'compatible' },
    { method: 'POST', path: '/v3/virtual-account-numbers', status: 'partial' },
    { method: 'GET', path: '/v3/virtual-account-numbers/:ref', status: 'partial' },
  ],
};
