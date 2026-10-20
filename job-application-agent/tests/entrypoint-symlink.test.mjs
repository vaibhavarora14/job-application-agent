import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntrypoint } from '../scripts/entrypoint.mjs';

// Deliberately NOT realpath'd: on macOS tmpdir() is itself under the /var -> /private/var symlink,
// which is exactly the case that used to make the CLI exit 0 with no output.
const skillDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliScript = join(skillDir, 'scripts', 'job-application.mjs');
const binScript = join(repoRoot, 'bin', 'job-application-agent.mjs');
const isWindows = process.platform === 'win32';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'jaa-symlink-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state');
  await mkdir(state);
  await writeFile(join(state, 'telemetry.json'), JSON.stringify({ enabled: false, disclosed: true }));
  const env = {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: state,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(dir, 'absent-cloud.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
  };
  return { dir, env };
}

// Directory links use junctions on Windows (no admin or Developer Mode needed). File symlinks on
// Windows can require privileges; skip that case there rather than fail.
async function link(t, target, path, kind) {
  try {
    await symlink(target, path, kind === 'dir' && isWindows ? 'junction' : kind);
    return true;
  } catch (error) {
    if (isWindows && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip(`symlink creation not permitted on this Windows host (${error.code})`);
      return false;
    }
    throw error;
  }
}

function run(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  assert.notEqual(result.stdout.trim(), '', `no output from ${script} ${args.join(' ')}; stderr: ${result.stderr}`);
  return result.stdout;
}

function assertVersion(stdout) {
  assert.match(JSON.parse(stdout).version, /^\d+\.\d+\.\d+$/);
}

test('isEntrypoint matches direct, symlinked and differently spelled paths, and rejects others', async (t) => {
  const { dir } = await scratch(t);
  const url = pathToFileURL(cliScript).href;
  assert.equal(isEntrypoint(url, cliScript), true);
  assert.equal(isEntrypoint(url, join(skillDir, 'scripts', '.', 'job-application.mjs')), true);
  assert.equal(isEntrypoint(url, join(skillDir, 'scripts', 'outreach-cli.mjs')), false);
  assert.equal(isEntrypoint(url, undefined), false);
  assert.equal(isEntrypoint(url, ''), false);
  assert.equal(isEntrypoint(url, join(dir, 'does-not-exist.mjs')), false);
  if (await link(t, skillDir, join(dir, 'linked-skill'), 'dir')) {
    assert.equal(isEntrypoint(url, join(dir, 'linked-skill', 'scripts', 'job-application.mjs')), true);
  }
});

test('CLI produces output when the skill directory is reached through a symlink', async (t) => {
  const { dir, env } = await scratch(t);
  const linked = join(dir, 'linked-skill');
  if (!(await link(t, skillDir, linked, 'dir'))) return;
  const script = join(linked, 'scripts', 'job-application.mjs');
  assertVersion(run(script, ['--version'], env));
  assert.ok(Array.isArray(JSON.parse(run(script, ['help'], env)).usage));
  assert.equal(JSON.parse(run(script, ['round', 'start', '--stdin', '{"requestedCount":1}'], env)).requestedCount, 1);
});

test('CLI produces output when invoked through a symlinked script file', async (t) => {
  const { dir, env } = await scratch(t);
  const linked = join(dir, 'job-application.mjs');
  if (!(await link(t, cliScript, linked, 'file'))) return;
  assertVersion(run(linked, ['--version'], env));
});

for (const root of [['.agents', 'skills'], ['.claude', 'skills']]) {
  test(`installed skill works when ~/${root.join('/')} is a symlink to another directory`, async (t) => {
    const { dir, env } = await scratch(t);
    // Common dotfiles setup: the skills root is a symlink into a synced/dotfiles directory.
    const realRoot = join(dir, 'dotfiles', 'skills');
    await mkdir(realRoot, { recursive: true });
    await cp(skillDir, join(realRoot, 'job-application-agent'), { recursive: true, filter: (source) => !source.includes(join('job-application-agent', 'tests')) });
    await mkdir(join(dir, 'home', root[0]), { recursive: true });
    if (!(await link(t, realRoot, join(dir, 'home', ...root), 'dir'))) return;
    const script = join(dir, 'home', ...root, 'job-application-agent', 'scripts', 'job-application.mjs');
    const homeEnv = { ...env, HOME: join(dir, 'home'), USERPROFILE: join(dir, 'home') };
    assertVersion(run(script, ['--version'], homeEnv));
    assert.equal(JSON.parse(run(script, ['outreach', 'policy', 'status'], homeEnv)).enabled, false);
  });
}

test('npm bin shim works through a node_modules/.bin style symlink', async (t) => {
  const { dir, env } = await scratch(t);
  const binDir = join(dir, 'node_modules', '.bin');
  await mkdir(binDir, { recursive: true });
  const linked = join(binDir, 'job-application-agent');
  if (!(await link(t, binScript, linked, 'file'))) return;
  assert.match(run(linked, ['platforms'], env), /Platform setup guides/);
  if (!isWindows) {
    // Executed directly via the shebang, as npm's bin link is on macOS/Linux.
    const direct = spawnSync(linked, ['platforms'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(direct.status, 0, direct.stderr);
    assert.match(direct.stdout, /Platform setup guides/);
  }
});
