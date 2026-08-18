import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installSkill, readInstallStatus, resolveAgentHome, setAutomaticUpdates, uninstallSkill, updateSkill } from './installer.mjs';
import { createUpdateRunner } from './runner.mjs';

const USAGE = `Usage:\n  job-application-agent install [--enable-background-updates]\n  job-application-agent update [--enable-background-updates]\n  job-application-agent status\n  job-application-agent updates enable|disable\n  job-application-agent uninstall\n`;

function defaultPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

async function defaultVersion(packageRoot) {
  return JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).version;
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
  const command = args[0];
  const backgroundUpdates = args.includes('--enable-background-updates');

  if (command === 'status') {
    const status = await readInstallStatus({ homeDir, agentHome });
    output(status.installed
      ? `Installed version: ${status.installedVersion}\nBackground update checks: ${status.automaticUpdates ? 'enabled' : 'disabled'}`
      : 'Not installed.');
    return status;
  }

  if (command === 'updates' && ['enable', 'disable'].includes(args[1])) {
    let checkRunner;
    if (args[1] === 'enable' && scheduler !== false) {
      checkRunner = await createUpdateRunner({ agentHome, packageVersion });
    }
    const status = await setAutomaticUpdates(args[1] === 'enable', { homeDir, agentHome, platform: options.platform, scheduler, checkRunner });
    output(`Background update checks: ${status.automaticUpdates ? 'enabled' : 'disabled'}`);
    return status;
  }

  if (command === 'uninstall') {
    await uninstallSkill({ homeDir, agentHome, platform: options.platform });
    output('Uninstalled job-application-agent. Background checks and scheduler artifacts were removed.');
    return { uninstalled: true };
  }

  if (command === 'install' || command === 'update') {
    const prior = await readInstallStatus({ homeDir, agentHome });
    const priorEnabled = prior.installed && prior.automaticUpdates !== false;
    let checkRunner;
    if (scheduler !== false && (backgroundUpdates || priorEnabled)) {
      checkRunner = await createUpdateRunner({ agentHome, packageVersion });
    }
    const shared = {
      packageRoot,
      packageVersion,
      homeDir,
      agentHome,
      platform: options.platform,
      scheduler,
      backgroundUpdates: backgroundUpdates ? true : undefined,
      checkRunner,
    };
    const status = command === 'install' ? await installSkill(shared) : await updateSkill(shared);
    output(`${command === 'install' ? 'Installed' : 'Updated'} job-application-agent ${status.installedVersion}.\nBackground update checks: ${status.automaticUpdates ? 'enabled' : 'disabled'}`);
    return status;
  }

  throw new Error(USAGE);
}

export async function main() {
  await runCli(process.argv.slice(2));
}
