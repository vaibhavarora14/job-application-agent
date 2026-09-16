CREATE TABLE IF NOT EXISTS outreach_meta (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach_opportunities (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach_contents (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach_events (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach_reservations (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach_operations (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach_tombstones (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
