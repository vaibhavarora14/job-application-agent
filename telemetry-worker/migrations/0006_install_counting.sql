-- Installs are counted in the lifetime `installations` total at their first real activity,
-- not at installation_started alone. uncounted = 1 marks a registered installation that is not
-- (or no longer) part of the public total. Existing rows default to 0, i.e. stay counted, and
-- the pre-deploy worker keeps inserting counted rows until the new code is live.
ALTER TABLE public_installations ADD COLUMN uncounted INTEGER NOT NULL DEFAULT 0 CHECK (uncounted IN (0, 1));

-- Installations excluded from the public total by a one-off correction. Rows are marked, never deleted.
CREATE TABLE IF NOT EXISTS public_installation_exclusions (
  installation_hash TEXT PRIMARY KEY NOT NULL,
  correction_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  excluded_at TEXT NOT NULL
);

-- Audit trail of applied corrections (each applies at most once).
CREATE TABLE IF NOT EXISTS public_stats_corrections (
  correction_id TEXT PRIMARY KEY NOT NULL,
  metric TEXT NOT NULL,
  listed_count INTEGER NOT NULL,
  applied_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
