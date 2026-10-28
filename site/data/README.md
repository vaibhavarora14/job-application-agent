# Directory location index

`job-locations.json` is an owner-generated evidence snapshot, separate from community job moderation and contribution history. The legacy `/v1/jobs` and `/api/community-jobs` contracts stay unchanged because older installed agents reject unexpected fields. Only the unlisted `/jobs` page joins this metadata to the current published feed.

## Refresh

From the repository root, run:

```sh
node site/scripts/collect-job-locations.mjs
```

The collector snapshots all published IDs first, then uses read-only public ATS endpoints with four concurrent requests, shared-board caching, timeouts, response limits, and no redirects. It atomically regenerates `job-locations.json` (records only; the site bundles this file) and `job-locations-unresolved.json` (the maintenance queue; never bundled). It never changes publication status or production databases. Review the diff and the printed coverage line before committing the new snapshot.

The site ignores records older than 30 days, so a stale snapshot silently blanks location, workplace and pay for every job. Guards:

- `node site/scripts/check-job-locations-freshness.mjs [--max-days=N]` exits non-zero when the snapshot is older than N days (default 21).
- `.github/workflows/job-locations-refresh.yml` runs daily: when the snapshot is older than 7 days it re-runs the collector and pushes `automation/job-locations-refresh` (opening a PR when Actions may create PRs); when main's snapshot is older than 21 days the run fails so the owner is notified. It never deploys.
- `deploy-site.yml` refuses to deploy a snapshot past the 30-day cutoff.

Sources: [Ashby public postings](https://developers.ashbyhq.com/docs/public-job-posting-api), [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html), [Lever postings](https://github.com/lever/postings-api), and [Workable public job API](https://apply.workable.com).

## Evidence rules and limits

- Match exact ATS job identifier, canonical destination, and normalized role title (tolerating employer location/meta suffixes). The employer board comes from the already-published URL, never from a company-name guess.
- Preserve source location labels, multiple cities, structured country/region values, source URL and UTC check timestamp. Do not geocode guessed office locations.
- Workplace comes from an explicit ATS field, or an unambiguous arrangement at the start of Greenhouse's location label. Never interpret missing `isRemote` or a city address as on-site.
- Compensation comes from the employer only: structured fields first (Ashby `?includeCompensation=true` salary component, Greenhouse `?pay_transparency=true` pay ranges, Lever `salaryRange`), then explicit pay text in the posting (`salary.basis` is `ats` or `text`). When omitted by the employer, salary is left blank; no estimates or benchmarks.
- Employment type (`full-time`, `part-time`, `contract`, `internship`) and experience level (`intern`, `entry`, `mid`, `senior`, `staff`, `executive`) are stored only when the ATS field (Ashby `employmentType`, Greenhouse metadata, Lever `commitment`, Workable type) or the title states them. Unstated values are `null`, never a default.
- Also stored when the ATS gives them: `department`, `team`, the employer's publish date (`postedAt`: Ashby `publishedAt`, Greenhouse `first_published`, Lever `createdAt`, Workable `published`), and `places` / `countryCodes` (ISO 3166-1 alpha-2) used for JSON-LD `jobLocation` and `applicantLocationRequirements`. Regions such as EMEA or NAMER are kept in the label but never turned into a country.
- Unsupported providers, mismatches, missing metadata and failed requests remain unresolved. They still appear in the directory as not specified. The unresolved queue needs page inspection or another verified provider adapter; a failed enrichment is not evidence to reject a job.
- Join only when job ID, URL, company and role still match. Ignore metadata older than 30 days. A subsequent run replaces the snapshot; unresolved jobs do not silently retain stale verified metadata.
- Current coverage is intentionally partial. New jobs get metadata on the next explicit collection run and site deployment, not immediately on submission. A database-backed live enrichment service can replace this snapshot later without breaking the legacy feed.

