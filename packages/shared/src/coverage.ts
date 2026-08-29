/**
 * Coverage manifests (spec §31).
 *
 * `docs/<provider>.md` calls itself "a contract, not marketing". Until now
 * that was a convention held up by care alone: nothing checked that the
 * endpoint tables matched the routes actually registered, so a route added
 * without a doc row -- or a row left behind after a route was removed -- would
 * go unnoticed until someone trusted the file and was wrong.
 *
 * A manifest makes the claim machine-checkable. Each adapter declares exactly
 * what it serves, `tests/coverage-drift.test.ts` asserts the declaration and
 * the router agree in both directions, and the docs tables and the README
 * summary are generated from the same source. A number that comes from the
 * routes cannot drift from the routes.
 *
 * What stays in Markdown is the part worth writing by hand: *why* something is
 * partial, and what differs from the real provider. That prose is the valuable
 * half of a coverage contract and does not belong in a data structure.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * How faithfully one endpoint is emulated.
 *
 *   compatible     Behaves as the provider's does, within what paybox models.
 *   partial        Real, with a documented limitation. `note` must say what.
 *   emulator-only  Has no provider counterpart -- a hosted page, or a hook
 *                  that exists because the flow would otherwise be untestable
 *                  locally. Must never be presented as provider surface.
 */
export type CoverageStatus = 'compatible' | 'partial' | 'emulator-only';

export interface CoverageEntry {
  method: HttpMethod;
  /**
   * The path as registered on the plugin, **relative to its prefix**.
   *
   * Relative rather than public so the manifest can be compared to what
   * Fastify reports without every entry repeating a prefix that is configured
   * elsewhere. Parameters use the router's own `:name` form.
   */
  path: string;
  status: CoverageStatus;
  /**
   * A one-line reason, for the CLI's benefit.
   *
   * Optional by design: the full explanation of *why* something is partial
   * belongs in the manifest's `docs` file, and duplicating it here would give
   * it two homes and let the two disagree.
   */
  note?: string;
}

export interface CoverageManifest {
  /** The provider this covers, plus an API version where one has several. */
  id: string;
  /** Human label for the README and the CLI. */
  label: string;
  /** Where the plugin is mounted, for turning a relative path into a real one. */
  basePath: string;
  /** The documentation file that carries the prose for this manifest. */
  docs: string;
  entries: readonly CoverageEntry[];
}

/** Counts by status, for a summary line. */
export interface CoverageSummary {
  total: number;
  compatible: number;
  partial: number;
  emulatorOnly: number;
}

export function summarise(manifest: CoverageManifest): CoverageSummary {
  const count = (status: CoverageStatus): number =>
    manifest.entries.filter((entry) => entry.status === status).length;
  return {
    total: manifest.entries.length,
    compatible: count('compatible'),
    partial: count('partial'),
    emulatorOnly: count('emulator-only'),
  };
}

/** `GET /v1/charges` — the form both the docs table and the drift test use. */
export function formatEntry(entry: CoverageEntry): string {
  return `${entry.method} ${entry.path}`;
}

/**
 * Normalise a path for comparison.
 *
 * Router parameters are compared by position, not by name: `/charges/:id` and
 * `/charges/:reference` address the same endpoint, and a manifest that had to
 * match the parameter's spelling would fail for a rename that changed nothing.
 * Trailing slashes are insignificant.
 */
export function normalisePath(path: string): string {
  const withoutParams = path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':x');
  const trimmed = withoutParams.replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : '/';
}

export function entryKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalisePath(path)}`;
}
