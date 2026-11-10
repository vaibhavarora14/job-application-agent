// Forgiving argument handling and area-specific usage for the job-application CLI.
// Usage errors only ever echo known command tokens, never caller-supplied values,
// because error messages feed bounded skill_error analytics.

export const COMMAND_USAGE = Object.freeze({
  cloud: 'cloud status | configure --stdin | reconcile [--dry-run] | export [path] | lease-acquire | lease-renew | lease-release | intent-prepare --stdin | intent-sent --stdin | intent-confirm --stdin',
  profile: 'profile set --stdin | migrate --stdin | check | field <name>',
  resume: 'resume import <google-doc-url-or-local-pdf> | path',
  score: 'score --stdin | guard | guard-reset',
  ledger: 'ledger check|add|outcome|review-ack|delivery|retry --stdin | outcome <application-id-or-url> --status <status> [--note <text>] | list [--status <status>] [--company <name>] [--json] | review | deliveries [application-id]',
  autonomy: 'autonomy grant --stdin | status | preview | revoke',
  review: 'review <any> (removed in 3.8.6: a no-op that explains batch review is gone)',
  round: 'round start|lead|source|confirm|complete --stdin | status [round-id] | leads [round-id]',
  sources: 'sources list [--stdin] | jobs [--stdin] | suggest --stdin | pending | sync | sharing status|enable|disable|reset',
  attention: 'attention add|resolve --stdin | list',
  friction: 'friction record --stdin | list',
  telemetry: 'telemetry status|enable|disable|reset | preview|record --stdin | contact status|enable|disable | identity status|enable|disable',
  updates: 'updates check',
  outreach: 'outreach policy status|enable --stdin|disable --stdin | assess|draft|handoff|record|suppress|clear --stdin | list | show <id> | review',
});

export const KNOWN_AREAS = Object.freeze(Object.keys(COMMAND_USAGE));

// Subcommands that read one JSON object from stdin; used for --stdin hints.
const STDIN_ACTIONS = Object.freeze({
  cloud: ['configure', 'intent-prepare', 'intent-sent', 'intent-confirm'],
  profile: ['set', 'migrate'],
  ledger: ['check', 'add', 'outcome', 'review-ack', 'delivery', 'retry'],
  autonomy: ['grant'],
  review: ['stage', 'approve'],
  round: ['start', 'lead', 'source', 'confirm', 'complete'],
  sources: ['suggest'],
  attention: ['add', 'resolve'],
  friction: ['record'],
  telemetry: ['preview', 'record'],
});

const KNOWN_ACTIONS = new Set(Object.values(COMMAND_USAGE)
  .flatMap((line) => line.split(/[\s|]+/))
  .filter((token) => /^[a-z][a-z-]*$/.test(token)));

const HELP = new Set(['help', '--help', '-h']);
const VERSION = new Set(['version', '--version', '-v']);
// Most commands already print JSON, so agents' extra `--json` / `--pretty` flags are no-ops.
// `ledger list` is the exception: plain text unless `--json` is present, so that flag is kept.
const NO_OP_FLAGS = new Set(['--json', '--pretty']);
const ACTION_ALIASES = Object.freeze({
  profile: { show: 'check', status: 'check', get: 'field' },
  autonomy: { show: 'status', check: 'status' },
  attention: { ls: 'list' },
  friction: { ls: 'list' },
});

