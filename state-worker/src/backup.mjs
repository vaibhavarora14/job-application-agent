import { createHash } from 'node:crypto';
import { OUTREACH_TABLES } from '../../job-application-agent/scripts/outreach-domain.mjs';
import { loadOutreach } from './outreach.mjs';

const TABLES = Object.freeze({
  clients: ['client_id', 'name', 'token_hash', 'created_at', 'last_seen_at', 'revoked_at'],
  documents: ['name', 'revision', 'payload_json', 'sha256', 'updated_at', 'updated_by'],
  records: ['sequence', 'stream', 'record_key', 'idempotency_key', 'payload_json', 'occurred_at', 'received_at', 'client_id', 'provenance'],
  record_corrections: ['correction_id', 'record_sequence', 'reason', 'created_at', 'created_by'],
  files: ['name', 'revision', 'sha256', 'size', 'updated_at', 'updated_by'],
  application_intents: ['intent_id', 'application_id', 'round_id', 'canonical_url', 'status', 'payload_json', 'client_id', 'created_at', 'updated_at'],
});

export async function createBackup(database, generatedAt = new Date().toISOString()) {
  const tables = {};
  for (const [table, columns] of Object.entries(TABLES)) {
    tables[table] = (await database.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all()).results;
  }
  const outreach = {};
  if (await database.prepare("SELECT name FROM sqlite_master WHERE name = 'outreach_meta'").first()) {
    if (await database.prepare('SELECT id FROM outreach_meta LIMIT 1').first()) {
      // Reuse the revision-checked reader: a handoff/clear between table reads
      // must not produce orphaned content or mismatched reservation history.
      const state = await loadOutreach(database);
      outreach.meta = [{ id: 1, revision: state.meta.revision, payload_json: JSON.stringify(state.meta) }];
      for (const table of OUTREACH_TABLES) outreach[table] = Object.entries(state[table]).map(([id, value]) => ({ id, payload_json: JSON.stringify(value) }));
    }
  }
  return { version: 1, generatedAt, tables, ...(outreach.meta?.length ? { outreach } : {}) };
}

export async function restoreBackup(database, archive, { deletionManifest } = {}) {
  if (!archive || archive.version !== 1 || !archive.tables || typeof archive.tables !== 'object') throw new Error('Unsupported private backup format.');
  if (archive.outreach?.meta?.length) {
    if (!await database.prepare("SELECT name FROM sqlite_master WHERE name = 'outreach_meta'").first()) throw new Error('Apply outreach migration before restoring this backup');
    if (await database.prepare('SELECT id FROM outreach_meta LIMIT 1').first()) throw new Error('Restore outreach only into an empty destination, never over live state');
  }
  const counts = {};
  for (const [table, columns] of Object.entries(TABLES)) {
    let inserted = 0;
    for (const row of archive.tables[table] ?? []) {
      if (!row || typeof row !== 'object' || columns.some((column) => !(column in row))) throw new Error(`Malformed ${table} backup row.`);
      const placeholders = columns.map(() => '?').join(', ');
      const result = await database.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
        .bind(...columns.map((column) => row[column])).run();
      inserted += Number(result.meta?.changes ?? 0);
    }
    counts[table === 'application_intents' ? 'intents' : table] = inserted;
  }
  if (archive.outreach?.meta?.length) {
    const stored = archive.outreach;
    const meta = JSON.parse(stored.meta[0].payload_json);
    const keyFingerprint = createHash('sha256').update(meta.key).digest('hex');
    const verifiedManifest = deletionManifest?.keyFingerprint === keyFingerprint && Number.isInteger(deletionManifest.revision) && deletionManifest.revision >= meta.revision && Array.isArray(deletionManifest.tombstones);
    if (deletionManifest && !verifiedManifest) throw new Error('Deletion manifest does not match this backup or is older than it');
    const tombstones = new Map((stored.tombstones ?? []).map(r => [r.id, JSON.parse(r.payload_json)]));
    for (const item of verifiedManifest ? deletionManifest.tombstones : []) tombstones.set(item.id, item);
    const opportunities = (stored.opportunities ?? []).map(r => ({ id: r.id, value: JSON.parse(r.payload_json) }));
    if (!verifiedManifest) for (const row of opportunities) tombstones.set(row.id, { id: row.id, clearedAt: new Date().toISOString(), actor: 'restore-without-manifest' });
    const deleted = new Set(tombstones.keys());
    meta.enabled = false;
    // Even a current deletion manifest cannot prove which handoffs occurred after
    // the backup. Require explicit recovery review before any new handoff.
    meta.recoveryBlocked = true;
    meta.revision = Math.max(meta.revision, deletionManifest?.revision ?? 0) + 1;
    const statements = [database.prepare('INSERT INTO outreach_meta VALUES (1, ?, ?)').bind(meta.revision, JSON.stringify(meta))];
    for (const table of OUTREACH_TABLES) {
      let rows = stored[table] ?? [];
      if (table === 'contents') rows = rows.filter(r => !deleted.has(r.id));
      if (table === 'tombstones') rows = [...tombstones].map(([id, value]) => ({ id, payload_json: JSON.stringify(value) }));
      if (table === 'opportunities') rows = opportunities.map(({ id, value }) => ({ id, payload_json: JSON.stringify(deleted.has(id) ? { ...value, cleared: true, suppressed: true } : value) }));
      for (const row of rows) statements.push(database.prepare(`INSERT INTO outreach_${table} VALUES (?, ?)`).bind(row.id, row.payload_json));
    }
    for (const { id, value } of opportunities.filter(row => deleted.has(row.id))) {
      statements.push(database.prepare('INSERT OR REPLACE INTO outreach_reservations VALUES (?, ?)').bind(`clear-${id}`, JSON.stringify({ opportunityId: id, companies: value.companies, recipients: value.recipients, suppressed: true })));
    }
    await database.batch(statements);
    counts.outreach = opportunities.length;
    counts.outreachRecoveryBlocked = true;
  }
  return counts;
}
