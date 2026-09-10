import { randomUUID } from 'node:crypto';

import { openAttention } from '../attention.mjs';
import { nowIso, openDb } from '../db.mjs';

export function recordHandoff({
  applicationId,
  jobId,
  url,
  stage,
  blocker,
  instructions,
  env = process.env,
}) {
  const sessionId = `session-${randomUUID()}`;
  // H0: noVNC is not wired. Inbox shows the apply URL; refill-on-open is the contract.
  const liveViewUrl = url;
  openDb(env).prepare(
    `INSERT INTO browser_sessions (id, application_id, status, live_view_url, last_heartbeat, created_at)
     VALUES (?, ?, 'leased', ?, ?, ?)`
  ).run(sessionId, applicationId, liveViewUrl, nowIso(), nowIso());
  const attentionId = openAttention({
    applicationId,
    jobId,
    url,
    stage,
    blocker,
    instructions,
    liveViewUrl,
    env,
  });
  return { sessionId, attentionId, liveViewUrl };
}

export function heartbeatSession(sessionId, env = process.env) {
  openDb(env).prepare('UPDATE browser_sessions SET last_heartbeat = ? WHERE id = ?').run(nowIso(), sessionId);
}

export function releaseSession(sessionId, env = process.env) {
  openDb(env).prepare("UPDATE browser_sessions SET status = 'released' WHERE id = ?").run(sessionId);
}
