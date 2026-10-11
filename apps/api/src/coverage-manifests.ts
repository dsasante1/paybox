import type { CoverageManifest } from '@paybox/shared';
import { PAYSTACK_COVERAGE } from '@paybox/paystack';
import { STRIPE_COVERAGE } from '@paybox/stripe';
import { FLUTTERWAVE_V3_COVERAGE, FLUTTERWAVE_V4_COVERAGE } from '@paybox/flutterwave';
import { KORA_COVERAGE } from '@paybox/kora';
import { QUIDDPAY_COVERAGE } from '@paybox/quiddpay';
import { TINGG_COVERAGE } from '@paybox/tingg';
import { WEWIRE_COVERAGE } from '@paybox/wewire';
import { WISE_COVERAGE } from '@paybox/wise';
import { BACHS_COVERAGE } from '@paybox/bachs';

/**
 * Every adapter's coverage manifest, in the order the banner lists them.
 *
 * The one list. It used to be copied by hand into the OpenAPI document, the
 * CLI's `paybox coverage` and the generated README block, and the OpenAPI copy
 * quietly missed Quid Payments and Tingg for two releases -- its test kept a
 * copy of its own, so it checked the list against itself. Everything that
 * enumerates the served surface imports this instead, and
 * `tests/coverage-drift.test.ts` holds it against the adapters the router
 * actually mounts.
 *
 * Kept free of anything heavier than the provider packages, and exported as
 * `@paybox/api/coverage`, so the CLI can read it without loading storage.
 */
export const COVERAGE_MANIFESTS: readonly CoverageManifest[] = [
  PAYSTACK_COVERAGE,
  STRIPE_COVERAGE,
  FLUTTERWAVE_V3_COVERAGE,
  FLUTTERWAVE_V4_COVERAGE,
  KORA_COVERAGE,
  QUIDDPAY_COVERAGE,
  TINGG_COVERAGE,
  WEWIRE_COVERAGE,
  WISE_COVERAGE,
  BACHS_COVERAGE,
];
