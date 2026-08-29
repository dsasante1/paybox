/**
 * Baked in by `scripts/build.mjs` from `apps/paybox/package.json`, so the
 * published package has exactly one version number and `paybox --version`
 * reports it. The dev loop (`npm run cli`) has no build step and reports a
 * marker instead of pretending to be a release.
 */
declare const __PAYBOX_VERSION__: string | undefined;

export const VERSION: string =
  typeof __PAYBOX_VERSION__ === 'string' ? __PAYBOX_VERSION__ : '0.0.0-dev';
