# Job Application Agent — cloud state sidecar

Cloud is the source of truth. Local cache: `~/Library/Application Support/job-application-agent`.

## Local workflow

```text
node state-worker/bin/sync.mjs pull   # before resume, profile, or ledger work
node state-worker/bin/sync.mjs push   # after local writes
node state-worker/bin/sync.mjs status
node state-worker/bin/sync.mjs enable --url <url> --token <token>
```

Bearer token lives in `~/Library/Application Support/job-application-agent-cloud/config.json` (mode `0600`). Never commit the token.

## Cloud / computer-use agents

1. `GET /v1/profile` and `GET /v1/files/*` for ledgers and resume metadata.
2. Download `resume.pdf` to a workspace path (e.g. `./job-app-state/resume.pdf`).
3. Use path-based ATS upload (`setInputFiles`) — do not drive a visible file picker.
4. `POST /v1/ledgers/:name` only after visible submit success.

Auth: `Authorization: Bearer <token>` on every request.
