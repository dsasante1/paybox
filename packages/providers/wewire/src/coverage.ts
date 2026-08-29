import type { CoverageManifest } from '@paybox/shared';

/**
 * What the WeWire adapter actually serves (spec §31).
 *
 * Kept in step with the router by `tests/coverage-drift.test.ts`, which fails
 * if this list and the registered routes disagree in either direction. The
 * prose -- why something is partial, what differs from the real provider --
 * lives in `docs/wewire.md`.
 */
export const WEWIRE_COVERAGE: CoverageManifest = {
  id: 'wewire',
  label: 'WeWire',
  basePath: '/wewire',
  docs: 'docs/wewire.md',
  entries: [
    /* transactions */
    {
      method: 'POST',
      path: '/v1/transactions/initiate-payout',
      status: 'partial',
      note: 'Supporting documents are counted, not stored. Fees are zero.',
    },
    { method: 'GET', path: '/v1/transactions', status: 'compatible' },
    { method: 'GET', path: '/v1/transactions/:transactionId', status: 'compatible' },

    /* wallets */
    {
      method: 'GET',
      path: '/v1/wallets',
      status: 'partial',
      note: 'WeWire publishes no example body for this endpoint; the shape is inferred.',
    },
    { method: 'GET', path: '/v1/subcustomers/:subCustomerId/wallets', status: 'partial' },

    /* rates */
    {
      method: 'GET',
      path: '/v1/rates',
      status: 'partial',
      note: 'A fixed table, not market data. Determinism forbids a moving rate.',
    },
    { method: 'GET', path: '/v1/rates/:pair', status: 'partial' },
    {
      method: 'POST',
      path: '/v1/rates/conversion/preview',
      status: 'partial',
      note: 'Fee is always zero: paybox models no pricing.',
    },

    /* beneficiaries */
    { method: 'POST', path: '/v1/beneficiaries', status: 'compatible' },
    { method: 'GET', path: '/v1/beneficiaries', status: 'compatible' },
    { method: 'GET', path: '/v1/beneficiaries/:beneficiaryId', status: 'compatible' },
    { method: 'PATCH', path: '/v1/beneficiaries/:beneficiaryId', status: 'compatible' },
    {
      method: 'DELETE',
      path: '/v1/beneficiaries/:beneficiaryId',
      status: 'partial',
      note: 'Soft delete: accounts survive so historical payouts still resolve.',
    },
    { method: 'GET', path: '/v1/beneficiaries/:beneficiaryId/accounts', status: 'compatible' },
    { method: 'POST', path: '/v1/beneficiaries/:beneficiaryId/accounts', status: 'compatible' },
    {
      method: 'GET',
      path: '/v1/beneficiaries/:beneficiaryId/accounts/:accountId',
      status: 'compatible',
    },

    /* sub-customers */
    {
      method: 'POST',
      path: '/v1/subcustomers',
      status: 'partial',
      note: 'Created APPROVED. There is no KYC review lifecycle.',
    },
    { method: 'GET', path: '/v1/subcustomers', status: 'compatible' },
    { method: 'GET', path: '/v1/subcustomers/:subCustomerId', status: 'compatible' },
    { method: 'PATCH', path: '/v1/subcustomers/:subCustomerId/archive', status: 'compatible' },

    /* africa (ghana corridor) */
    { method: 'POST', path: '/v1/collections', status: 'compatible' },
    { method: 'POST', path: '/v1/disbursements', status: 'compatible' },
    {
      method: 'GET',
      path: '/v1/account-lookup',
      status: 'partial',
      note: 'The name is derived from the number, not looked up at an operator.',
    },

    /* emulator-only */
    {
      method: 'POST',
      path: '/paybox/wallets/credit',
      status: 'emulator-only',
      note: 'WeWire funds a wallet by someone paying into a virtual account. Without this a fresh emulator has no balance and every payout fails.',
    },
    {
      method: 'GET',
      path: '/paybox/ghana-codes',
      status: 'emulator-only',
      note: 'WeWire publishes these as a reference page, not an endpoint.',
    },
  ],
};
