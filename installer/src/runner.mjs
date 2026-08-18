import { chmod, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SKILL_NAME = 'job-application-agent';
const CHECK_RUNNER_FILENAME = 'check-update-runner.mjs';

function assertExactVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) throw new Error('An exact immutable semantic version is required to create the safe update-check runner.');
  return value;
}

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
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

export async function createUpdateRunner({ agentHome, codexHome, nodePath = process.execPath, packageVersion }) {
  if (!packageVersion) throw new Error('An exact package version is required to create the safe update-check runner.');
  const home = agentHome || codexHome;
  if (!home) throw new Error('An agent home directory is required to create the safe update-check runner.');
  const exactVersion = assertExactVersion(packageVersion);
  assertAbsolute(home, 'The agent home');
  assertAbsolute(nodePath, 'The Node.js executable');

  const managerDir = path.join(home, SKILL_NAME);
  const checkScriptPath = path.join(managerDir, CHECK_RUNNER_FILENAME);
  await mkdir(managerDir, { recursive: true });
  await rm(checkScriptPath, { force: true });
  await writeFile(checkScriptPath, createCheckScript(), { mode: 0o600 });
  await chmod(checkScriptPath, 0o600);

  const scriptStat = await lstat(checkScriptPath);
  if (scriptStat.isSymbolicLink()) throw new Error('The update-check runner must not be a symbolic link.');
  if (!scriptStat.isFile()) throw new Error('The update-check runner could not be created as a regular file.');

  const resolvedScript = await realpath(checkScriptPath);
  const resolvedNode = await realpath(nodePath);

  return {
    nodePath: resolvedNode,
    checkScriptPath: resolvedScript,
    agentHome: home,
    packageVersion: exactVersion,
  };
}
