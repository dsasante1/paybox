# Changelog

What each published version of `paybox-emulator` (npm) and `dsasante1/paybox`
(Docker Hub, mirrored to GHCR) shipped, newest first. A release is a tag:
merging to `main` publishes nothing, and everything under **Unreleased** goes
out with the next tag — see [docs/releasing.md](docs/releasing.md).

## 0.3.0 — 2026-09-20

- **An eighth provider: Tingg** (Cellulant) — `/tingg`, 11 endpoints,
  [contract](docs/tingg.md). Two APIs served from one prefix: Checkout 3.0
  (OAuth2 bearer *plus* an `apiKey` header, REST, `snake_case`) and Payouts
  (BEEP — credentials in the request body, RPC on a `function` field,
  `camelCase`). They share almost nothing, but a real client points one base
  URL at `api.tingg.africa` and calls both, so prefix follows what a client
  targets rather than how different the APIs are. Express and custom checkout,
  the mobile-money prompt, query, acknowledgement, refunds, and five BEEP
  functions including a float balance folded from the same ledger a payout
  reserves against. No card rail: Tingg documents `source_Of_funds` only as an
  "encrypted string", and guessing the scheme would mean inventing the one
  thing a developer's encryption code has to match exactly.
- **A 2xx is no longer assumed to mean "delivered".**
  `WebhookFormatter.interpretResponse` lets an adapter decide what a
  subscriber's response actually meant. Tingg reads a `status_code` out of the
  response **body** — 183, 180 or 188 — and re-posts until it sees one, so an
  integration answering a bare `200 OK` is correct against every other
  provider here and gets re-posted for twenty-four hours in production. The
  hook is consulted only after the HTTP layer already succeeded, so no
  formatter can mark a 500 or a timeout delivered. Absent, behaviour is
  unchanged.
- **A formatter can carry its own retry ladder** (`WebhookFormatter.retry`).
  Tingg's is a flat 30 seconds bounded by elapsed time rather than attempt
  count; paybox runs the same interval and caps at 20 attempts instead of
  2,880, with both figures stated in its contract. The global switch still
  wins, so turning retries off turns them off everywhere.
- **A webhook can name its own destination** (`FormattedWebhook.deliverTo`).
  Tingg has no dashboard-registered callback address — it arrives per request —
  so two concurrent checkouts can legitimately name two URLs, and neither may
  receive the other's notification.
- **A seventh provider: Quid Payments** (`/quiddpay`, 36 endpoints,
  [contract](docs/quiddpay.md)). The first hosted-checkout adapter here: a
  merchant creates a session, redirects the payer to `checkout_url` and waits
  for a signed webhook, so the emulator serves the **public checkout API** the
  hosted page itself calls as well as the merchant one. Mobile money, bank
  transfer and cash deposit slips; invoice lines and service codes; payouts
  with recipients, quotes, a ledger-folded balance and PDF receipts; and
  Quid's own published test endpoint for settling a rail no teller can
  confirm locally. There are no card payments, because Quid has none.
  Transcribed from Quid's published OpenAPI document (contract `2026-06`).
- `PaymentMethod` gains **`cash`**. A payer handing notes to a teller against
  a deposit slip debits no account of theirs, so none of the existing members
  described it.
- **Every list query now sorts on a second, unique column.** `created_at` is
  not unique under a frozen clock — every row written in one operation shares a
  timestamp to the millisecond — so twenty-eight queries were leaving SQLite
  free to return tied rows in any order it liked. That broke determinism for
  anything reading a list, and broke `LIMIT`/`OFFSET` paging outright once a
  tie spanned a page boundary. Tiebreaker is `sequence` for `events`, `jobs`
  and `balance_ledger`, `id` elsewhere.
- **Wise's seeded profiles are ordered explicitly**, so `GET /v2/profiles`
  answers the same way whether the pair was just created or read back from
  storage. The two paths previously agreed only by coincidence.

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
