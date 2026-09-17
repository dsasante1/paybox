/**
 * Regenerate the published coverage tables from the adapters' manifests.
 *
 * The repo's front page is where a visitor forms their expectations, so the
 * numbers on it have to come from the same place the drift test checks. A
 * hand-maintained table would be a fifth thing to forget to update, and the
 * first to go stale.
 *
 * Two places publish those numbers: the README and the landing page in
 * `site/`. Both are generated here, from the same manifests, between the same
 * markers.
 *
 * Run with `npm run coverage:table`. `tests/coverage-drift.test.ts` asserts
 * both match, so a stale table fails the build rather than quietly misleading
 * anyone.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderReadmeTable, renderSiteTable, type CoverageManifest } from '@paybox/shared';
import { PAYSTACK_COVERAGE } from '@paybox/paystack';
import { STRIPE_COVERAGE } from '@paybox/stripe';
import { FLUTTERWAVE_V3_COVERAGE, FLUTTERWAVE_V4_COVERAGE } from '@paybox/flutterwave';
import { KORA_COVERAGE } from '@paybox/kora';
import { QUIDDPAY_COVERAGE } from '@paybox/quiddpay';
import { WEWIRE_COVERAGE } from '@paybox/wewire';
import { WISE_COVERAGE } from '@paybox/wise';

export const MANIFESTS: readonly CoverageManifest[] = [
  PAYSTACK_COVERAGE,
  STRIPE_COVERAGE,
  FLUTTERWAVE_V3_COVERAGE,
  FLUTTERWAVE_V4_COVERAGE,
  KORA_COVERAGE,
  QUIDDPAY_COVERAGE,
  WEWIRE_COVERAGE,
  WISE_COVERAGE,
];

/** The markers the generated block sits between. */
export const START = '<!-- coverage:start -->';
export const END = '<!-- coverage:end -->';

/**
 * Where the landing page's contract links point.
 *
 * `site/` deploys on its own, so a relative `docs/paystack.md` would 404
 * there. The manifests hold repository-relative paths, which is right for the
 * README, so the site's generator absolutises them against the default branch.
 */
export const SITE_DOCS_BASE_URL = 'https://github.com/dsasante1/paybox/blob/main';

export function renderBlock(): string {
  return `${START}\n${renderReadmeTable(MANIFESTS)}\n${END}`;
}

export function renderSiteBlock(): string {
  return `${START}\n${renderSiteTable(MANIFESTS, SITE_DOCS_BASE_URL)}\n${END}`;
}

function replace(source: string, contents: string, render: () => string): string {
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (!pattern.test(contents)) {
    throw new Error(`${source} is missing the ${START} / ${END} markers.`);
  }
  return contents.replace(pattern, render());
}

export function replaceBlock(markdown: string): string {
  return replace('README.md', markdown, renderBlock);
}

export function replaceSiteBlock(html: string): string {
  return replace('site/index.html', html, renderSiteBlock);
}

/** The files this script owns a block in, and how to regenerate each. */
export const GENERATED: readonly { path: string; replace: (contents: string) => string }[] = [
  { path: 'README.md', replace: replaceBlock },
  { path: 'site/index.html', replace: replaceSiteBlock },
];

// Only write when run directly, so the test can import the helpers.
if (process.argv[1]?.endsWith('coverage-table.ts')) {
  for (const target of GENERATED) {
    const current = readFileSync(target.path, 'utf8');
    const updated = target.replace(current);
    if (updated === current) {
      process.stdout.write(`${target.path} coverage table is already up to date.\n`);
    } else {
      writeFileSync(target.path, updated);
      process.stdout.write(`${target.path} coverage table regenerated.\n`);
    }
  }
}
