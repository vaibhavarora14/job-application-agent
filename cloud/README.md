# Cloud apply (H0 personal dogfood)

Hosted loop around the existing Agent Skill. Onboard once, start a round, leave. The worker discovers public ATS boards, scores with `scoreJob`, fills Greenhouse, and clicks Submit only when the routine-auto gate passes. `submitted` is written only after a visible thank-you page.

This package is `private: true` and is **not** in the root npm `files` list. `npx job-application-agent` does not ship it.

## What this is not

- Not the Paisewise / Founder's Office Machine. Deploy a **new** Fly app.
- Not a public website. Bind `127.0.0.1` and reach it with `fly proxy`, Tailscale, or WireGuard.
- Not a second scoring system. Import `scoreJob` / `validateProfile` / `validateLedgerEntry`.

## Local

```bash
cd cloud
npm install
cp .env.example .env
# Point state at ./data (gitignored). Do not write candidate data into the repo.
export CLOUD_DATA_DIR="$PWD/data"
export JOB_APPLICATION_AGENT_STATE_DIR="$PWD/data/skill-state"
export HOST=127.0.0.1
export PORT=8787
export CLOUD_EMBED_WORKER=1

node src/cli.mjs onboard --profile ./profile.json --resume ./resume.pdf
node src/cli.mjs status
node src/server.mjs
```

Open `http://127.0.0.1:8787`. Tap **Find and apply to these**. The HTTP handler only enqueues; Playwright and `cloud llm` run in the worker.

CLI:

```bash
node src/cli.mjs discover
node src/cli.mjs round start --count 10
node src/cli.mjs attention
node src/cli.mjs llm assess --stdin < job.json
```

`JOB_APPLICATION_AGENT_STATE_DIR` is the skill's state dir (résumé copy, optional ledger files). Linux `secret-tool` will not work on a headless Fly box; SQLite is the profile source of truth.

## LLM

Tried in order, first success wins:

1. Ollama on your laptop — `OLLAMA_HOST=http://<tailnet-host>:11434`. Bind Ollama to the tailnet, not `0.0.0.0`.
2. Hosted API — `ANTHROPIC_API_KEY` (default) or `OPENAI_API_KEY`.
3. Keyword-overlap heuristic if no provider is configured.

If a provider is configured but unreachable, the job stays `pending_llm` and the rest of the round continues.

Do not install Ollama on the 2 GB Fly Machine.

## Fly

Create a **new** app and volume. Do not reuse the Paisewise app, volume, or image.

```bash
fly apps create job-application-agent
fly volumes create cloud_data --size 10 --app job-application-agent
fly deploy --config cloud/fly.toml --app job-application-agent
fly proxy 8787:8787 -a job-application-agent
```

Do not allocate a public IPv4 for the UI. Machine size: 2 shared CPUs, 2 GB RAM, `auto_stop` off while a round is running.

After reviewing the first 20 assess outputs, you may set `CLOUD_ROUTINE_CHANNELS=greenhouse` so a `review` decision can Submit on that channel without `autoEligible`.

## Submit gate

The agent clicks Submit only when all of these hold:

- `submissionMode` is `routine-auto`
- ledger check is clean
- score decision is `review` and (`autoEligible` or the channel is in `CLOUD_ROUTINE_CHANNELS`)
- required fields are verified facts
- résumé is attached
- no login / MFA / CAPTCHA / legal / demographic / government-id / LinkedIn overlay
- channel is on `CLOUD_SUBMIT_ALLOWLIST` (default: `greenhouse`)

Otherwise the inbox shows the company URL. H0 does not ship noVNC; refill-on-open is the contract. Never click Submit a second time if confirmation is unclear.

Lever and Ashby are discovered and scored, then handed off until one Greenhouse agent-submit is confirmed.
