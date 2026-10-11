import type { CoverageManifest } from '@paybox/shared';

/**
 * What the Bachs adapter actually serves (spec §31).
 *
 * Kept in step with the router by `tests/coverage-drift.test.ts`, which fails
 * if this list and the routes disagree in either direction, so the table in
 * `docs/bachs.md` is a contract rather than a promise. This is the first of
 * Bachs' phases -- collection: checkout, payments, catalog, refunds,
 * webhooks, balances -- and everything outside it is listed in docs/bachs.md
 * as not implemented.
 */
export const BACHS_COVERAGE: CoverageManifest = {
  id: 'bachs',
  label: 'Bachs',
  basePath: '/bachs',
  docs: 'docs/bachs.md',
  entries: [
    {
      method: 'POST',
      path: '/v1/checkout-sessions',
      status: 'partial',
      note: 'No subscriptions, saved cards or Connect splits; corridors that need FX are not offered.',
    },
    { method: 'GET', path: '/v1/checkout-sessions/:checkout_id', status: 'compatible' },
    { method: 'GET', path: '/v1/payments', status: 'compatible' },
    { method: 'GET', path: '/v1/payments/:payment_id', status: 'compatible' },
    { method: 'GET', path: '/v1/payments/charges/:charge_id', status: 'compatible' },
    { method: 'POST', path: '/v1/products', status: 'partial', note: 'No media uploads.' },
    { method: 'GET', path: '/v1/products', status: 'compatible' },
    { method: 'GET', path: '/v1/products/:product_id', status: 'compatible' },
    { method: 'PATCH', path: '/v1/products/:product_id', status: 'partial', note: 'media is accepted and ignored.' },
    { method: 'POST', path: '/v1/products/:product_id/archive', status: 'compatible' },
    { method: 'POST', path: '/v1/products/:product_id/unarchive', status: 'compatible' },
    { method: 'POST', path: '/v1/customers', status: 'compatible' },
    { method: 'GET', path: '/v1/customers', status: 'compatible' },
    { method: 'GET', path: '/v1/customers/:customer_id', status: 'compatible' },
    { method: 'PATCH', path: '/v1/customers/:customer_id', status: 'compatible' },
    {
      method: 'POST',
      path: '/v1/refunds',
      status: 'partial',
      note: 'An underpaid charge cannot be refunded.',
    },
    { method: 'GET', path: '/v1/refunds', status: 'compatible' },
    { method: 'GET', path: '/v1/refunds/:refund_id', status: 'compatible' },
    { method: 'GET', path: '/v1/refunds/by-charge/:payment_id', status: 'compatible' },
    {
      method: 'GET',
      path: '/v1/balances',
      status: 'partial',
      note: 'One balance per collected currency; no FX into USD.',
    },
    { method: 'POST', path: '/v1/webhooks/endpoints', status: 'compatible' },
    { method: 'GET', path: '/v1/webhooks/endpoints', status: 'compatible' },
    { method: 'GET', path: '/v1/webhooks/endpoints/:endpoint_id', status: 'compatible' },
    { method: 'PATCH', path: '/v1/webhooks/endpoints/:endpoint_id', status: 'compatible' },
    { method: 'DELETE', path: '/v1/webhooks/endpoints/:endpoint_id', status: 'compatible' },
    { method: 'GET', path: '/v1/webhooks/endpoints/:endpoint_id/secret', status: 'compatible' },
    { method: 'POST', path: '/v1/webhooks/endpoints/:endpoint_id/rotate-secret', status: 'compatible' },
    { method: 'GET', path: '/v1/webhooks/endpoints/:endpoint_id/metrics', status: 'compatible' },
    { method: 'GET', path: '/v1/webhooks/endpoints/:endpoint_id/events', status: 'compatible' },
    { method: 'GET', path: '/v1/webhooks/endpoints/:endpoint_id/events/:event_id', status: 'compatible' },
    {
      method: 'POST',
      path: '/v1/webhooks/endpoints/:endpoint_id/events/:event_id/resend',
      status: 'compatible',
    },
    { method: 'GET', path: '/v1/webhooks/events', status: 'compatible' },
    { method: 'GET', path: '/v1/webhooks/events/:event_id', status: 'compatible' },
    { method: 'POST', path: '/v1/webhooks/replay', status: 'compatible' },
    // The hosted checkout. Bachs serves its own at checkout.bachs.io; these
    // are paybox's, and the test controls on them are labelled as paybox's.
    { method: 'GET', path: '/c/:token', status: 'emulator-only' },
    { method: 'POST', path: '/c/:token/identify', status: 'emulator-only' },
    { method: 'POST', path: '/c/:token/amount', status: 'emulator-only' },
    { method: 'POST', path: '/c/:token/complete', status: 'emulator-only' },
    { method: 'POST', path: '/c/:token/pay', status: 'emulator-only' },
    { method: 'POST', path: '/c/:token/simulate', status: 'emulator-only' },
  ],
};
