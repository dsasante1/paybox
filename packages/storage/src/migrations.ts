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
];
