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
