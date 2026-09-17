/**
 * Regenerate every block the published pages carry but nobody should type.
 *
 * The README and the landing page in `site/` are where a visitor forms their
 * expectations, so the facts on them have to come from the place that already
 * holds them: the adapters' coverage manifests, and the version of the package
 * that actually ships. A hand-maintained copy is one more thing to forget, and
 * the first thing to go stale -- and a *wrong* fact on a page whose argument is
 * that its numbers are enforced is worse than no fact at all.
 *
 * Two kinds of block, marked in the files themselves:
 *
 *   coverage   the endpoint table, from the manifests (README, site)
 *   version    the published version, from apps/paybox/package.json (site)
 *
 * Run with `npm run generate`. `tests/coverage-drift.test.ts` asserts every
 * block is current, so a stale one fails the build rather than quietly
 * misleading anyone.
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

/** The one file that decides what version the published package is. */
export const VERSION_SOURCE = 'apps/paybox/package.json';

export function publishedVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(VERSION_SOURCE, 'utf8'));
  const version =
    typeof manifest === 'object' && manifest !== null
      ? (manifest as { version?: unknown }).version
      : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${VERSION_SOURCE} has no version.`);
  }
  return version;
}

/** Replace what sits between one kind's markers, and nothing else. */
function replaceBlockOfKind(
  kind: string,
  path: string,
  contents: string,
  render: () => string,
): string {
  const start = `<!-- ${kind}:start -->`;
  const end = `<!-- ${kind}:end -->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(contents)) {
    throw new Error(`${path} is missing the ${start} / ${end} markers.`);
  }
  return contents.replace(pattern, `${start}${render()}${end}`);
}

export function replaceCoverageBlock(path: string, contents: string): string {
  const render = () =>
    path.endsWith('.md')
      ? `\n${renderReadmeTable(MANIFESTS)}\n`
      : `\n${renderSiteTable(MANIFESTS, SITE_DOCS_BASE_URL)}\n`;
  return replaceBlockOfKind('coverage', path, contents, render);
}

/**
 * The version block carries no whitespace: it sits inline in the title plate,
 * where a newline would print as a space before the number.
 */
export function replaceVersionBlock(path: string, contents: string): string {
  return replaceBlockOfKind('version', path, contents, publishedVersion);
}

/** Every published file, and every block this script owns inside it. */
export const GENERATED: readonly { path: string; replace: (contents: string) => string }[] = [
  {
    path: 'README.md',
    replace: (contents) => replaceCoverageBlock('README.md', contents),
  },
  {
    path: 'site/index.html',
    replace: (contents) =>
      replaceVersionBlock(
        'site/index.html',
        replaceCoverageBlock('site/index.html', contents),
      ),
  },
];

// Only write when run directly, so the test can import the helpers.
if (process.argv[1]?.endsWith('generated-blocks.ts')) {
  for (const target of GENERATED) {
    const current = readFileSync(target.path, 'utf8');
    const updated = target.replace(current);
    if (updated === current) {
      process.stdout.write(`${target.path} is already up to date.\n`);
    } else {
      writeFileSync(target.path, updated);
      process.stdout.write(`${target.path} regenerated.\n`);
    }
  }
}
