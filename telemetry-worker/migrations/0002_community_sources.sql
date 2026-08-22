CREATE TABLE IF NOT EXISTS community_sources (
  source_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('direct-employer', 'professional-network', 'social-feed', 'startup-network', 'community-thread', 'job-board', 'curated-board', 'inbound', 'user-supplied')),
  regions_json TEXT NOT NULL,
  role_families_json TEXT NOT NULL,
  requires_session INTEGER NOT NULL CHECK(requires_session IN (0, 1)),
  publication_status TEXT NOT NULL DEFAULT 'pending' CHECK(publication_status IN ('pending', 'published', 'rejected')),
  review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_status IN ('unreviewed', 'maintainer-reviewed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  first_contributed_at TEXT NOT NULL,
  last_contributed_at TEXT NOT NULL,
  published_at TEXT,
  reviewed_at TEXT,
  rejected_at TEXT
);

CREATE TABLE IF NOT EXISTS community_source_contributions (
  source_id TEXT NOT NULL REFERENCES community_sources(source_id) ON DELETE CASCADE,
  contributor_hash TEXT NOT NULL,
  first_contributed_at TEXT NOT NULL,
  last_contributed_at TEXT NOT NULL,
  PRIMARY KEY (source_id, contributor_hash)
);

CREATE INDEX IF NOT EXISTS idx_community_sources_publication
  ON community_sources(publication_status, last_contributed_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_source_contributions_source
  ON community_source_contributions(source_id, last_contributed_at DESC);
