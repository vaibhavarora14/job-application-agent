# Optional private cloud state

Private cloud state lets multiple trusted agent hosts use one authoritative candidate dataset. It is separate from anonymous analytics and the public community registry.

Configure each host with a different revocable client token:

```text
echo '{"version":2,"url":"https://private-worker.example","clientId":"mac-codex","clientName":"Mac Codex","token":"..."}' | node scripts/job-application.mjs cloud configure --stdin
node scripts/job-application.mjs cloud status
node scripts/job-application.mjs cloud reconcile --dry-run
```

The owner-only configuration file stores the token with mode `0600`. The server stores only its SHA-256 hash. D1 stores revisioned documents, append-only records, application intents, and the single-writer lease. R2 stores the canonical résumé, migration snapshots, and 30-day backups.

Browser sessions, Gmail credentials, passwords, verification codes, CAPTCHA responses, demographic responses, legal answers, and device-specific telemetry credentials never enter private cloud state.

Normal profile, résumé, ledger, outcome, round, attention, review, and friction commands automatically reconcile through the configured backend. `cloud export` creates an owner-only JSON archive. During a cloud outage, continue cached research and drafts but do not transmit a new application.
