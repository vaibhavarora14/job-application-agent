# Discovery source registry

The packaged [`SOURCES.json`](SOURCES.json) catalog is the shared, versioned list of repeatable discovery surfaces available to every installation. It is distinct from application channels such as Greenhouse, Ashby, Lever, and Workday.

## Use the catalog

```text
node scripts/job-application.mjs sources list
node scripts/job-application.mjs sources list --stdin
```

Optional filter input:

```json
{
  "regions": ["india", "global", "remote"],
  "roleFamilies": ["engineering"],
  "kinds": ["job-board", "startup-network"],
  "requiresSession": false
}
```

Treat each catalog entry as a lead source, not an eligibility claim. Resolve every lead to the direct employer or ATS page and verify that posting immediately before assessment and submission. Respect `requiresSession`; do not upload a résumé or transmit profile data merely to unlock discovery unless the candidate has authorized that destination.

Store three independent attribution fields when available:

- `discoverySource`: coarse compatible channel such as `linkedin`, `x`, `yc`, `job-board`, or `user-supplied`.
- `discoverySourceId`: stable catalog ID such as `yc-work-at-a-startup` or `hacker-news-who-is-hiring`.
- `applicationChannel`: actual submission channel such as `greenhouse`, `ashby`, `lever`, `company`, or `email`.

`discoverySourceId` remains local in v1 and is not transmitted by telemetry.

## Grow the catalog safely

Queue only repeatable public discovery surfaces—not one-off company jobs, recruiter profiles, referral links, or personal URLs:

```text
node scripts/job-application.mjs sources suggest --stdin
node scripts/job-application.mjs sources pending
```

Suggestion input:

```json
{
  "name": "Example Engineering Board",
  "baseUrl": "https://jobs.example.org/engineering",
  "kind": "job-board",
  "regions": ["global"],
  "roleFamilies": ["engineering"],
  "requiresSession": false
}
```

Suggestions stay in the owner-only local state directory. To benefit every user, validate that the source is active, repeatable, and useful; then open a sanitized public-registry PR containing only source metadata. Never publish candidate identity, job history, prompts, referral parameters, or private URLs. Released npm updates distribute accepted catalog additions to all installations.
