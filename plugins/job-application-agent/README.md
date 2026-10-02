# Job Application Agent (Cursor plugin)

In-repo Cursor plugin package for the open-source **Job Application Agent** Skill + CLI ([npm `job-application-agent`](https://www.npmjs.com/package/job-application-agent)).

**Status:** in-repo packaging is marketplace-ready (repo-root `.cursor-plugin/marketplace.json` + this nested package). **Listing submit is a separate human step** via the [Cursor Marketplace publish form](https://cursor.com/marketplace/publish). There is no CLI submit path.

This plugin is an **Agent Skill / CLI** package (not a remote MCP server). Full scripts and the managed updater ship via npm; this package provides Cursor skill + command entry points and Marketplace metadata.

Product site: [https://jobappagent.com](https://jobappagent.com)

## Install in Cursor (Marketplace — after listing)

Once listed, install from the Cursor Marketplace, then run:

```bash
npx job-application-agent@latest install
```

so the full skill runtime (scripts, references, updater) is on disk.

## Install in Cursor (local plugin path)

Until a Marketplace listing ships, use the local plugin path for personal testing:

```bash
mkdir -p ~/.cursor/plugins/local
cp -R /path/to/job-application-agent/plugins/job-application-agent ~/.cursor/plugins/local/job-application-agent
```

Restart Cursor or run **Developer: Reload Window**. Then install the CLI runtime:

```bash
npx job-application-agent@latest install
```

On Teams/Enterprise, local plugin imports may be admin-gated (**Allow Local Plugin Imports**).

Monorepo note: this plugin is listed from the repo root at `.cursor-plugin/marketplace.json` with `source: plugins/job-application-agent`. The nested package owns `.cursor-plugin/plugin.json`.

## What you get

| Piece | Role |
| --- | --- |
| `skills/job-application-agent/SKILL.md` | Cursor Agent Skill guidance |
| `commands/install-job-application-agent.md` | One-shot install/update command |
| npm `job-application-agent` | Full CLI, scripts, OS secrets, updater |

## Privacy & security

- Candidate profile prefers OS-backed secret storage; ledgers are owner-only.
- No passwords, MFA, government IDs, or browser session secrets in skill state.
- Default analytics/community sharing are disclosed by the CLI with explicit opt-outs.
- See repo [`SECURITY.md`](../../SECURITY.md) and site [privacy](https://jobappagent.com/privacy).

## Related

- GitHub: https://github.com/vaibhavarora14/job-application-agent
- npm: https://www.npmjs.com/package/job-application-agent
- License: MIT via repository root [`LICENSE`](../../LICENSE)
