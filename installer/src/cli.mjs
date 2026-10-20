import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertApplyUrlAllowed, parseApplyUrl } from '../../job-application-agent/scripts/ats/apply-url-gate.mjs';
import { installSkill, readInstallStatus, resolveAgentHome, setAutomaticUpdates, updateSkill } from './installer.mjs';
import { createUpdateRunner } from './runner.mjs';

const HELP_ARGS = new Set(['help', '--help', '-h']);
const USAGE = `Usage:\n  job-application-agent install\n  job-application-agent update\n  job-application-agent status\n  job-application-agent updates enable|disable\n  job-application-agent platforms [hermes|grok|openclaw]\n  job-application-agent outreach <command>\n  job-application-agent apply <url>\n`;

function defaultPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function assertPublicHttpsApplyUrl(value) {
  const parsed = parseApplyUrl(value);
  if (parsed.protocol !== 'https:') {
    throw new Error(`Apply URL must be HTTPS: ${value}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Apply URL must not include username or password: ${value}`);
  }
  return parsed;
}

export function buildApplyReviewPrompt(url) {
  return [
    'Apply to this role in review mode (do not submit until I approve):',
    '',
    `URL: ${url}`,
    '',
    'Instructions:',
    '1. Open the posting and extract only facts from my profile/resume.',
    '2. Draft the application.',
    '3. Stop and show me the draft for approval before any submit.',
    '4. Never auto-submit. Review mode stays on.',
    '',
    'Paste this into your JobAppAgent session, or run your usual agent after: npx job-application-agent@latest install',
  ].join('\n');
}

async function defaultVersion(packageRoot) {
  return JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).version;
}

async function locateNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await readFile(candidate); return candidate; } catch {}
  }
  throw new Error('Could not locate npm. Install Node.js with npm and retry.');
}

function resolveHome(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const agentHome = options.agentHome || options.codexHome || resolveAgentHome(homeDir);
  return { homeDir, agentHome };
}

export async function runCli(args, options = {}) {
  const output = options.output || (value => process.stdout.write(`${value}\n`));
  // An explicit help request is not an error: print usage and exit 0. A missing or unknown
  // command still fails with the same usage text.
  if (args.length === 1 && HELP_ARGS.has(args[0])) {
    output(USAGE.trimEnd());
    return { usage: USAGE };
  }
  const packageRoot = options.packageRoot || defaultPackageRoot();
  const packageVersion = options.packageVersion || await defaultVersion(packageRoot);
  const scheduler = process.env.JOB_APPLICATION_AGENT_NO_SCHEDULER === '1' ? false : options.scheduler;
  const { homeDir, agentHome } = resolveHome(options);
  const shared = {
    packageRoot,
    packageVersion,
    homeDir,
    agentHome,
    platform: options.platform,
    scheduler,
  };
  const command = args[0];

  if (command === 'platforms') {
    const catalog = JSON.parse(await readFile(path.join(packageRoot, 'job-application-agent', 'platforms.json'), 'utf8'));
    if (args.length === 1) {
      const listing = catalog.platforms.map(item => `${item.id}: ${item.name} — ${item.status}`).join('\n');
      output(`Platform setup guides (read-only):\n${listing}\nRun job-application-agent platforms <name> for instructions.`);
      return catalog.platforms;
    }
    const selected = catalog.platforms.find(item => item.id === args[1]);
    if (!selected || args.length !== 2) throw new Error(USAGE);
    const steps = selected.steps.map((step, i) => `${i + 1}. ${step.title}\n${step.text}${step.code ? `\n\n${step.code}` : ''}`).join('\n\n');
    const templateLine = selected.templateUrl ? `\nBot template: ${selected.templateUrl}` : '';
    const guide = `${selected.name}\n${selected.status}${templateLine}\n\n${steps}\n\nStarter prompt\n${selected.starter}\n\nReusable instructions\n${catalog.instructions}\n\nPlatform documentation: ${selected.docsUrl}`;
    output(guide);
    return guide;
  }

  if (command === 'outreach') {
    const { runOutreach } = await import('../../job-application-agent/scripts/outreach-cli.mjs');
    const result = await runOutreach(args.slice(1));
    output(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'apply') {
    const rawUrl = args[1];
    if (!rawUrl || args.length !== 2) throw new Error(USAGE);
    const parsed = assertPublicHttpsApplyUrl(rawUrl);
    const href = parsed.href;
    const env = options.env || process.env;
    const log = options.log || ((message) => {
      if (typeof process !== 'undefined' && process.stderr) process.stderr.write(`${message}\n`);
    });
    const gate = assertApplyUrlAllowed(href, { liveApply: true, env, log });
    const prompt = buildApplyReviewPrompt(href);
    const confirmation = `Confirmed: apply ${href} — review mode required; do not submit until approved.`;
    const result = {
      url: href,
      reviewMode: true,
      prompt,
      confirmation,
      applyKind: gate.applyKind,
      liveApply: gate.liveApply,
      entry: gate.entry,
    };
    if (options.launchPrompt) return result;
    output(prompt);
    output('');
    output(confirmation);
    return result;
  }

  if (command === 'status') {
    const status = await readInstallStatus({ homeDir, agentHome });
    output(status.installed
      ? `Installed version: ${status.installedVersion}\nAutomatic updates: ${status.automaticUpdates ? 'enabled' : 'disabled'}`
      : 'Not installed.');
    return status;
  }

  if (command === 'updates' && ['enable', 'disable'].includes(args[1])) {
    const status = await setAutomaticUpdates(args[1] === 'enable', { homeDir, agentHome, platform: options.platform, scheduler });
    output(`Automatic updates: ${status.automaticUpdates ? 'enabled' : 'disabled'}`);
    return status;
  }

  if (command === 'auto-update') {
    const current = await readInstallStatus({ homeDir, agentHome });
    if (!current.automaticUpdates) { output('Automatic updates are disabled.'); return current; }
    if (current.installedVersion === packageVersion) { output(`Job Application Agent ${packageVersion} is already current.`); return current; }
    const status = await updateSkill({ ...shared, scheduler: false });
    output(`Updated job-application-agent to ${status.installedVersion}.`);
    return status;
  }

  if (command === 'install' || command === 'update') {
    if (scheduler !== false) {
      const runner = await createUpdateRunner({ platform: options.platform, agentHome, npmCliPath: await locateNpmCli() });
      shared.command = runner.path;
    }
    const status = command === 'install' ? await installSkill(shared) : await updateSkill(shared);
    output(`${command === 'install' ? 'Installed' : 'Updated'} job-application-agent ${status.installedVersion}.\nAutomatic updates: ${status.automaticUpdates ? 'enabled' : 'disabled'}`);
    return status;
  }

  throw new Error(USAGE);
}

export async function main() {
  await runCli(process.argv.slice(2));
}
