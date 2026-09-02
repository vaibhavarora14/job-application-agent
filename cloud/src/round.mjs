import { randomUUID } from 'node:crypto';

import { nowIso, openDb } from './db.mjs';
import { enqueue } from './queue.mjs';

export function startRound(count = 10, env = process.env) {
  const requested = Math.max(1, Math.min(50, Number(count) || 10));
  const id = `round-${randomUUID()}`;
  openDb(env).prepare(
    'INSERT INTO rounds (id, requested_count, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, requested, 'running', nowIso());
  enqueue('discover', { roundId: id, count: requested }, env);
  return { id, requestedCount: requested, status: 'running' };
}

export function offeredFills(roundId, env = process.env) {
  if (!roundId) return 0;
  const row = openDb(env).prepare(
    `SELECT COUNT(*) AS n FROM applications WHERE round_id = ? AND status NOT IN ('abandoned')`
  ).get(roundId);
  return Number(row?.n || 0);
}

export function remainingSlots(roundId, env = process.env) {
  if (!roundId) return 10;
  const round = openDb(env).prepare('SELECT requested_count FROM rounds WHERE id = ?').get(roundId);
  if (!round) return 0;
  return Math.max(0, round.requested_count - offeredFills(roundId, env));
}

export function listRounds(env = process.env) {
  return openDb(env).prepare('SELECT * FROM rounds ORDER BY created_at DESC').all();
}
