-- ============================================================
-- KANDARIA RENT MANAGEMENT SYSTEM — SUPABASE SQL SCHEMA
-- Run this in your Supabase SQL Editor (in order)
-- ============================================================


-- ─────────────────────────────────────────────
-- 1. USERS
-- Stores tenants, caretakers, landlords, accountants
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                BIGSERIAL PRIMARY KEY,
  full_name         TEXT NOT NULL,
  phone_number      TEXT NOT NULL UNIQUE,
  id_number         TEXT,
  emergency_contact TEXT,
  password          TEXT,                          -- hashed; NULL for tenants (OTP login)
  role              TEXT NOT NULL DEFAULT 'tenant' -- tenant | caretaker | landlord | accountant
                    CHECK (role IN ('tenant', 'caretaker', 'landlord', 'accountant')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ─────────────────────────────────────────────
-- 2. OTPs
-- Short-lived codes for tenant login
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otps (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-clean expired OTPs (optional; run manually or via cron)
-- DELETE FROM otps WHERE expires_at < NOW();


-- ─────────────────────────────────────────────
-- 3. PROPERTIES
-- Individual rental units across all locations
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id           BIGSERIAL PRIMARY KEY,
  location     TEXT NOT NULL
               CHECK (location IN ('Nakuru town', 'Mwiki', 'Nyamasaria', 'Manyatta', 'Oyugis', 'Mombassa')),
  plot_name    TEXT NOT NULL,
  house_number TEXT NOT NULL,
  house_type   TEXT,                               -- Bedsitter | 1 Bedroom | 2 Bedroom | etc.
  base_rent    NUMERIC(10, 2) NOT NULL,
  status       TEXT NOT NULL DEFAULT 'vacant'
               CHECK (status IN ('vacant', 'occupied')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ─────────────────────────────────────────────
-- 4. TENANCIES
-- Links a tenant to a property for a period
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenancies (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  property_id    BIGINT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  start_date     DATE NOT NULL,
  end_date       DATE,                             -- NULL = still active
  deposit_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'terminated', 'vacated')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ─────────────────────────────────────────────
-- 5. LEDGERS
-- Monthly billing record per tenancy
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledgers (
  id                     BIGSERIAL PRIMARY KEY,
  tenancy_id             BIGINT NOT NULL REFERENCES tenancies(id) ON DELETE CASCADE,
  billing_month          DATE NOT NULL,            -- Always the 1st of the month e.g. 2026-09-01
  rent_due               NUMERIC(10, 2) NOT NULL,
  utilities_water        NUMERIC(10, 2) NOT NULL DEFAULT 0,
  utilities_electricity  NUMERIC(10, 2) NOT NULL DEFAULT 0,
  utilities_garbage      NUMERIC(10, 2) NOT NULL DEFAULT 0,
  penalty_fee            NUMERIC(10, 2) NOT NULL DEFAULT 0, -- Late payment penalty
  amount_paid            NUMERIC(10, 2) NOT NULL DEFAULT 0,
  balance                NUMERIC(10, 2) GENERATED ALWAYS AS (
                           rent_due
                           + utilities_water
                           + utilities_electricity
                           + utilities_garbage
                           + penalty_fee
                           - amount_paid
                         ) STORED,
  status                 TEXT NOT NULL DEFAULT 'unpaid'
                         CHECK (status IN ('unpaid', 'partial', 'paid', 'overpaid')),
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenancy_id, billing_month)               -- One ledger row per tenancy per month
);


-- ─────────────────────────────────────────────
-- 6. PAYMENTS
-- Individual payment transactions (M-Pesa, bank, etc.)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              BIGSERIAL PRIMARY KEY,
  tenancy_id      BIGINT NOT NULL REFERENCES tenancies(id) ON DELETE CASCADE,
  ledger_id       BIGINT REFERENCES ledgers(id) ON DELETE SET NULL,
  amount          NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  payment_date    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method          TEXT NOT NULL DEFAULT 'M-Pesa'
                  CHECK (method IN ('M-Pesa', 'KCB', 'Cash', 'Bank Transfer', 'Other')),
  proof_image_url TEXT,                            -- Cloudinary URL
  mpesa_code      TEXT,                            -- M-Pesa transaction ref
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'verified', 'rejected')),
  verified_by     BIGINT REFERENCES users(id),     -- Caretaker/admin who approved
  verified_at     TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ─────────────────────────────────────────────
-- 7. INVOICES
-- Immutable monthly bill details, updated only as verified payments are applied
-- ─────────────────────────────────────────────
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


-- ─────────────────────────────────────────────
-- 8. INVOICE DELIVERIES
-- Audit record for invoice notifications sent to tenants
-- ─────────────────────────────────────────────
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


-- ============================================================
-- INDEXES — for faster queries
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_users_phone       ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_role        ON users(role);
CREATE INDEX IF NOT EXISTS idx_otps_user         ON otps(user_id);
CREATE INDEX IF NOT EXISTS idx_tenancies_tenant  ON tenancies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenancies_status  ON tenancies(status);
CREATE INDEX IF NOT EXISTS idx_ledgers_tenancy   ON ledgers(tenancy_id);
CREATE INDEX IF NOT EXISTS idx_ledgers_month     ON ledgers(billing_month);
CREATE INDEX IF NOT EXISTS idx_payments_tenancy  ON payments(tenancy_id);
CREATE INDEX IF NOT EXISTS idx_payments_ledger   ON payments(ledger_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
CREATE INDEX IF NOT EXISTS idx_invoices_tenancy  ON invoices(tenancy_id);
CREATE INDEX IF NOT EXISTS idx_invoices_month    ON invoices(billing_month);
CREATE INDEX IF NOT EXISTS idx_invoice_deliveries_invoice ON invoice_deliveries(invoice_id);
CREATE INDEX IF NOT EXISTS idx_properties_loc    ON properties(location);


-- ============================================================
-- SEED DATA — Admin / Caretaker accounts
-- Passwords are bcrypt hashes of 'Kandaria2026!'
-- Change these passwords immediately after first login!
-- ============================================================

-- NOTE: Passwords below are bcrypt hashes of 'Kandaria2026!'
-- Run generate-hash.js to regenerate if needed.
INSERT INTO users (full_name, phone_number, role, password) VALUES
  ('Admin Landlord',  '254700000001', 'landlord',   '$2a$10$ZVldCjKLK1PK7pFCabi76Okw8c/0WKGiP4wlwxUylVPfsAn6t40ma'),
  ('Head Accountant', '254700000002', 'accountant', '$2a$10$ZVldCjKLK1PK7pFCabi76Okw8c/0WKGiP4wlwxUylVPfsAn6t40ma'),
  ('Caretaker One',   '254700000003', 'caretaker',  '$2a$10$ZVldCjKLK1PK7pFCabi76Okw8c/0WKGiP4wlwxUylVPfsAn6t40ma')
ON CONFLICT (phone_number) DO NOTHING;
