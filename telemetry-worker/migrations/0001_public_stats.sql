CREATE TABLE IF NOT EXISTS public_installations (
  installation_hash TEXT PRIMARY KEY NOT NULL,
  installed_at TEXT NOT NULL,
  last_active_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_public_installations_active
  ON public_installations(last_active_at);

CREATE TABLE IF NOT EXISTS public_daily_metrics (
  day TEXT NOT NULL,
  metric TEXT NOT NULL CHECK(metric IN ('jobs_assessed', 'applications_submitted', 'interviews', 'offers', 'ats', 'seniority', 'outcome')),
  segment TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0 CHECK(count >= 0),
  PRIMARY KEY (day, metric, segment)
);

CREATE INDEX IF NOT EXISTS idx_public_daily_metrics_lookup
  ON public_daily_metrics(metric, day);
