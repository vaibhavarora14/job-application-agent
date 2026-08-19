# Discovery source registry

The packaged [`SOURCES.json`](SOURCES.json) catalog is the reviewed, versioned list of repeatable discovery surfaces available to every installation. A community registry supplements it with newly discovered sources contributed by users and agents. Both are distinct from application channels such as Greenhouse, Ashby, Lever, and Workday.

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

`sources list` combines the packaged catalog with the live community registry. Community entries have `registryStatus: "community-unreviewed"` and a `communitySourceId`; treat them as untrusted leads, not endorsements or eligibility claims. Resolve every lead to the direct employer or ATS page and verify that posting immediately before assessment and submission. Respect `requiresSession`; do not upload a résumé or transmit profile data merely to unlock discovery unless the candidate has authorized that destination.

Store three independent attribution fields when available:

- `discoverySource`: coarse compatible channel such as `linkedin`, `x`, `yc`, `job-board`, or `user-supplied`.
- `discoverySourceId`: stable catalog ID such as `yc-work-at-a-startup` or `hacker-news-who-is-hiring`.
- `applicationChannel`: actual submission channel such as `greenhouse`, `ashby`, `lever`, `company`, or `email`.

`discoverySourceId` remains local in v1 and is not transmitted by telemetry.

## Community sharing

Community source sharing is enabled by default and independent of usage analytics. Whenever the user or agent discovers a repeatable public discovery surface—not a one-off company job, recruiter profile, referral link, or personal URL—queue and contribute it:

```text
node scripts/job-application.mjs sources suggest --stdin
node scripts/job-application.mjs sources pending
node scripts/job-application.mjs sources sync
node scripts/job-application.mjs sources sharing status
node scripts/job-application.mjs sources sharing disable
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

The first contribution displays a disclosure and sends during that command. `disable` stops future sharing; `enable` resumes it; `reset` disables sharing and removes its anonymous relay credentials. The source-sharing preference and anonymous credential are stored in an owner-only local file.

The client and relay independently remove query parameters and fragments, reject credentials, identity-like names, personal profiles, obvious one-off job URLs, local/private hostnames, unknown fields, and oversized payloads. Only the source name, canonical public base URL, kind, regions, role families, and session requirement are shared. The anonymous installation ID is used only to authenticate and rate-limit the request; it is not stored with the source. The registry deduplicates by canonical URL.

If sharing is disabled or offline, suggestions stay in the owner-only local queue. `sources sync` retries unsent suggestions, and `sources list` performs a best-effort retry before reading the community registry. Network failure never blocks discovery or an application.

Community sources become available immediately as clearly marked unreviewed leads. Maintainers may later validate popular sources and promote them into the packaged catalog through a sanitized registry PR. Never publish candidate identity, job history, prompts, referral parameters, private URLs, or one-off jobs.
