import type { CoverageManifest } from '@paybox/shared';

/**
 * What the Paystack adapter actually serves (spec §31).
 *
 * Generated from the routes the plugin registers and kept in step by
 * `tests/coverage-drift.test.ts`, which fails if this list and the router
 * disagree in either direction. That is what makes the coverage table in
 * `docs/paystack.md` a contract rather than a promise: a route added without an entry
 * here, or an entry left behind after a route is removed, breaks the build.
 *
 * The *prose* in that file -- why something is partial, what differs from the
 * real provider -- stays in Markdown, where it belongs.
 */
export const PAYSTACK_COVERAGE: CoverageManifest = {
  id: 'paystack',
  label: 'Paystack',
  basePath: '/paystack',
  docs: 'docs/paystack.md',
  entries: [
    { method: 'GET', path: '/balance', status: 'partial' },
    { method: 'GET', path: '/balance/ledger', status: 'partial' },
    { method: 'GET', path: '/bank', status: 'partial' },
    { method: 'POST', path: '/charge', status: 'partial' },
    { method: 'GET', path: '/charge/:reference', status: 'compatible' },
    { method: 'POST', path: '/charge/submit_birthday', status: 'partial' },
    { method: 'POST', path: '/charge/submit_otp', status: 'compatible' },
    { method: 'POST', path: '/charge/submit_phone', status: 'partial' },
    { method: 'POST', path: '/charge/submit_pin', status: 'partial' },
    { method: 'GET', path: '/checkout/:accessCode', status: 'emulator-only', note: 'The hosted payment page.' },
    { method: 'POST', path: '/checkout/:accessCode/pay', status: 'emulator-only', note: 'The hosted page’s own form. Not provider surface.' },
    { method: 'GET', path: '/country', status: 'partial' },
    { method: 'GET', path: '/customer', status: 'compatible' },
    { method: 'POST', path: '/customer', status: 'compatible' },
    { method: 'GET', path: '/customer/:code', status: 'compatible' },
    { method: 'POST', path: '/customer/authorization/deactivate', status: 'compatible' },
    { method: 'GET', path: '/dedicated_account', status: 'partial' },
    { method: 'POST', path: '/dedicated_account', status: 'compatible' },
    { method: 'GET', path: '/dedicated_account/:id', status: 'compatible' },
    { method: 'POST', path: '/dedicated_account/assign', status: 'compatible' },
    { method: 'GET', path: '/dedicated_account/available_providers', status: 'partial' },
    { method: 'GET', path: '/dispute', status: 'compatible' },
    { method: 'POST', path: '/dispute', status: 'emulator-only' },
    { method: 'GET', path: '/dispute/:id', status: 'compatible' },
    { method: 'POST', path: '/dispute/:id/evidence', status: 'compatible' },
    { method: 'PUT', path: '/dispute/:id/resolve', status: 'compatible' },
    { method: 'GET', path: '/dispute/:id/upload_url', status: 'partial' },
    { method: 'GET', path: '/dispute/transaction/:id', status: 'compatible' },
    { method: 'GET', path: '/plan', status: 'compatible' },
    { method: 'POST', path: '/plan', status: 'compatible' },
    { method: 'GET', path: '/plan/:code', status: 'compatible' },
    { method: 'PUT', path: '/plan/:code', status: 'partial' },
    { method: 'POST', path: '/refund', status: 'compatible' },
    { method: 'GET', path: '/refund/:id', status: 'compatible' },
    { method: 'POST', path: '/refund/retry_with_customer_details/:id', status: 'compatible' },
    { method: 'GET', path: '/split', status: 'compatible' },
    { method: 'POST', path: '/split', status: 'compatible' },
    { method: 'GET', path: '/split/:id', status: 'compatible' },
    { method: 'PUT', path: '/split/:id', status: 'compatible' },
    { method: 'POST', path: '/split/:id/subaccount/add', status: 'compatible' },
    { method: 'POST', path: '/split/:id/subaccount/remove', status: 'compatible' },
    { method: 'GET', path: '/subaccount', status: 'compatible' },
    { method: 'POST', path: '/subaccount', status: 'compatible' },
    { method: 'GET', path: '/subaccount/:code', status: 'compatible' },
    { method: 'PUT', path: '/subaccount/:code', status: 'compatible' },
    { method: 'GET', path: '/subscription', status: 'compatible' },
    { method: 'POST', path: '/subscription', status: 'compatible' },
    { method: 'GET', path: '/subscription/:code', status: 'compatible' },
    { method: 'GET', path: '/subscription/:code/invoices', status: 'emulator-only' },
    { method: 'GET', path: '/subscription/:code/manage/link', status: 'partial' },
    { method: 'POST', path: '/subscription/disable', status: 'compatible' },
    { method: 'POST', path: '/subscription/enable', status: 'compatible' },
    { method: 'GET', path: '/transaction', status: 'compatible' },
    { method: 'GET', path: '/transaction/:id', status: 'partial' },
    { method: 'POST', path: '/transaction/charge_authorization', status: 'compatible' },
    { method: 'GET', path: '/transaction/export', status: 'partial' },
    { method: 'POST', path: '/transaction/initialize', status: 'compatible' },
    { method: 'POST', path: '/transaction/partial_debit', status: 'partial' },
    { method: 'GET', path: '/transaction/timeline/:id', status: 'compatible' },
    { method: 'GET', path: '/transaction/totals', status: 'partial' },
    { method: 'GET', path: '/transaction/verify/:reference', status: 'partial' },
    { method: 'POST', path: '/transfer', status: 'partial' },
    { method: 'GET', path: '/transfer/:id', status: 'partial' },
    { method: 'POST', path: '/transferrecipient', status: 'partial' },
  ],
};
