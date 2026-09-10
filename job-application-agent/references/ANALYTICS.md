# Usage analytics

Job Application Agent includes default-enabled, opt-out usage analytics. The purpose is to learn which discovery sources, job types, applicant-tracking systems, and application steps are useful or unreliable.

The first eligible command displays a disclosure. New installations may send that command's events after the disclosure. Existing installations receive a one-command grace period before events begin.

Name and email sharing is also enabled by default, separately from usage analytics. New and upgraded installations receive an identity disclosure; that entire command sends no identity. Starting with the following command, when analytics and identity sharing are enabled, only the explicit `name` and `email` in the saved candidate profile accompany new usage events. The maintainer can use these private PostHog fields for support and product improvement. Agents must show the disclosure to the user before proceeding to another command. Missing, unreadable, or invalid identity falls back to anonymous events. No conversation or résumé extraction is performed by telemetry.

## Controls

```text
node scripts/job-application.mjs telemetry status
node scripts/job-application.mjs telemetry identity status
node scripts/job-application.mjs telemetry identity disable
node scripts/job-application.mjs telemetry identity enable
node scripts/job-application.mjs telemetry disable
node scripts/job-application.mjs telemetry enable
node scripts/job-application.mjs telemetry reset
node scripts/job-application.mjs telemetry preview --stdin
node scripts/job-application.mjs telemetry record --stdin
```

- `identity disable` stops name/email sharing without disabling usage analytics. It clears the analytics UUID and relay credentials; the next eligible event gets a new UUID so future anonymous usage does not share the identified UUID. The command itself sends nothing.
- `identity enable` resumes default-on identity sharing after another disclosure grace command when previously opted out. It rotates the UUID again to avoid attaching identity to the intervening anonymous period. It does not re-enable disabled usage analytics.
- `status` and `identity status` show the UUID and sharing/disclosure flags, never the candidate name/email or relay token. They send nothing and do not acknowledge disclosure.
- `disable` stops all future analytics collection while preserving the installation ID and identity-sharing preference.
- `enable` resumes collection with the same installation ID and preserves the identity-sharing preference.
- `reset` disables collection and removes the anonymous ID and relay token. Enabling later creates a new identity.
- `preview` validates and shows structured event properties without transmitting them. It does not read or display profile identity; identity attachment is controlled separately.
- `record` rejects undocumented events and properties; browser workflows use it for started, step, pause, skip, and round events. Confirmed submissions are emitted by `ledger add` and must not be recorded twice.
- `status`, `disable`, `reset`, and `preview` never transmit an event. After `enable`, collection resumes on the next eligible workflow command.
- Previously collected events remain until the analytics retention period expires. Disabling or resetting does not issue a historical-deletion request.

Telemetry is best effort. It has no offline queue, uses a short network timeout, and never changes the result of a job-application command.

Community sharing is a separate default-enabled feature with independent `sources sharing status|enable|disable|reset` controls. Confirmed applications contribute bounded public job metadata, while repeatable discovery sources use maintainer review. Neither sends analytics events nor stores a raw contributor identity with a record; a record-scoped HMAC is used only for deduplication and unique-system counting. See [`SOURCES.md`](SOURCES.md) for the exact public metadata contracts.

## Identity boundary

The only candidate identity fields allowed are the explicitly saved name and email, under the separately disclosed opt-out control above. They appear only in the validated optional `identity` envelope object (`name`: 1–160 characters; `email`: 1–254 characters with email syntax). Unknown fields and control characters are rejected by both client and relay. They are forwarded as private event properties `candidateName` and `candidateEmail`, keeping the UUID as `distinct_id`. They are never sent to the public aggregate store or community registry, and are never duplicated in local telemetry configuration. Workflow event properties still reject name/email and all other identity fields; `telemetry record` cannot inject an identity object.

Analytics never includes phone, exact address, profile URLs, candidate location, work authorization, personal compensation or compensation floor, target profile or thresholds, resume or attachments, must-have evidence or coverage details, rejection reasons, prompts, responses, job descriptions, form questions, drafted answers, notes, passwords, MFA, CAPTCHA, legal or demographic answers, browser data, IP address, request headers, user agent, or raw error messages.

