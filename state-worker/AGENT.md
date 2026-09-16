# Job Application Agent — private cloud state

The v2 Worker/live protocol uses private D1 for structured records and private R2 for the canonical résumé and backups when the account has R2 enabled. It also supports the existing private Workers KV namespace as a blob fallback. It is separate from telemetry and the public community registry.

Each Mac/VPS agent has a distinct revocable bearer token. Only SHA-256 token hashes are stored in D1. Use the packaged CLI rather than calling the API directly:

```text
node scripts/job-application.mjs cloud status
node scripts/job-application.mjs cloud reconcile --dry-run
node scripts/job-application.mjs cloud lease-acquire
```

The application-run lease lasts 15 minutes and must be renewed every five minutes. Create an intent before transmission. Mark uncertain sends `sent-unverified`; never retry them solely because a lease expired.

Hosted attention resume (P1 site coordination, not a second ledger): while an attention item is open and the lease is held, the GCP runner may poll `GET {PUBLIC_SITE_URL}/api/internal/attention-signals/:id` with `ATTENTION_NOTIFY_SECRET`. Signals are `resume_requested`, `skipped`, or `aborted`. See `site/docs/ATTENTION.md`. Never store passwords, MFA codes, CAPTCHA answers, or session cookies in D1/KV.

Legacy `/v1` reads remain authenticated for cutover recovery. Legacy whole-file writes return `410` after cutover. Daily private R2 exports retain 30 days and can be restored into a separate D1 database with the tested backup module.
