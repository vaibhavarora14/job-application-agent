# Job Application Agent cloud state

When working on this candidate's job applications, resume, profile, or ledgers, use the packaged `cloud` commands. Profile, résumé, ledger, outcome, round, and attention commands reconcile authenticated records when `cloud status` reports the v2 backend. Do not use the retired whole-file sync program.

1. Use the installed job-application-agent skill against `~/Library/Application Support/job-application-agent`. Do not patch that skill; update it with `npx job-application-agent@latest update` when `updates check` reports a newer version.
2. Check cloud state, then reconcile:
   `node scripts/job-application.mjs cloud status`
   `node scripts/job-application.mjs cloud reconcile --dry-run`
   Before browser transmission, run `node scripts/job-application.mjs cloud lease-acquire` and renew that lease at least every five minutes. Create an intent immediately before submission and confirm it only after visible ATS success.
3. Download the canonical résumé with `node scripts/job-application.mjs resume path` and upload that absolute path. A cloud computer-use agent that must fetch the bytes uses authenticated `GET /v2/files/resume.pdf`, writes them to a workspace path, and uploads that path (`setInputFiles` / file-chooser). Never send the résumé, profile, or ledgers to the telemetry or community workers.

The per-host bearer token stays in owner-only configuration at `~/Library/Application Support/job-application-agent-cloud/config.json` (mode 0600). Worker: `https://job-application-agent-state.varora1406.workers.dev`. Full protocol: `state-worker/AGENT.md`.
