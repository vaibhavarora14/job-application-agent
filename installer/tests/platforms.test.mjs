import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.mjs';

test('platform guides work before installation without creating private state', async t => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'job-agent-platforms-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const output = [];
  const options = { homeDir, agentHome: path.join(homeDir, '.agents'), output: value => output.push(value) };
  await runCli(['platforms'], options);
  assert.match(output.pop(), /hermes.*grok.*openclaw/s);
  for (const platform of ['hermes', 'grok', 'openclaw']) {
    await runCli(['platforms', platform], options);
    const guide = output.pop();
    assert.match(guide, /npx job-application-agent@latest install/);
    assert.match(guide, /review-each/);
    assert.match(guide, /resume path/);
    assert.match(guide, /lease/);
    assert.match(guide, /visible ATS success/);
  }
  assert.deepEqual(await readdir(homeDir), []);
});

test('unknown platform names and extra arguments fail without reading arbitrary files', async () => {
  for (const args of [['platforms', '../../package'], ['platforms', 'toString'], ['platforms', 'hermes', 'install']]) {
    await assert.rejects(runCli(args, { output: () => assert.fail('Unexpected output') }), /Usage:/);
  }
});
