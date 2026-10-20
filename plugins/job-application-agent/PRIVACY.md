# Privacy — Job Application Agent plugin

The product privacy policy is https://jobappagent.com/privacy. This page summarizes how it applies to this plugin package. If the two ever differ, the privacy policy wins.

## What this plugin package contains

This package ships Agent Skill guidance for the open-source Job Application Agent (Codex / ChatGPT, Claude, and Cursor packaging share one folder). It contains no MCP server, apps, or hooks, bundles no secrets or API keys, and contains no candidate data. The skill asks you to confirm before it runs the public npm installer (`npx job-application-agent@latest install`) or the GitHub skills installer.

## Data handling by the installed CLI / skill

- Profile facts are kept in OS-backed secret storage (macOS Keychain, Windows Credential Manager, Linux Secret Service).
- The canonical résumé and append-only application ledgers stay in an owner-only local state directory, or in your own optional private cloud state backend when you configure one.
- The skill never stores passwords, MFA codes, government IDs, demographic data, CAPTCHA answers, or browser session data, and it never reads browser cookies or session files.
- In the default review mode, nothing is submitted without your confirmation for that job.

## Usage analytics (on by default)

Structured usage analytics are enabled by default, keyed to an anonymous install ID, so the maintainers can learn which job sources, ATS flows, and workflow steps work. Analytics events do not include your name, email, phone, résumé content, prompts, answers, browser data, IP addresses, or raw errors. The analytics retention policy is 24 months; automatic raw-event expiry still requires configuration with PostHog. Run `telemetry disable` to stop all analytics; previously collected events are not deleted by opting out.

## Private contact store

Separately from analytics events, the CLI may store the name and email you explicitly saved in your candidate profile in a private maintainer database tied to your anonymous install ID. It is used only to support you and send product updates. It is not exposed on public community or job endpoints. Run `telemetry contact disable` to stop future contact sharing, or `telemetry disable` to stop both analytics and contact sharing. Opting out does not automatically delete a stored contact; see the privacy policy for deletion requests.

## Community sharing (on by default)

Confirmed applications share only a canonical public job URL, company, role, application channel, optional coarse discovery source, and derived provider URL — never your identity, answers, résumé, score, referral parameters, or submission time. Run `sources sharing disable` to opt out.

## Related

- Privacy policy: https://jobappagent.com/privacy
- Terms: https://jobappagent.com/terms
- Security policy: [`SECURITY.md`](./SECURITY.md)
- License: MIT via [`LICENSE`](../../LICENSE)
