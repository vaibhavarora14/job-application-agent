import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installSkill, readInstallStatus, resolveAgentHome, setAutomaticUpdates, updateSkill } from './installer.mjs';
import { createUpdateRunner } from './runner.mjs';

const USAGE = `Usage:\n  job-application-agent install\n  job-application-agent update\n  job-application-agent status\n  job-application-agent updates enable|disable\n  job-application-agent platforms [hermes|grok|openclaw]\n  job-application-agent outreach <command>\n`;

function defaultPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
    const guide = `${selected.name}\n${selected.status}\n\n${steps}\n\nStarter prompt\n${selected.starter}\n\nReusable instructions\n${catalog.instructions}\n\nPlatform documentation: ${selected.docsUrl}`;
    output(guide);
    return guide;
  }

  if (command === 'outreach') {
    const { runOutreach } = await import('../../job-application-agent/scripts/outreach-cli.mjs');
    const result = await runOutreach(args.slice(1));
    output(JSON.stringify(result, null, 2));
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
