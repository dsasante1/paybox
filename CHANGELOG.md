# Changelog

What each published version of `paybox-emulator` (npm) and `dsasante1/paybox`
(Docker Hub, mirrored to GHCR) shipped, newest first. A release is a tag:
merging to `main` publishes nothing, and everything under **Unreleased** goes
out with the next tag — see [docs/releasing.md](docs/releasing.md).

## 0.2.1 — 2026-08-31

- The `/docs` API reference lists **every route the emulator serves**,
  generated from the coverage manifests the test suite enforces against the
  router — grouped per adapter, each entry carrying its coverage status and a
  pointer to its contract. Schemas remain hand-transcribed only (#31).

## 0.2.0 — 2026-08-31

- **Flutterwave v4 webhooks** are delivered in v4's
  `{webhook_id, timestamp, type, data}` envelope, signed with
  `flutterwave-signature`, chosen per the resource that created them;
  v3-created resources keep `verif-hash`. Emulator-internal keys no longer
  leak into echoed `meta` (#25, #28).
- **Webhook endpoint secrets default per provider** — `whsec_…` for Stripe
  and WeWire, the provider's own local key otherwise — instead of the
  Paystack key for every provider, and an unknown provider is refused with
  400. The dashboard's endpoint form asks which provider and which secret,
  with click-to-copy (#24, #27).
- **`/docs` renders the Scalar API reference** — self-hosted, works offline —
  instead of a pretty-printed JSON dump; three declared-but-unused
  dependencies removed (#26, #27).
- **Ctrl+C announces shutdown, and a second Ctrl+C force-quits** instead of
  waiting out a blocked close (#29).
- Fixes from an end-to-end pass: reset atomicity, the clock's refusal to
  rewind, scenario-step edge cases, transfer-reference uniqueness, and
  adapter-contract gaps (#22).
- The user documentation set: concepts, configuration, control-API reference,
  test instruments, payment lifecycle, time control, per-provider integration
  guide, testing/CI guide, dashboard, troubleshooting (#23).

## 0.1.2 — 2026-08-30

- One version number is stamped into the API as well as the CLI, so
  `/api/health` and `paybox --version` agree (#19).

## 0.1.1 — 2026-08-30

- The first complete release: the `paybox-emulator` npm package (bundled
  launcher, Node ≥ 22.5, no native addons) and the `dsasante1/paybox` image
  (amd64 + arm64, also pushed to GHCR), published from a `v*` tag by one
  workflow (#17, #18).

## 0.1.0 — 2026-08-29

- Published to npm, but its release run did not complete: there is no 0.1.0
  image and no GitHub Release. Superseded by 0.1.1 within hours; recorded
  here because npm versions are immutable and it remains installable.
