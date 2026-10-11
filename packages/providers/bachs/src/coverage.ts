import type { CoverageManifest } from '@paybox/shared';

/**
 * What the Bachs adapter actually serves (spec §31).
 *
 * Kept in step with the router by `tests/coverage-drift.test.ts`, which fails
 * if this list and the routes disagree in either direction, so the table in
 * `docs/bachs.md` is a contract rather than a promise. Four of Bachs'
 * phases are here -- collection (checkout, payments, catalog, refunds,
 * webhooks, balances), billing (subscriptions, saved cards, off-session
 * charges, product groups, the customer portal), money out (payouts,
 * destinations, schedules, conversions, the virtual account) and disputes
 * (evidence, submission, uploads) -- and everything outside them is listed in
 * docs/bachs.md as not implemented.
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
      note: 'No Connect splits; corridors that need FX are not offered.',
    },
    { method: 'GET', path: '/v1/checkout-sessions/:checkout_id', status: 'compatible' },
    { method: 'GET', path: '/v1/payments', status: 'compatible' },
    { method: 'GET', path: '/v1/payments/:payment_id', status: 'compatible' },
    { method: 'GET', path: '/v1/payments/charges/:charge_id', status: 'compatible' },
    {
      method: 'POST',
      path: '/v1/charges',
      status: 'partial',
      note: 'The processing fee is always absorbed: the customer-pays account setting is not modelled yet.',
    },
    { method: 'GET', path: '/v1/subscriptions', status: 'compatible' },
    { method: 'GET', path: '/v1/subscriptions/:subscription_id', status: 'compatible' },
    { method: 'PATCH', path: '/v1/subscriptions/:subscription_id', status: 'compatible' },
    { method: 'DELETE', path: '/v1/subscriptions/:subscription_id', status: 'compatible' },
    { method: 'POST', path: '/v1/customers/:customer_id/portal-sessions', status: 'compatible' },
    { method: 'POST', path: '/v1/payouts/destinations', status: 'compatible' },
    { method: 'GET', path: '/v1/payouts/destinations', status: 'compatible' },
    { method: 'GET', path: '/v1/payouts/destinations/:destination_id', status: 'compatible' },
    { method: 'PATCH', path: '/v1/payouts/destinations/:destination_id', status: 'compatible' },
    { method: 'DELETE', path: '/v1/payouts/destinations/:destination_id', status: 'compatible' },
    { method: 'POST', path: '/v1/payouts/quotes', status: 'compatible' },
    {
      method: 'POST',
      path: '/v1/payouts',
      status: 'partial',
      note: 'No first-payout review hold and no withdrawal limits; neither has a sandbox trigger.',
    },
    { method: 'GET', path: '/v1/payouts', status: 'compatible' },
    { method: 'GET', path: '/v1/payouts/:withdrawal_id', status: 'compatible' },
    {
      method: 'GET',
      path: '/v1/payouts/mobile-money-providers',
      status: 'partial',
      note: 'Absent from the pinned spec; shape from the payouts guide.',
    },
    { method: 'GET', path: '/v1/balance_settings', status: 'compatible' },
    { method: 'POST', path: '/v1/balance_settings', status: 'compatible' },
    { method: 'POST', path: '/v1/conversions/quotes', status: 'compatible' },
    { method: 'POST', path: '/v1/conversions', status: 'compatible' },
    { method: 'GET', path: '/v1/conversions', status: 'compatible' },
    { method: 'GET', path: '/v1/conversions/:conversion_id', status: 'compatible' },
    { method: 'GET', path: '/v1/disputes', status: 'compatible' },
    { method: 'GET', path: '/v1/disputes/:dispute_id', status: 'compatible' },
    { method: 'PATCH', path: '/v1/disputes/:dispute_id/evidence', status: 'compatible' },
    { method: 'POST', path: '/v1/disputes/:dispute_id/submit', status: 'compatible' },
    { method: 'POST', path: '/v1/disputes/uploads', status: 'compatible' },
    { method: 'POST', path: '/v1/utilities/uploads', status: 'compatible' },
    { method: 'GET', path: '/v1/utilities/uploads/:upload_id', status: 'compatible' },
    { method: 'DELETE', path: '/v1/utilities/uploads/:upload_id', status: 'compatible' },
    { method: 'POST', path: '/v1/accounts', status: 'compatible' },
    { method: 'GET', path: '/v1/accounts', status: 'compatible' },
    { method: 'GET', path: '/v1/accounts/me', status: 'compatible' },
    { method: 'GET', path: '/v1/accounts/:account_id', status: 'compatible' },
    {
      method: 'POST',
      path: '/v1/accounts/:account_id',
      status: 'partial',
      note: "Requirements follow paybox's own catalogue; Bachs publishes none.",
    },
    { method: 'GET', path: '/v1/accounts/:account_id/capabilities', status: 'compatible' },
    { method: 'POST', path: '/v1/accounts/:account_id/account-links', status: 'compatible' },
    { method: 'POST', path: '/v1/accounts/:account_id/documents', status: 'compatible' },
    { method: 'GET', path: '/v1/accounts/:account_id/persons', status: 'compatible' },
    { method: 'POST', path: '/v1/accounts/:account_id/persons', status: 'compatible' },
    { method: 'GET', path: '/v1/accounts/:account_id/persons/:person_id', status: 'compatible' },
    { method: 'POST', path: '/v1/accounts/:account_id/persons/:person_id', status: 'compatible' },
    { method: 'DELETE', path: '/v1/accounts/:account_id/persons/:person_id', status: 'compatible' },
    { method: 'POST', path: '/v1/accounts/:account_id/persons/:person_id/documents', status: 'compatible' },
    {
      method: 'GET',
      path: '/v1/reference/business-structures',
      status: 'partial',
      note: "Nigeria's three structures only, the only ones Bachs publishes.",
    },
    {
      method: 'GET',
      path: '/v1/reference/product-categories',
      status: 'partial',
      note: 'The two published categories only.',
    },
    { method: 'POST', path: '/v1/virtual-accounts', status: 'compatible' },
    { method: 'GET', path: '/v1/virtual-accounts', status: 'compatible' },
    { method: 'GET', path: '/v1/currencies/payout-supported', status: 'compatible' },
    { method: 'GET', path: '/v1/reference/banks', status: 'partial', note: 'A representative bank list, not Bachs\' full one.' },
    {
      method: 'GET',
      path: '/v1/reference/momo',
      status: 'partial',
      note: 'Absent from the pinned spec; shape from the payouts guide.',
    },
    { method: 'POST', path: '/v1/misc/bank-accounts/resolve', status: 'partial', note: 'Names are synthetic.' },
    { method: 'POST', path: '/v1/product-groups', status: 'compatible' },
    { method: 'GET', path: '/v1/product-groups', status: 'compatible' },
    { method: 'GET', path: '/v1/product-groups/:group_id', status: 'compatible' },
    { method: 'PATCH', path: '/v1/product-groups/:group_id', status: 'compatible' },
    { method: 'DELETE', path: '/v1/product-groups/:group_id', status: 'compatible' },
    { method: 'POST', path: '/v1/products', status: 'compatible' },
    { method: 'GET', path: '/v1/products', status: 'compatible' },
    { method: 'GET', path: '/v1/products/:product_id', status: 'compatible' },
    { method: 'PATCH', path: '/v1/products/:product_id', status: 'compatible' },
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
      note: 'USD and NGN, as Bachs holds them, at fixed rates; nothing is ever pending.',
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
    // A deposit into the virtual account: "there is no way to simulate a
    // deposit into it today" at Bachs, so this test control is paybox's.
    { method: 'POST', path: '/v1/virtual-accounts/:virtual_account_id/deposits', status: 'emulator-only' },
    // A chargeback is filed by the payer's bank and ruled on by the card
    // network, and Bachs' sandbox has no trigger for either, so these test
    // controls are paybox's.
    { method: 'POST', path: '/v1/disputes', status: 'emulator-only' },
    { method: 'POST', path: '/v1/disputes/:dispute_id/network', status: 'emulator-only' },
    // A public upload's bytes, at the `url` the uploads API returns. Bachs
    // serves its own from cdn.bachs.io.
    { method: 'GET', path: '/files/:upload_id/:file_name', status: 'emulator-only' },
    // Connect onboarding: Bachs hosts its own page at connect.bachs.io and
    // never describes it, and its sandbox reviews nothing, so the page and
    // the reviewer's controls are paybox's.
    { method: 'GET', path: '/connect/setup/c/:account_id/:token', status: 'emulator-only' },
    { method: 'POST', path: '/connect/setup/c/:account_id/:token', status: 'emulator-only' },
    { method: 'POST', path: '/v1/accounts/:account_id/requirements/review', status: 'emulator-only' },
    { method: 'POST', path: '/v1/accounts/:account_id/capabilities/:capability', status: 'emulator-only' },
    // The customer portal. Bachs serves its own at portal.bachs.io.
    { method: 'GET', path: '/portal/s/:token', status: 'emulator-only' },
    { method: 'POST', path: '/portal/s/:token/subscriptions/:subscription_id/cancel', status: 'emulator-only' },
    { method: 'POST', path: '/portal/s/:token/subscriptions/:subscription_id/resume', status: 'emulator-only' },
    { method: 'POST', path: '/portal/s/:token/subscriptions/:subscription_id/pay', status: 'emulator-only' },
  ],
};
