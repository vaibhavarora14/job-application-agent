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

Structured usage analytics are enabled by default, keyed to an anonymous install ID, so the maintainers can learn which job sources, ATS flows, and workflow steps work. Analytics events do not include your name, email, phone, résumé content, prompts, answers, browser data, or IP addresses. Error events include only a short sanitized error message, with file paths, your home folder, OS username, and contact details redacted. The analytics retention policy is 24 months; automatic raw-event expiry still requires configuration with PostHog. Run `telemetry disable` to stop all analytics; previously collected events are not deleted by opting out.

## Private contact store

Separately from analytics events, the CLI may store the name and email you explicitly saved in your candidate profile in a private maintainer database tied to your anonymous install ID. It is used only to support you and send product updates. It is never written into PostHog analytics events (since 3.7.3; the relay also strips name and email fields from older versions) and is not exposed on public community or job endpoints. Run `telemetry contact disable` to stop future contact sharing, or `telemetry disable` to stop both analytics and contact sharing. Opting out does not automatically delete a stored contact; see the privacy policy for deletion requests.

## Job board email alerts

The website, not this plugin package, can email new roles for a search you save on the job board. If you save a search on the job board, we store only the email address you enter, the filter query (the same filters as the board URL), whether you chose daily or weekly, a confirmation token hash, an unsubscribe token (a random secret that only deletes that saved search), and timestamps for when you subscribed, when you confirmed, when we last sent an alert, and a watermark of the newest role already considered. We send a confirmation email first and send no alerts until you confirm. Each email has a one-click unsubscribe link. Unsubscribing deletes that saved search. Unconfirmed searches are deleted after 7 days. Confirmed searches are kept until you unsubscribe. We do not store your name, résumé, or IP address on the saved search, and the emails we send have no tracking pixels.

## Community sharing (on by default)

Confirmed applications share only a canonical public job URL, company, role, application channel, optional coarse discovery source, and derived provider URL — never your identity, answers, résumé, score, referral parameters, or submission time. Run `sources sharing disable` to opt out.

## Related

- Privacy policy: https://jobappagent.com/privacy
- Terms: https://jobappagent.com/terms
- Security policy: [`SECURITY.md`](./SECURITY.md)
- License: MIT via [`LICENSE`](../../LICENSE)
