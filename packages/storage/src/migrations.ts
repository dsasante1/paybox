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
];
