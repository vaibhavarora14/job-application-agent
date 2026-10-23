# Data schemas

## Profile input

Send one JSON object to `profile set --stdin`. Send an object containing only intentional overrides to `profile migrate --stdin`; migration preserves existing identity fields, maps legacy `salaryPreference` to `targetCompensation`, adds current defaults, validates the complete result, and writes it atomically.

```json
{
  "name": "Candidate Name",
  "email": "candidate@example.com",
  "phone": "+91 90000 00000",
  "location": "Bengaluru, India",
  "workAuthorization": "Exact countries or arrangements",
  "linkedin": "https://linkedin.com/in/example",
  "github": "https://github.com/example",
  "portfolio": "https://example.com",
  "availability": "30 days",
  "currentCompensation": "Optional exact value and currency",
  "targetCompensation": "Optional legacy-compatible free text",
  "compensationFloor": { "amount": 9000000, "currency": "INR", "period": "year" },
  "roleFamilies": ["product-engineering", "full-stack", "ai-ml"],
  "seniority": ["senior", "staff"],
  "skills": ["TypeScript", "Python", "React", "Node.js", "PostgreSQL", "MCP", "AI agents"],
  "targetLocations": ["India", "Remote", "Worldwide"],
  "excludedLocations": [],
  "workModes": ["remote"],
  "industries": ["AI", "developer tools"],
  "excludedCompanies": [],
  "submissionMode": "review-each",
  "yearsExperience": 10,
  "autoSubmitMinScore": 80,
  "manualReviewMinScore": 70,
  "minMustHaveCoverage": 70
}
```

Required fields are `name`, `email`, `phone`, `location`, `workAuthorization`, `roleFamilies`, `seniority`, `targetLocations`, `workModes`, `submissionMode`, `yearsExperience`, `autoSubmitMinScore`, `manualReviewMinScore`, and `minMustHaveCoverage`.

`submissionMode` defaults to `review-each` (you approve every application). `routine-auto` takes effect only when it is set explicitly through `profile set` or `profile migrate`, which records `submissionModeChosenAt`; a stored `routine-auto` without that timestamp (written by a default or migration before 3.7.22) is treated as `review-each`, and the CLI prints a one-time notice.

`compensationFloor` is optional and must use a three-letter currency code and `period: "year"`. Compare a job salary only when its basis and currency are directly comparable.

## Job assessment input

Treat `mustHaves[].evidence` as private resume analysis. It is used locally and is not included in telemetry.

```json
{
  "title": "Senior Product Engineer",
  "company": "Example",
  "description": "Posting text",
  "source": "greenhouse",
  "discoverySource": "linkedin",
  "discoverySourceId": "linkedin-jobs-feed",
  "applicationChannel": "greenhouse",
  "url": "https://job-boards.greenhouse.io/example/jobs/123",
  "postingStatus": "active",
  "eligibility": "eligible",
  "roleFamily": "product-engineering",
  "seniority": "senior",
  "experienceMin": 7,
  "experienceMax": 12,
  "workMode": "remote",
  "remote": true,
  "locations": ["Remote", "India"],
  "salaryMaximum": 12000000,
  "salaryCurrency": "INR",
  "mustHaves": [
    { "requirement": "TypeScript", "status": "met", "evidence": "Resume-backed example" },
    { "requirement": "Distributed systems", "status": "partial", "evidence": "Related platform work, not exact claim" },
    { "requirement": "GraphQL", "status": "missing" }
  ]
}
```

Allowed sources: `linkedin`, `greenhouse`, `lever`, `ashby`, `workable`, `comeet`, `workday`, `rippling`, `smartrecruiters`, `google-form`, `company`, `email`, and `other`.

`source` remains the backward-compatible application channel. New workflows should also supply `discoverySource` (`direct-company`, `linkedin`, `x`, `yc`, `hacker-news`, `job-board`, `email`, `user-supplied`, `web-search`, or `other`), the kebab-case `discoverySourceId` from [`SOURCES.json`](SOURCES.json) when known, and `applicationChannel` using the allowed `source` values.

