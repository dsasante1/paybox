/**
 * Hand-written, forward-only migrations applied at boot.
 *
 * No migration CLI: this is an embedded database that ships inside the tool,
 * so "run pending migrations on startup" is the entire lifecycle. Each entry
 * is applied once, inside a transaction, and recorded in schema_migrations.
 *
 * Never edit an applied migration -- add a new one.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial',
    sql: `
      CREATE TABLE payments (
        id                     TEXT PRIMARY KEY,
        provider               TEXT NOT NULL,
        reference              TEXT NOT NULL,
        provider_transaction_id TEXT NOT NULL,
        amount                 INTEGER NOT NULL CHECK (amount > 0),
        currency               TEXT NOT NULL,
        status                 TEXT NOT NULL,
        provider_status        TEXT NOT NULL,
        payment_method         TEXT,
        payment_method_details TEXT NOT NULL DEFAULT '{}',
        customer_id            TEXT REFERENCES customers(id) ON DELETE SET NULL,
        callback_url           TEXT,
        amount_refunded        INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
        failure_code           TEXT,
        failure_message        TEXT,
        metadata               TEXT NOT NULL DEFAULT '{}',
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        expires_at             TEXT,
        authorized_at          TEXT,
        paid_at                TEXT,
        CHECK (amount_refunded <= amount)
      );

      -- A reference is unique per provider, not globally: the same order id
      -- may legitimately be replayed against Paystack and Stripe in one test.
      CREATE UNIQUE INDEX idx_payments_provider_reference
        ON payments (provider, reference);
      CREATE UNIQUE INDEX idx_payments_provider_txn
        ON payments (provider, provider_transaction_id);
      CREATE INDEX idx_payments_status ON payments (status);
      CREATE INDEX idx_payments_created ON payments (created_at DESC);

      CREATE TABLE customers (
        id                   TEXT PRIMARY KEY,
        provider             TEXT NOT NULL,
        provider_customer_id TEXT NOT NULL,
        email                TEXT NOT NULL,
        first_name           TEXT,
        last_name            TEXT,
        phone                TEXT,
        metadata             TEXT NOT NULL DEFAULT '{}',
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_customers_provider_email ON customers (provider, email);
      CREATE UNIQUE INDEX idx_customers_provider_code
        ON customers (provider, provider_customer_id);

      CREATE TABLE refunds (
        id                TEXT PRIMARY KEY,
        payment_id        TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
        provider          TEXT NOT NULL,
        provider_refund_id TEXT NOT NULL,
        amount            INTEGER NOT NULL CHECK (amount > 0),
        currency          TEXT NOT NULL,
        status            TEXT NOT NULL,
        provider_status   TEXT NOT NULL,
        reason            TEXT,
        metadata          TEXT NOT NULL DEFAULT '{}',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX idx_refunds_payment ON refunds (payment_id);
      CREATE UNIQUE INDEX idx_refunds_provider_id ON refunds (provider, provider_refund_id);

      CREATE TABLE transfers (
        id                  TEXT PRIMARY KEY,
        provider            TEXT NOT NULL,
        provider_transfer_id TEXT NOT NULL,
        reference           TEXT NOT NULL,
        amount              INTEGER NOT NULL CHECK (amount > 0),
        currency            TEXT NOT NULL,
        status              TEXT NOT NULL,
        provider_status     TEXT NOT NULL,
        recipient_name      TEXT,
        recipient_account   TEXT,
        recipient_bank_code TEXT,
        reason              TEXT,
        failure_reason      TEXT,
        metadata            TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_transfers_provider_reference ON transfers (provider, reference);

      -- Append-only. There is deliberately no UPDATE path for this table:
      -- it is the source of truth for history, and the payment row is the
      -- projection. See docs/architecture.md.
      CREATE TABLE events (
        id              TEXT PRIMARY KEY,
        type            TEXT NOT NULL,
        provider        TEXT NOT NULL,
        resource_id     TEXT NOT NULL,
        resource_type   TEXT NOT NULL,
        sequence        INTEGER NOT NULL,
        data            TEXT NOT NULL DEFAULT '{}',
        previous_status TEXT,
        current_status  TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_events_resource_sequence ON events (resource_id, sequence);
      CREATE INDEX idx_events_type ON events (type);
      CREATE INDEX idx_events_created ON events (created_at DESC);

      -- Per-resource counter, bumped inside the same transaction as the
      -- append so sequences are gapless and ordering is total.
      CREATE TABLE event_sequences (
        resource_id   TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL
      );

      CREATE TABLE webhook_endpoints (
        id          TEXT PRIMARY KEY,
        provider    TEXT NOT NULL,
        url         TEXT NOT NULL,
        secret      TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        event_types TEXT NOT NULL DEFAULT '[]',
        description TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_webhook_endpoints_provider ON webhook_endpoints (provider);

      CREATE TABLE webhook_deliveries (
        id                    TEXT PRIMARY KEY,
        endpoint_id           TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
        event_id              TEXT NOT NULL,
        provider              TEXT NOT NULL,
        event_type            TEXT NOT NULL,
        url                   TEXT NOT NULL,
        payload               TEXT NOT NULL,
        headers               TEXT NOT NULL DEFAULT '{}',
        status                TEXT NOT NULL,
        attempt               INTEGER NOT NULL DEFAULT 0,
        max_attempts          INTEGER NOT NULL DEFAULT 5,
        response_status       INTEGER,
        response_body         TEXT,
        error_message         TEXT,
        duration_ms           INTEGER,
        next_retry_at         TEXT,
        replay_of_delivery_id TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX idx_deliveries_event ON webhook_deliveries (event_id);
      CREATE INDEX idx_deliveries_status ON webhook_deliveries (status);
      CREATE INDEX idx_deliveries_created ON webhook_deliveries (created_at DESC);

      CREATE TABLE jobs (
        id               TEXT PRIMARY KEY,
        kind             TEXT NOT NULL,
        payload          TEXT NOT NULL DEFAULT '{}',
        status           TEXT NOT NULL,
        run_at           TEXT NOT NULL,
        attempt          INTEGER NOT NULL DEFAULT 0,
        max_attempts     INTEGER NOT NULL DEFAULT 1,
        lease_expires_at TEXT,
        last_error       TEXT,
        group_key        TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      -- The scheduler's hot path: ready jobs ordered by due time.
      CREATE INDEX idx_jobs_ready ON jobs (status, run_at);
      CREATE INDEX idx_jobs_group ON jobs (group_key);

      CREATE TABLE idempotency_keys (
        provider        TEXT NOT NULL,
        key             TEXT NOT NULL,
        request_hash    TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body   TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (provider, key)
      );
    `,
  },
  {
    id: '0002_transfer_recipients',
    sql: `
      CREATE TABLE transfer_recipients (
        id                    TEXT PRIMARY KEY,
        provider              TEXT NOT NULL,
        provider_recipient_id TEXT NOT NULL,
        type                  TEXT NOT NULL,
        name                  TEXT NOT NULL,
        account_number        TEXT,
        bank_code             TEXT,
        bank_name             TEXT,
        currency              TEXT NOT NULL,
        metadata              TEXT NOT NULL DEFAULT '{}',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_recipients_provider_code
        ON transfer_recipients (provider, provider_recipient_id);
    `,
  },
  {
    id: '0003_authorizations',
    sql: `
      -- Reusable instrument handles (spec §5). Only masked fragments are ever
      -- stored: there is no column for a PAN and none for a CVV, by design.
      CREATE TABLE authorizations (
        id                          TEXT PRIMARY KEY,
        provider                    TEXT NOT NULL,
        provider_authorization_code TEXT NOT NULL,
        customer_id                 TEXT REFERENCES customers(id) ON DELETE SET NULL,
        payment_id                  TEXT REFERENCES payments(id) ON DELETE SET NULL,
        channel                     TEXT NOT NULL,
        bin                         TEXT,
        last4                       TEXT,
        exp_month                   TEXT,
        exp_year                    TEXT,
        card_type                   TEXT,
        bank                        TEXT,
        brand                       TEXT,
        country_code                TEXT,
        signature                   TEXT,
        reusable                    INTEGER NOT NULL DEFAULT 0,
        active                      INTEGER NOT NULL DEFAULT 1,
        account_name                TEXT,
        mobile_money_number         TEXT,
        metadata                    TEXT NOT NULL DEFAULT '{}',
        created_at                  TEXT NOT NULL,
        updated_at                  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_authorizations_provider_code
        ON authorizations (provider, provider_authorization_code);
      CREATE INDEX idx_authorizations_customer ON authorizations (customer_id);
      -- Partial: only non-null signatures dedupe, so momo rows (which have
      -- none) do not collide with each other.
      CREATE UNIQUE INDEX idx_authorizations_signature
        ON authorizations (provider, signature) WHERE signature IS NOT NULL;
    `,
  },
  {
    id: '0004_dedicated_accounts',
    sql: `
      -- Synthetic account numbers only. These belong to no bank and the
      -- emulator has no path that could move real money through one.
      CREATE TABLE dedicated_accounts (
        id                  TEXT PRIMARY KEY,
        provider            TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        customer_id         TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        account_number      TEXT NOT NULL,
        account_name        TEXT NOT NULL,
        bank_name           TEXT NOT NULL,
        bank_slug           TEXT NOT NULL,
        currency            TEXT NOT NULL,
        active              INTEGER NOT NULL DEFAULT 1,
        assigned            INTEGER NOT NULL DEFAULT 1,
        metadata            TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_dva_provider_id
        ON dedicated_accounts (provider, provider_account_id);
      CREATE UNIQUE INDEX idx_dva_account_number
        ON dedicated_accounts (provider, account_number);
      CREATE INDEX idx_dva_customer ON dedicated_accounts (customer_id);
    `,
  },
  {
    id: '0005_subscriptions',
    sql: `
      CREATE TABLE plans (
        id                TEXT PRIMARY KEY,
        provider          TEXT NOT NULL,
        provider_plan_code TEXT NOT NULL,
        name              TEXT NOT NULL,
        amount            INTEGER NOT NULL CHECK (amount > 0),
        currency          TEXT NOT NULL,
        interval          TEXT NOT NULL,
        description       TEXT,
        invoice_limit     INTEGER NOT NULL DEFAULT 0,
        send_invoices     INTEGER NOT NULL DEFAULT 1,
        send_sms          INTEGER NOT NULL DEFAULT 1,
        active            INTEGER NOT NULL DEFAULT 1,
        metadata          TEXT NOT NULL DEFAULT '{}',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_plans_provider_code ON plans (provider, provider_plan_code);

      CREATE TABLE subscriptions (
        id                         TEXT PRIMARY KEY,
        provider                   TEXT NOT NULL,
        provider_subscription_code TEXT NOT NULL,
        customer_id                TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        plan_id                    TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
        authorization_id           TEXT NOT NULL REFERENCES authorizations(id) ON DELETE RESTRICT,
        status                     TEXT NOT NULL,
        provider_status            TEXT NOT NULL,
        quantity                   INTEGER NOT NULL DEFAULT 1,
        amount                     INTEGER NOT NULL CHECK (amount > 0),
        currency                   TEXT NOT NULL,
        start_date                 TEXT NOT NULL,
        -- Virtual-time ISO, compared against virtual time by the scheduler.
        next_payment_date          TEXT,
        invoice_limit              INTEGER NOT NULL DEFAULT 0,
        invoice_count              INTEGER NOT NULL DEFAULT 0,
        email_token                TEXT NOT NULL,
        cancelled_at               TEXT,
        metadata                   TEXT NOT NULL DEFAULT '{}',
        created_at                 TEXT NOT NULL,
        updated_at                 TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_subscriptions_provider_code
        ON subscriptions (provider, provider_subscription_code);
      CREATE INDEX idx_subscriptions_customer ON subscriptions (customer_id);
      CREATE INDEX idx_subscriptions_next_payment ON subscriptions (next_payment_date);

      CREATE TABLE invoices (
        id                   TEXT PRIMARY KEY,
        provider             TEXT NOT NULL,
        provider_invoice_code TEXT NOT NULL,
        subscription_id      TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        customer_id          TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        payment_id           TEXT REFERENCES payments(id) ON DELETE SET NULL,
        amount               INTEGER NOT NULL CHECK (amount > 0),
        currency             TEXT NOT NULL,
        status               TEXT NOT NULL,
        provider_status      TEXT NOT NULL,
        period_start         TEXT NOT NULL,
        period_end           TEXT NOT NULL,
        due_at               TEXT NOT NULL,
        paid_at              TEXT,
        metadata             TEXT NOT NULL DEFAULT '{}',
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_invoices_provider_code
        ON invoices (provider, provider_invoice_code);
      CREATE INDEX idx_invoices_subscription ON invoices (subscription_id);
    `,
  },
  {
    id: '0006_marketplace',
    sql: `
      CREATE TABLE subaccounts (
        id                      TEXT PRIMARY KEY,
        provider                TEXT NOT NULL,
        provider_subaccount_code TEXT NOT NULL,
        business_name           TEXT NOT NULL,
        settlement_bank         TEXT NOT NULL,
        account_number          TEXT NOT NULL,
        percentage_charge       REAL NOT NULL DEFAULT 0,
        description             TEXT,
        primary_contact_email   TEXT,
        primary_contact_name    TEXT,
        primary_contact_phone   TEXT,
        currency                TEXT NOT NULL,
        active                  INTEGER NOT NULL DEFAULT 1,
        metadata                TEXT NOT NULL DEFAULT '{}',
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_subaccounts_provider_code
        ON subaccounts (provider, provider_subaccount_code);

      CREATE TABLE splits (
        id                   TEXT PRIMARY KEY,
        provider             TEXT NOT NULL,
        provider_split_code  TEXT NOT NULL,
        name                 TEXT NOT NULL,
        type                 TEXT NOT NULL,
        currency             TEXT NOT NULL,
        bearer_type          TEXT NOT NULL DEFAULT 'account',
        bearer_subaccount_id TEXT REFERENCES subaccounts(id) ON DELETE SET NULL,
        active               INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_splits_provider_code ON splits (provider, provider_split_code);

      CREATE TABLE split_subaccounts (
        split_id      TEXT NOT NULL REFERENCES splits(id) ON DELETE CASCADE,
        subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
        share         REAL NOT NULL,
        PRIMARY KEY (split_id, subaccount_id)
      );

      -- Append-only, like events. The balance is a fold over this table and is
      -- never stored as a mutable number.
      CREATE TABLE balance_ledger (
        id          TEXT PRIMARY KEY,
        provider    TEXT NOT NULL,
        currency    TEXT NOT NULL,
        direction   TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
        amount      INTEGER NOT NULL CHECK (amount > 0),
        reason      TEXT NOT NULL,
        resource_id TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_ledger_provider_currency ON balance_ledger (provider, currency);
      CREATE INDEX idx_ledger_resource ON balance_ledger (resource_id);
    `,
  },
  {
    id: '0007_disputes',
    sql: `
      CREATE TABLE disputes (
        id                  TEXT PRIMARY KEY,
        provider            TEXT NOT NULL,
        provider_dispute_id TEXT NOT NULL,
        payment_id          TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
        customer_id         TEXT REFERENCES customers(id) ON DELETE SET NULL,
        category            TEXT NOT NULL,
        status              TEXT NOT NULL,
        provider_status     TEXT NOT NULL,
        resolution          TEXT,
        refund_amount       INTEGER NOT NULL CHECK (refund_amount >= 0),
        currency            TEXT NOT NULL,
        -- Virtual-time ISO: the response deadline is a scheduled job, so
        -- "nobody answered in time" is one time advance away.
        due_at              TEXT NOT NULL,
        resolved_at         TEXT,
        evidence            TEXT,
        message             TEXT,
        metadata            TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_disputes_provider_id ON disputes (provider, provider_dispute_id);
      CREATE INDEX idx_disputes_payment ON disputes (payment_id);
      CREATE INDEX idx_disputes_status ON disputes (status);
    `,
  },
  {
    id: '0008_refund_account_details',
    sql: `
      -- Bank details supplied to recover a needs-attention refund. Synthetic
      -- only; nothing here is ever transmitted anywhere.
      ALTER TABLE refunds ADD COLUMN account_details TEXT;
    `,
  },
  {
    id: '0009_products_and_interval_count',
    sql: `
      -- Stripe separates the Product (what it is) from the Price (what it
      -- costs). Paystack folds both into a plan, so product_id is nullable.
      CREATE TABLE products (
        id                  TEXT PRIMARY KEY,
        provider            TEXT NOT NULL,
        provider_product_id TEXT NOT NULL,
        name                TEXT NOT NULL,
        description         TEXT,
        active              INTEGER NOT NULL DEFAULT 1,
        metadata            TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_products_provider_id
        ON products (provider, provider_product_id);

      -- Stripe writes "every three months" as interval=month plus a count.
      -- Existing plans are all count 1, which is Paystack's only shape.
      ALTER TABLE plans ADD COLUMN interval_count INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE plans ADD COLUMN product_id TEXT REFERENCES products(id) ON DELETE SET NULL;
    `,
  },
  {
    id: '0010_instrument_setups',
    sql: `
      -- Verifying an instrument and storing it, without charging for it.
      -- Stripe calls it a SetupIntent; the canonical resource is provider
      -- neutral because every provider has some route to card-on-file.
      --
      -- Only masked fragments are ever written here, exactly as in
      -- authorizations: there is no column that could hold a PAN or a CVV.
      CREATE TABLE instrument_setups (
        id                  TEXT PRIMARY KEY,
        provider            TEXT NOT NULL,
        provider_setup_id   TEXT NOT NULL,
        customer_id         TEXT REFERENCES customers(id) ON DELETE SET NULL,
        authorization_id    TEXT REFERENCES authorizations(id) ON DELETE SET NULL,
        status              TEXT NOT NULL,
        provider_status     TEXT NOT NULL,
        usage               TEXT NOT NULL DEFAULT 'off_session',
        channel             TEXT,
        instrument          TEXT NOT NULL DEFAULT '{}',
        failure_code        TEXT,
        failure_message     TEXT,
        cancellation_reason TEXT,
        metadata            TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_instrument_setups_provider_id
        ON instrument_setups (provider, provider_setup_id);
      CREATE INDEX idx_instrument_setups_customer ON instrument_setups (customer_id);
    `,
  },
  {
    id: '0011_invoice_lifecycle',
    sql: `
      -- Invoices gain a life before and after the billing run that raised
      -- them: a draft you build up, a finalisation that opens it, and the two
      -- ways it can end without being paid.
      --
      -- SQLite cannot relax a column, so the table is rebuilt. Nothing
      -- references invoices yet, so the drop is safe with foreign keys on;
      -- invoice_items is created afterwards, pointing at the new table.
      --
      -- Three changes: subscription_id becomes nullable (a standalone invoice
      -- belongs to a customer, not a subscription), amount allows zero (a
      -- fresh draft has no lines yet), and the three Stripe fields that only
      -- make sense once an invoice has a lifecycle are added.
      CREATE TABLE invoices_new (
        id                    TEXT PRIMARY KEY,
        provider              TEXT NOT NULL,
        provider_invoice_code TEXT NOT NULL,
        subscription_id       TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
        customer_id           TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        payment_id            TEXT REFERENCES payments(id) ON DELETE SET NULL,
        amount                INTEGER NOT NULL CHECK (amount >= 0),
        currency              TEXT NOT NULL,
        status                TEXT NOT NULL,
        provider_status       TEXT NOT NULL,
        -- Why this invoice exists, in Stripe's vocabulary.
        billing_reason        TEXT NOT NULL DEFAULT 'subscription_cycle',
        -- How many times payment has been attempted.
        attempt_count         INTEGER NOT NULL DEFAULT 0,
        -- Assigned at finalisation, as Stripe does; a draft has none.
        number                TEXT,
        period_start          TEXT NOT NULL,
        period_end            TEXT NOT NULL,
        due_at                TEXT NOT NULL,
        paid_at               TEXT,
        metadata              TEXT NOT NULL DEFAULT '{}',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );

      INSERT INTO invoices_new (
        id, provider, provider_invoice_code, subscription_id, customer_id,
        payment_id, amount, currency, status, provider_status, billing_reason,
        attempt_count, number, period_start, period_end, due_at, paid_at,
        metadata, created_at, updated_at
      )
      SELECT
        id, provider, provider_invoice_code, subscription_id, customer_id,
        payment_id, amount, currency, status, provider_status,
        'subscription_cycle',
        CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
        NULL, period_start, period_end, due_at, paid_at,
        metadata, created_at, updated_at
      FROM invoices;

      DROP TABLE invoices;
      ALTER TABLE invoices_new RENAME TO invoices;

      CREATE UNIQUE INDEX idx_invoices_provider_code
        ON invoices (provider, provider_invoice_code);
      CREATE INDEX idx_invoices_subscription ON invoices (subscription_id);
      CREATE INDEX idx_invoices_customer ON invoices (customer_id);
      CREATE INDEX idx_invoices_status ON invoices (status);

      -- What an invoice is actually made of. Needed the moment an invoice can
      -- be built by hand, and again the moment a subscription can carry more
      -- than one price.
      --
      -- amount is deliberately unconstrained in sign: a proration credit for
      -- unused time on a downgraded plan is a negative line, which is exactly
      -- how the arithmetic is supposed to work.
      CREATE TABLE invoice_items (
        id               TEXT PRIMARY KEY,
        provider         TEXT NOT NULL,
        provider_item_id TEXT NOT NULL,
        customer_id      TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        -- Null while pending: an item waiting to be swept onto the next
        -- invoice, which is how Stripe carries a mid-cycle change forward.
        invoice_id       TEXT REFERENCES invoices(id) ON DELETE CASCADE,
        subscription_id  TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
        plan_id          TEXT REFERENCES plans(id) ON DELETE SET NULL,
        description      TEXT,
        amount           INTEGER NOT NULL,
        currency         TEXT NOT NULL,
        quantity         INTEGER NOT NULL DEFAULT 1,
        unit_amount      INTEGER NOT NULL DEFAULT 0,
        period_start     TEXT NOT NULL,
        period_end       TEXT NOT NULL,
        proration        INTEGER NOT NULL DEFAULT 0,
        -- Insertion order, explicitly.
        --
        -- created_at cannot carry it: the emulator's headline feature is a
        -- frozen clock, under which every line on an invoice shares one
        -- timestamp and the tiebreak falls to a random id -- so an invoice
        -- would render its lines shuffled. Monotonic across the table so a
        -- pending item swept onto an invoice still lands after the lines
        -- already on it.
        position         INTEGER NOT NULL DEFAULT 0,
        metadata         TEXT NOT NULL DEFAULT '{}',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_invoice_items_provider_id
        ON invoice_items (provider, provider_item_id);
      CREATE INDEX idx_invoice_items_invoice ON invoice_items (invoice_id);
      CREATE INDEX idx_invoice_items_customer ON invoice_items (customer_id);
      CREATE INDEX idx_invoice_items_subscription ON invoice_items (subscription_id);
    `,
  },
  {
    id: '0012_subscription_items_and_trials',
    sql: `
      -- A subscription can carry several prices, and can begin with a trial.
      CREATE TABLE subscription_items (
        id               TEXT PRIMARY KEY,
        provider         TEXT NOT NULL,
        provider_item_id TEXT NOT NULL,
        subscription_id  TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        plan_id          TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
        quantity         INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
        -- Insertion order, for the same reason invoice_items carries one: the
        -- frozen clock gives every item on a subscription one timestamp.
        position         INTEGER NOT NULL DEFAULT 0,
        metadata         TEXT NOT NULL DEFAULT '{}',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_subscription_items_provider_id
        ON subscription_items (provider, provider_item_id);
      CREATE INDEX idx_subscription_items_subscription
        ON subscription_items (subscription_id);

      -- Trial window. Null on both means the subscription bills from day one.
      ALTER TABLE subscriptions ADD COLUMN trial_start TEXT;
      ALTER TABLE subscriptions ADD COLUMN trial_end TEXT;

      -- When the *current* period began.
      --
      -- start_date is when the subscription began, which is a different thing
      -- from the third month's period start -- reporting the former as the
      -- latter made current_period_start wrong on every renewal after the
      -- first.
      ALTER TABLE subscriptions ADD COLUMN current_period_start TEXT;
      UPDATE subscriptions SET current_period_start = start_date;

      -- Backfill one item per existing subscription, so a row written before
      -- this migration reads the same as one written after it. The id is
      -- derived from the subscription's rather than generated, which keeps the
      -- backfill deterministic and unique without a random source.
      INSERT INTO subscription_items (
        id, provider, provider_item_id, subscription_id, plan_id, quantity,
        position, metadata, created_at, updated_at
      )
      SELECT
        'sui_' || substr(id, 5),
        provider,
        'si_' || substr(id, 5),
        id,
        plan_id,
        quantity,
        0,
        '{}',
        created_at,
        updated_at
      FROM subscriptions;
    `,
  },
  {
    id: '0013_authorization_signature_per_customer',
    sql: `
      -- A stored instrument belongs to a customer.
      --
      -- The signature index was unique on (provider, signature), which said
      -- "one row per card, ever". That is wrong: two customers who happen to
      -- save the same card must get two stored instruments, and the global
      -- rule handed the first customer's saved card to the second. Every
      -- provider we model scopes this to the customer -- Paystack mints a
      -- separate authorization_code per customer, and a Stripe PaymentMethod
      -- attaches to exactly one.
      --
      -- SQLite treats NULLs as distinct in a unique index, so instruments with
      -- no customer never collide with each other, which is also what both
      -- providers do: POST /v1/payment_methods mints a fresh one every time.
      DROP INDEX IF EXISTS idx_authorizations_signature;
      CREATE UNIQUE INDEX idx_authorizations_signature
        ON authorizations (provider, signature, customer_id)
        WHERE signature IS NOT NULL;
    `,
  },
  {
    id: '0014_connected_accounts',
    sql: `
      -- A connected account is not usable the moment it is created.
      --
      -- At Stripe it must submit details first; until then charges_enabled is
      -- false and requirements says what is missing. That gap is the single
      -- most common thing a Connect integration gets wrong in production, so
      -- the emulator models it rather than handing back a working account.
      --
      -- Existing rows are Paystack subaccounts, which have no such lifecycle
      -- and are usable at once: they backfill to fully enabled, so nothing
      -- about Paystack's behaviour changes.
      ALTER TABLE subaccounts ADD COLUMN account_type TEXT;
      ALTER TABLE subaccounts ADD COLUMN country_code TEXT NOT NULL DEFAULT 'NG';
      ALTER TABLE subaccounts ADD COLUMN charges_enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE subaccounts ADD COLUMN payouts_enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE subaccounts ADD COLUMN details_submitted INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE subaccounts ADD COLUMN requirements TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE subaccounts ADD COLUMN capabilities TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    id: '0015_ledger_owner',
    sql: `
      -- The balance ledger gains an owner.
      --
      -- Until now there was one pot of money per (provider, currency).
      -- Connect is several: the platform's, and one per connected account.
      -- Every Connect flow -- a direct charge, an application fee, a transfer,
      -- a payout -- is a movement between two of them, so the ledger needs to
      -- know which pot each entry belongs to before any of it can be modelled.
      --
      -- NULL means the platform, which is what every existing row is. The
      -- balance stays a fold over an append-only ledger; it just folds per
      -- owner now.
      ALTER TABLE balance_ledger
        ADD COLUMN subaccount_id TEXT REFERENCES subaccounts(id) ON DELETE RESTRICT;
      CREATE INDEX idx_balance_ledger_owner
        ON balance_ledger (provider, currency, subaccount_id);
    `,
  },
  {
    id: '0016_marketplace_payments',
    sql: `
      -- Which marketplace participant a payment involves, and how.
      --
      -- settlement_mode is the load-bearing column. There are two genuinely
      -- different arrangements and they move money differently:
      --
      --   direct     the participant took the payment; the platform keeps only
      --              its fee. Stripe calls this a direct charge, made with the
      --              Stripe-Account header.
      --   forwarded  the platform took the payment and passes a share on. What
      --              Stripe calls a destination charge, and what a Paystack
      --              split resembles.
      --
      -- NULL for an ordinary payment involving no participant at all.
      ALTER TABLE payments
        ADD COLUMN subaccount_id TEXT REFERENCES subaccounts(id) ON DELETE SET NULL;
      ALTER TABLE payments ADD COLUMN settlement_mode TEXT;
      -- The platform's cut. Stripe calls it an application fee.
      ALTER TABLE payments ADD COLUMN platform_fee INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE payments ADD COLUMN platform_fee_refunded INTEGER NOT NULL DEFAULT 0;
      -- Ties charges and transfers that belong to one piece of business.
      ALTER TABLE payments ADD COLUMN transfer_group TEXT;
      CREATE INDEX idx_payments_subaccount ON payments (subaccount_id);
      CREATE INDEX idx_payments_transfer_group ON payments (transfer_group);
    `,
  },
  {
    id: '0017_transfers_between_balances',
    sql: `
      -- A transfer already models "money leaves a balance and may fail".
      -- Moving funds to a connected account is the same shape of problem, so
      -- it reuses the mechanism rather than growing a second one: the only new
      -- facts are which balance it left and which it landed in.
      --
      -- destination NULL means it went to a bank, which is every existing row.
      ALTER TABLE transfers
        ADD COLUMN source_subaccount_id TEXT REFERENCES subaccounts(id) ON DELETE RESTRICT;
      ALTER TABLE transfers
        ADD COLUMN destination_subaccount_id TEXT REFERENCES subaccounts(id) ON DELETE RESTRICT;
      ALTER TABLE transfers
        ADD COLUMN source_payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL;
      ALTER TABLE transfers ADD COLUMN transfer_group TEXT;
      ALTER TABLE transfers ADD COLUMN amount_reversed INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_transfers_destination ON transfers (destination_subaccount_id);
      CREATE INDEX idx_transfers_group ON transfers (transfer_group);
    `,
  },
  {
    id: '0018_job_sequence',
    sql: `
      -- Enqueue order, explicitly.
      --
      -- claimDue ordered by run_at alone. Under the frozen clock -- the
      -- emulator's headline feature -- every job scheduled at the same instant
      -- shares a run_at, so the tie fell to SQLite's arbitrary row order and
      -- shifted whenever unrelated ids changed. That made **webhook delivery
      -- order nondeterministic**, which breaks the same-seed-same-output
      -- promise and would deliver a settlement webhook before the creation one.
      --
      -- created_at cannot carry it either: it ties for exactly the same reason.
      ALTER TABLE jobs ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
      -- Existing rows keep their relative order under the new sort by taking
      -- distinct ascending values in rowid order.
      UPDATE jobs SET sequence = rowid;
      CREATE INDEX idx_jobs_due ON jobs (status, run_at, sequence);
    `,
  },
];
