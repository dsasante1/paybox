import type { CoverageManifest } from '@paybox/shared';

/**
 * What the Flutterwave v4 adapter actually serves (spec §31).
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
export const FLUTTERWAVE_V4_COVERAGE: CoverageManifest = {
  id: 'flutterwave-v4',
  label: 'Flutterwave v4',
  basePath: '/flutterwave/v4',
  docs: 'docs/flutterwave.md',
  entries: [
    { method: 'POST', path: '/charges', status: 'compatible' },
    { method: 'GET', path: '/charges/:id', status: 'compatible' },
    { method: 'PUT', path: '/charges/:id', status: 'compatible' },
    { method: 'POST', path: '/charges/:id/refund', status: 'compatible' },
    { method: 'POST', path: '/customers', status: 'partial' },
    { method: 'GET', path: '/customers/:id', status: 'partial' },
    { method: 'POST', path: '/oauth/token', status: 'partial' },
    { method: 'POST', path: '/payment-methods', status: 'partial' },
    { method: 'GET', path: '/payment-methods/:id', status: 'partial' },
    { method: 'GET', path: '/redirect/:ref', status: 'emulator-only' },
    { method: 'POST', path: '/transfers', status: 'partial' },
  ],
};
