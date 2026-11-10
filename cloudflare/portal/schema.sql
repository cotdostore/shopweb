CREATE TABLE IF NOT EXISTS portal_customers (
 id TEXT PRIMARY KEY,
 access_hash TEXT NOT NULL UNIQUE,
 access_encrypted TEXT NOT NULL,
 display_name TEXT NOT NULL,
 messenger_id TEXT UNIQUE,
 active INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS portal_accounts (
 id TEXT PRIMARY KEY,
 service TEXT NOT NULL,
 label TEXT NOT NULL,
 source_id TEXT UNIQUE,
 secret TEXT,
 updated_at INTEGER,
 checked_at INTEGER,
 sync_error TEXT,
 observed_at INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS portal_grants (
 customer_id TEXT NOT NULL REFERENCES portal_customers(id),
 account_id TEXT NOT NULL REFERENCES portal_accounts(id),
 expires_at INTEGER,
 PRIMARY KEY(customer_id, account_id)
);
CREATE TABLE IF NOT EXISTS portal_sessions (
 token_hash TEXT PRIMARY KEY,
 customer_id TEXT,
 role TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_grants_account ON portal_grants(account_id);
CREATE INDEX IF NOT EXISTS portal_sessions_expiry ON portal_sessions(expires_at);
CREATE INDEX IF NOT EXISTS portal_sessions_customer ON portal_sessions(customer_id);
CREATE INDEX IF NOT EXISTS portal_accounts_service ON portal_accounts(service,active);
CREATE TABLE IF NOT EXISTS portal_rate_limits (
 bucket TEXT PRIMARY KEY,
 count INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS portal_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS portal_rate_limits_expiry ON portal_rate_limits(expires_at);
