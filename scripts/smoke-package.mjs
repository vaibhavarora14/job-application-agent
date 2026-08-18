import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const packageManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const temp = await mkdtemp(path.join(os.tmpdir(), 'job-application-agent-package-'));
const agentHome = path.join(temp, '.agents');
let tarball;

try {
  const packed = await execFileAsync('npm', ['pack', '--silent', '--ignore-scripts'], { cwd: root });
  tarball = path.join(root, packed.stdout.trim().split(/\r?\n/).at(-1));
  await execFileAsync('npm', [
    'exec', '--yes', `--package=file:${tarball}`, '--', 'job-application-agent', 'install',
  ], {
    cwd: temp,
    env: {
      ...process.env,
      HOME: temp,
      JOB_APPLICATION_AGENT_HOME: agentHome,
      JOB_APPLICATION_AGENT_NO_SCHEDULER: '1',
    },
  });

  const skill = await readFile(path.join(agentHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8');
  const config = JSON.parse(await readFile(path.join(agentHome, 'job-application-agent', 'install.json'), 'utf8'));
  if (!skill.includes('# Job Application Agent')) throw new Error('Packed skill did not install correctly.');
  if (config.installedVersion !== packageManifest.version || config.automaticUpdates !== false) throw new Error('Packed installer state is incorrect.');
  if (((await stat(path.join(agentHome, 'job-application-agent', 'install.json'))).mode & 0o777) !== 0o600) throw new Error('Install configuration permissions are not private.');
  process.stdout.write('Packed npm installation smoke test passed.\n');
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(temp, { recursive: true, force: true });
}
