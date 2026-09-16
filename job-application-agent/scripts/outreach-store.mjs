import { createRequire } from 'node:module';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialOutreach, OUTREACH_TABLES } from './outreach-domain.mjs';

export const OUTREACH_SCHEMA = `
CREATE TABLE IF NOT EXISTS outreach_meta (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, payload_json TEXT NOT NULL);
${OUTREACH_TABLES.map(t => `CREATE TABLE IF NOT EXISTS outreach_${t} (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);`).join('\n')}
`;

let sqlite;
async function runtime() {
  const require = createRequire(import.meta.url);
  if (!sqlite) {
    let initialize;
    try { initialize = require('./runtime/sql-asm.cjs'); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; initialize = require('sql.js/dist/sql-asm.js'); }
    sqlite = initialize();
  }
  return sqlite;
}
export async function privateOutreachWrite(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); await chmod(path, 0o600); }
  finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

// sql.js is pinned and copied with managed skills: no native build or Node minimum change.
// The exclusive lock covers load, transaction, and atomic fsync/rename of the SQLite file.
export async function withOutreachLock(directory, name, callback) {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const lockPath = join(directory, name);
  let lock;
  for (let i = 0; i < 100; i++) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  if (!lock) throw new Error(`Outreach storage locked. If a process crashed, verify it has exited before removing ${name}.`);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    return await callback();
  } finally { await lock.close(); await unlink(lockPath); }
}
export async function withLocalOutreach(directory, callback) {
  return withOutreachLock(directory, 'outreach.lock', async () => {
    let db;
    try {
      const SQL = await runtime(); const path = join(directory, 'outreach.sqlite');
      let bytes; try { bytes = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      db = new SQL.Database(bytes); db.run(OUTREACH_SCHEMA); db.run('PRAGMA secure_delete=ON');
      const rows = sql => { const result = db.exec(sql)[0]; return result ? result.values.map(row => Object.fromEntries(result.columns.map((key, i) => [key, row[i]]))) : []; };
      const meta = rows('SELECT payload_json FROM outreach_meta')[0];
      const state = initialOutreach(); if (meta) state.meta = JSON.parse(meta.payload_json);
      for (const table of OUTREACH_TABLES) state[table] = Object.fromEntries(rows(`SELECT id, payload_json FROM outreach_${table}`).map(r => [r.id, JSON.parse(r.payload_json)]));
      const output = await callback(state);
      if (output.state && (output.state !== state || !bytes)) {
        db.run('BEGIN');
        db.run('INSERT OR REPLACE INTO outreach_meta VALUES (1, ?, ?)', [output.state.meta.revision, JSON.stringify(output.state.meta)]);
        for (const table of OUTREACH_TABLES) {
          db.run(`DELETE FROM outreach_${table}`);
          for (const [key, value] of Object.entries(output.state[table])) db.run(`INSERT INTO outreach_${table} VALUES (?, ?)`, [key, JSON.stringify(value)]);
        }
        db.run('COMMIT'); db.run('VACUUM');
        await privateOutreachWrite(path, Buffer.from(db.export()));
      }
      return output.result;
    } finally { db?.close(); }
  });
}
