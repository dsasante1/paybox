# Releasing

A release is a tag. Everything after the tag is `.github/workflows/release.yml`.

## Cutting one

```bash
# 1. Bump the version. One field, one file.
npm version 0.2.0 --workspace apps/paybox --no-git-tag-version

# 2. Land it through a pull request like any other change: main is protected.

# 3. Tag the merged commit and push the tag.
git checkout main && git pull
git tag v0.2.0
git push origin v0.2.0
```

The tag must equal the version in `apps/paybox/package.json`; the workflow
checks that before it runs anything else and refuses a mismatch. If that
happens, fix the version, delete the tag (`git push --delete origin v0.2.0`,
`git tag -d v0.2.0`) and tag again.

## What the tag sets in motion

```
verify ──┬── publish to npm ────┬── github release
         └── publish image ─────┘
```

**verify** repeats CI on Node 22 — typecheck, lint, the test suite, `npm run
build` and `npm run smoke:package` — then packs the tarball. It also refuses
to continue if the Docker Hub variable below is missing, so a half-configured
repository fails in seconds rather than after the long steps.

**publish to npm** publishes `paybox-emulator@<version>` with provenance,
using trusted publishing: the workflow's own OIDC identity is the credential,
so there is no token to store, rotate or leak. There is deliberately no token
path in the workflow at all.

**publish image** builds `docker/Dockerfile` for `linux/amd64` and
`linux/arm64` and pushes it to **Docker Hub** as `<DOCKERHUB_IMAGE>` tagged
`<version>`, `<major>.<minor>` and `latest`, then refreshes the Docker Hub
overview from `apps/paybox/README.md`. The same manifest is also pushed to
`ghcr.io/dsasante1/paybox` under the same tags — free, no setup, and an
address without Docker Hub's anonymous pull limit for anyone whose CI hits it.

**github release** runs last, and only if both publishes succeeded: a Release
named after the tag, with generated notes and the npm tarball attached. A
release page therefore never describes a version that cannot be installed.

Versions on npm are immutable. If the image push fails after npm succeeded,
use *Re-run failed jobs* on the workflow run — a full re-run would fail at npm
with "version already exists".

Check a release from the outside:

```bash
npm view paybox-emulator version
npm audit signatures            # in a project that depends on it: verifies the provenance
docker buildx imagetools inspect dsasante1/paybox:0.2.0   # both platforms listed
```

## One-time setup

### npm: publish the first version by hand

A trusted publisher is configured on the package's settings page at npmjs.com,
so the package has to exist before the workflow can publish it. The first
release is therefore manual, from a machine logged in to npm with 2FA:

```bash
npm run build
npm run smoke:package
npm publish --workspace apps/paybox --access public
```

Then, on npmjs.com: **paybox-emulator → Settings → Trusted publisher → GitHub
Actions**, with organisation `dsasante1`, repository `paybox`, workflow
`release.yml`, environment blank; allow `npm publish` only. Under *Publishing
access*, choose *Require two-factor authentication and disallow bypass 2fa
tokens*: the trusted publisher works regardless, and the setting removes the
only other way a publish could happen without a person present. From the next
tag on, the workflow publishes without a token and provenance is attached
automatically (npm ≥ 11.5.1 does this under OIDC; `--provenance` is not
needed and `publishConfig.provenance` is deliberately *not* set, because it
would break the manual publish above).

### Docker Hub: an account, a token, three settings

1. A Docker Hub account. The Docker ID is the namespace in the image name
   (`dsasante1` → `dsasante1/paybox`), so match the GitHub name. Turn on 2FA.
2. A personal access token: **Account settings → Personal access tokens →
   Generate**, scope **Read, Write, Delete**. Pushing needs read/write; the
   step that refreshes the Docker Hub overview page needs delete as well,
   and with a narrower token it fails quietly and the page stays blank. Note
   the token's expiry; when it lapses the image job fails at login and
   nothing else is affected.
3. On this repository, **Settings → Secrets and variables → Actions**:

| Tab | Name | Value |
| --- | --- | --- |
| Variables | `DOCKERHUB_IMAGE` | `dsasante1/paybox` |
| Secrets | `DOCKERHUB_USERNAME` | the Docker ID |
| Secrets | `DOCKERHUB_TOKEN` | the access token |

The image name is a variable rather than a secret because it is not one, and
because the workflow needs to read it in places secrets cannot be read.

The Docker Hub repository itself does not need creating: the first push
creates it, public, under your namespace. Create it by hand first only if you
want the description in place before the first release lands.

### GHCR: make the package public once

Nothing is needed for the push — `GITHUB_TOKEN` with `packages: write` is
enough, and the image is linked to this repository through its
`org.opencontainers.image.source` label. The first push creates the package
**private**, so the GHCR address will need a login until it is opened:

**github.com → your profile → Packages → paybox → Package settings → Change
visibility → Public.** Once.

### Who can release

Anyone who can push a `v*` tag can publish. On a solo repository that is one
person; before adding collaborators, add a tag ruleset (**Settings → Rules →
Rulesets → New tag ruleset** on `v*`) restricting creation to maintainers, so
that write access to branches does not silently include the ability to
publish to npm and Docker Hub under the project's name.
