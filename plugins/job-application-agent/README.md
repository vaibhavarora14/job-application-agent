# Job Application Agent (multi-marketplace plugin)

In-repo plugin package for the open-source **Job Application Agent** Skill + CLI ([npm `job-application-agent`](https://www.npmjs.com/package/job-application-agent)).

**Status:** in-repo packaging is marketplace-ready for Cursor, Claude, and Codex/ChatGPT. **Listing submit is a separate human step** for each directory. There is no CLI submit path.

| Surface | Packaging in this folder | Submit after merge |
| --- | --- | --- |
| Cursor | `.cursor-plugin/plugin.json` + repo `.cursor-plugin/marketplace.json` | [Cursor Marketplace publish](https://cursor.com/marketplace/publish) |
| Claude | `.claude-plugin/plugin.json` (skills auto-discovered under `skills/`) | [Claude directory manage](https://claude.ai/directory/manage) — plugin path `plugins/job-application-agent` |
| Codex / ChatGPT Plugins | Portable root `plugin.json` (Agent Plugins schema + `extensions.com.openai.interface`) | OpenAI Plugins ZIP of this folder |

This plugin is an **Agent Skill / CLI** package (not a remote MCP server). Full scripts and the managed updater ship via npm; this package provides skill (+ Cursor command) entry points and marketplace metadata.

Product site: [https://jobappagent.com](https://jobappagent.com) · Contact: founders@jobappagent.com · License: MIT

## Install the CLI runtime (all hosts)

After installing the skill/plugin from any marketplace (or loading it locally), run:

```bash
npx job-application-agent@latest install
```

so the full skill runtime (scripts, references, updater) is on disk.

## Install in Cursor (Marketplace — after listing)

Once listed, install from the Cursor Marketplace, then run the npm install command above.

## Install in Cursor (local plugin path)

Until a Marketplace listing ships, use the local plugin path for personal testing:

```bash
mkdir -p ~/.cursor/plugins/local
cp -R /path/to/job-application-agent/plugins/job-application-agent ~/.cursor/plugins/local/job-application-agent
```

Restart Cursor or run **Developer: Reload Window**. Then install the CLI runtime with `npx job-application-agent@latest install`.

On Teams/Enterprise, local plugin imports may be admin-gated (**Allow Local Plugin Imports**).

Monorepo note: Cursor lists this plugin from the repo root at `.cursor-plugin/marketplace.json` with `source: plugins/job-application-agent`. The nested package owns `.cursor-plugin/plugin.json`.

## Install in Claude (directory / Claude Code plugin)

After directory listing (or for local dogfood), point Claude Code at this plugin directory (for example `--plugin-dir plugins/job-application-agent` or install from a marketplace that sources this path). Claude discovers `skills/job-application-agent/SKILL.md` from the plugin root. Then run `npx job-application-agent@latest install`.

## Install in Codex / ChatGPT (Plugins Directory — after listing)

Once listed in the OpenAI Plugins Directory, install from ChatGPT Work or Codex Plugins. For local testing, this repo ships `.agents/plugins/marketplace.json` pointing at `./plugins/job-application-agent` (does not change Cursor’s `.cursor-plugin/marketplace.json`).

## What you get

| Piece | Role |
| --- | --- |
| `skills/job-application-agent/SKILL.md` | Shared Agent Skill guidance (Cursor / Claude / Codex) |
| `commands/install-job-application-agent.md` | Cursor one-shot install/update command |
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
