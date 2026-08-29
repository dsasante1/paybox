/**
 * Regenerate the README's coverage table from the adapters' manifests.
 *
 * The repo's front page is where a visitor forms their expectations, so the
 * numbers on it have to come from the same place the drift test checks. A
 * hand-maintained table would be a fifth thing to forget to update, and the
 * first to go stale.
 *
 * Run with `npm run coverage:table`. `tests/coverage-drift.test.ts` asserts the
 * README matches, so a stale table fails the build rather than quietly
 * misleading anyone.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderReadmeTable, type CoverageManifest } from '@paybox/shared';
import { PAYSTACK_COVERAGE } from '@paybox/paystack';
import { STRIPE_COVERAGE } from '@paybox/stripe';
import { FLUTTERWAVE_V3_COVERAGE, FLUTTERWAVE_V4_COVERAGE } from '@paybox/flutterwave';
import { KORA_COVERAGE } from '@paybox/kora';
import { WEWIRE_COVERAGE } from '@paybox/wewire';

export const MANIFESTS: readonly CoverageManifest[] = [
  PAYSTACK_COVERAGE,
  STRIPE_COVERAGE,
  FLUTTERWAVE_V3_COVERAGE,
  FLUTTERWAVE_V4_COVERAGE,
  KORA_COVERAGE,
  WEWIRE_COVERAGE,
];

/** The markers the generated block sits between. */
export const START = '<!-- coverage:start -->';
export const END = '<!-- coverage:end -->';

export function renderBlock(): string {
  return `${START}\n${renderReadmeTable(MANIFESTS)}\n${END}`;
}

export function replaceBlock(markdown: string): string {
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (!pattern.test(markdown)) {
    throw new Error(`README is missing the ${START} / ${END} markers.`);
  }
  return markdown.replace(pattern, renderBlock());
}

// Only write when run directly, so the test can import the helpers.
if (process.argv[1]?.endsWith('coverage-table.ts')) {
  const readme = readFileSync('README.md', 'utf8');
  const updated = replaceBlock(readme);
  if (updated === readme) {
    process.stdout.write('README coverage table is already up to date.\n');
  } else {
    writeFileSync('README.md', updated);
    process.stdout.write('README coverage table regenerated.\n');
  }
}