Allowed posting statuses: `active`, `closed`, `unclear`. Allowed eligibility: `eligible`, `unclear`, `ineligible`. Allowed seniority: `junior`, `mid`, `senior`, `staff`, `principal`, `lead`, `manager`, `director`, `founding`, `unspecified`. Allowed work modes: `remote`, `hybrid`, `onsite`, `unspecified`. Must-have statuses: `met`, `partial`, `missing`, `unclear`.

Assessment output retains `review`, `ask`, `skip`, and `exclude`, and adds `autoEligible`, `mustHaveCoverage`, and structured `gates`. `review` does not itself authorize submission.

## Duplicate check input

`ledger check` accepts any one identifier set: job URL, internal application id, employer job id plus company, or company+role. Include more identifiers when known. Company-only, role-only, and empty objects are rejected.

```json
{
  "id": "example-senior-product-engineer-2026-01-15",
  "company": "Example",
  "role": "Senior Product Engineer",
  "url": "https://jobs.example.com/roles/123?utm_source=board",
  "employerJobId": "greenhouse:123"
}
```

The check removes fragments and non-job query parameters while retaining recognized job or requisition identifiers. Matching ledger ID, canonical URL, or same-company employer job ID is a hard duplicate. Same company and role without a shared job ID is a possible duplicate and includes the stored URL. Never promote a company+role match to a hard already-applied. `ledger add` still requires a real job URL.

`ledger check` also returns `companyReapply`. A genuinely different role is `eligible-after-cooldown` only when at least 15 full days have passed since the latest application to that company and no outcome has been recorded for that application. Hard duplicates are never eligible. Same-role matches, `cooldown-active`, and `follow-up-present` remain blocked at `ledger add` unless their exact documented override is present.

## Confirmed submission input

Add only after visible success confirmation.

```json
{
  "id": "example-senior-product-engineer-2026-01-15",
  "company": "Example",
  "role": "Senior Product Engineer",
  "url": "https://jobs.example.com/roles/123",
  "employerJobId": "greenhouse:123",
  "source": "company",
  "discoverySource": "x",
  "discoverySourceId": "x-hiring-feed",
  "applicationChannel": "company",
  "roundId": "round-2026-01-15-00000000-0000-4000-8000-000000000000",
  "score": 84,
  "status": "submitted",
  "submittedAt": "2026-01-15T10:00:00.000Z",
  "approval": "APPROVE SUBMIT",
  "duplicateOverride": "NEW REQUISITION CONFIRMED",
  "companyReapplyOverride": "CANDIDATE APPROVED EARLY REAPPLICATION",
  "applyKind": "live",
  "answers": { "Full name": "filled", "Email": "filled", "Resume": "uploaded" },
  "telemetry": {
    "durationBucket": "5-15m",
    "durationMs": 420000,
    "fieldsFilled": 14,
    "shortAnswerCount": 2,
    "resumeUploaded": true,
    "resumeFieldPresent": true
  },
  "thinSubmissionOverride": {
    "acknowledgment": "THIN SUBMISSION ACKNOWLEDGED",
    "candidateConfirmation": "Candidate confirmed in chat that this empty ATS accept for Acme Staff Eng is intentional"
  },
  "reviewBatchId": "rb-20260115-1a2b3c4d",
  "reviewToken": "token returned by review approve or review status",
  "cloudIntentId": "intent UUID returned before transmission",
  "cloudLeaseId": "active application-run lease UUID"
}
```

