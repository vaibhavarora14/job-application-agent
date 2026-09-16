import { initialOutreach, mutateOutreach, readOutreach, OUTREACH_TABLES } from '../../job-application-agent/scripts/outreach-domain.mjs';
import { stableJson } from '../../job-application-agent/scripts/application-accounting.mjs';
import { createHash } from 'node:crypto';

export async function outreachAvailable(db) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outreach_meta'").first());
}
export async function loadOutreach(db) {
  const fresh = initialOutreach();
  await db.prepare('INSERT OR IGNORE INTO outreach_meta (id, revision, payload_json) VALUES (1, 0, ?)').bind(JSON.stringify(fresh.meta)).run();
  for (let retry = 0; retry < 5; retry++) {
    const before = await db.prepare('SELECT revision, payload_json FROM outreach_meta WHERE id = 1').first();
    const state = { meta: JSON.parse(before.payload_json) };
    for (const table of OUTREACH_TABLES) state[table] = Object.fromEntries((await db.prepare(`SELECT id, payload_json FROM outreach_${table}`).all()).results.map(r => [r.id, JSON.parse(r.payload_json)]));
    const after = await db.prepare('SELECT revision FROM outreach_meta WHERE id = 1').first();
    if (before.revision === after.revision) return state;
  }
  throw new Error('Outreach changed concurrently; retry read');
}

export async function loadOutreachHistory(db) {
  const historyRevision = await db.prepare('SELECT (SELECT COALESCE(MAX(sequence), 0) FROM records) AS records, (SELECT COUNT(*) FROM record_corrections) AS corrections').first();
  const rows = (await db.prepare("SELECT r.stream, r.payload_json FROM records r LEFT JOIN record_corrections c ON c.record_sequence = r.sequence WHERE r.stream IN ('applications', 'outcomes') AND c.record_sequence IS NULL").all()).results;
  return { historyRevision, ...Object.fromEntries(['applications', 'outcomes'].map(stream => [stream, rows.filter(row => row.stream === stream).map(row => JSON.parse(row.payload_json))])) };
}

export async function cloudOutreachMutation(db, action, input, context) {
  for (let retry = 0; retry < 5; retry++) {
    const before = await loadOutreach(db);
    const history = context?.loadHistory ? await context.loadHistory() : {};
    const output = mutateOutreach(before, action, input, { ...context, ...history });
    if (output.state === before) return output.result;
    const statements = [];
    // Every statement uses the same revision predicate. D1 batch is transactional:
    // either this operation wins and all rows change, or every statement is a no-op.
    let predicate = '(SELECT revision FROM outreach_meta WHERE id = 1) = ?';
    const guardValues = [before.meta.revision];
    if (history.historyRevision) {
      predicate += ' AND (SELECT COALESCE(MAX(sequence), 0) FROM records) = ? AND (SELECT COUNT(*) FROM record_corrections) = ?';
      guardValues.push(history.historyRevision.records, history.historyRevision.corrections);
    }
    for (const table of OUTREACH_TABLES) {
      const old = before[table], next = output.state[table];
      for (const key of Object.keys(old)) if (!Object.hasOwn(next, key)) statements.push(db.prepare(`DELETE FROM outreach_${table} WHERE id = ? AND ${predicate}`).bind(key, ...guardValues));
      for (const [key, value] of Object.entries(next)) if (stableJson(value) !== stableJson(Object.hasOwn(old, key) ? old[key] : null)) {
        statements.push(db.prepare(`INSERT INTO outreach_${table} (id, payload_json) SELECT ?, ? WHERE ${predicate} ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`).bind(key, JSON.stringify(value), ...guardValues));
      }
    }
    statements.push(db.prepare(`UPDATE outreach_meta SET revision = ?, payload_json = ? WHERE id = 1 AND ${predicate}`).bind(output.state.meta.revision, JSON.stringify(output.state.meta), ...guardValues));
    const result = await db.batch(statements);
    if (result.at(-1).meta.changes) return output.result;
  }
  throw new Error('Outreach changed concurrently; retry the same operation ID');
}

export async function outreachRoute(request, db, client) {
  const respond = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  if (!await outreachAvailable(db)) return respond({ error: 'Outreach backend migration required' }, 409);
  const route = new URL(request.url).pathname;
  try {
    if (request.method === 'GET' && route === '/v2/outreach/deletions') {
      const state = await loadOutreach(db);
      return respond({ keyFingerprint: createHash('sha256').update(state.meta.key).digest('hex'), revision: state.meta.revision, tombstones: Object.values(state.tombstones) });
    }
    if (request.method === 'GET' && route === '/v2/outreach/snapshot') {
      const state = await loadOutreach(db);
      // A host cache never receives the fingerprinting secret or operation digests.
      return respond({ revision: state.meta.revision, policy: readOutreach(state, 'policy-status'),
        items: readOutreach(state, 'list').items.map(item => readOutreach(state, 'show', { id: item.id })), review: readOutreach(state, 'review') });
    }
    if (request.method !== 'POST' || route !== '/v2/outreach/command') return respond({ error: 'Not found' }, 404);
    const raw = await request.text(); if (raw.length > 34000) return respond({ error: 'Request too large' }, 413);
    const body = JSON.parse(raw);
    if (!body || Object.keys(body).some(k => !['action', 'input'].includes(k))) throw new Error('Invalid command envelope');
    const context = { actor: client.id };
    if ((body.action === 'assess' && body.input?.applicationId) || body.action === 'handoff') {
      context.loadHistory = () => loadOutreachHistory(db);
    }
    return respond(await cloudOutreachMutation(db, body.action, body.input, context));
  } catch (error) {
    // Never echo submitted text, URLs, JSON parser fragments, or SQL diagnostics.
    if (error instanceof SyntaxError || error instanceof TypeError || /SQL|constraint/i.test(error.message)) return respond({ error: 'Invalid outreach input or storage conflict' }, 400);
    return respond({ error: error.message }, 409);
  }
}
