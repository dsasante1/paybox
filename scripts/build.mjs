#!/usr/bin/env node
// Builds the publishable package, apps/paybox.
//
// The workspace packages export TypeScript source (`./src/index.ts`) and are
// private, which is right for the dev loop -- tsx and Vitest resolve it
// directly, no build step -- but means none of them can be installed from
// npm. This script bundles the CLI entry point, and through its lazy import
// the server and every provider adapter, into one ESM file that plain `node`
// can run: apps/paybox/dist/paybox.js.
//
// Only the @paybox/* workspace code is bundled. Third-party packages stay as
// ordinary imports and are listed as `dependencies` of apps/paybox, so npm
// installs them the normal way and their own file layouts are undisturbed.
// That list is checked, not trusted: after the bundle is written, every
// external import esbuild recorded must be declared, and every declared
// dependency must actually be imported. Either mismatch fails the build --
// the same either-direction rule tests/coverage-drift.test.ts applies to the
// provider manifests, for the same reason. A dependency missing here would
// surface only as a crash on the developer's machine after `npx`.

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(root, 'apps', 'paybox');
const entry = path.join(root, 'apps', 'cli', 'src', 'main.ts');
const outfile = path.join(packageDir, 'dist', 'paybox.js');

const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

/**
 * Anything with the `node:` scheme is Node's, whatever version is running
 * this. That matters for `node:sqlite`: it has no bare `sqlite` alias, and on
 * Node 22 `builtinModules` does not list it, so a check built from that list
 * reports the storage layer's one import as an undeclared dependency.
 */
const isNodeBuiltin = (specifier) => specifier.startsWith('node:') || isBuiltin(specifier);

/** Bare specifier -> package name: `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every third-party package the bundle imports, as recorded while resolving. */
const externals = new Set();

const bundleWorkspaceOnly = {
  name: 'bundle-workspace-only',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      if (args.path.startsWith('@paybox/')) return null;
      if (!isNodeBuiltin(args.path)) externals.add(packageName(args.path));
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  plugins: [bundleWorkspaceOnly],
  define: { __PAYBOX_VERSION__: JSON.stringify(manifest.version) },
  legalComments: 'none',
  logLevel: 'warning',
});

const declared = new Set(Object.keys(manifest.dependencies ?? {}));
const missing = [...externals].filter((name) => !declared.has(name)).sort();
const unused = [...declared].filter((name) => !externals.has(name)).sort();

if (missing.length > 0 || unused.length > 0) {
  const relative = path.relative(root, path.join(packageDir, 'package.json'));
  for (const name of missing) {
    console.error(`build: the bundle imports "${name}" but ${relative} does not declare it`);
  }
  for (const name of unused) {
    console.error(`build: ${relative} declares "${name}" but nothing in the bundle imports it`);
  }
  console.error(
    '\nThe published package installs exactly what that file declares. Add or remove the entry.',
  );
  process.exit(1);
}

// npm only ships a LICENSE it finds inside the package directory.
mkdirSync(path.dirname(outfile), { recursive: true });
copyFileSync(path.join(root, 'LICENSE'), path.join(packageDir, 'LICENSE'));

const kib = Math.round(statSync(outfile).size / 1024);
console.log(
  `build: ${manifest.name}@${manifest.version} -> ${path.relative(root, outfile)} (${kib} KiB, ${externals.size} external packages)`,
);
