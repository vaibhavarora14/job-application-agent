import { createHash } from 'node:crypto';

import { nowIso, openDb } from './db.mjs';

export function fingerprint(question, channel = 'greenhouse') {
  const norm = String(question || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha1').update(`${channel}|${norm}`).digest('hex');
}

export function saveAnswer({ channel, question, answer, env = process.env }) {
  const db = openDb(env);
  const fp = fingerprint(question, channel);
  db.prepare(
    `INSERT INTO answers (fingerprint, channel, question, answer, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at`
  ).run(fp, channel, question, answer, nowIso());
  return { fingerprint: fp };
}

export function lookupAnswer(question, channel = 'greenhouse', env = process.env) {
  const row = openDb(env).prepare('SELECT answer FROM answers WHERE fingerprint = ?')
    .get(fingerprint(question, channel));
  return row?.answer || null;
}

export function allAnswers(env = process.env) {
  return openDb(env).prepare('SELECT * FROM answers ORDER BY updated_at DESC').all();
}
