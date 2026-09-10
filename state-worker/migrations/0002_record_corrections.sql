PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS record_corrections (
  correction_id TEXT PRIMARY KEY,
  record_sequence INTEGER NOT NULL UNIQUE REFERENCES records(sequence),
  reason TEXT NOT NULL CHECK (reason IN ('test-fixture', 'migration-error', 'operator-correction')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES clients(client_id)
);

CREATE INDEX IF NOT EXISTS record_corrections_sequence
  ON record_corrections(record_sequence);
