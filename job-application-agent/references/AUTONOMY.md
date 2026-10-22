# Standing autonomy

Use a durable autonomy grant only after an explicit candidate instruction such as “apply autonomously.” Store no prompt text in the grant.

```text
node scripts/job-application.mjs autonomy grant --stdin
node scripts/job-application.mjs autonomy status
node scripts/job-application.mjs autonomy preview
node scripts/job-application.mjs autonomy revoke
```

Grant input:

```json
{ "mode": "routine-auto" }
```

An active grant covers discovery, assessment, verified form filling, canonical résumé upload, staging review batches, ledger and outcome recording, completed-tab cleanup, and opening a sanitized improvement PR.

**A grant never covers a send.** Every submission, replacement transmission and outreach handoff needs a batch approval from the candidate; see [REVIEW.md](REVIEW.md). With both the profile and the grant on `routine-auto`, batch routine applications (up to 25) into one review instead of asking about each one. The CLI refuses to prepare or record a send without a valid `reviewToken`. It cannot stop a browser click, so never click Submit or Send without an approved item.

Grants written before batch review listed `submit` and `send-recruiting-email` scopes. Those scopes no longer exist; the CLI ignores them and prints a one-line notice the first time it reads such a grant.

The profile counts as `routine-auto` only after the candidate explicitly sets it (`profile set` records `submissionModeChosenAt`). The default is `review-each`, where each batch holds one application.

The grant never authorizes `thinSubmissionOverride`. That override is only for an explicit, per-job candidate confirmation in the conversation under `APPROVE SUBMIT` — never in unattended or `routine-auto` batches. For one-click applies that use a stored site profile/résumé, use `applicationChannel: "profile_one_click"` with `telemetry.profileResumeOnFile: true` instead.

Always stop for authentication, MFA, CAPTCHA, legal attestations, demographic responses, government identifiers, unverifiable claims, and ambiguous work authorization or compensation. Obey every browser, host, and tool permission prompt; the grant never bypasses an access control.

CAPTCHA vendor assist (`scripts/captcha-vendor.mjs`) remains **Off by default** (`CAPTCHA_VENDOR=off`). It may run only when the vendor flag, API key, and buyer `captchaAssist` opt-in are all set; otherwise pause with `complete-captcha` / live panel. MFA, SSO, and government ID stay human forever. Optional judgment drafts on the attention page still require candidate Approve before inject — never silent AI paste, and Draft is disabled when a posting discourages AI assistance.

`autonomy revoke` ends the grant without deleting applications, outcomes, rounds, queued attention items or review batches. `review revoke <batch-id>` withdraws a batch approval.

## Improvement boundary

Record friction while the application round continues. Open a public-agent PR only when the issue is reproducible, general-purpose, sanitized, and covered by a regression test. Validate the full suite, privacy audit, package smoke test, and secret scan before marking the PR ready.

Never automatically merge, tag, release, or publish. Never alter telemetry privacy boundaries, candidate facts, résumé claims, targeting thresholds, or answer guidance from an improvement PR. Keep live application work on the latest released package; do not hot-swap unmerged code.
