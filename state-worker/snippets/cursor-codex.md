# Job Application Agent cloud state

When working on this candidate's job applications, resume, profile, or ledgers:

1. Pull cloud state before the work:
   `node /Users/vaibhavarora/Coding/job-application-agent/state-worker/bin/sync.mjs pull`
2. Use the installed job-application-agent skill against `~/Library/Application Support/job-application-agent`. Do not patch that skill; npm auto-updates it.
3. Push after writes:
   `node /Users/vaibhavarora/Coding/job-application-agent/state-worker/bin/sync.mjs push`
4. Cloud computer-use agents: `GET /v1/files/resume.pdf` into a workspace path, then use that path for ATS upload (`setInputFiles` / file-chooser). Never send resume, profile, or ledgers to the telemetry worker.

Bearer token lives in `~/Library/Application Support/job-application-agent-cloud/config.json` (mode 0600). Worker: `https://job-application-agent-state.varora1406.workers.dev`. Full protocol: `state-worker/AGENT.md`.
