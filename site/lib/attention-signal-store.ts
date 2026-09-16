import { env } from "cloudflare:workers";

let schemaReady: Promise<void> | undefined;

/**
 * Coordination table only — not an application ledger.
 * Never store passwords, MFA codes, CAPTCHA answers, or session cookies.
 */
export async function ensureAttentionSignalSchema() {
  const db = env.DB;
  schemaReady ??= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS attention_signals (
      attention_id TEXT PRIMARY KEY NOT NULL,
      signal TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'candidate',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_attention_signals_updated_at
      ON attention_signals (updated_at)`),
  ]).then(() => undefined);
  await schemaReady;
}

export async function upsertAttentionSignal(record: {
  attentionId: string;
  signal: string;
  actor?: string;
  payload?: Record<string, unknown>;
}) {
  await ensureAttentionSignalSchema();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO attention_signals (attention_id, signal, actor, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(attention_id) DO UPDATE SET
       signal=excluded.signal,
       actor=excluded.actor,
       payload_json=excluded.payload_json,
       updated_at=excluded.updated_at`,
  ).bind(
    record.attentionId,
    record.signal,
    record.actor ?? "candidate",
    JSON.stringify(record.payload ?? {}),
    now,
    now,
  ).run();
  return {
    attentionId: record.attentionId,
    signal: record.signal,
    actor: record.actor ?? "candidate",
    createdAt: now,
    updatedAt: now,
  };
}

export async function getAttentionSignal(attentionId: string) {
  await ensureAttentionSignalSchema();
  const row = await env.DB.prepare(
    `SELECT attention_id AS attentionId, signal, actor, payload_json AS payloadJson,
            created_at AS createdAt, updated_at AS updatedAt
     FROM attention_signals WHERE attention_id = ?`,
  ).bind(attentionId).first<{
    attentionId: string;
    signal: string;
    actor: string;
    payloadJson: string;
    createdAt: string;
    updatedAt: string;
  }>();
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payloadJson || "{}");
  } catch {
    payload = {};
  }
  return {
    attentionId: row.attentionId,
    signal: row.signal,
    actor: row.actor,
    payload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
