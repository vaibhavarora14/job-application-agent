# Optional LLM assist: Free.ai

Free.ai is an **optional** OpenAI-compatible LLM endpoint for text assists in the open-source skill path. It is not wired into the skill CLI, and it is not the hosted executor, browser apply loop, or Antigravity/Codex default product path.

Use it only when your agent host already supports a custom OpenAI-compatible `base_url` and API key. Point that client at Free.ai; keep Job Application Agent’s deterministic CLI (`score`, `ledger check`, leases, intents, and related commands) as the source of truth for gates and records.

## Setup

| Setting | Value |
|---|---|
| Base URL | `https://api.free.ai/v1` |
| Chat | `POST /v1/chat/` |
| API key env | `FREE_AI_API_KEY` (Bearer `sk-free-…`) |
| Key source | [free.ai/account/?tab=api](https://free.ai/account/?tab=api) |
| Model (own-hardware / grant-friendly) | `qwen7b` |

Configure the key and base URL in the agent host that supports custom OpenAI-compatible clients. The skill package does not read `FREE_AI_API_KEY` or call Free.ai itself.

Document only own-hardware models such as `qwen7b` for this OSS assist path. Premium third-party models on Free.ai are not the free/grant path.

## Good for

- Parsing a job description into structured must-haves / nice-to-haves
- Explaining a fit score or drafting short rationale text
- Short why-company or motivation drafts (still grounded in verified résumé facts)

## Not for

- Hosted cloud apply loops
- Headed browser fill/submit
- Lease, intent, or ledger authority
- Sole default product brain or auto-submit decisions

## Authority and caution

1. Run `score --stdin`, `ledger check`, and the other CLI gates before any submission decision. LLM output is assistive only.
2. Free.ai assists can be slightly more eager toward `auto` than Antigravity’s `review` path. Do not trust Free.ai alone for auto-submit.
3. Narrative drafts must still follow [APPLICATION_GUIDANCE.md](APPLICATION_GUIDANCE.md) and verified profile/résumé facts.
4. Browser transmission, SSO/MFA/CAPTCHA pauses, and cloud lease/intent protocol are unchanged. See [CLOUD_STATE.md](CLOUD_STATE.md) and [VPS_CLIENTS.md](VPS_CLIENTS.md) for the hosted multi-host path.