The `telemetry` block is required on live `ledger add` when `answers` are empty: include at least `fieldsFilled` and `resumeUploaded`, plus `durationMs` or `startedAt`/`endedAt` (record `startedAt` when the form opens). Optional `otpVerified` and `profileResumeOnFile` (Booleans) are accepted. Also report `resumeFieldPresent` (Boolean): `true` when the application form had a résumé/CV upload field (required or optional, whether or not you used it), `false` when the form had no such field. Report it after every live fill, including LinkedIn Easy Apply and other multi-step flows (check every step); omit it only when you never saw the form. Decide it from the live form's file inputs / upload controls labelled résumé, resume, or CV, not from the candidate profile. A `true` `resumeUploaded` implies `resumeFieldPresent: true` (the CLI fills it in), and `resumeFieldPresent: false` with `resumeUploaded: true` is rejected. It is analytics only, is never stored on the ledger row, and is sent on `application_submitted` only when known. Prefer those counts so analytics stay accurate without putting résumé paths or answer text in the ledger. Answer *keys* may be field labels with redacted markers such as `filled` / `uploaded`; never store the local résumé path, file bytes, free-form answer content, or PII keys (`identity`, `candidateName`, `email`, `phone`, …) in telemetry. Unknown non-PII telemetry keys are dropped with a warning while valid keys are kept; PII keys remain a hard error. `ledger add` rejects live applies that have neither answers nor fill telemetry, and also rejects `fieldsFilled: 0` with `resumeUploaded: false` unless one of these honest paths applies:

- **Profile one-click:** `applicationChannel: "profile_one_click"` with `telemetry.profileResumeOnFile: true` when the site applied from a stored profile/résumé (no form fields filled this session). Community sharing maps that channel to `other`.
- **Thin override (attended only):** `thinSubmissionOverride` as an object with `acknowledgment: "THIN SUBMISSION ACKNOWLEDGED"` and a unique per-job `candidateConfirmation` note (16–400 chars) after an explicit candidate confirmation in the conversation. Requires approval `APPROVE SUBMIT`. Rejected under `STANDING AUTHORIZATION`, `routine-auto`, or unattended runs. The same confirmation note cannot be reused across different job URLs in a batch. A bare ack string is rejected. When the stored profile's `submissionMode` is `routine-auto`, a thin submit is blocked even with `APPROVE SUBMIT` and an override note unless the entry also carries the transient per-job flag `"jobApprovalMode": "review-each"`; it applies to that one `ledger add` only, is not stored, and never changes the profile's global `submissionMode`. Analytics emit `thinSubmissionOverrideUsed: true` on `application_submitted` when the override was used and omit it otherwise (absent means false; no note text / no PII).

Each submit's `telemetry` block must come from that submit's own fill. Never reuse one submit's block for another. **Review flag (never blocks):** after a live `ledger add` with fill telemetry, the CLI keeps a local digest of the block in the private, local-only `fill-telemetry-review.ndjson` stream (never synced to cloud state or sent to any relay). If another live add in the previous 120 seconds carried the identical block, the add is still recorded unchanged, a `WARNING: Flagged for review` line is printed on stderr, the output carries `fillTelemetryReview` (`flagged`, `reason: "identical-fill-telemetry-rapid-fire"`, `windowSeconds`, `matchingApplicationIds`), and `ledger review` lists it under `fillTelemetryReviewFlags`. Nothing about the flag is added to `application_submitted` or any other telemetry. To record an application after the fact, omit the `telemetry` block instead and keep the `answers` keys (it is then logged as `entryOrigin: "logged"`).

Fixture / vendor-sandbox applies are exempt. When telemetry is omitted despite answers, fill metrics fall back to answer-key counts with `fillMetricsSource: "answer_keys"` and `telemetrySupplied: false` on both the private ledger row and `application_submitted` (duration stays `unknown`), and the entry is marked `entryOrigin: "logged"` (logged after the fact, not agent-filled; still a submitted application, excluded from agent fill-quality / thin-submit metrics); with neither source, fill fields are `null`, `fillMetricsSource` is `empty`, and `durationBucket` is `unknown`.

