import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ALLOWED_FILES } from '../src/names.mjs';
import { loadConfig, runSync } from '../src/sync.mjs';
import worker, { ALLOWLIST } from '../src/worker.mjs';

const EXPECTED_FILES = [
  'resume.pdf',
  'resume.json',
  'autonomy.json',
  'postal-address.json',
  'review-policy.json',
  'source-sharing.json',
  'telemetry.json',
  'applications.ndjson',
  'attention.ndjson',
  'community-job-contribution-receipts.ndjson',
  'friction.ndjson',
  'outcomes.ndjson',
  'rounds.ndjson',
  'source-contribution-receipts.ndjson',
  'source-suggestions.ndjson',
];

function capture() {
  const lines = [];
  return {
    lines,
    write(chunk) {
      lines.push(String(chunk));
    },
  };
}

test('runSync usage names the program that runs runSync', async () => {
  const stderr = capture();
  const code = await runSync(['nope'], {
    env: {},
    home: tmpdir(),
    secretStore: { readProfile() { return null; } },
    stdout: capture(),
    stderr,
  });
  const text = stderr.lines.join('');
  assert.equal(code, 2);
  assert.match(text, /node state-worker\/sync\.mjs enable\|push\|pull\|status/);
  assert.doesNotMatch(text, /state-worker\/bin\/sync\.mjs/);
});

test('missing cloud config tells the operator to run state-worker/sync.mjs', async () => {
  const missing = join(tmpdir(), 'job-application-agent-missing-cloud-config.json');
  await assert.rejects(
    () => loadConfig({ env: {}, home: tmpdir(), path: missing }),
    (error) => {
      assert.match(error.message, /node state-worker\/sync\.mjs enable --url <url> --token <token>/);
      assert.doesNotMatch(error.message, /state-worker\/bin\/sync\.mjs/);
      assert.equal(error.message.includes(missing), true);
      return true;
    },
  );
});

test('cursor snippet uses packaged cloud commands and the v2 resume route', async () => {
  const snippet = await readFile(new URL('../snippets/cursor-codex.md', import.meta.url), 'utf8');
  assert.match(snippet, /node scripts\/job-application\.mjs cloud status/);
  assert.match(snippet, /node scripts\/job-application\.mjs cloud reconcile --dry-run/);
  assert.match(snippet, /node scripts\/job-application\.mjs cloud lease-acquire/);
  assert.match(snippet, /node scripts\/job-application\.mjs resume path/);
  assert.match(snippet, /GET \/v2\/files\/resume\.pdf/);
  assert.doesNotMatch(snippet, /state-worker\/bin\/sync\.mjs/);
  assert.doesNotMatch(snippet, /state-worker\/sync\.mjs/);
  assert.doesNotMatch(snippet, /\/v1\/files\//);
  assert.doesNotMatch(snippet, /\bpush\b/i);
  assert.doesNotMatch(snippet, /\bpull\b/i);
});

test('worker allowlist is the names allowlist', () => {
  assert.deepEqual([...ALLOWED_FILES].sort(), [...EXPECTED_FILES].sort());
  assert.deepEqual([...ALLOWLIST].sort(), [...EXPECTED_FILES].sort());
  assert.equal(ALLOWLIST.size, EXPECTED_FILES.length);
});

test('scheduled backup failure logs kind, ok, and the error name', async () => {
  const secret = 'PRIVATE-BACKUP-BODY-do-not-log';
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
  };
  try {
    const failure = new Error(`backup write failed ${secret}`);
    failure.name = 'BackupWriteError';
    await assert.rejects(
      () => worker.scheduled({}, {
        DB: {
          prepare() {
            throw failure;
          },
        },
        STATE_KV: {
          getWithMetadata() {
            throw new Error(`kv read ${secret}`);
          },
          put() {
            throw new Error(`kv write ${secret}`);
          },
          delete() {
            throw new Error(`kv delete ${secret}`);
          },
        },
      }),
      (error) => {
        assert.equal(error.name, 'BackupWriteError');
        assert.equal(error.message, 'BackupWriteError');
        assert.equal(error.cause, undefined);
        assert.equal(String(error.stack).includes(secret), false);
        assert.equal(String(error.message).includes(secret), false);
        return true;
      },
    );
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes('\n'), false);
  assert.equal(lines[0].includes(secret), false);
  assert.deepEqual(JSON.parse(lines[0]), { kind: 'backup', ok: false, error: 'BackupWriteError' });
});

test('scheduled backup does not log when the database or blob binding is missing', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
  };
  try {
    await worker.scheduled({}, {});
    await worker.scheduled({}, { DB: { prepare() { throw new Error('should not run'); } } });
    await worker.scheduled({}, { STATE_KV: {} });
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines, []);
});
