# Changelog

## 3.7.10

- Fix lost submission analytics in 3.7.9: `application_submitted` always carried the new `thinSubmissionOverrideUsed` Boolean, and the production telemetry relay (deployed before that key existed) rejects unknown properties, so every 3.7.9 submission event was dropped (HTTP 400) and stuck in the local retry queue. `thinSubmissionOverrideUsed` is now optional and only sent when `true` (absent means `false`); events already queued by 3.7.9 with `false` are cleaned before resend so they drain. No change to the thin-submit guard: thin overrides stay blocked in routine-auto / unattended / `STANDING AUTHORIZATION` runs.

## 3.7.9

- Harden empty-submit protection: reject `thinSubmissionOverride` under `routine-auto` / unattended / `STANDING AUTHORIZATION`; require an object with `acknowledgment` plus a unique per-job `candidateConfirmation` note (no bare ack string; no reuse across jobs in a batch); require `APPROVE SUBMIT`.
- Add honest one-click path `applicationChannel: "profile_one_click"` with `telemetry.profileResumeOnFile: true` for stored-profile applies (e.g. hirist.tech); community sharing maps that channel to `other`.
- Emit `thinSubmissionOverrideUsed` (Boolean, no note text) on every `application_submitted` event for daily quality checks.
- SKILL / AUTONOMY / SCHEMAS / ANALYTICS: remove wording that invited agents to auto-ack thin submits; state the override is only for an explicit, per-job candidate confirmation in the conversation.

## 3.7.8

- Soften unknown `entry.telemetry` keys on `ledger add`: strip and warn instead of rejecting the whole block; keep PII keys (`identity`, `candidateName`, `email`, …) as hard errors; accept optional `otpVerified` Boolean.
- When fill metrics fall back to answer keys, store and emit `fillMetricsSource: "answer_keys"` with `telemetrySupplied: false`, and print a loud stderr warning to resend real telemetry (avoid silent 7-field / unknown-duration analytics).
- SKILL.md: on telemetry validation errors, fix only the named key and retry — never drop the entire telemetry block.

## 3.7.7

- Publish the installer `apply <url>` command (review-mode prompt printer) so `npx job-application-agent@latest apply <url>` works after this release.
- Batched job-liveness sweep in the telemetry Worker (oldest-checked first, ~50 fetches + D1 `batch` writes per run, cron every 15 minutes) with open/closed/unknown logging, an authenticated admin trigger, and generic HTML checks for non-ATS postings.
- `/v1/jobs/live` responses include `meta.newestLastCheckedAt` for staleness monitoring.

## 3.7.6

- When `application_submitted` has no telemetry block, send `fieldsFilled`/`shortAnswerCount`/`resumeUploaded` as `null`, `durationBucket: "unknown"`, and `telemetrySupplied: false` instead of fabricated zeros / `under-1s`.
- Derive submission duration from `telemetry.startedAt`/`endedAt`/`durationMs`, or a locally remembered `application_started` timestamp; otherwise send `unknown`.
- Relabel command telemetry: `attention` / `friction` / `ledger check` / `ledger delivery|retry|deliveries` no longer collapse into `batch` or `apply`; schema and ANALYTICS docs match.
- Make the ledger-add `telemetry` block (`fieldsFilled`, `resumeUploaded`, timing) mandatory in SKILL.md (and packaging copies).
- Confirm live `ledger add` still rejects entries with neither answers nor fill telemetry; add HighLevel-style same-company cooldown coverage.

## 3.7.5

- Require `telemetry.fieldsFilled` and `telemetry.resumeUploaded` on live `ledger add` when `answers` are empty, so `application_submitted` no longer defaults to 0 fields / no résumé when agents omit fill metrics.
- Block live submits that report 0 fields and no résumé unless `thinSubmissionOverride: "THIN SUBMISSION ACKNOWLEDGED"` (true empty ATS accepts only); fixture / vendor-sandbox applies stay exempt.
- Derive fill metrics from answer *keys* when present, and document count-only telemetry (no paths or answer text).
- Fix attention/`batch` `invalid_input` from partial session-binding fields: only write a binding when `browserProfilePath` is set; map common blocker/action aliases; reject `answers` on attention add with a clear message; surface display/VNC binding errors as actionable invalid input.
- Confirm setup `internal_error` on v3.7.2 was the cloud `Usage:` mislabel fixed in 3.7.3 (`invalid_input` + `errorCategory=usage`); keep the regression coverage.

## 3.7.4

- Emit `application_started` from `score` when the decision is `review`, and emit `application_paused` from `attention add`, so those events no longer depend on the browser workflow remembering `telemetry record`.
- Deduplicate `application_started` / `application_paused` per job attempt when the skill also calls `telemetry record`.
- Reject unused `identity` keys on telemetry event envelopes (analytics keep install id + schema fields only).

## 3.7.3

- Treat corrupt `telemetry.json` as enabled (unless an explicit opt-out file/env/`telemetry disable`), and rewrite the file instead of permanently disabling analytics.
- Send the first command after disclosure and on upgrades that lack `telemetry.json`, including the install event (no more dropped grace-period command).
- Persist a bounded on-disk telemetry queue with modest retry/backoff so one failed send no longer drops the rest of the command; debug-log each drop reason.
- Debug-log schema-invalid events and emit a `skill_error` counter with `errorCategory=schema_invalid` (no invalid payload).
- Start the telemetry session before cloud-state preparation so failures still emit `skill_error` / `command_completed`.
- Emit domain events (`job_assessed`, `application_submitted`, `application_skipped`, round/source coverage, etc.) as they happen instead of only after the command finishes.
- Stop sending candidate name/email on PostHog analytics event payloads; relay no longer forwards `candidateName` / `candidateEmail`.
- Add a private contact store (`POST /v1/contact` → `PRIVATE_CONTACTS_DB.install_contacts`) that upserts saved name/email once per install and when values change, with `telemetry contact disable` opt-out; skipped when telemetry is opted out; uses the same queue/retry path.
- Update first-run disclosure plus site Privacy/Terms to describe private contact storage for support and product updates.
- Add sanitized `skill_error` details (`errorCategory`, `sanitizedMessage`, `fieldLabel`) and accept real application durations via `durationMs` / `startedAt`/`endedAt`.
- Emit `application_skipped` from score decisions `skip`/`exclude`; keep `application_started` available via `telemetry record`.
- Classify Usage, profile-missing/migration, lease, cloud HTTP, and duplicate/cooldown errors more accurately instead of opaque `internal_error`.