Opt-out prevents future identity collection; it does not delete or anonymize previously collected events. Before opt-out, events sharing an identified UUID can be linked, including earlier anonymous events for that UUID. UUID rotation is not a historical deletion request and may increase installation-based counts.

Structured job context may include company, role title, canonical destination domain, a SHA-256 hash of the job URL after removing query parameters and fragments, bounded discovery source, ATS/application channel, job country, work mode, employment type, seniority, role family, published salary band, fit score, match/gap categories, workflow stages, field categories, pause reasons, submission result, outcome, bounded interview quality, and bounded interview failure point.

The more specific local `discoverySourceId` catalog attribution is not transmitted in v1.

Local attention details and friction evidence are never transmitted. Analytics may receive only their already-documented bounded stage, ATS, pause reason, result, and aggregate count fields.

Company and title values are bounded and rejected when they resemble an email, phone number, URL, LinkedIn profile, or GitHub profile.

## Event schema

| Event | Structured properties |
|---|---|
| `installation_started` | OS family, Node major version, submission mode |
| `command_completed` | Command category, result, duration bucket |
| `job_discovered` | Company, title, job hash/domain, ATS/source, job country, work mode, seniority, employment type, role family, published salary band |
| `job_assessed` | Company, title, job hash/domain, ATS, fit score, eligibility, decision, match/gap tags |
| `application_started` | Job hash, ATS, approval mode, required-field count, resume/cover-letter/referral requirements |
| `application_step` | Job hash, ATS, stage, field category, retry count, duration bucket |
| `application_paused` | Job hash, ATS, stage, bounded reason |
| `application_skipped` | Job hash, bounded reason, fit score, eligibility |
| `application_submitted` | Company, title, job hash/domain, ATS, duration, fields filled, short-answer count, resume-upload Boolean, approval mode |
| `round_completed` | Requested/submitted/assessed/skipped/paused/error counts, duration bucket |
| `outcome_recorded` | Company, title, job hash/domain, ATS, outcome, days since submission, optional bounded interview quality/failure point |
| `review_generated` | Canonical unique-submission and outcome counts, review-due Boolean |
| `skill_error` | Stable error code, workflow stage, ATS/job hash when available, recoverable Boolean |

Only documented enums, bounded numbers, Booleans, bounded company/title/country strings, and documented tag arrays are accepted. Client and relay both reject unknown properties. Payloads are limited to 4 KB.

## Processing and retention

- A Cloudflare Worker validates events, signs anonymous installation tokens, and forwards accepted payloads.
- PostHog US Cloud stores personless events with `$process_person_profile: false`.
- Every event disables GeoIP enrichment with `$geoip_disable: true`, and the PostHog project discards incoming IP data.
- The project does not call PostHog identify, alias, group, person-property, autocapture, or session-replay features.
- Installation IDs remain stable until reset or an identity-sharing boundary change. An identified UUID is pseudonymous, not anonymous.
- The product retention policy is 24 months and dashboards are private. Dashboard queries exclude data older than 24 months.
- A public usage dashboard exposes only fixed aggregate metrics. It never exposes raw events or anonymous installation IDs, rolls segment counts below three into `other`, and caches results at the edge for 15 minutes.
- After PostHog accepts an event, the relay best-effort increments a separate Cloudflare D1 store containing daily counters and HMAC-derived installation hashes. The public endpoint reads only this aggregate store; it has no PostHog read credential.
- PostHog US Cloud must be configured with a 24-month raw-event TTL before production telemetry is considered fully retention-compliant. The current free project does not expose a self-service raw-event TTL, so the owner must enable that control through an eligible PostHog plan or arrange time-bounded deletion with PostHog. This limitation does not weaken any collection-time identity boundary.
- The Worker does not forward client IPs or request headers, and Worker observability is disabled.

## Release ordering

Deploy the relay with optional identity-envelope support before releasing the CLI. Existing schema-v1 envelopes without identity remain valid; older relays reject the new optional identity field. Then release the CLI and updated disclosures together. This change does not backfill candidate identity from historical ledgers or transmit existing local candidate data during development.
