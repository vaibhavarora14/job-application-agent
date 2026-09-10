# VPS client instructions

This host is a reader by default. It must acquire the shared Cloudflare application-run lease before transmitting any application.

## VPS Codex

Use the installed skill and its default Linux cloud configuration:

```sh
node "$HOME/.agents/skills/job-application-agent/scripts/job-application.mjs" cloud status
```

All profile, resume, ledger, outcome, round, attention, and review commands must use that same CLI. Do not create or treat an independent local ledger as authoritative.

## VPS Antigravity

Use the dedicated wrapper so Antigravity presents its separately revocable client credential:

```sh
"$HOME/.local/bin/job-application-agent-antigravity" cloud status
```

Never copy the Codex credential into Antigravity configuration or print either token. Browser sessions, Gmail credentials, passwords, and verification codes stay on the host and are not uploaded.

## Writer protocol

1. Require a healthy `cloud status` result.
2. Acquire the application-run lease before application work and renew it every five minutes.
3. Create an application intent before each transmission.
4. Confirm the intent only after visible submission evidence; mark an ambiguous send `sent-unverified` and do not retry it.
5. Release the lease when the run finishes or stops.

If cloud state is unavailable, continue cached research and drafting only. Do not submit.
