import type { CoverageManifest } from '@paybox/shared';

/**
 * What the Tingg adapter actually serves (spec §31).
 *
 * Kept in step with the router by `tests/coverage-drift.test.ts`, which fails
 * if this list and the routes disagree in either direction. That is what makes
 * the table in `docs/tingg.md` a contract rather than a promise.
 *
 * One manifest covers both of Tingg's APIs because both are mounted at one
 * prefix — see the note at the top of routes.ts. The *prose* separating
 * collections from payouts stays in Markdown, where it belongs.
 */
export const TINGG_COVERAGE: CoverageManifest = {
  id: 'tingg',
  label: 'Tingg',
  basePath: '/tingg',
  docs: 'docs/tingg.md',
  entries: [
    { method: 'POST', path: '/v1/oauth/token/request', status: 'compatible' },
    {
      method: 'POST',
      path: '/v3/checkout-api/checkout-request/express-request',
      status: 'partial',
      note: 'charge_beneficiaries and prefill_msisdn are accepted and echoed, not acted on.',
    },
    { method: 'POST', path: '/v3/checkout-api/checkout/request', status: 'compatible' },
    { method: 'POST', path: '/v3/checkout-api/checkout-charge', status: 'compatible' },
    { method: 'POST', path: '/v3/checkout-api/charge/request', status: 'compatible' },
    {
      method: 'GET',
      path: '/v3/checkout-api/query/:service_code/:merchant_transaction_id',
      status: 'partial',
      note: "Response body is paybox's: Tingg's published page 403s automated fetches.",
    },
    { method: 'POST', path: '/v3/checkout-api/acknowledgement/request', status: 'compatible' },
    {
      method: 'POST',
      path: '/v3/checkout-api/refund/request',
      status: 'partial',
      note: 'Refund notification codes 186/187/191 are emitted; no refund query endpoint.',
    },
    {
      method: 'POST',
      path: '/v1/global-api/payments',
      status: 'partial',
      note: 'Five BEEP functions: postPayment, queryPaymentStatus, queryFloatBalance, validateAccount, queryBill.',
    },
    {
      method: 'GET',
      path: '/checkout/:reference',
      status: 'emulator-only',
      note: "Tingg's hosted page lives on a Tingg domain; this stands in for it.",
    },
    {
      method: 'POST',
      path: '/checkout/:reference',
      status: 'emulator-only',
      note: 'The hosted page posting back to itself.',
    },
  ],
};
