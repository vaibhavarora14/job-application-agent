CREATE TABLE IF NOT EXISTS community_jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  application_channel TEXT NOT NULL,
  discovery_source TEXT,
  provider_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_skill_version TEXT NOT NULL,
  last_skill_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS community_job_contributions (
  job_id TEXT NOT NULL REFERENCES community_jobs(job_id) ON DELETE CASCADE,
  contributor_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  PRIMARY KEY (job_id, contributor_hash)
);

CREATE INDEX IF NOT EXISTS idx_community_jobs_recent
  ON community_jobs(last_seen_at DESC, job_id DESC);

CREATE INDEX IF NOT EXISTS idx_community_job_contributions_job
  ON community_job_contributions(job_id, last_seen_at DESC);
