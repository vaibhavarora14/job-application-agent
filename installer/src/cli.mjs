import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installSkill, readInstallStatus, setAutomaticUpdates, updateSkill } from './installer.mjs';
import { createUpdateRunner } from './runner.mjs';

const USAGE = `Usage:\n  job-application-agent install\n  job-application-agent update\n  job-application-agent status\n  job-application-agent updates enable|disable\n`;

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

export async function runCli(args, options = {}) {
  const output = options.output || (value => process.stdout.write(`${value}\n`));
  const packageRoot = options.packageRoot || defaultPackageRoot();
  const packageVersion = options.packageVersion || await defaultVersion(packageRoot);
  const shared = {
    packageRoot,
    packageVersion,
    homeDir: options.homeDir,
    codexHome: options.codexHome,
    platform: options.platform,
    scheduler: options.scheduler,
  };
  const command = args[0];

  if (command === 'status') {
    const status = await readInstallStatus({ codexHome: options.codexHome });
    output(status.installed
      ? `Installed version: ${status.installedVersion}\nAutomatic updates: ${status.automaticUpdates ? 'enabled' : 'disabled'}`
      : 'Not installed.');
    return status;
  }

  if (command === 'updates' && ['enable', 'disable'].includes(args[1])) {
    const status = await setAutomaticUpdates(args[1] === 'enable', { codexHome: options.codexHome, homeDir: options.homeDir, platform: options.platform, scheduler: options.scheduler });
    output(`Automatic updates: ${status.automaticUpdates ? 'enabled' : 'disabled'}`);
    return status;
  }

  if (command === 'auto-update') {
    const current = await readInstallStatus({ codexHome: options.codexHome });
    if (!current.automaticUpdates) { output('Automatic updates are disabled.'); return current; }
    const status = await updateSkill(shared);
    output(`Updated job-application-agent to ${status.installedVersion}.`);
    return status;
  }

  if (command === 'install' || command === 'update') {
    if (options.scheduler !== false) {
      const codexHome = options.codexHome || path.join(options.homeDir || process.env.HOME, '.codex');
      const runner = await createUpdateRunner({ platform: options.platform, codexHome, npmCliPath: await locateNpmCli() });
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
