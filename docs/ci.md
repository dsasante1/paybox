# CI and merge safety

## What runs

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

```
npm ci  →  typecheck  →  lint  →  test  →  build  →  package smoke test
```

on **Node 22 and Node 24**, with `fail-fast: false` so a failure reports every
affected version rather than just the first.

The last two steps are about the artifact rather than the source. `npm run
build` bundles `apps/paybox` and fails if its dependency list disagrees with
what the bundle actually imports; `npm run smoke:package` installs the packed
tarball into an empty directory and drives the `paybox` binary it produced.
Everything before them tests the source tree through workspace symlinks with
every devDependency present; the smoke test is the only step that tests what
`npx paybox-emulator` hands a developer.

A second job, `image`, builds `docker/Dockerfile`, boots the result, waits for
`/api/health` and runs the CLI inside the container. The Dockerfile once went
stale without anyone noticing — it listed the workspace manifests to copy by
hand and stopped at one provider of five — because nothing built it. It is not
in the matrix: the image pins its own Node.

The matrix is not decoration. Its first run caught a real difference: on Node
22.5.0 exactly, typecheck and lint passed but the test runner could not start —
Vitest's `rolldown` binding falls back to a `wasm32-wasi` build that is not
installed. That is a dev-toolchain limit rather than a paybox one, so the
`>=22.5.0` floor in `package.json` still stands, and the matrix tests the
latest 22.x instead.

Running that suite is what makes the other guarantees real. The coverage
contract (`tests/coverage-drift.test.ts`) and the determinism rules
(`eslint.config.js`) only protect anything if something runs them.

## What GitHub enforces

`main` is protected. A pull request cannot merge until `verify (node 22)` and
`verify (node 24)` have passed; force-pushes to `main` and deletion of it are
refused; and *"Do not allow bypassing the above settings"* is on, so the rule
binds administrators too — without that box an admin can still merge red,
which is most of the gap.

Deliberately **off**: *require pull request reviews*. On a solo repo it only
means reaching for `--admin` to get past it, and a rule everyone routinely
bypasses is worse than no rule, because it teaches you to ignore the ones that
matter.

This was not always available. Branch protection needs a public repository or
a paid plan, and this one was private on a free plan until it was opened up;
the two client-side guards below date from then and remain worth having.

Releases are a separate workflow: a `v*` tag runs
`.github/workflows/release.yml`, which repeats the full verification before it
publishes anything. See [releasing.md](releasing.md).

## What else guards this repo

Client-side, and older than the protection above. Both are **guards, not
gates** — each can be bypassed, deliberately, by someone who means to.

### `npm run ship -- <pr>`

Merges a pull request only if every check has actually passed. Refuses a PR
that is draft, conflicting, still running, failing, or — the case worth
catching — has **no checks at all**, which looks mergeable and has verified
nothing.

```
npm run ship -- 13
npm run ship -- 13 --squash
```

`gh pr merge` still works and still bypasses this. The point is to make the
safe path the easy one and the bypass a decision rather than a default.

### The `pre-push` hook

`.githooks/pre-push` refuses a direct push to `main`, so changes go through a
pull request where CI can see them. `npm install` points git at it via
`core.hooksPath`; a fresh clone gets it on first install.

This exists because a force-push to `main` did happen on this repo. Recovering
was straightforward — but only because someone noticed at the time.

`git push --no-verify` bypasses it. If you need that, say why in the commit or
the pull request.
