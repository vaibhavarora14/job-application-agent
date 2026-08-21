import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

import {
  classifyChangedPaths,
  parseNameStatusZ,
} from '../../scripts/ci/classify-paths.mjs';

function workflowUses(source) {
  const workflow = parse(source);
  const references = [];

  for (const job of Object.values(workflow?.jobs ?? {})) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
    if (typeof job.uses === 'string') references.push(job.uses);
    for (const step of job.steps ?? []) {
      if (step && typeof step === 'object' && typeof step.uses === 'string') {
        references.push(step.uses);
      }
    }
  }

  return references;
}

test('classifies documentation-only changes as low risk', () => {
  assert.deepEqual(classifyChangedPaths(['README.md', 'job-application-agent/references/RUNS.md']), {
    codeChanged: false,
    dependencyChanged: false,
    highRisk: false,
  });
});

test('classifies installer, state, workflow, package, and security changes as high risk', () => {
  for (const changedPath of [
    'installer/src/installer.mjs',
    'job-application-agent/scripts/job-application.mjs',
    '.github/workflows/validate.yml',
    'package.json',
    'package-lock.json',
    'bin/job-application-agent.mjs',
    'scripts/smoke-package.mjs',
    'scripts/ci/classify-paths.mjs',
    'telemetry-worker/src/worker.mjs',
    'telemetry-worker/migrations/0002_add_index.sql',
    'telemetry-worker/wrangler.jsonc',
    'SECURITY.md',
  ]) {
    assert.equal(classifyChangedPaths([changedPath]).highRisk, true, changedPath);
  }
});

test('tracks dependency and ordinary JavaScript changes independently', () => {
  assert.deepEqual(classifyChangedPaths(['package-lock.json']), {
    codeChanged: false,
    dependencyChanged: true,
    highRisk: true,
  });
  assert.deepEqual(classifyChangedPaths(['telemetry-worker/public/dashboard.js']), {
    codeChanged: true,
    dependencyChanged: false,
    highRisk: false,
  });
});

test('parses both sides of renamed and copied paths from git name-status -z output', () => {
  const input = Buffer.from([
    'M', 'README.md',
    'R100', 'installer/src/old.mjs', 'docs/installer-example.mjs',
    'C075', 'package.json', 'examples/package.json',
    'A', 'telemetry-worker/src/new-worker.mjs',
    '',
  ].join('\0'));

  assert.deepEqual(parseNameStatusZ(input), [
    'README.md',
    'installer/src/old.mjs',
    'docs/installer-example.mjs',
    'package.json',
    'examples/package.json',
    'telemetry-worker/src/new-worker.mjs',
  ]);
});

test('all workflows use immutable action SHAs, explicit permissions, and safe pull request triggers', async () => {
  const workflowDirectory = new URL('../../.github/workflows/', import.meta.url);
  const workflows = (await readdir(workflowDirectory)).filter(name => /\.ya?ml$/.test(name));
  assert.ok(workflows.length > 0, 'at least one workflow must be checked');

  for (const workflow of workflows) {
    const source = await readFile(new URL(workflow, workflowDirectory), 'utf8');
    assert.match(source, /^permissions:/m, `${workflow} must declare permissions`);
    assert.doesNotMatch(source, /pull_request_target\s*:/, `${workflow} must not run privileged code from pull_request_target`);
    for (const reference of workflowUses(source)) {
      if (reference.startsWith('./')) continue;
      assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/, `${workflow} must pin ${reference} to a full commit SHA`);
    }
  }
});

test('workflow pinning scans both step actions and job-level reusable workflows', () => {
  const workflow = `jobs:
  reusable:
    uses: owner/automation/.github/workflows/check.yml@v1
  spaced:
    uses : owner/automation/.github/workflows/spaced.yml@v2
  quoted:
    "uses": owner/automation/.github/workflows/quoted.yml@v3
  flow: { uses: owner/automation/.github/workflows/flow.yml@v4 }
  action:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@0123456789012345678901234567890123456789
`;

  assert.deepEqual(workflowUses(workflow), [
    'owner/automation/.github/workflows/check.yml@v1',
    'owner/automation/.github/workflows/spaced.yml@v2',
    'owner/automation/.github/workflows/quoted.yml@v3',
    'owner/automation/.github/workflows/flow.yml@v4',
    'actions/checkout@0123456789012345678901234567890123456789',
  ]);
});

test('workflows install lockfile dependencies before running repository tests', async () => {
  const workflowDirectory = new URL('../../.github/workflows/', import.meta.url);
  const workflows = (await readdir(workflowDirectory)).filter(name => /\.ya?ml$/.test(name));

  for (const workflow of workflows) {
    const source = await readFile(new URL(workflow, workflowDirectory), 'utf8');
    const document = parse(source);
    for (const [jobName, job] of Object.entries(document?.jobs ?? {})) {
      const commands = (job?.steps ?? [])
        .map(step => step?.run)
        .filter(command => typeof command === 'string');
      const testIndex = commands.findIndex(command => /\bnpm test\b/.test(command));
      if (testIndex === -1) continue;
      const installIndex = commands.findIndex(command => /\bnpm ci\b/.test(command));
      assert.ok(
        installIndex !== -1 && installIndex < testIndex,
        `${workflow}:${jobName} must run npm ci before npm test`,
      );
    }
  }
});

test('telemetry persistence and deployment paths require code-owner review', async () => {
  const codeowners = await readFile(new URL('../../.github/CODEOWNERS', import.meta.url), 'utf8');
  assert.match(codeowners, /^\/telemetry-worker\/src\/\s+@vaibhavarora14$/m);
  assert.match(codeowners, /^\/telemetry-worker\/migrations\/\s+@vaibhavarora14$/m);
  assert.match(codeowners, /^\/telemetry-worker\/wrangler\.jsonc\s+@vaibhavarora14$/m);
});

test('staging moderation always rejects an approved fixture after a failed verification', async () => {
  const workflow = (await readFile(new URL('../../.github/workflows/staging-telemetry.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(workflow, /id:\s*verify_reviewed/);
  assert.match(workflow, /id:\s*reject_source\n\s*if:\s*\$\{\{ always\(\) && steps\.pending_source\.outputs\.community_source_id != '' \}\}/);
  assert.match(workflow, /steps\.verify_reviewed\.outcome == 'success'/);
});

test('validation exposes a stable quality gate and a six-combination high-risk matrix', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/validate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^\s{2}quality-gate:/m);
  assert.match(workflow, /name:\s*quality-gate/);
  assert.match(workflow, /matrix:/);
  assert.match(workflow, /os:\s*\[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(workflow, /node:\s*\[20, 24\]/);
  assert.match(workflow, /classify-paths\.mjs/);
  assert.match(workflow, /check:native-artifacts/);
});

test('validation commands are portable across Windows and pipefail shells', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const workflow = await readFile(new URL('../../.github/workflows/validate.yml', import.meta.url), 'utf8');
  const smokePackage = await readFile(new URL('../../scripts/smoke-package.mjs', import.meta.url), 'utf8');

  assert.equal(packageJson.scripts.test, 'node --test', 'the shell must not be responsible for expanding test globs');
  assert.match(workflow, /tar -tzf "\$package_file" > "\$package_listing"/);
  assert.doesNotMatch(workflow, /tar -tzf "\$package_file" \| grep/, 'tar must not receive SIGPIPE under pipefail');
  assert.match(smokePackage, /process\.env\.npm_execpath/);
  assert.doesNotMatch(smokePackage, /execFileAsync\(['"]npm['"]/, 'the smoke check must not assume a Unix npm executable');
});
