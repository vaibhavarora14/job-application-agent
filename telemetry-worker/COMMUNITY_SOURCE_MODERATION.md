# Community source moderation

Community source moderation is owner-only and uses D1 directly. There is no public administration endpoint. Run every command against staging first, then repeat it against production only after checking the affected `community-…` source ID.

## Inspect pending sources

This query intentionally omits contributor hashes:

```sql
SELECT sources.source_id, sources.name, sources.base_url, sources.kind,
       sources.regions_json, sources.role_families_json, sources.requires_session,
       COUNT(contributions.contributor_hash) AS unique_contributing_systems,
       sources.first_contributed_at, sources.last_contributed_at
FROM community_sources AS sources
JOIN community_source_contributions AS contributions
  ON contributions.source_id = sources.source_id
WHERE sources.publication_status = 'pending'
GROUP BY sources.source_id
ORDER BY unique_contributing_systems DESC, sources.last_contributed_at DESC;
```

Execute a reviewed statement with the pinned Wrangler version:

```text
npx --yes wrangler@4.122.0 d1 execute job-application-agent-public-stats-staging --remote --config telemetry-worker/wrangler.jsonc --env staging --command "<SQL>"
npx --yes wrangler@4.122.0 d1 execute job-application-agent-public-stats --remote --config telemetry-worker/wrangler.jsonc --command "<SQL>"
```

## Publish a pending source early

Replace the example source ID only after inspecting its canonical URL and metadata:

```sql
UPDATE community_sources
SET publication_status = 'published',
    review_status = 'maintainer-reviewed',
    published_at = COALESCE(published_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_id = 'community-0000000000000000'
  AND publication_status = 'pending';
```

Manually approved public entries are returned as `community-reviewed`.

## Reject a source

```sql
UPDATE community_sources
SET publication_status = 'rejected',
    review_status = 'maintainer-reviewed',
    rejected_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_id = 'community-0000000000000000'
  AND publication_status <> 'rejected';
```

Later contributions remain deduplicated, but a rejected source never republishes automatically.

## Correct canonical metadata during review

First-contributor metadata is immutable through the public contribution API. A maintainer may correct it directly while reviewing the source:

```sql
UPDATE community_sources
SET name = 'Corrected source name',
    kind = 'job-board',
    regions_json = '["global"]',
    role_families_json = '["engineering"]',
    requires_session = 0,
    review_status = 'maintainer-reviewed',
    reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_id = 'community-0000000000000000';
```

Do not query, export, or publish `contributor_hash`. It exists only to count unique contributing systems for a single canonical source and must never be interpreted as a person count.
