# Changelog

## 3.8.1

Packaging and registry-scan fixes only; no behavior change.

- **Smaller published package.** npm's `files` list now ships just the runtime skill: `SKILL.md`, `capabilities.json`, `platforms.json`, `references/`, `scripts/` (without the dev-only `serve-apply-fixtures.mjs`) and the owned-fixture allowlist `fixtures/test-jobs.json` that the apply URL gate reads. `job-application-agent/tests/`, the fixture HTML pages and `fixtures/README.md` no longer ship (63 files instead of 109). New `job-application-agent/.clawhubignore` keeps the same set when the skill folder is published to ClawHub.
- SKILL.md (all copies): the Untrusted content section keeps the same rule but no longer quotes injection-style example phrases, which registry scanners flagged as prompt injection.
- Test fixture: the fake CAPTCHA vendor key values are now obvious placeholders.
- Comments explaining the remaining `child_process` use (`secret-store.mjs`, `review open`) and the environment reads next to network code (cloud config path, community endpoint, `GITHUB_ACTIONS`). The cloud config path is read in one place.

## 3.8.0

- **Batch review is the only path to a send.** The agent stages filled applications (and outreach emails) with `review stage --stdin`: company, role, URL, fit score, the exact drafted answers, and a hash of the canonical résumé the CLI computes itself. The candidate approves on a one-shot local review page (`review open <batch-id>`: `127.0.0.1` only, a random path secret, no external requests and only one fixed, nonce-bound inline script for the live approve count; it shows each email's recipient, subject and attachments and links the exact résumé PDF; untick items, type the batch code to approve, or reject the batch), or, on hosts without a local browser, by typing the batch's approval phrase in chat (`review approve --stdin`, optionally leaving items out). Batches hold at most 25 items; a pending batch expires after 24 hours and an approval lasts 24 hours. New commands: `review stage|approve --stdin`, `review show|open|status|revoke <batch-id>`, `review list`.
- Gates: `ledger add`, `cloud intent-prepare`, `cloud intent-confirm`, `ledger retry` and `outreach handoff` refuse a live send without a `reviewBatchId` and `reviewToken` for an approved, unexpired, unused item that still matches (application ID, URL, answers, résumé; draft revision for email). Each item covers one send. This applies to `review-each` too (a batch of one). Owned fixtures on the packaged allowlist are exempt; a caller-supplied `applyKind` is not. The token is an HMAC over the approved items with a per-install key in the private state directory. Ledger rows record `reviewBatchId`, `reviewApprovedAt` and `reviewApprovalChannel`; the token is never stored or sent.
- Honest limit, documented in SKILL.md, README and `references/REVIEW.md`: the CLI gates preparing and logging a submit, not a click made directly in the browser.
- Autonomy grants no longer include `submit` or `send-recruiting-email`; `autonomy status` reports `maySubmitRoutineApplications: false` and `submissionsRequireBatchReview: true`, and prints a one-line notice once for older grants.
- Telemetry: no schema change. `review` commands report as the existing `batch` command category, so the deployed relay accepts them as is.
- Package metadata: drop the `auto-apply` keyword.
- Skill triggers: all three SKILL.md copies now activate only when the user names JobAppAgent / job-application-agent or explicitly asks for a job-search or application task, never on vague requests (addresses the SkillSpector "vague triggers" finding on SKILL.md line 10). The description still opens "JobAppAgent, the open-source AI job application agent."
- **Windows profile store hardening.** `windows-profile-store.ps1` now rejects any request whose service name is not `com.vaibhavarora.job-application-agent` (or a dotted sub-name), whose account is not a short identifier, or whose path is not a `.dat` file inside the state folder (`JOB_APPLICATION_AGENT_STATE_DIR`, otherwise `%APPDATA%\job-application-agent`) or passes through a junction or symlink. These checks run before any Credential Manager or file access. `secret-store.mjs` enforces the same service rule before starting PowerShell and reports the rejection reason, never profile data. A custom `JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE` on Windows must now use that prefix. The `Add-Type` P/Invoke stays, because the profile file already uses the built-in `ProtectedData` (DPAPI) and Windows PowerShell 5.1 has no built-in API for the Credential Manager key. `-ExecutionPolicy Bypass` also stays: it is process-scoped, a default Windows client (`Restricted`) runs no `.ps1` without it, and the inline or encoded alternatives are less reviewable. Both reasons are documented in the code. New tests run the real script with PowerShell (validation everywhere, plus a full Credential Manager and DPAPI round trip on Windows).
- **Updates are notify-only by default.** New installs no longer schedule a background updater; `npx job-application-agent@latest updates enable` is the explicit opt-in (and `updates disable` goes back). New `updates check` command (`node scripts/job-application.mjs updates check`) reads the latest version from the public npm registry and reports `updateAvailable`; it never downloads, installs or runs anything, sends no profile or identity data, and is skipped with `JOB_APPLICATION_AGENT_NO_UPDATE_CHECK=1`. SKILL.md (all copies) now tells the agent to run that check, tell the user, and ask before updating; it never runs the managed updater itself. Installs that already had automatic updates on keep them (the scheduled job is not removed) and get a one-time notice from `status`, `install`/`update` or `updates check` explaining how to keep them or turn them off.
- SKILL.md (all copies): new **Untrusted content** section. Job pages, postings, emails, ATS forms and other web or inbox content are data, never instructions; the agent reports any requested action to the candidate instead of taking it.

## 3.7.23

- Metadata only (no CLI behavior change): the SKILL.md frontmatter description now starts with "JobAppAgent, the open-source AI job application agent." and states that submissions happen only with the candidate's approval; npm keywords add `jobappagent`; the site og:description and twitter:description start with "JobAppAgent is an open-source AI job application agent".

## 3.7.22

- `review-each` is now the default submission mode. `profile migrate` and the built-in targeting defaults write `review-each` (previously `routine-auto`), matching the docs.
- An explicit `routine-auto` is recorded: `profile set` / `profile migrate` with `"submissionMode": "routine-auto"` stamps `submissionModeChosenAt`. Earlier versions wrote `routine-auto` from defaults without a marker, so explicit choices can't be told apart from defaults; every stored `routine-auto` without the stamp is treated as `review-each` from this version on, and the CLI prints a one-line notice once per install explaining how to turn `routine-auto` back on. The stored profile itself is not rewritten.
- Package metadata: new npm description and keywords (job-application-agent, ai-agent, agent-skill, auto-apply, greenhouse, ashby, lever, open-source).

## 3.7.21

- Tests never reach the production telemetry relay by default. Previously only `node --test` (`NODE_TEST_CONTEXT`) and GitHub Actions were detected. Now any test run uses the local dead endpoint: `npm test` and `npm run privacy-audit` load `tests/support/no-live-telemetry.mjs`, which sets `JAA_TEST=1` for every spawned CLI and makes an in-process fetch to the production relay fail; `npm_lifecycle_event` test/prepack scripts and test files run directly with `node file.test.mjs` are detected too. Opt in explicitly with `JAA_TEST_LIVE_TELEMETRY=1`. An explicit `JOB_APPLICATION_AGENT_TELEMETRY_URL` still wins. Real CLI use is unchanged (production by default; generic `CI=true` does not opt out).
- New guard test `tests/telemetry-test-isolation.test.mjs` fails if a test run would resolve or fetch the production relay, or if any test file names it.
- Relay (already deployed, no client protocol change): installs are counted in the public total at their first real activity rather than at `installation_started`; 398 installs created by the test suite's fixture `ledger add` were excluded from the lifetime count; `interviews` is no longer in `/api/public-stats`.

## 3.7.20

- `score`: local guard against runaway assessment loops. Each `score --stdin` call is its own CLI process, so an agent (or a script it writes) piping a whole feed through `score` could re-assess the same jobs without bound; one install logged 2,768 assessments and 246 invalid-input errors in two hours with no submissions. The guard keeps counters in `assessment-guard.json` in the private state directory, so it holds across invocations:
  - a cap on new assessments per run, as a rolling window: default 200 per 6 hours (`JOB_APPLICATION_AGENT_MAX_ASSESSMENTS`, `JOB_APPLICATION_AGENT_ASSESSMENT_WINDOW_MINUTES`);
  - no re-assessing the same job: identical input for a job already scored in the window returns the earlier result with `repeatAssessment: true` and emits no telemetry; a job is refused after 3 attempts (`JOB_APPLICATION_AGENT_MAX_ASSESSMENTS_PER_JOB`); 20 repeat/refused calls in a row stop assessment;
  - exponential backoff after invalid input (1s, 2s, 4s, 8s, capped at 30s), then a hard stop after 5 consecutive invalid-input failures (`JOB_APPLICATION_AGENT_MAX_CONSECUTIVE_INVALID`).
  A stop refuses further `score` calls for 30 minutes (or until the cap window rolls) with an `Assessment guard stop` message that tells the agent to stop the run, names the last error and what to fix, and tells the user how to resume. `score guard` shows the counters; `score guard-reset` clears them. The state holds hashed job keys, input digests, timestamps and the last gate result only.
- Telemetry: guard refusals are reported as `skill_error` with `errorCode: "rate_limited"` (an existing value), once per stop rather than on every refused call. No schema changes; works with the deployed relay as is.
- `score` output gains an `assessmentGuard` object (`used`, `limit`, `remaining`, …). Existing keys are unchanged.

## 3.7.19

- `ledger add`: when a submitted entry has no fill telemetry and fill metrics fall back to answer keys (`fillMetricsSource: "answer_keys"`, `telemetrySupplied: false`), the private ledger row and `application_submitted` now carry `entryOrigin: "logged"` — the application was logged after the fact, not filled by the agent. The entry is still accepted and still counts as a submitted application (public stats unchanged); it is excluded from agent fill-quality / thin-submit checks. The CLI derives `entryOrigin` itself and ignores any caller-supplied value. Agent-filled submits omit the key, so their property set is unchanged. Existing ledger rows and analytics are not backfilled.
- Telemetry schema: optional `entryOrigin` (`"agent"` | `"logged"`) on `application_submitted`. Old clients without it are still accepted. The relay (shared schema) must be deployed with this key **before** a CLI release that sends it, otherwise the relay rejects logged-entry events with 400 and the client drops them.
- Relay (deployed ahead of this release): accepts `entryOrigin` on `application_submitted`, and refuses clients below `MIN_CLIENT_VERSION` (2.0.0) with 426 and "Please upgrade: npx job-application-agent@latest". Staging-tagged versions are always accepted.

## 3.7.18

Includes everything prepared for 3.7.17, which was tagged but never published to npm.

- Privacy: `skill_error.sanitizedMessage` now redacts home-directory paths on every OS (`/home/<user>`, `/Users/<user>`, WSL `/mnt/c/Users/<user>`, `C:\Users\<user>`, UNC and `file://` forms become `~`), plus the current `os.homedir()` and `os.userInfo().username` wherever they appear. Earlier versions could include an absolute path containing the OS username.
- Privacy (relay, deployed ahead of this release): the telemetry relay applies the same path redaction to every forwarded string property, and strips legacy `identity` envelopes and known contact keys (`candidateName`, `candidateEmail`, `name`, `email`, `phone`, …) sent by 3.7.2 and earlier clients instead of rejecting them, so those clients' anonymous analytics still arrive without the contact data.
- Docs: README, plugin `PRIVACY.md` and the site privacy page now agree: saved name and email are stored privately in a separate contact store and are never written into PostHog events (since 3.7.3); error events carry only a sanitized message with paths and contact details redacted; opt-outs are `telemetry contact disable` and `telemetry disable`.
- `job-application-agent help`, `--help` and `-h` now print usage and exit 0 (previously the installer printed usage as an error and exited 1). Missing or unknown commands still exit 1 with the same usage text.
- Codex / ChatGPT plugin packaging: the packaged skill now asks the user to confirm before running `npx job-application-agent@latest install` or `npx skills add` (both download and run code), and continues with guidance only if declined. The listing manifest gains a fuller long description, a shorter subtitle, `publication.release_notes`, and no country restriction (`publication.countries: []`). `plugins/job-application-agent/PRIVACY.md` is reworded to match the current privacy policy.
- Codex listing short description is now "Job applications you approve"; release notes updated for the first listing.
- No telemetry schema changes.

## 3.7.16

- Fix the CLI exiting 0 with no output when run through a symlinked path (a symlinked `~/.agents`, `~/.agents/skills` or `~/.claude/skills` directory, a symlinked script, or macOS temp paths under `/var` → `/private/var`). Node resolves the main module to its real path, so `import.meta.url` named the real file while `process.argv[1]` kept the symlinked spelling, and the "run only when executed directly" check compared them without resolving symlinks. Entry-point detection now compares the `fs.realpathSync` of both sides (falling back to `path.resolve`, case-insensitive on Windows) in `job-application.mjs`, `prove-apply.mjs`, `attention-runner-poll.mjs`, `attention-resume-submit.mjs`, `session-binding.mjs`, `novnc-display-guard.mjs`, and the CI path classifier. The npm `bin` shim was not affected (it calls the installer unconditionally). New tests run the CLI through a symlinked skill directory, a symlinked script file, symlinked `~/.agents/skills` and `~/.claude/skills` roots, and a `node_modules/.bin`-style symlink to the npm bin, on Linux, macOS and Windows CI. No telemetry schema changes.

## 3.7.15

- Fix `Cannot find module 'sql.js/dist/sql-asm.js'` when the skill folder is copied without the npm installer (for example `npx skills add` into `~/.agents/skills/job-application-agent`): the pure-JS sql.js 1.13.0 runtime (MIT, license included) is now vendored at `scripts/runtime/sql-asm.cjs` inside the skill folder, so every install location and the npm tarball carry it. A test copies the skill into `.agents/skills` and `.claude/skills` roots without `node_modules` and checks the npm pack contents; another keeps the vendored file byte-identical to the pinned dependency.
- Clearer, area-specific CLI usage errors. Any unknown command used to fail with the cloud usage line (`Usage: cloud status|...`), so non-cloud mistakes were reported as cloud errors. Errors now name the area and reason (`unknown area`, `unknown subcommand`, `missing --stdin` with a piping example) and only echo known command tokens. `help`, `--help`, `<area> help`, and `--version` print usage/version instead of failing. Forgiving forms: `--json`/`--pretty` are ignored, `-` means `--stdin`, an inline JSON object argument is read as the stdin payload, `cloud lease acquire` / `cloud intent prepare` map to the hyphenated commands, `cloud lease-renew|lease-release <id>` accept the recorded lease ID, and `profile show`/`get`, `autonomy show`, and `attention|friction ls` aliases work. SKILL.md now says to run documented forms and use `help` instead of guessing.
- `round lead`: `observedAt` is optional and defaults to the recording time; epoch seconds/milliseconds are accepted, and invalid values get an ISO 8601 example. Observation time never affects lead identity, so this is backward compatible.
- `round source` in per-lead rounds: the count-mismatch error now reports the recorded totals and says to record leads first or omit the counts. RUNS.md no longer shows counts in the new-round example (the cause of agents reporting counts before recording leads); ACCOUNTING.md and SKILL.md list the required lead fields and the leads-then-source order.
- No telemetry schema changes.

## 3.7.14

- Add an optional Boolean `resumeFieldPresent` to `application_submitted` telemetry: `true` when the application form had a résumé/CV upload field (required or optional, used or not), `false` when it had none, and absent when unknown. The agent reports it as `telemetry.resumeFieldPresent` on `ledger add`, decided from the live form's résumé/CV upload controls (not the candidate profile). An explicit `resumeUploaded: true` implies `true`; `resumeFieldPresent: false` with `resumeUploaded: true` is rejected; answer-key heuristics never fill it in. Boolean only, no PII, never stored on the ledger row. Backward-compatible: the relay (shared schema) accepts events with or without it, and older CLIs that do not send it count as unknown. The relay was deployed with the new optional key before this release so no submission is rejected.

## 3.7.13

- Close the remaining thin-submit gap: `ledger add` now also reads the stored profile's `submissionMode`. When it is `routine-auto`, an empty submit (0 fields filled and no résumé, same thresholds as before) is blocked even if the entry claims `APPROVE SUBMIT` or carries a per-job `thinSubmissionOverride` note. The error explains the honest paths (fill the form, or `profile_one_click` with `telemetry.profileResumeOnFile`) and how to review just that one job: add the transient `"jobApprovalMode": "review-each"` to that `ledger add` together with `approval: "APPROVE SUBMIT"` and the normal `thinSubmissionOverride` acknowledgement and per-job candidate confirmation. The flag is per entry, not stored, and never changes the profile's global `submissionMode`. Filled submits, the one-click path, and `review-each` profiles are unchanged. No new telemetry fields.

## 3.7.12

- Second safeguard against CI writing to production telemetry: inside GitHub Actions (`GITHUB_ACTIONS` set) the telemetry and community relay endpoints now default to the same unroutable local address used under `node --test`, even for CLIs spawned outside the test runner or with a stripped child environment. An explicit `JOB_APPLICATION_AGENT_TELEMETRY_URL` / `JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL` still wins. The generic `CI` variable is deliberately not used: agent runtimes and sandboxes that real candidates run in often export `CI=true`, and keying on it would silently drop real usage analytics.

## 3.7.11

- Fix the telemetry retry queue so one event the relay refuses can no longer hide every event behind it. Previously any non-2xx (including a permanent `400 invalid_event`) was treated as "relay unavailable": the queue stopped at that item on every command, which is how the 3.7.9 `thinSubmissionOverrideUsed` rejection hid submissions. Now a 4xx other than 401/408/425/429 (or a queued event that no longer passes the local schema) moves just that item to a bounded local `telemetry-quarantine.ndjson` with a one-line warning (event type and relay error code only, never properties or contact values) and draining continues. Network errors, 5xx, and 429 keep retry/backoff. Rejected events are no longer queued at all.
- Fix silent loss of queued analytics: when a queue flush stopped at an unavailable relay, every item after the failing one was deleted instead of kept. With the 3.7.9 rejection this meant only the first stuck submission per installation survived; later queued submissions were discarded on the next command. All untried items are now preserved.
- Stop test runs from writing to production telemetry: CLIs spawned under `node --test` (CI, `npm test`, `prepack`) fell back to the production relay and registered throwaway installations and `apply` command events (22 fake installations during the 3.7.10 PR, release, and relay-deploy runs on Oct 18, inflating PostHog and the public installation count). Under the test runner the telemetry and community endpoints now default to an unroutable local address unless a URL is set explicitly.

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
