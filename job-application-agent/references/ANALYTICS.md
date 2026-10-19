# Usage analytics

Job Application Agent includes default-enabled, opt-out usage analytics. The purpose is to learn which discovery sources, job types, applicant-tracking systems, and application steps are useful or unreliable.

The first eligible command displays a disclosure and may send that command's events immediately (including upgrades that previously had private state but no `telemetry.json`). Telemetry stays on unless the candidate has explicitly opted out via `telemetry disable`, a `telemetry.opt-out` file in the state directory, or `JOB_APPLICATION_AGENT_TELEMETRY_DISABLED=1` / `JOB_APPLICATION_AGENT_TELEMETRY=0`.

Candidate name, email, phone, and résumé content are never included in analytics / PostHog event payloads.

Separately, the CLI may upsert the saved profile name and email into a private maintainer contact store (`POST /v1/contact`) once per install and again only when the value changes. Contact sharing is skipped when telemetry is opted out, and has its own opt-out (`telemetry contact disable`, `telemetry.contact.opt-out`, or `JOB_APPLICATION_AGENT_CONTACT_DISABLED=1`).

## Controls

```text
node scripts/job-application.mjs telemetry status
node scripts/job-application.mjs telemetry contact status
node scripts/job-application.mjs telemetry contact disable
node scripts/job-application.mjs telemetry contact enable
node scripts/job-application.mjs telemetry identity status
node scripts/job-application.mjs telemetry identity disable
node scripts/job-application.mjs telemetry identity enable
node scripts/job-application.mjs telemetry disable
node scripts/job-application.mjs telemetry enable
node scripts/job-application.mjs telemetry reset
node scripts/job-application.mjs telemetry preview --stdin
node scripts/job-application.mjs telemetry record --stdin
```

- `contact disable` / `contact enable` control the private contact store only. Contact payloads are never attached to PostHog events.
- `identity disable` / `identity enable` are compatibility aliases for the contact controls.
- `status`, `contact status`, and `identity status` show the UUID and sharing/disclosure flags, never candidate name/email or relay tokens. They send nothing.
- `disable` stops all future analytics collection and contact sharing while preserving the installation ID, and writes an explicit opt-out marker.
- `enable` resumes collection with the same installation ID and clears the telemetry opt-out marker.
- `reset` disables collection and removes the anonymous ID, relay token, and queued events. Enabling later creates a new identity.
- `preview` validates and shows structured event properties without transmitting them.
- `record` rejects undocumented events and properties; browser workflows may still use it for step events and as a fallback for lifecycle events. `score` emits `application_started` on `review` and `application_skipped` on skip/exclude. `attention add` emits `application_paused`. Confirmed submissions are emitted by `ledger add`. Duplicate started/paused/submitted events for the same job attempt are ignored.
- `status`, `disable`, `reset`, and `preview` never transmit an event. After `enable`, collection resumes on the next eligible workflow command.
- Previously collected events remain until the analytics retention period expires. Disabling or resetting does not issue a historical-deletion request.

Telemetry is best effort. Failed sends are written to a bounded on-disk queue (size and age limited) and retried on the next command, with modest per-request retry/backoff. Only network errors, HTTP 5xx, and the retryable 4xx statuses (401 after a token refresh, 408, 425, 429) are retried; when the relay rejects one specific event with any other 4xx (for example `400 invalid_event`), or a queued event no longer passes the local schema, that item is moved to a bounded local `telemetry-quarantine.ndjson` (0600, never sent), a one-line warning naming only the event type and relay error code is printed, and the rest of the queue keeps draining. A rejected contact update is dropped the same way; its name and email are never copied into the quarantine. Under `node --test`, and inside GitHub Actions (`GITHUB_ACTIONS` set), the relay endpoints default to an unroutable local address unless `JOB_APPLICATION_AGENT_TELEMETRY_URL` is set, so test and CI runs never reach production. The generic `CI` variable is not used, because agent runtimes often export `CI=true`. Network failures never change the result of a job-application command. Set `JOB_APPLICATION_AGENT_TELEMETRY_DEBUG=1` to log drop reasons.

