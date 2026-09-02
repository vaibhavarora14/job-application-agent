import { randomUUID } from 'node:crypto';

import { nowIso, openDb } from './db.mjs';

export function enqueue(type, payload = {}, env = process.env) {
  const db = openDb(env);
  const id = `job-${randomUUID()}`;
  db.prepare(`INSERT INTO work_queue (id, type, payload_json, status, created_at) VALUES (?, ?, ?, 'queued', ?)`)
    .run(id, type, JSON.stringify(payload), nowIso());
  return { id, type, payload };
}

export function claimNext(types, env = process.env) {
  const db = openDb(env);
  const placeholders = types.map(() => '?').join(', ');
  const row = db.prepare(`SELECT id, type, payload_json FROM work_queue WHERE status = 'queued' AND type IN (${placeholders}) ORDER BY created_at LIMIT 1`).get(...types);
  if (!row) return null;
  db.prepare(`UPDATE work_queue SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`).run(nowIso(), row.id);
  const claimed = db.prepare(`SELECT id, type, payload_json, status FROM work_queue WHERE id = ?`).get(row.id);
  if (claimed.status !== 'running') return null;
  return { id: claimed.id, type: claimed.type, payload: JSON.parse(claimed.payload_json) };
}

export function finish(id, error = null, env = process.env) {
  const db = openDb(env);
  db.prepare(`UPDATE work_queue SET status = ?, error = ?, finished_at = ? WHERE id = ?`)
    .run(error ? 'failed' : 'done', error, nowIso(), id);
}

export function queuedCounts(env = process.env) {
  const db = openDb(env);
  const rows = db.prepare(`SELECT type, status, COUNT(*) AS n FROM work_queue GROUP BY type, status`).all();
  return rows;
}
