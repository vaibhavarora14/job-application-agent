import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
// Constant preload: pause immediately before the source command acquires its
// rounds lock, allowing a real lead command to commit first without timing sleeps.
const lockBarrierPreload = `
import fs from 'node:fs/promises';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const originalOpen = fs.open;
let intercepted = false;
fs.open = async function(path, ...args) {
  if (!intercepted && basename(String(path)) === '.rounds.lock') {
    intercepted = true;
    await new Promise((resolve, reject) => {
      process.once('message', message => {
        if (message !== 'release-lock-attempt') return reject(new Error('Unexpected barrier message'));
        process.disconnect();
        resolve();
      });
      process.send('before-rounds-lock');
    });
  }
  return originalOpen.call(fs, path, ...args);
};
syncBuiltinESMExports();
`;

function launch(env, args, input, preloadPath) {
  const runtime = preloadPath ? ['--import', pathToFileURL(preloadPath).href] : [];
  const child = spawn(process.execPath, [...runtime, script, ...args], {
    env, stdio: preloadPath ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
  });
  const completed = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  child.stdin.end(JSON.stringify(input));
  return { child, completed };
}

for (const explicitStaleCounts of [false, true]) {
  test(explicitStaleCounts
    ? 'source coverage rejects stale count assertions after a lead commits before lock acquisition'
    : 'source coverage derives counts from the lead committed before lock acquisition', { timeout: 15000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'accounting-source-race-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const preloadPath = join(dir, 'rounds-lock-barrier.mjs');
    await writeFile(preloadPath, lockBarrierPreload);
    await writeFile(join(dir, 'telemetry.json'), JSON.stringify({ enabled: false, disclosed: true }));
    const env = {
      ...process.env,
      JOB_APPLICATION_AGENT_STATE_DIR: dir,
      JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(dir, 'absent-cloud-config.json'),
      JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    };
    const started = await launch(env, ['round', 'start', '--stdin'], { requestedCount: 1 }).completed;
    assert.equal(started.code, 0, started.stderr);
    const { roundId } = JSON.parse(started.stdout);
    const sourceId = 'indeed';
    const source = launch(env, ['round', 'source', '--stdin'], {
      roundId, sourceId, status: 'searched', evidence: 'Synthetic source search.',
      ...(explicitStaleCounts ? { reviewedCount: 0, qualifiedCount: 0 } : {}),
    }, preloadPath);
    t.after(() => { if (source.child.exitCode === null) source.child.kill(); });
    await Promise.race([
      new Promise((resolve, reject) => {
        source.child.once('message', message => {
          if (message === 'before-rounds-lock') resolve();
          else reject(new Error('Source sent an unexpected barrier message.'));
        });
      }),
      source.completed.then(result => { throw new Error(`Source exited before the lock barrier: ${result.stderr}`); }),
    ]);
    const lead = await launch(env, ['round', 'lead', '--stdin'], {
      id: 'qualified-lead', roundId, sourceId, company: 'Synthetic Example', role: 'Engineer',
      url: 'https://example.test/jobs/123', disposition: 'qualified',
      observedAt: '2026-09-14T10:00:00.000Z', evidence: 'Synthetic qualifying employer requisition.',
    }).completed;
    assert.equal(lead.code, 0, lead.stderr);
    source.child.send('release-lock-attempt');
    const result = await source.completed;
    const stored = (await readFile(join(dir, 'rounds.ndjson'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const coverage = stored.filter(event => event.type === 'source-checked');
    if (explicitStaleCounts) {
      assert.notEqual(result.code, 0, 'Stale zero-count assertions must not be accepted after one qualified lead commits.');
      assert.match(result.stderr, /count assertions do not match recorded leads/i);
      assert.equal(coverage.length, 0);
    } else {
      assert.equal(result.code, 0, result.stderr);
      const event = JSON.parse(result.stdout);
      assert.equal(event.reviewedCount, 1);
      assert.equal(event.qualifiedCount, 1);
      assert.equal(coverage.length, 1);
      assert.equal(coverage[0].reviewedCount, 1);
      assert.equal(coverage[0].qualifiedCount, 1);
    }
  });
}
