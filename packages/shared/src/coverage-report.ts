import {
  summarise,
  type CoverageManifest,
  type CoverageStatus,
} from './coverage.js';

/**
 * Rendering coverage manifests.
 *
 * Lives in shared so the CLI, the docs generator and the README summary all
 * read the same numbers from the same place. A figure published on the repo
 * page that came from a different source than the one the drift test checks
 * would be exactly the kind of claim this whole mechanism exists to prevent.
 */

export interface CoverageRow {
  id: string;
  label: string;
  basePath: string;
  docs: string;
  total: number;
  compatible: number;
  partial: number;
  emulatorOnly: number;
}

export function toRows(manifests: readonly CoverageManifest[]): CoverageRow[] {
  return manifests.map((manifest) => {
    const summary = summarise(manifest);
    return {
      id: manifest.id,
      label: manifest.label,
      basePath: manifest.basePath,
      docs: manifest.docs,
      ...summary,
    };
  });
}

/**
 * The Markdown table the README carries.
 *
 * Generated rather than written, so the counts on the repo's front page are
 * the ones the drift test enforces. Every adapter reads **Partial** overall,
 * because every one of them is -- a per-endpoint status of `compatible` says
 * that endpoint behaves as the provider's does, not that the adapter is
 * finished.
 */
export function renderReadmeTable(manifests: readonly CoverageManifest[]): string {
  const rows = toRows(manifests);
  const lines = [
    '| Provider | Base path | Endpoints | Coverage |',
    '|---|---|---|---|',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.label} | \`${row.basePath}\` | ${row.total} | **Partial** — [what works](${row.docs}) |`,
    );
  }
  return lines.join('\n');
}

/** One line per adapter, for `paybox coverage`. */
export function renderSummaryLine(row: CoverageRow): string {
  return (
    `${row.label.padEnd(16)} ${String(row.total).padStart(3)} endpoints  ` +
    `(${row.compatible} compatible, ${row.partial} partial, ${row.emulatorOnly} emulator-only)`
  );
}

/** Endpoints of one status, formatted for the CLI's detail view. */
export function entriesByStatus(
  manifest: CoverageManifest,
  status: CoverageStatus,
): { endpoint: string; note: string | null }[] {
  return manifest.entries
    .filter((entry) => entry.status === status)
    .map((entry) => ({
      endpoint: `${entry.method} ${manifest.basePath}${entry.path}`,
      note: entry.note ?? null,
    }));
}

/** HTML-escape a value that goes into generated markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The same table, as HTML, for the landing page in `site/`.
 *
 * The landing page is deployed on its own and cannot resolve the repository's
 * relative `docs/*.md` links, so each row's contract link is absolutised
 * against `docsBaseUrl`. Generated for the same reason the README's table is:
 * the front page a visitor reads first must not be able to claim an endpoint
 * the router does not serve. `npm run generate` writes both, and
 * `tests/coverage-drift.test.ts` fails on either being stale.
 */
export function renderSiteTable(
  manifests: readonly CoverageManifest[],
  docsBaseUrl: string,
): string {
  const rows = toRows(manifests);
  const base = docsBaseUrl.replace(/\/+$/, '');
  const lines = [
    '<table>',
    '  <thead>',
    '    <tr><th scope="col">Provider</th><th scope="col">Base path</th>' +
      '<th scope="col">Endpoints</th><th scope="col">Coverage</th></tr>',
    '  </thead>',
    '  <tbody>',
  ];
  for (const row of rows) {
    lines.push(
      `    <tr><th scope="row">${escapeHtml(row.label)}</th>` +
        `<td><code>${escapeHtml(row.basePath)}</code></td>` +
        `<td class="num">${row.total}</td>` +
        `<td><span class="pill">Partial</span> ` +
        `<a href="${escapeHtml(`${base}/${row.docs}`)}">what works</a></td></tr>`,
    );
  }
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  lines.push('  </tbody>');
  lines.push('</table>');
  lines.push(
    `<p class="note">${total} endpoints across ${rows.length} adapters, ` +
      'counted from the manifests the test suite checks against the router.</p>',
  );
  return lines.join('\n');
}
