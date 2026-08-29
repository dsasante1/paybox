#!/usr/bin/env node
// Proves the *artifact* works, not the source tree.
//
// `npm test` exercises the code through the workspace symlinks, with every
// devDependency present. None of that says whether `npx paybox-emulator start`
// works on a machine that has nothing but Node. This does: it packs
// apps/paybox exactly as `npm publish` would, installs the tarball into an
// empty directory with production dependencies only, and drives the `paybox`
// binary that install produced -- `--version`, a real `start` on an in-memory
// database until /api/health answers, then `status` through the CLI client.
//
// It also asserts the launcher kept node:sqlite's ExperimentalWarning off
// stderr, which only means anything on Node 22 -- which is why CI runs this on
// the 22 lane as well as 24.
//
// Timers and the wall clock are fine here: this is a test harness around a
// child process, not emulator code (eslint's determinism rules apply to *.ts).

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(root, 'apps', 'paybox');
const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

if (!existsSync(path.join(packageDir, 'dist', 'paybox.js'))) {
  console.error('smoke: apps/paybox/dist is missing -- run `npm run build` first');
  process.exit(1);
}

const work = mkdtempSync(path.join(tmpdir(), 'paybox-smoke-'));
const step = (label) => console.log(`smoke: ${label}`);

try {
  step('packing apps/paybox');
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '-w', 'apps/paybox', '--pack-destination', work, '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
  const tarball = path.join(work, packed.filename);

  step(`installing ${packed.filename} into an empty project`);
  writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({ name: 'paybox-smoke', private: true }),
  );
  execFileSync(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const bin = path.join(work, 'node_modules', '.bin', 'paybox');

  step('paybox --version');
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  if (version !== manifest.version) {
    throw new Error(`--version printed "${version}", package.json says "${manifest.version}"`);
  }

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  step(`paybox start --database :memory: --port ${port}`);
  // cwd is the scratch project: no paybox.yml there, so the start is config-free.
  const server = spawn(bin, ['start', '--database', ':memory:', '--port', String(port)], {
    cwd: work,
    env: { ...process.env, PAYBOX_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  server.stdout.on('data', (chunk) => (stdout += chunk));
  server.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => server.on('exit', (code) => resolve(code)));

  try {
    await waitFor(async () => {
      const response = await fetch(`${url}/api/health`).catch(() => null);
      return response?.ok === true;
    }, 20_000, () => server.exitCode !== null);

    step('paybox status against the running server');
    execFileSync(bin, ['status', '--url', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } finally {
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }

  if (!stdout.includes('paybox — local payment emulator')) {
    throw new Error(`the start banner did not print. stdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (/ExperimentalWarning/.test(stderr)) {
    throw new Error(`the launcher let an ExperimentalWarning through:\n${stderr}`);
  }

  console.log(`smoke: ok -- ${packed.filename} installs and runs on Node ${process.versions.node}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check, timeoutMs, gaveUp) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (gaveUp()) throw new Error('the server exited before it became healthy');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the server did not answer /api/health within ${timeoutMs}ms`);
}