Community sharing is a separate default-enabled feature with independent `sources sharing status|enable|disable|reset` controls. Confirmed applications contribute bounded public job metadata, while repeatable discovery sources use maintainer review. Neither sends analytics events nor stores a raw contributor identity with a record; a record-scoped HMAC is used only for deduplication and unique-system counting. See [`SOURCES.md`](SOURCES.md) for the exact public metadata contracts.

## Identity boundary

Analytics / PostHog events never include candidate name, email, phone, exact address, profile URLs, candidate location, work authorization, personal compensation or compensation floor, target profile or thresholds, resume or attachments, must-have evidence or coverage details, rejection reasons, prompts, responses, job descriptions, form questions, drafted answers, notes, passwords, MFA, CAPTCHA, legal or demographic answers, browser data, IP address, request headers, user agent, or raw error messages.

The private contact endpoint may store only the explicitly saved profile `name` and `email` (plus install ID, skill version, and timestamps) in `PRIVATE_CONTACTS_DB.install_contacts`. That table is never read by `/v1/jobs`, `/api/public-stats`, or other public routes.

Optional `skill_error` fields may include a short `sanitizedMessage` and `fieldLabel` after stripping emails, phones, query-bearing URLs, and secrets. They never include résumé text or free-form candidate answers.

Structured job context may include company, role title, canonical destination domain, a SHA-256 hash of the job URL after removing query parameters and fragments, bounded discovery source, ATS/application channel, job country, work mode, employment type, seniority, role family, published salary band, fit score, match/gap categories, workflow stages, field categories, pause reasons, submission result, outcome, bounded interview quality, and bounded interview failure point.

Per-application `discoverySourceId` attribution is not transmitted. Round coverage reports send only the allowlisted packaged source IDs from `SOURCES.json`; custom/community IDs are collapsed to `community`. Search evidence, concentration explanations, application IDs, and round IDs stay local.

Local attention details and friction evidence are never transmitted. Analytics may receive only their already-documented bounded stage, ATS, pause reason, result, and aggregate count fields.

Company and title values are bounded and rejected when they resemble an email, phone number, URL, LinkedIn profile, or GitHub profile.

## Event schema

| Event | Structured properties |
|---|---|
| `installation_started` | OS family, Node major version, submission mode |
| `command_completed` | Command category (`onboard`, `search`, `assess`, `apply`, `check`, `delivery`, `attention`, `friction`, `round`, `outcome`, `review`, `resume`, `profile`, `telemetry`, `other`; legacy `batch` still accepted), result, duration bucket |
| `source_checked` | Allowlisted packaged source ID or `community`, searched/blocked status, reviewed/qualified counts, optional bounded blocker |
| `job_discovered` | Company, title, job hash/domain, ATS/source, job country, work mode, seniority, employment type, role family, published salary band |
| `job_assessed` | Company, title, job hash/domain, ATS, fit score, eligibility, decision, match/gap tags |
| `application_started` | Job hash, ATS, approval mode, required-field count, resume/cover-letter/referral requirements |
| `application_step` | Job hash, ATS, stage, field category, retry count, duration bucket |
| `application_paused` | Job hash, ATS, stage, bounded reason |
| `application_skipped` | Job hash, bounded reason, fit score, eligibility |
| `application_submitted` | Company, title, job hash/domain, ATS, duration bucket (or `unknown`), fields filled / short-answer count / résumé Boolean (or `null` when telemetry was omitted), approval mode, `telemetrySupplied`, optional `thinSubmissionOverrideUsed` (sent only as `true`; absent means `false`; no note text), optional `fillMetricsSource` (`telemetry` / `answer_keys` / `empty`) |
| `round_completed` | Requested/submitted/assessed/skipped/paused/error counts, duration bucket; optional attempted/searched/blocked source counts, maximum source share percentage, bounded concentration reason. `submittedCount` and `assessedCount` are ledger application totals only and never include attached outreach. |
| `outcome_recorded` | Company, title, job hash/domain, ATS, outcome, days since submission, optional bounded interview quality/failure point |
| `review_generated` | Canonical unique-submission and outcome counts, review-due Boolean |
| `skill_error` | Stable error code, workflow stage, recoverable Boolean; optional ATS/job hash, `errorCategory`, sanitized message, field label |

