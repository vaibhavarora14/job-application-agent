import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { dataDir } from './paths.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  motivation_blurb TEXT,
  how_heard TEXT,
  authorized_without_sponsorship TEXT,
  needs_sponsorship TEXT,
  willing_to_relocate TEXT,
  resume_path TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  employer_job_id TEXT,
  application_channel TEXT NOT NULL,
  discovery_source TEXT NOT NULL,
  locations TEXT,
  salary_maximum INTEGER,
  salary_currency TEXT,
  work_mode TEXT,
  questions_json TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assessments (
  job_id TEXT PRIMARY KEY,
  decision TEXT NOT NULL,
  score INTEGER,
  auto_eligible INTEGER NOT NULL DEFAULT 0,
  must_have_coverage INTEGER,
  payload_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  provider TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  round_id TEXT,
  status TEXT NOT NULL,
  url TEXT NOT NULL,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  confirmation_url TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answers (
  fingerprint TEXT PRIMARY KEY,
  channel TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attention (
  id TEXT PRIMARY KEY,
  application_id TEXT,
  job_id TEXT,
  url TEXT NOT NULL,
  stage TEXT NOT NULL,
  blocker TEXT NOT NULL,
  instructions TEXT NOT NULL,
  live_view_url TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS browser_sessions (
  id TEXT PRIMARY KEY,
  application_id TEXT,
  status TEXT NOT NULL,
  live_view_url TEXT,
  last_heartbeat TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_queue (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  requested_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

let cached;

export function openDb(env = process.env) {
  if (cached && !env.CLOUD_DB_PATH && !env.CLOUD_DATA_DIR) return cached;
  const file = env.CLOUD_DB_PATH || join(dataDir(env), 'cloud.sqlite');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  if (!env.CLOUD_DB_PATH && !env.CLOUD_DATA_DIR) cached = db;
  return db;
}

export function closeDb() {
  if (cached) {
    cached.close();
    cached = undefined;
  }
}

export function nowIso() {
  return new Date().toISOString();
}
