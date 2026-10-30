// #218: "Application round was not found." says what was looked up, lists recent rounds and the next step.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { roundNotFoundError } from '../scripts/outreach-round.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

async function cliEnv(t) {
  const directory = await mkdtemp(join(tmpdir(), 'round-not-found-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  return {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_TELEMETRY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_NO_BROWSER: '1',
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  };
}
const cli = (env, args, input) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', ...(input === undefined ? {} : { input: JSON.stringify(input) }) });

test('roundNotFoundError names the lookup, recent rounds with status and the next command', () => {
  const events = [
    { type: 'started', roundId: 'r-old' }, { type: 'completed', roundId: 'r-old' },
    { type: 'started', roundId: 'r-new' },
  ];
  const byId = roundNotFoundError(events, 'r-typo').message;
  assert.match(byId, /^Application round was not found: no round "r-typo" was started in this state folder\./);
  assert.match(byId, /Recent rounds: r-new \(open\), r-old \(completed\)\./);
  assert.match(byId, /round status/);
  assert.match(byId, /Without cloud sync, rounds live only in this state folder \(JOB_APPLICATION_AGENT_STATE_DIR\).*with cloud sync, check the round ID/);
  const none = roundNotFoundError([], null).message;
  assert.match(none, /there is no open round in this state folder\. No rounds have been started here yet\. Start one with round start --stdin/);
});

test('round status with an unknown roundId lists the open round instead of a bare not-found', async (t) => {
  const env = await cliEnv(t);
  const started = cli(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  assert.equal(started.status, 0, started.stderr);
  const { roundId } = JSON.parse(started.stdout);
  const missing = cli(env, ['round', 'status', 'round-does-not-exist']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Application round was not found: no round "round-does-not-exist"/);
  assert.ok(missing.stderr.includes(`${roundId} (open)`), missing.stderr);
});
