import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { outreachCache, runOutreach } from '../scripts/outreach-cli.mjs';
import { migrateLegacyStateDir, legacyMacStateDir, resolveStateDir } from '../scripts/secret-store.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

test('CLI outreach success and errors bypass telemetry, identity, and community network paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outreach-cli-'));
  try {
    const trap = join(dir, 'network-trap.mjs');
    await writeFile(trap, "import { appendFileSync } from 'node:fs'; globalThis.fetch = async () => { appendFileSync(process.env.NETWORK_MARKER, 'called'); throw new Error('NETWORK_TRAP'); };\n");
    const run = args => exec(process.execPath, ['--import', pathToFileURL(trap).href, cli, 'outreach', ...args], { env: { ...process.env, NETWORK_MARKER: join(dir, 'network-called'), JOB_APPLICATION_AGENT_STATE_DIR: dir, JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(dir, 'absent.json') } });
    const result = await run(['policy', 'status']);
    assert.equal(JSON.parse(result.stdout).enabled, false);
    await assert.rejects(run(['invented']), error => !error.stderr.includes('NETWORK_TRAP') && /outreach/i.test(error.stderr));
    for (const name of ['telemetry.json', 'source-sharing.json', 'telemetry-identity.json']) await assert.rejects(readFile(join(dir, name)), { code: 'ENOENT' });
    await assert.rejects(readFile(join(dir, 'network-called')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('late snapshots cannot undo mutation invalidation or a newer clear snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outreach-cache-race-'));
  try {
    const { generation } = await outreachCache(dir, 'synthetic-binding', 'read');
    await outreachCache(dir, 'synthetic-binding', 'invalidate');
    const rejected = await outreachCache(dir, 'synthetic-binding', 'write', { generation, snapshot: { revision: 1, privateText: 'old' } });
    assert.equal(rejected.snapshot, undefined);
    await outreachCache(dir, 'synthetic-binding', 'write', { generation: rejected.generation, snapshot: { revision: 3, cleared: true } });
    const current = await outreachCache(dir, 'synthetic-binding', 'write', { generation: rejected.generation, snapshot: { revision: 2, privateText: 'old' } });
    assert.equal(current.snapshot, undefined);
    assert.equal(current.generation, rejected.generation + 1);
    assert.equal(JSON.stringify(current).includes('old'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('outreach first-run migrates legacy state before creating its database', async () => {
  const home = await mkdtemp(join(tmpdir(), 'outreach-legacy-'));
  try {
    const options = { home, env: {}, plat: 'darwin' };
    const legacy = legacyMacStateDir(home), destination = resolveStateDir(options);
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'applications.ndjson'), '{"id":"legacy"}\n');
    await runOutreach(['policy', 'status'], { stateDirectory: destination,
      cloudClient: { config: async () => null }, migrate: directory => migrateLegacyStateDir(directory, options) });
    assert.equal(await readFile(join(destination, 'applications.ndjson'), 'utf8'), '{"id":"legacy"}\n');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a lower authoritative revision removes pre-restore sensitive cache before offline use', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outreach-restored-cache-'));
  try {
    const binding = 'same-worker-and-token';
    const { generation } = await outreachCache(dir, binding, 'read');
    await outreachCache(dir, binding, 'write', { generation, snapshot: { revision: 50, privateText: 'pre-restore' } });
    await outreachCache(dir, binding, 'write', { generation, snapshot: { revision: 3, items: [], policy: { recoveryBlocked: true } } });
    const cache = await outreachCache(dir, binding, 'read');
    assert.equal(cache.snapshot, undefined);
    assert.equal((await readFile(join(dir, 'outreach-cloud-cache.json'), 'utf8')).includes('pre-restore'), false);
    // A delayed pre-restore response cannot refill the invalidated cache.
    await outreachCache(dir, binding, 'write', { generation, snapshot: { revision: 51, privateText: 'pre-restore' } });
    assert.equal((await outreachCache(dir, binding, 'read')).snapshot, undefined);
    await outreachCache(dir, binding, 'write', { generation: cache.generation, snapshot: { revision: 3, items: [] } });
    assert.deepEqual((await outreachCache(dir, binding, 'read')).snapshot.items, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
