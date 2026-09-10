PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  name TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES clients(client_id)
);

CREATE TABLE IF NOT EXISTS records (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL,
  record_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  provenance TEXT NOT NULL DEFAULT 'live',
  UNIQUE(stream, idempotency_key)
);

CREATE INDEX IF NOT EXISTS records_stream_sequence
  ON records(stream, sequence);
CREATE INDEX IF NOT EXISTS records_stream_key
  ON records(stream, record_key);

CREATE TABLE IF NOT EXISTS record_corrections (
  correction_id TEXT PRIMARY KEY,
  record_sequence INTEGER NOT NULL UNIQUE REFERENCES records(sequence),
  reason TEXT NOT NULL CHECK (reason IN ('test-fixture', 'migration-error', 'operator-correction')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES clients(client_id)
);

CREATE INDEX IF NOT EXISTS record_corrections_sequence
  ON record_corrections(record_sequence);

CREATE TABLE IF NOT EXISTS files (
  name TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES clients(client_id)
);

CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  holder_client_id TEXT NOT NULL REFERENCES clients(client_id),
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_intents (
  intent_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  round_id TEXT,
  canonical_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'sent-unverified', 'confirmed', 'abandoned')),
  payload_json TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS application_intents_application
  ON application_intents(application_id, status);

CREATE TABLE IF NOT EXISTS exports (
  export_id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES clients(client_id)
);

INSERT OR IGNORE INTO clients (client_id, name, token_hash, created_at)
VALUES ('system', 'Cloudflare Worker', 'system-no-login', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