function parseInlineJson(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Normalize common agent invocation mistakes without changing documented forms:
 * - `help` / `--help` / no args and `<area> help` print usage instead of failing;
 * - `version` / `--version` print the CLI version;
 * - `--json` / `--pretty` are dropped (output is already JSON), except `ledger list`, which keeps `--json`;
 * - `-` and `--stdin=` mean `--stdin`;
 * - an inline JSON object or array argument (`round lead '{"roundId":...}'` or `round lead '[{...}]'`) is read as the stdin payload;
 * - `cloud lease acquire` → `cloud lease-acquire`, `cloud intent prepare` → `cloud intent-prepare`;
 * - small aliases such as `profile show` → `profile check`, `profile get <name>` → `profile field <name>`.
 */
export function normalizeCliArgs(input) {
  const keepListJson = input[0] === 'ledger' && input[1] === 'list';
  let args = [...input].filter((arg) => (arg === '--json' && keepListJson) || !NO_OP_FLAGS.has(arg));
  if (args.length === 0 || HELP.has(args[0])) return { args, help: args[1] && KNOWN_AREAS.includes(args[1]) ? args[1] : true };
  if (VERSION.has(args[0])) return { args, version: true };
  if (KNOWN_AREAS.includes(args[0]) && args.slice(1).some((arg) => HELP.has(arg))) return { args, help: args[0] };
  let inlineJson;
  args = args.map((arg, index) => {
    if (index === 0) return arg;
    if (arg === '-' || arg === '--stdin=') return '--stdin';
    if (inlineJson === undefined) {
      const parsed = parseInlineJson(arg);
      if (parsed) { inlineJson = parsed; return '--stdin'; }
    }
    return arg;
  });
  const [area] = args;
  if (area === 'cloud' && (args[1] === 'lease' || args[1] === 'intent') && /^[a-z]+$/.test(args[2] ?? '')) {
    args = ['cloud', `${args[1]}-${args[2]}`, ...args.slice(3)];
  }
  const aliases = Object.hasOwn(ACTION_ALIASES, area) ? ACTION_ALIASES[area] : undefined;
  const alias = aliases && Object.hasOwn(aliases, args[1]) ? aliases[args[1]] : undefined;
  if (alias) args = [area, alias, ...args.slice(2)];
  // A stdin subcommand given its JSON inline is equivalent to `--stdin`.
  if (inlineJson !== undefined && Object.hasOwn(STDIN_ACTIONS, area) && STDIN_ACTIONS[area].includes(args[1]) && args[2] === '--stdin') args = args.slice(0, 3);
  return { args, ...(inlineJson !== undefined ? { inlineJson } : {}) };
}

const USAGE_NOTES = Object.freeze({
  score: 'An unknown job.roleFamily, job.source, job.discoverySource, job.applicationChannel, job.seniority, job.workMode or must-have status is rejected with the allowed values. An omitted roleFamily defaults to other (references/SCHEMAS.md).',
  round: 'An unknown lead disposition is rejected with the allowed values (references/ACCOUNTING.md). round lead and round source also accept one JSON array.',
});

/** Usage text for `help` output: every area, or one area. */
export function usageFor(area) {
  if (area && Object.hasOwn(COMMAND_USAGE, area)) {
    const note = Object.hasOwn(USAGE_NOTES, area) ? USAGE_NOTES[area] : undefined;
    return { usage: [COMMAND_USAGE[area]], ...(note ? { note } : {}) };
  }
  return {
    usage: Object.values(COMMAND_USAGE),
    note: 'Run node scripts/job-application.mjs <area> help for one area. Commands marked --stdin read one JSON object from standard input. round lead, round source, and ledger check also accept one JSON array.',
  };
}

/**
 * Area-specific usage error that names only known command tokens. The diagnostic prefix comes
 * first because skill_error analytics keep only the first 160 characters of the message.
 */
export function usageError(args) {
  const [area, action, value] = args;
  if (!area || !KNOWN_AREAS.includes(area)) {
    return new Error(`Usage (unknown area): areas are ${KNOWN_AREAS.join(', ')}. Run "help" for every command.`);
  }
  const knownAction = action && KNOWN_ACTIONS.has(action) ? action : null;
  let reason;
  let hint = '';
  if (area === 'ledger' && knownAction === 'outcome' && value !== '--stdin') {
    reason = 'ledger outcome, missing --stdin or --status';
    hint = ' Pipe one JSON object to --stdin, or pass an application id or URL with --status.';
  } else if (knownAction && STDIN_ACTIONS[area]?.includes(knownAction) && value !== '--stdin') {
    reason = `${area} ${knownAction}, missing --stdin`;
    hint = ` Pipe one JSON object: echo '{...}' | node scripts/job-application.mjs ${area} ${knownAction} --stdin.`;
  } else if (knownAction) reason = `${area} ${knownAction}, unexpected arguments`;
  else if (action) reason = `${area}, unknown subcommand`;
  else reason = `${area}, missing subcommand`;
  return new Error(`Usage (${reason}):${hint} ${COMMAND_USAGE[area]}`);
}
