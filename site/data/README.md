# Directory location index

`job-locations.json` is an owner-generated evidence snapshot, separate from community job moderation and contribution history. The legacy `/v1/jobs` and `/api/community-jobs` contracts stay unchanged because older installed agents reject unexpected fields. Only the unlisted `/jobs` page joins this metadata to the current published feed.

## Refresh

From the repository root, run:

```sh
node site/scripts/collect-job-locations.mjs
```

The collector snapshots all published IDs first, then uses read-only public ATS endpoints with four concurrent requests, shared-board caching, timeouts, response limits, and no redirects. It atomically regenerates the index and unresolved queue; it never changes publication status or production databases. Review the diff and coverage before committing/deploying the new snapshot. This is an explicit maintenance command, not a newly scheduled job.

Sources: [Ashby public postings](https://developers.ashbyhq.com/docs/public-job-posting-api), [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html), [Lever postings](https://github.com/lever/postings-api), and [Workable public job API](https://apply.workable.com).

## Evidence rules and limits

- Match exact ATS job identifier, canonical destination, and normalized role title (tolerating employer location/meta suffixes). The employer board comes from the already-published URL, never from a company-name guess.
- Preserve source location labels, multiple cities, structured country/region values, source URL and UTC check timestamp. Do not geocode guessed office locations.
- Workplace comes from an explicit ATS field, or an unambiguous arrangement at the start of Greenhouse's location label. Never interpret missing `isRemote` or a city address as on-site.
- Structured addresses are not remote eligibility restrictions: an employer can label a job “Global” while attaching its headquarters address. The UI states this limitation.
- Compensation is extracted directly from ATS postings (Ashby `descriptionPlain`, Greenhouse `content`, Lever `additionalPlain`, Workable `salary`/`description`) as verified employer pay (`isEstimated: false`). When omitted by the employer, calibrated market benchmark estimates (`isEstimated: true`) are generated based on role domain, seniority, and region.
- Employment type (`full-time`, `contract`, `internship`) and experience level (`intern`, `entry`, `mid`, `senior`, `staff`, `executive`) are structured for candidate directory filtering.
- Unsupported providers, mismatches, missing metadata and failed requests remain unresolved. They still appear in the directory as not specified. The unresolved queue needs page inspection or another verified provider adapter; a failed enrichment is not evidence to reject a job.
- Join only when job ID, URL, company and role still match. Ignore metadata older than 30 days. A subsequent run replaces the snapshot; unresolved jobs do not silently retain stale verified metadata.
- Current coverage is intentionally partial. New jobs get metadata on the next explicit collection run and site deployment, not immediately on submission. A database-backed live enrichment service can replace this snapshot later without breaking the legacy feed.

