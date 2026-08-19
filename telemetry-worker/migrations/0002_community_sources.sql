CREATE TABLE IF NOT EXISTS community_sources (
  source_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('direct-employer', 'professional-network', 'social-feed', 'startup-network', 'community-thread', 'job-board', 'curated-board', 'inbound', 'user-supplied')),
  regions_json TEXT NOT NULL,
  role_families_json TEXT NOT NULL,
  requires_session INTEGER NOT NULL CHECK(requires_session IN (0, 1)),
  contribution_count INTEGER NOT NULL DEFAULT 1 CHECK(contribution_count >= 1),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_sources_popular
  ON community_sources(contribution_count DESC, last_seen_at DESC);
