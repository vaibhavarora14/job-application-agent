import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const skillDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const vendored = join(skillDir, 'scripts', 'runtime', 'sql-asm.cjs');

test('the vendored SQLite runtime is byte-identical to the pinned sql.js dependency', async () => {
  const require = createRequire(import.meta.url);
  const pinned = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).dependencies['sql.js'];
  assert.equal(JSON.parse(await readFile(require.resolve('sql.js/package.json'), 'utf8')).version, pinned);
  assert.ok((await readFile(vendored)).equals(await readFile(require.resolve('sql.js/dist/sql-asm.js'))),
    'scripts/runtime/sql-asm.cjs drifted from node_modules/sql.js/dist/sql-asm.js; recopy it after bumping sql.js');
  assert.ok((await readFile(join(skillDir, 'scripts', 'runtime', 'sql.js-LICENSE'), 'utf8')).includes('MIT'));
});

// `npx skills add` (and plain git copies) drop the bare skill folder into ~/.agents/skills or a vendor
// skills root with no node_modules beside it. The outreach store must not depend on resolving sql.js.
for (const root of [['.agents', 'skills'], ['.claude', 'skills']]) {
  test(`outreach store loads when the skill folder is copied into ~/${root.join('/')} without node_modules`, async () => {
    // Not realpath'd on purpose: on macOS this path sits under the /var -> /private/var symlink,
    // which the symlink-safe entrypoint check must handle (see entrypoint-symlink.test.mjs).
    const home = await mkdtemp(join(tmpdir(), 'jaa-skills-root-'));
    try {
      const dest = join(home, ...root, 'job-application-agent');
      await mkdir(join(home, ...root), { recursive: true });
      await cp(skillDir, dest, { recursive: true, filter: (source) => !source.includes(`${join('job-application-agent', 'tests')}`) });
      const cli = join(dest, 'scripts', 'job-application.mjs');
      // Prove the simulation is honest: sql.js is not resolvable from the copied skill.
      assert.throws(() => createRequire(cli).resolve('sql.js/dist/sql-asm.js'), { code: 'MODULE_NOT_FOUND' });
      const state = join(home, 'state');
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NODE_PATH: '',
        JOB_APPLICATION_AGENT_STATE_DIR: state,
        JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(home, 'absent-cloud.json'),
      };
      const run = async (args) => JSON.parse((await exec(process.execPath, [cli, 'outreach', ...args], { env, cwd: home })).stdout);
      assert.equal((await run(['policy', 'status'])).enabled, false);
      assert.equal((await run(['review'])).sentVerified, 0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

test('npm pack includes the vendored SQLite runtime and its license', async () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const { stdout } = await exec(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repoRoot, maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32',
  });
  const files = new Set(JSON.parse(stdout)[0].files.map((file) => file.path.replace(/\\/g, '/')));
  assert.ok(files.has('job-application-agent/scripts/runtime/sql-asm.cjs'), [...files].join('\n'));
  assert.ok(files.has('job-application-agent/scripts/runtime/sql.js-LICENSE'));
});
