import type { CoverageManifest } from '@paybox/shared';

/**
 * What the Wise adapter actually serves (spec §31).
 *
 * Kept in step with the router by `tests/coverage-drift.test.ts`, which fails
 * if this list and the registered routes disagree in either direction. The
 * prose lives in `docs/wise.md`.
 *
 * Wise's real surface is 174 paths across 50 tags. This is the payout core —
 * profile, rate, quote, recipient, transfer, fund, balance, webhook,
 * simulation — and the docs file names every tag left out.
 */
export const WISE_COVERAGE: CoverageManifest = {
  id: 'wise',
  label: 'Wise',
  basePath: '/wise',
  docs: 'docs/wise.md',
  entries: [
    /* profiles */
    {
      method: 'GET',
      path: '/v2/profiles',
      status: 'partial',
      note: 'Two profiles are seeded; creation and KYC are not modelled.',
    },
    { method: 'GET', path: '/v2/profiles/:profileId', status: 'partial' },

    /* rates */
    {
      method: 'GET',
      path: '/v1/rates',
      status: 'partial',
      note: 'A fixed table, not market data. Determinism forbids a moving rate.',
    },

    /* quotes */
    { method: 'POST', path: '/v3/profiles/:profileId/quotes', status: 'compatible' },
    { method: 'POST', path: '/v3/quotes', status: 'compatible' },
    { method: 'GET', path: '/v3/profiles/:profileId/quotes/:quoteId', status: 'compatible' },
    { method: 'PATCH', path: '/v3/profiles/:profileId/quotes/:quoteId', status: 'compatible' },

    /* recipients */
    {
      method: 'POST',
      path: '/v1/accounts',
      status: 'partial',
      note: 'Details are stored as sent; only GBP, EUR and USD requirements are published.',
    },
    { method: 'GET', path: '/v2/accounts', status: 'partial', note: 'No seek pagination.' },
    { method: 'GET', path: '/v2/accounts/:accountId', status: 'compatible' },
    { method: 'DELETE', path: '/v2/accounts/:accountId', status: 'compatible' },
    {
      method: 'GET',
      path: '/v1/quotes/:quoteId/account-requirements',
      status: 'partial',
      note: 'Three routes rather than Wise’s dozens.',
    },

    /* transfers */
    { method: 'POST', path: '/v1/transfers', status: 'compatible' },
    { method: 'GET', path: '/v1/transfers', status: 'compatible' },
    { method: 'GET', path: '/v1/transfers/:transferId', status: 'compatible' },
    { method: 'PUT', path: '/v1/transfers/:transferId/cancel', status: 'compatible' },
    {
      method: 'POST',
      path: '/v3/profiles/:profileId/transfers/:transferId/payments',
      status: 'partial',
      note: 'Only type BALANCE can settle locally.',
    },
    { method: 'GET', path: '/v1/transfers/:transferId/payments', status: 'compatible' },

    /* balances */
    { method: 'GET', path: '/v4/profiles/:profileId/balances', status: 'compatible' },
    { method: 'GET', path: '/v4/profiles/:profileId/balances/:balanceId', status: 'compatible' },
    {
      method: 'POST',
      path: '/v4/profiles/:profileId/balances',
      status: 'partial',
      note: 'SAVINGS balances are accepted but behave as STANDARD.',
    },
    { method: 'POST', path: '/v2/profiles/:profileId/balance-movements', status: 'compatible' },
    { method: 'GET', path: '/v1/profiles/:profileId/total-funds/:currency', status: 'compatible' },

    /* simulation — Wise's own sandbox endpoints, not paybox inventions */
    { method: 'GET', path: '/v1/simulation/transfers/:transferId/:status', status: 'compatible' },
    { method: 'POST', path: '/v1/simulation/balance/topup', status: 'compatible' },

    /* webhooks */
    { method: 'POST', path: '/v2/profiles/:profileId/subscriptions', status: 'compatible' },
    { method: 'GET', path: '/v2/profiles/:profileId/subscriptions', status: 'compatible' },
    {
      method: 'GET',
      path: '/v2/profiles/:profileId/subscriptions/:subscriptionId',
      status: 'compatible',
    },
    {
      method: 'DELETE',
      path: '/v2/profiles/:profileId/subscriptions/:subscriptionId',
      status: 'compatible',
    },

    /* emulator-only */
    {
      method: 'GET',
      path: '/paybox/webhook-public-key',
      status: 'emulator-only',
      note: 'Wise publishes its public key on a docs page, not through the API.',
    },
  ],
};
