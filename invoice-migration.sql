-- Run once in the Supabase SQL Editor for existing Kandaria installations.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS ledger_id BIGINT REFERENCES ledgers(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS invoices (
  id                    BIGSERIAL PRIMARY KEY,
  tenancy_id            BIGINT NOT NULL REFERENCES tenancies(id) ON DELETE CASCADE,
  ledger_id             BIGINT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  invoice_number        TEXT NOT NULL UNIQUE,
  billing_month         DATE NOT NULL,
  issued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_date              DATE NOT NULL,
  rent_due              NUMERIC(10, 2) NOT NULL,
  utilities_water       NUMERIC(10, 2) NOT NULL DEFAULT 0,
  utilities_electricity NUMERIC(10, 2) NOT NULL DEFAULT 0,
  utilities_garbage     NUMERIC(10, 2) NOT NULL DEFAULT 0,
  penalty_fee           NUMERIC(10, 2) NOT NULL DEFAULT 0,
  amount_paid           NUMERIC(10, 2) NOT NULL DEFAULT 0,
  balance               NUMERIC(10, 2) NOT NULL,
  status                TEXT NOT NULL DEFAULT 'unpaid'
                        CHECK (status IN ('unpaid', 'partial', 'paid', 'overpaid')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenancy_id, billing_month)
);

CREATE TABLE IF NOT EXISTS invoice_deliveries (
  id             BIGSERIAL PRIMARY KEY,
  invoice_id     BIGINT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  channel        TEXT NOT NULL CHECK (channel IN ('sms')),
  recipient      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('accepted', 'failed', 'unavailable')),
  provider_ref   TEXT,
  error_message  TEXT,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_ledger ON payments(ledger_id);
CREATE INDEX IF NOT EXISTS idx_invoices_tenancy ON invoices(tenancy_id);
CREATE INDEX IF NOT EXISTS idx_invoices_month ON invoices(billing_month);
CREATE INDEX IF NOT EXISTS idx_invoice_deliveries_invoice ON invoice_deliveries(invoice_id);
