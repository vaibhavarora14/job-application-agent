# Privacy — Job Application Agent plugin

## What this plugin does

This Cursor plugin packages Agent Skill guidance and an install command for the open-source Job Application Agent. It does not embed a remote MCP server, does not scrape your machine by itself, and does not ship candidate profile data.

## Data handling (CLI / skill runtime)

After `npx job-application-agent@latest install`:

- Profile facts prefer OS-backed secret storage (macOS Keychain, Windows Credential Manager, Linux Secret Service).
- Canonical résumé and append-only ledgers live in an owner-only state directory (or optional private cloud state adapter when configured).
- The skill must not store passwords, MFA codes, government IDs, demographic data, CAPTCHA answers, or browser session data.

## Analytics & community (CLI defaults)

The CLI discloses default-enabled structured usage analytics and separate default-enabled name/email sharing with the maintainer for support/product improvement, plus independent anonymous community sharing of confirmed public job links. Users can opt out (`telemetry identity disable`, `telemetry disable`, `sources sharing disable`). See the installed skill and product [privacy](https://jobappagent.com/privacy).

## What we do not do with this plugin package

- We do not embed secrets or API keys in the plugin repo.
- We do not enable hosted pilot submissions from this packaging change.
- Marketplace listing submit is a separate Product step after packaging lands.

## Related

- Product privacy: https://jobappagent.com/privacy
- Security policy: [`SECURITY.md`](../../SECURITY.md) / [`SECURITY.md`](./SECURITY.md)
- License: MIT via [`LICENSE`](../../LICENSE)
