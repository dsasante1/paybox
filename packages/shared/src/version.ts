/**
 * The version everything reports: `paybox --version`, `/api/health`, the
 * OpenAPI document. Baked in by `scripts/build.mjs` from
 * `apps/paybox/package.json`, so the published package has exactly one
 * version number and no file can drift from it. The dev loop (`npm start`,
 * `npm run cli`) has no build step and reports a marker instead of
 * pretending to be a release.
 *
 * Lives in `shared` because both the API and the CLI need it, and the CLI
 * must not import the API statically -- it loads the server lazily so that
 * `paybox status` does not pay for every provider adapter.
 */
declare const __PAYBOX_VERSION__: string | undefined;

export const VERSION: string =
  typeof __PAYBOX_VERSION__ === 'string' ? __PAYBOX_VERSION__ : '0.0.0-dev';