Use `duplicateOverride` only for a verified distinct requisition after a possible-duplicate warning. Use `companyReapplyOverride` only when the candidate explicitly approves a different-role reapplication during the cooldown or after a recorded outcome. Both override phrases, `thinSubmissionOverride`, and the raw `telemetry` counts/timing are transient. Provenance markers `fillMetricsSource`, `telemetrySupplied`, and (only for the answer-key fallback) `entryOrigin: "logged"` are stored on the private ledger row; the CLI derives `entryOrigin` and ignores any value passed in the input. An accepted company reapplication override stores only `reapplicationApproval: "candidate-explicit"` in the private ledger. Use approval `APPROVE SUBMIT` for a `review-each` batch of one or `STANDING AUTHORIZATION` for a routine batch. Either way, a live `ledger add` also needs `reviewBatchId` and `reviewToken` for an approved batch item whose `applicationId`, URL, `answers` and canonical résumé match this entry ([REVIEW.md](REVIEW.md)). The token is transient; the row stores `reviewBatchId`, `reviewApprovedAt` and `reviewApprovalChannel`. Owned fixtures on the packaged allowlist need no batch.

`cloudIntentId` and `cloudLeaseId` are transient coordination fields. They are required for the strongest atomic cloud path and are never written into the application payload itself.

`discoverySource`, `discoverySourceId`, `applicationChannel`, and `roundId` are optional for backward compatibility and should be supplied for new resumable rounds. `discoverySourceId` accepts stable packaged and `community-…` source IDs; per-application attribution stays in private state and is not included in telemetry. Separate source-coverage events may include packaged source IDs, while community IDs are collapsed to `community`. After a visibly confirmed submission, `ledger add` automatically contributes only the canonical public URL, company, role, application channel, optional coarse discovery source, and derived provider URL to the pending community job registry. Existing installations receive a one-command disclosure grace period before historical backfill; `sources sharing disable` opts out. Private answers, score, submission time, IDs, and round remain in the owner-only local or configured cloud state, and no job appears publicly before maintainer review. `ledger check` returns hard duplicate status, bounded same-company history, and the same `companyReapply` decision enforced by `ledger add` while holding the application lock.