Only documented enums, bounded numbers, Booleans, bounded company/title/country strings, and documented tag arrays are accepted. Client and relay both reject unknown properties. Payloads are limited to 4 KB.

`ledger add` accepts `telemetry.durationMs` or `telemetry.startedAt`/`endedAt` so `application_submitted` can report a real per-application duration bucket. When those are absent, the CLI uses a locally remembered `application_started` timestamp for the same job hash when available; otherwise it sends `durationBucket: "unknown"` (never a fabricated `under-1s`). Pass `telemetry.fieldsFilled` and `telemetry.resumeUploaded` on every live confirm (counts and Booleans only; `otpVerified` and `profileResumeOnFile` are also allowed). Unknown non-PII keys are stripped with a warning; PII keys hard-fail. If the agent omits the telemetry block entirely with no answers, analytics send `fieldsFilled`/`shortAnswerCount`/`resumeUploaded` as `null` with `telemetrySupplied: false` and `fillMetricsSource: "empty"` rather than fake zeros. If answers exist but telemetry counts are missing, analytics use answer-key counts with `fillMetricsSource: "answer_keys"` and `telemetrySupplied: false`, and the CLI prints a loud resend warning. Empty answers with missing fill metrics, or `0` fields with no résumé, are rejected for live `ledger add` unless the honest `profile_one_click` + `profileResumeOnFile` path applies, or an attended `thinSubmissionOverride` object (with a unique per-job `candidateConfirmation`) is used under `APPROVE SUBMIT`. `application_submitted` always includes `thinSubmissionOverrideUsed` (Boolean only; never the confirmation note).

Command categories map CLI areas accurately: `ledger add` → `apply`; `ledger check` → `check`; `ledger delivery`/`retry`/`deliveries` → `delivery`; `attention *` → `attention`; `friction *` → `friction`. Legacy `batch` remains schema-valid for queued historical events only.

## Processing and retention

- A Cloudflare Worker validates events, signs anonymous installation tokens, and forwards accepted payloads.
- PostHog US Cloud stores personless events with `$process_person_profile: false`.
- Every event disables GeoIP enrichment with `$geoip_disable: true`, and the PostHog project discards incoming IP data.
- The project does not call PostHog identify, alias, group, person-property, autocapture, or session-replay features.
- Installation IDs remain stable until reset. Historical events may still contain `candidateName` / `candidateEmail` from skill versions 3.4.0–3.7.2; new events never include them.
- The product retention policy is 24 months and dashboards are private. Dashboard queries exclude data older than 24 months.
- A public usage dashboard exposes only fixed aggregate metrics. It never exposes raw events or anonymous installation IDs, rolls segment counts below three into `other`, and caches results at the edge for 15 minutes.
- After PostHog accepts an event, the relay best-effort increments a separate Cloudflare D1 store containing daily counters and HMAC-derived installation hashes. The public endpoint reads only this aggregate store; it has no PostHog read credential.
- PostHog US Cloud must be configured with a 24-month raw-event TTL before production telemetry is considered fully retention-compliant. The current free project does not expose a self-service raw-event TTL, so the owner must enable that control through an eligible PostHog plan or arrange time-bounded deletion with PostHog. This limitation does not weaken any collection-time identity boundary.
- The Worker does not forward client IPs or request headers, and Worker observability is disabled.

## Release ordering

Deploy the relay (which rejects unused `identity` envelope fields) before or with the CLI release. Existing schema-v1 envelopes without identity remain valid. Then release the CLI and updated disclosures together.
