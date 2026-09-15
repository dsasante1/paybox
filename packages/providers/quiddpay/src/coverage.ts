import type { CoverageManifest } from '@paybox/shared';

/**
 * What the Quid Payments adapter actually serves (spec §31).
 *
 * Generated from the routes the plugin registers and kept in step by
 * `tests/coverage-drift.test.ts`, which fails if this list and the router
 * disagree in either direction. That is what makes the coverage table in
 * `docs/quiddpay.md` a contract rather than a promise: a route added without an
 * entry here, or an entry left behind after a route is removed, breaks the
 * build.
 *
 * The *prose* in that file -- why something is partial, what differs from the
 * real provider -- stays in Markdown, where it belongs.
 */
export const QUIDDPAY_COVERAGE: CoverageManifest = {
  id: 'quiddpay',
  label: 'Quid Payments',
  basePath: '/quiddpay',
  docs: 'docs/quiddpay.md',
  entries: [
    { method: 'POST', path: '/api/v1/sessions', status: 'compatible' },
    { method: 'GET', path: '/api/v1/sessions/:reference', status: 'compatible' },
    { method: 'POST', path: '/api/v1/invoice-lines', status: 'compatible' },
    { method: 'GET', path: '/api/v1/invoice-lines', status: 'partial', note: 'Requires invoice_ref; no paging.' },
    { method: 'POST', path: '/api/v1/revenue-lines', status: 'compatible' },
    { method: 'GET', path: '/api/v1/revenue-lines', status: 'partial', note: 'No paging or filtering.' },
    { method: 'GET', path: '/api/v1/checkout/options', status: 'partial' },
    { method: 'GET', path: '/api/v1/checkout/sessions/:reference', status: 'compatible' },
    { method: 'GET', path: '/api/v1/checkout/sessions/:reference/quote', status: 'partial', note: 'No surcharges.' },
    { method: 'GET', path: '/api/v1/checkout/sessions/:reference/bank-transfer-banks', status: 'partial' },
    { method: 'POST', path: '/api/v1/checkout/sessions/:reference/momo-account-verification', status: 'partial' },
    { method: 'POST', path: '/api/v1/checkout/sessions/:reference/provider-attempts', status: 'compatible' },
    {
      method: 'GET',
      path: '/api/v1/checkout/sessions/:reference/provider-attempts/:attemptReference',
      status: 'compatible',
    },
    {
      method: 'POST',
      path: '/api/v1/checkout/sessions/:reference/provider-attempts/:attemptReference/authorize',
      status: 'compatible',
    },
    {
      method: 'POST',
      path: '/api/v1/checkout/sessions/:reference/provider-attempts/:attemptReference/resend',
      status: 'partial',
      note: 'Echoes the attempt; no new prompt is generated.',
    },
    {
      method: 'POST',
      path: '/api/v1/checkout/sessions/:reference/provider-attempts/:attemptReference/payment-declarations',
      status: 'compatible',
    },
    { method: 'GET', path: '/api/v1/checkout/sessions/:reference/receipt', status: 'compatible' },
    { method: 'PUT', path: '/api/v1/checkout/sessions/:reference/receipt-email', status: 'partial', note: 'No mail is sent.' },
    { method: 'POST', path: '/api/v1/checkout/cash-slips', status: 'compatible' },
    { method: 'POST', path: '/api/v1/test/payment-attempts/:reference/simulate', status: 'compatible' },
    { method: 'GET', path: '/api/v1/payouts/capabilities', status: 'partial' },
    { method: 'GET', path: '/api/v1/payouts/balance', status: 'compatible' },
    { method: 'POST', path: '/api/v1/payouts/recipients', status: 'compatible' },
    { method: 'GET', path: '/api/v1/payouts/recipients', status: 'compatible' },
    { method: 'GET', path: '/api/v1/payouts/recipients/:recipientId', status: 'compatible' },
    { method: 'DELETE', path: '/api/v1/payouts/recipients/:recipientId', status: 'compatible' },
    { method: 'POST', path: '/api/v1/payouts/recipients/:recipientId/verify', status: 'partial', note: 'Resolves immediately.' },
    { method: 'POST', path: '/api/v1/payouts/quote', status: 'partial', note: 'paybox’s own fee schedule; Quid publishes none.' },
    { method: 'POST', path: '/api/v1/payouts', status: 'compatible' },
    { method: 'GET', path: '/api/v1/payouts', status: 'compatible' },
    { method: 'GET', path: '/api/v1/payouts/:payoutId', status: 'compatible' },
    { method: 'POST', path: '/api/v1/payouts/:payoutId/cancel', status: 'compatible' },
    { method: 'GET', path: '/api/v1/payouts/:payoutId/receipt', status: 'partial', note: 'A generated PDF with no branding.' },
    { method: 'GET', path: '/api/v1/payouts/:payoutId/evidence/:evidenceId', status: 'partial', note: 'One receipt document per payout.' },
    { method: 'GET', path: '/checkout/:ref', status: 'emulator-only' },
    {
      method: 'POST',
      path: '/checkout/:ref/pay',
      status: 'emulator-only',
      note: 'The hosted page’s own form. Not provider surface.',
    },
  ],
};
