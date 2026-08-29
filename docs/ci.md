# CI and merge safety

## What runs

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

```
npm ci  →  npm run typecheck  →  npm run lint  →  npm test
```

on **Node 22 and Node 24**, with `fail-fast: false` so a failure reports every
affected version rather than just the first.

The matrix is not decoration. Its first run caught a real difference: on Node
22.5.0 exactly, typecheck and lint passed but the test runner could not start —
Vitest's `rolldown` binding falls back to a `wasm32-wasi` build that is not
installed. That is a dev-toolchain limit rather than a paybox one, so the
`>=22.5.0` floor in `package.json` still stands, and the matrix tests the
latest 22.x instead.

Running that suite is what makes the other guarantees real. The coverage
contract (`tests/coverage-drift.test.ts`) and the determinism rules
(`eslint.config.js`) only protect anything if something runs them.

## What is *not* enforced, and why

**GitHub cannot block a red merge on this repo.** Branch protection and
rulesets both return:

```
403  Upgrade to GitHub Pro or make this repository public to enable this feature.
```

The repository is private on a free plan, which gates both. So CI *reports*
failures; it does not *prevent* anyone merging past them.

Two ways to close that properly, whenever it is worth it:

| | What it costs | What you get |
| --- | --- | --- |
| Make the repository public | Nothing, if the code can be public | Branch protection and rulesets, free |
| GitHub Pro | A few dollars a month | The same, staying private |

Either one, then: **Settings → Branches → Add rule** on `main`, require the
status checks `verify (node 22)` and `verify (node 24)`, and tick *"Do not
allow bypassing the above settings"* — without that last box an admin can still
merge red, which is most of the gap.

Deliberately **not** recommended on a solo repo: *require pull request
reviews*. With one contributor it only means reaching for `--admin` to get past
it, and a rule everyone routinely bypasses is worse than no rule, because it
teaches you to ignore the ones that matter.

## What guards this repo today

Client-side, because that is what is available. Both are **guards, not gates** —
each can be bypassed, deliberately, by someone who means to.

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
