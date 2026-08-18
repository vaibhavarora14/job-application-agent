import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertExactVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) throw new Error('An exact immutable semantic version is required to create the safe update-check runner.');
  return value;
}

function createCheckScript() {
  return `import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [agentHome, installedVersion] = process.argv.slice(2);

if (!agentHome || !installedVersion) {
  throw new Error('Usage: check-update-runner.mjs <agentHome> <installedVersion>');
}

const managerDir = path.join(agentHome, 'job-application-agent');
const statusPath = path.join(managerDir, 'update-status.json');
const temporary = path.join(managerDir, \`update-status.\${process.pid}.tmp\`);

let current = {};
try {
  current = JSON.parse(await readFile(statusPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const next = {
  version: 1,
  checkedAt: new Date().toISOString(),
  installedVersion,
  automaticUpdateExecution: false,
  pendingUpdateVersion: null,
  status: 'manual-review-required',
  reason: 'Background checks never download or execute remote packages. Run an explicit exact-version install from a trusted release after verifying integrity.',
};

await mkdir(managerDir, { recursive: true });
await writeFile(temporary, \`\${JSON.stringify({ ...current, ...next }, null, 2)}\\n\`, { mode: 0o600 });
await rename(temporary, statusPath);
`;
}

export async function createUpdateRunner({ platform = process.platform, agentHome, codexHome, nodePath = process.execPath, packageVersion }) {
  if (!packageVersion) throw new Error('An exact package version is required to create the safe update-check runner.');
  const home = agentHome || codexHome;
  const managerDir = path.join(home, 'job-application-agent');
  const nodeDir = path.dirname(nodePath);
  const exactVersion = assertExactVersion(packageVersion);
  await mkdir(managerDir, { recursive: true });
  const checkScriptPath = path.join(managerDir, 'check-update-runner.mjs');
  await writeFile(checkScriptPath, createCheckScript(), { mode: 0o600 });
  if (platform === 'win32') {
    const filePath = path.join(managerDir, 'check-update.cmd');
    const script = `@echo off\r\nset "JOB_APPLICATION_AGENT_HOME=${home}"\r\nset "PATH=${nodeDir};%PATH%"\r\n"${nodePath}" "${checkScriptPath}" "${home}" "${exactVersion}"\r\n`;
    await writeFile(filePath, script, { mode: 0o700 });
    return { path: filePath };
  }
  const filePath = path.join(managerDir, 'check-update');
  const script = `#!/bin/sh\nJOB_APPLICATION_AGENT_HOME=${shellQuote(home)}\nPATH=${shellQuote(nodeDir)}:\${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}\nexport JOB_APPLICATION_AGENT_HOME PATH\nexec ${shellQuote(nodePath)} ${shellQuote(checkScriptPath)} ${shellQuote(home)} ${shellQuote(exactVersion)}\n`;
  await writeFile(filePath, script, { mode: 0o700 });
  await chmod(filePath, 0o700);
  return { path: filePath };
}
