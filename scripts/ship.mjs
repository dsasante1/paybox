#!/usr/bin/env node
/**
 * Merge a pull request only if CI actually passed.
 *
 * Branch protection would enforce this on GitHub's side, but it needs a public
 * repo or a paid plan — see docs/ci.md. Until then the merge path is a person
 * typing `gh pr merge`, and nothing stops them typing it on a red PR. This
 * closes that for the way merges actually happen here.
 *
 * It is a guard, not a gate: anyone can still bypass it by calling `gh pr
 * merge` directly. That is worth being honest about rather than pretending
 * otherwise — the point is to make the safe path the easy one, and to make
 * bypassing it a deliberate act.
 *
 *   npm run ship -- 13
 *   npm run ship -- 13 --squash
 */
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const number = argv.find((a) => /^\d+$/.test(a));
const method =
  argv.find((a) => ['--merge', '--squash', '--rebase'].includes(a)) ?? '--merge';

if (!number) {
  process.stderr.write('Usage: npm run ship -- <pr-number> [--merge|--squash|--rebase]\n');
  process.exit(2);
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function fail(message) {
  process.stderr.write(`\n  ✗ ${message}\n\n`);
  process.exit(1);
}

let pr;
try {
  pr = JSON.parse(
    gh([
      'pr',
      'view',
      number,
      '--json',
      'number,title,state,isDraft,mergeable,statusCheckRollup,baseRefName,headRefName',
    ]),
  );
} catch {
  fail(`Could not read PR #${number}. Is gh authenticated for this repo?`);
}

process.stdout.write(`\n  PR #${pr.number}  ${pr.headRefName} → ${pr.baseRefName}\n`);
process.stdout.write(`  ${pr.title}\n\n`);

if (pr.state !== 'OPEN') fail(`PR #${number} is ${pr.state}, not open.`);
if (pr.isDraft) fail(`PR #${number} is a draft.`);
if (pr.mergeable === 'CONFLICTING') fail(`PR #${number} has conflicts with ${pr.baseRefName}.`);

const checks = (pr.statusCheckRollup ?? []).filter(
  // Only completed check runs and statuses carry a verdict worth gating on.
  (check) => check.__typename !== 'StatusContext' || check.state,
);

if (checks.length === 0) {
  // A PR with no checks at all is the exact situation this exists to catch:
  // it looks mergeable and nothing has verified it.
  fail(
    `PR #${number} has no status checks. If CI should have run, find out why ` +
      `before merging.`,
  );
}

const failed = [];
const pending = [];
for (const check of checks) {
  const name = check.name ?? check.context ?? 'check';
  const verdict = check.conclusion ?? check.state ?? check.status ?? 'UNKNOWN';
  const ok = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(verdict).toUpperCase());
  const waiting = ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED'].includes(
    String(verdict).toUpperCase(),
  );
  const mark = ok ? '✓' : waiting ? '…' : '✗';
  process.stdout.write(`    ${mark} ${name}  ${String(verdict).toLowerCase()}\n`);
  if (waiting) pending.push(name);
  else if (!ok) failed.push(name);
}

process.stdout.write('\n');
if (failed.length > 0) fail(`Not merging: ${failed.join(', ')} did not pass.`);
if (pending.length > 0) fail(`Not merging: ${pending.join(', ')} still running.`);

process.stdout.write(`  All checks green. Merging with ${method.replace('--', '')}…\n`);
gh(['pr', 'merge', number, method]);
process.stdout.write(`  ✓ PR #${number} merged.\n\n`);
