const TABLES = Object.freeze({
  clients: ['client_id', 'name', 'token_hash', 'created_at', 'last_seen_at', 'revoked_at'],
  documents: ['name', 'revision', 'payload_json', 'sha256', 'updated_at', 'updated_by'],
  records: ['sequence', 'stream', 'record_key', 'idempotency_key', 'payload_json', 'occurred_at', 'received_at', 'client_id', 'provenance'],
  files: ['name', 'revision', 'sha256', 'size', 'updated_at', 'updated_by'],
  application_intents: ['intent_id', 'application_id', 'round_id', 'canonical_url', 'status', 'payload_json', 'client_id', 'created_at', 'updated_at'],
});

export async function createBackup(database, generatedAt = new Date().toISOString()) {
  const tables = {};
  for (const [table, columns] of Object.entries(TABLES)) {
    tables[table] = (await database.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all()).results;
  }
  return { version: 1, generatedAt, tables };
}

export async function restoreBackup(database, archive) {
  if (!archive || archive.version !== 1 || !archive.tables || typeof archive.tables !== 'object') throw new Error('Unsupported private backup format.');
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
  return counts;
}
