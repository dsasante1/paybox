# Changelog

What each published version of `paybox-emulator` (npm) and `dsasante1/paybox`
(Docker Hub, mirrored to GHCR) shipped, newest first. A release is a tag:
merging to `main` publishes nothing, and everything under **Unreleased** goes
out with the next tag — see [docs/releasing.md](docs/releasing.md).

## 0.5.0 — 2026-10-11

- **Bachs: Connect, part three**
  ([contract](docs/bachs.md#checkout-settings)).
  - **Checkout settings:** `/v1/accounts/checkout/settings`, per owner. These
    set which methods a checkout offers, and `fee_preference`.
    `customer_pays` adds the processing fee on top: a `29.00` charge on a USD
    card is `30.85`, and the merchant settles `29.00`.
  - **Listings:** `/v1/payment-methods`, `/v1/payment-methods/rails` and
    `/v1/currencies/supported`.
  - `POST /v1/charges` is now fully compatible.

- **Bachs: Connect, part two**
  ([contract](docs/bachs.md#split-payments)).
  - **Split payments:** a direct charge with a `platform_fee`, and destination
    charges (`transfer_data`), fee-first or share-first. The seller's share is
    sent as a `kind: payout` transfer when the sale settles.
  - **Platform fees:** `/v1/platform_fees`, readable by either party.
  - **Transfers:** `/v1/transfers` between a platform and its accounts,
    including `destination: "self"` for an account sending money back.
  - **Fees:** `fee_paid_by` and `settlement_amount` follow who actually paid
    the processing fee.
  - **New webhook:** `transfer.created`, on the account involved.

- **Bachs: Connect, part one**
  ([contract](docs/bachs.md#how-connect-behaves)).
  - **Accounts:** connected accounts, persons, company and person documents,
    capabilities, requirements, and onboarding links with paybox's onboarding
    page. paybox's review controls stand in for Bachs' reviewers.
  - **`X-Account-Id`:** runs any request as a connected account. Everything an
    owner creates (products, customers, checkouts, payments, refunds,
    disputes, payouts, destinations, schedules, conversions, the virtual
    account, uploads, webhook endpoints) is its own, and its balance is too.
  - **Direct charges:** a checkout created as an account is a direct charge,
    paid into the account's balance.
  - **Webhooks:** `account.updated` and `capability.updated` are new. An
    account's events carry it as `organization_id` and `account`, and reach
    the platform's `event_source: connect` endpoints.
  - Split payments, platform fees and transfers come next.
- **Customers are unique per owner, not per provider** (migration 0024). This
  changes nothing for providers without connected accounts.

- **Bachs: disputes**, the fourth phase of its API
  ([contract](docs/bachs.md#how-disputes-behave)).
  - **Disputes:** list, get, save evidence (`409 DISPUTE_NOT_EDITABLE`,
    `410 DEADLINE_PASSED`) and submit.
  - **Money:** the $15 fee is taken when a dispute opens, and the disputed amount
    is set aside until the ruling. A loss keeps it and can take the balance
    negative, which blocks payouts. A refund before the ruling prevents the
    dispute.
  - **Early dispute warnings:** a $29 fee, once per payment.
  - **Uploads:** dispute documents and general uploads (`multipart/form-data`),
    and product `media`, which `PATCH /v1/products` now honours.
  - **Test controls:** paybox's own, to open a dispute and to give the
    network's ruling, since Bachs' sandbox has no trigger for either.
  - **New webhooks:** `dispute.created`, `dispute.updated`.
  - **Generic tooling:** a dispute opened with `paybox dispute` or the control
    API on a Bachs payment is a Bachs dispute.
- **Fix:** storage silently dropped a change to a dispute's `dueAt` or
  `category`.

- **Bachs: money out**, the third phase of its API
  ([contract](docs/bachs.md#how-money-out-behaves)).
  - **Payouts:** payout destinations (bank, mobile money, crypto wallet),
    payouts, and cross-currency payout quotes (30 seconds, single use).
    Bachs' test destinations decide the outcome: 999/0001112223 completes,
    998/0001112224 fails.
  - **Schedules:** payout schedules (`/v1/balance_settings`): daily, weekly,
    monthly or instant, run on paybox's clock.
  - **Conversions:** USD <-> NGN.
  - **Virtual account:** the account's NGN virtual account, with a paybox test
    control to deposit into it, since Bachs has no way to simulate one.
  - **Reference lists:** payout currencies, banks, mobile-money providers,
    bank-account resolve.
  - **New webhooks:** `payout.created`, `payout.paid`, `payout.failed`,
    `conversion.completed`.
  - Transfers come with Connect, since they move money only to connected
    accounts.
- **Behaviour change: Bachs balances are USD and NGN only.**
  `GET /bachs/v1/balances` used to show one balance per collected currency.
  - A GHS mobile-money collection showed as a GHS balance. Bachs holds only
    USD and NGN and converts the rest when it settles, so paybox now does too.
  - The rates are fixed, and listed in docs/bachs.md.
  - `total_balance_usd` now counts NGN at that rate.
  - **Balances are net of Bachs' processing fee**, as `settlement_amount`
    always said; the fee comes off when a collection settles.
  - Both USD and NGN are always listed.
  - **If your tests read a non-USD/NGN Bachs balance:** read the USD balance
    instead.

- **Bachs: subscriptions and saved cards**, the second phase of its API
  ([contract](docs/bachs.md#how-billing-behaves)).
  - **Subscriptions.** A recurring product in a checkout starts a subscription
    (it used to answer `501`), with trials. There are
    `GET`/`PATCH`/`DELETE /v1/subscriptions`: plan changes prorated to the
    cent, trial moves, card changes, metadata, and cancelling now or at the
    period's end.
  - **Renewals on paybox's clock.** Bachs' sandbox cannot advance time, so
    paybox is where renewals and recovery are testable. A failed renewal goes
    `past_due` and is retried on days 1, 4 and 9, then cancelled. With
    `bachs.subscriptionRecovery: unpaid` it is left `unpaid` instead.
    Downgrades become customer credit, applied to the next invoice.
  - **Saved cards.** `save_payment_method`, with or without a charge.
    `POST /v1/charges` charges a saved card off-session, at a fixed
    1 USD = 1,500 NGN when the currencies differ. Bachs' test card
    `4000000000000341` saves and then declines.
  - **Also:** product groups, and the customer portal (`portal-sessions` and
    paybox's portal page).
  - **New webhooks:** `customer.subscription.*`, `invoice.*` and
    `payment_method.saved`.
  - No other provider's billing changed: Bachs runs its own renewal jobs
    rather than the shared runner.
- **Fixed: ids repeated after a restart.** On a database file, every start
  began the seeded id stream again. The first ids after a restart were ones
  already stored, and the write failed with `UNIQUE constraint failed`. Inside
  a job, that failure killed the job: a webhook retry, a payment expiry, a
  renewal.
  - A database now counts its starts (migration 0023), and each start after
    the first mints ids, and generated references such as WeWire's, from a
    stream of its own.
  - Local credentials are unchanged, and so are a fresh database and
    `:memory:`.
  - The same seed with the same restarts still mints the same ids.
  - A database from an earlier version is recognised as already started.

## 0.4.0 — 2026-10-11

- **Behaviour change: virtual time survives a restart.** With a database
  file, a restart used to rewind the clock to `PAYBOX_START_AT`, or to the wall
  clock if it was unset. That could put the clock earlier than events and jobs
  already in the database, so jobs that had been due stopped being due, and any
  `time advance` was lost.
  - The clock is now recorded on every change (migration 0022), and a restart
    resumes it: frozen at its instant, or flowing with its offset.
  - **If you relied on a restart to go back to `PAYBOX_START_AT`:** change the
    value, or start from a fresh database. A changed `PAYBOX_START_AT` is still
    honoured, so the documented way to reach an earlier date works as before.
  - `:memory:` (the usual choice for test suites) is unaffected.
  - An older paybox opening the same database ignores the recorded clock and
    rewinds as it always did. Upgrading again then resumes from the last
    clock this version recorded, which may be earlier than what the older one
    wrote. Change `PAYBOX_START_AT` (or start fresh) after a downgrade.
- **The API reference at `/docs` lists Quid Payments and Tingg.** Their routes
  were missing from `/openapi.json` since each was added: the document
  iterated a hand-kept copy of the provider list that nobody updated. Every
  place that enumerates the served surface — the OpenAPI document, `paybox
  coverage`, the generated README block — now reads one list
  (`@paybox/api/coverage`), and a test fails if a provider is missing from it.
- **A manual webhook retry records the attempt it grants.** `paybox webhook
  retry`, the dashboard's Retry button and `POST /api/webhooks/deliveries/:id/retry`
  always sent one more attempt, but the delivery row kept its old
  `maxAttempts`, so the log read "attempt 3 of 2". The row now says what was
  allowed.
- **A ninth provider: Bachs** — `/bachs`, the first phase of its API:
  [contract](docs/bachs.md).
  - **Endpoints.** Checkout sessions with paybox's hosted page, payments,
    products, customers, refunds, balances, and Bachs' full webhook-endpoint
    API (events, attempts, resend, replay, metrics, secret rotation).
  - **Collection.** All five rails: card, NGN bank transfer, nine mobile-money
    corridors, and crypto with under- and overpayment.
  - **Pricing.** Fixed, free and pay-what-you-want checkouts.
  - **Not yet.** Subscriptions, saved cards, payouts, disputes and Connect
    are later phases and answer `501`.
- **Webhook delivery can now stop early, for providers that ask.** The new
  delivery status `failed` means the provider treats the response as a
  refusal: Bachs stops on most `4xx` and every `3xx`. `exhausted` still means
  the retries ran out. A stopped delivery is never sent again by a stale job.
  For every other provider, delivery is unchanged.
- **Signing-secret rotation overlap.** An endpoint can sign with a rotated-out
  secret until it expires (migration 0021).
- **Six more currencies**: TZS, UGX, XAF, RWF, MWK and ZMW, for Bachs'
  mobile-money corridors.

- **Tingg is named wherever the other providers are.** It was in the generated
  endpoint tables but not in the hand-written prose beside them: the landing
  page's description, notice and docs index, the README's introduction and
  contract links, the npm description and keywords, and the Docker Hub short
  description. The documentation pages that enumerate providers — the control
  API's `provider` filter and `GET /api/providers` example, the `providers:`
  config block, the getting-started `.env`, the surfaces diagram, the transfer
  and vocabulary notes in the payment lifecycle, and the key-shape list in
  troubleshooting — now list Quid Payments and Tingg too. Nothing served
  changes.

## 0.3.0 — 2026-09-21

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
