-- BarberApp PostgreSQL Relational Schema
-- Run this script via VS Code (PostgreSQL extension) or psql against your database
-- to initialize all tables and indexes idempotently.

CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    shop_id TEXT UNIQUE NOT NULL,
    shop_name TEXT NOT NULL DEFAULT '',
    username TEXT UNIQUE NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS barbers (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES admins(shop_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    avatar TEXT NOT NULL DEFAULT '💈',
    commission_rate NUMERIC(5, 2) NOT NULL DEFAULT 50.00,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    barber_id TEXT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL,
    tip NUMERIC(12, 2) NOT NULL DEFAULT 0,
    commission_rate NUMERIC(5, 2) NOT NULL DEFAULT 50.00,
    payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card')),
    barber_share NUMERIC(12, 2) NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES admins(shop_id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT 'other'
        CHECK (category IN ('rent', 'supplies', 'bills', 'maintenance', 'food', 'other')),
    amount NUMERIC(12, 2) NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card')),
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT 'admin',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES admins(shop_id) ON DELETE CASCADE,
    barber_id TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card')),
    note TEXT NOT NULL DEFAULT '',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_barbers_shop_id ON barbers(shop_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_username_lower ON admins(LOWER(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_barbers_username_lower ON barbers(LOWER(username));
CREATE INDEX IF NOT EXISTS idx_services_barber_ts ON services(barber_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_shop_ts ON expenses(shop_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_shop_ts ON payouts(shop_id, timestamp DESC);
