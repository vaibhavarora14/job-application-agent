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

`sources list` combines the packaged catalog with the live community registry. Public v1 community entries are always maintainer-approved and have `registryStatus: "community-reviewed"`. They include a `communitySourceId` and remain discovery leads, not endorsements or eligibility claims. Resolve every lead to the direct employer or ATS page and verify that posting immediately before assessment and submission. Respect `requiresSession`; do not upload a résumé or transmit profile data merely to unlock discovery unless the candidate has authorized that destination.

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
  "baseUrl": "https://jobs.example.org/openings/engineering",
  "kind": "job-board",
  "regions": ["global"],
  "roleFamilies": ["engineering"],
  "requiresSession": false
}
```

The first contribution displays a disclosure and sends during that command. `disable` stops future sharing; `enable` resumes it; `reset` disables sharing and removes its anonymous relay credentials. The source-sharing preference and anonymous credential are stored in an owner-only local file.

The client and relay use the same fail-closed source-route classifier. They remove query parameters and fragments; reject credentials, identity-like names and paths, personal profiles, local/private hosts, unknown fields, oversized payloads, and known detail routes from Workday, LinkedIn Jobs, Greenhouse, Lever, Ashby, Workable, and SmartRecruiters. Unknown domains are accepted only at the root or on explicit collection, directory, feed, careers, openings, or job-index routes. Only the source name, canonical public base URL, kind, regions, role families, and session requirement are shared.

The raw anonymous installation ID authenticates and rate-limits a request but is never stored in the registry. The relay stores a source-scoped HMAC only to deduplicate contributions and help a maintainer prioritize review. One system contributes at most once to a canonical source, and `contributionCount` always means unique contributing systems—not people. It is never identity, trust, authority, or a condition for publication. The first valid contribution owns the canonical metadata; later contributions cannot rewrite it.

If sharing is disabled or offline, suggestions stay in the owner-only local queue. `sources pending` reports only these locally unsent suggestions; it does not expose server moderation status. `sources sync` retries locally unsent suggestions, and `sources list` performs a best-effort retry before reading the community registry. A server-accepted contribution is considered delivered even while its source is pending publication. Network failure never blocks discovery or an application.

Every accepted community contribution remains in the private pending queue until an owner explicitly approves it with the owner-only D1 moderation commands. Rejected sources remain hidden after later contributions and cannot republish automatically. Maintainer commands and metadata-correction procedures are documented in [`telemetry-worker/COMMUNITY_SOURCE_MODERATION.md`](https://github.com/vaibhavarora14/job-application-agent/blob/main/telemetry-worker/COMMUNITY_SOURCE_MODERATION.md). Never publish candidate identity, job history, prompts, referral parameters, private URLs, contributor hashes, or one-off jobs.
