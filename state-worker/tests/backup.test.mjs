import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createBackup, restoreBackup } from '../src/backup.mjs';
import { createMemoryD1 } from './d1-mock.mjs';

const schema = await readFile(new URL('../migrations/0001_private_state.sql', import.meta.url), 'utf8');

test('private export restores into a separate empty database without losing provenance', async () => {
  const source = createMemoryD1(schema);
  await source.prepare('INSERT INTO clients (client_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').bind('mac', 'Mac', 'hash', '2026-01-01T00:00:00.000Z').run();
  await source.prepare('INSERT INTO records (stream, record_key, idempotency_key, payload_json, occurred_at, received_at, client_id, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('applications', 'app-1', 'idem-1', '{"id":"app-1"}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'mac', 'mac-cutover').run();
  const archive = await createBackup(source, '2026-01-02T00:00:00.000Z');

  const target = createMemoryD1(schema);
  const restored = await restoreBackup(target, archive);
  assert.equal(restored.records, 1);
  const row = await target.prepare("SELECT payload_json, provenance FROM records WHERE stream = 'applications'").first();
  assert.equal(row.payload_json, '{"id":"app-1"}');
  assert.equal(row.provenance, 'mac-cutover');
  assert.equal((await restoreBackup(target, archive)).records, 0);
});