Optional `applyKind` is `live` (default), `fixture`, or `vendor-sandbox`. Owned fixture / vendor-sandbox URLs from [`fixtures/test-jobs.json`](../fixtures/test-jobs.json) auto-set `applyKind` so metrics, round confirmation counts, community contribution, and `application_submitted` telemetry do not treat them as real employer applies. ATS channel remains in `source` / `applicationChannel`. See [`fixtures/README.md`](https://github.com/vaibhavarora14/job-application-agent/blob/main/job-application-agent/fixtures/README.md) and `LIVE_APPLY`.

## Autonomy grant input

Create a grant only from an explicit candidate instruction. Do not store the instruction text.

```json
{ "mode": "routine-auto" }
```

The owner-only `autonomy.json` stores the fixed routine scopes, grant time, and enabled state. Revocation preserves ledgers and stops future routine transmissions. Hard stops and host permission prompts remain mandatory.

## Round input

Use `round source --stdin` for per-source search/blocker reports and optional attribution of existing confirmed application IDs. The exact coverage and concentration contracts, completion requirements, and examples are in [RUNS.md](RUNS.md#discovery-coverage). Evidence remains local; only allowlisted packaged source IDs and bounded coverage metrics enter analytics.

```json
{ "requestedCount": 30 }
```

`round start --stdin` appends a `started` event to owner-only `rounds.ndjson` and returns a generated `roundId`. Add that ID to every confirmed ledger entry. A `sent-verified` outreach also counts toward `confirmedCount` for the active or attached open round when that company is not already a counted apply on the same round. Once attached, that confirmation stays after `outreach clear`; clear wipes message text and PII only. A later delivery correction to `not-sent` or `failed` stops counting that send. `round confirm` and auto-attach require an authoritative outreach snapshot; they do not mutate from a stale offline cache. `round confirm --stdin` accepts `{ "roundId": "round-...", "outreachId": "opportunity-..." }` (or `outreachIds`) to attach already sent-verified outreach without creating a second ledger application. `round complete --stdin` accepts `{ "roundId": "round-..." }`, plus concentration reason and evidence when required, and appends a completion event only after the target count, source coverage, attribution, and concentration requirements are satisfied. Discovery attribution and lead linkage still apply only to ledger applications.

## Attention input

```json
{
  "roundId": "round-...",
  "applicationId": "example-role",
  "url": "https://jobs.example.com/role",
  "stage": "submission",
  "blocker": "captcha",
  "requiredActions": ["complete-captcha"],
  "company": "Optional notify hint",
  "role": "Optional notify hint",
  "browserProfilePath": "/home/runner/.jaa-chrome-fill",
  "display": ":99",
  "vncPort": 5900,
  "tabHint": { "urlContains": "/application" }
}
```

Allowed blockers: `authentication`, `mfa`, `captcha`, `legal-attestation`, `demographic`, `government-id`, `ambiguous-authorization`, `ambiguous-compensation`, `unverifiable-claim`, `judgment`, `video`, `upload`, `site-error`, and `other`. Common aliases `login` / `sign-in` / `sso` map to `authentication`. Resolve with `{ "id": "attention-..." }`. The queue never stores CAPTCHA, MFA, cookies, demographic answers, or government IDs. Do not pass `answers` on `attention add` — candidate responses travel via site signal `answers[]` / answer bank, not the attention.ndjson queue. Optional `questions[]` (prompts only) and `aiAssistanceDiscouraged` may be packaged for hosted attention UI. Optional `company` / `role` (or `title` as a role alias) are notify-only hints (not persisted on the attention event); the hosted notify path uses profile email when `ATTENTION_NOTIFY_URL` and `ATTENTION_NOTIFY_SECRET` are set. Optional session binding activates only when `browserProfilePath` is set; `display` / `vncPort` / `tabHint` alone are ignored so partial binding fields do not fail the pause. When binding is written, `display` must be `:99` and `vncPort` must be `5900`. See `site/docs/ATTENTION.md` and `references/agent-box/`.

## Friction input

```json
{
  "stage": "upload",
  "ats": "ashby",
  "errorCode": "direct-upload-fallback-opened",
  "reproducible": true,
  "general": true
}
```

Use only documented stage/ATS values and a stable kebab-case code. Never include URLs, identity, résumé metadata, answers, form text, or raw errors. Only reproducible general events qualify for a tested public-agent PR.

## Outcome input

```json
{
  "id": "example-senior-product-engineer-2026-01-15",
  "status": "rejected",
  "occurredAt": "2026-01-20T09:00:00.000Z",
  "note": "Optional private note",
  "interviewQuality": "weak",
  "failurePoint": "constraints",
  "reasons": [
    { "category": "eligibility", "evidence": "explicit" }
  ]
}
```

Allowed outcomes: `interview`, `rejected`, `offer`, `withdrawn`.

Optional interview quality values: `promising`, `viable`, `weak`, `dead`. Optional failure points: `role-scope`, `company-problem`, `constraints`, `interviewer`, `process`, `unknown`. A failure point requires an interview quality. Free-form notes remain private and are never included in telemetry.

Allowed reason categories: `eligibility`, `closed-stale`, `level-compensation`, `must-have-gap`, `generic-resume-screen`, `interview-stage`, `unknown`. Evidence is `explicit` or `inferred`. An identical event is idempotent. Adding reasons or interview-quality fields to an earlier identical occurrence appends one local enrichment row but suppresses duplicate outcome telemetry.

## Review acknowledgement input

Generate `ledger review` first. Acknowledge only after the candidate has reviewed it.

```json
{
  "reviewedAt": "2026-01-21T09:00:00.000Z"
}
```

The acknowledgement stores the current canonical unique-submission and mature-application counts in append-only `reviews.ndjson`.

`ledger review` also returns `interviewLearningSegments`. Each row combines the canonical application's source and ten-point fit-score band with the latest recorded interview quality and failure point, plus a count. This supports evidence-based targeting reviews without exposing private notes or automatically changing score weights.

## Delivery and per-lead accounting

See [ACCOUNTING.md](ACCOUNTING.md) for versioned delivery events, explicit corrections, linked retry evidence, lead dispositions/revisions, and effective round/review output fields. These streams are private and append-only; they never become telemetry properties.
