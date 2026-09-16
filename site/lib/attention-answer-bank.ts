import { env } from "cloudflare:workers";
import { fingerprintPrompt } from "./attention-questions.mjs";

let schemaReady: Promise<void> | undefined;

/**
 * Site D1 answer bank for reusable judgment answers.
 * Owner-scoped by magic-link attention id / email hash is deferred —
 * founding single-tenant stores by fingerprint only.
 * Never store CAPTCHA, MFA, cookies, or government IDs here.
 */
export async function ensureAttentionAnswerBankSchema() {
  const db = env.DB;
  schemaReady ??= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS attention_answer_bank (
      fingerprint TEXT PRIMARY KEY NOT NULL,
      prompt TEXT NOT NULL,
      text TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'typed',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_attention_answer_bank_updated_at
      ON attention_answer_bank (updated_at)`),
  ]).then(() => undefined);
  await schemaReady;
}

export async function upsertAnswerBankEntries(
  entries: {
    fingerprint?: string;
    prompt?: string;
    text: string;
    tags?: string[];
    source?: string;
  }[],
) {
  await ensureAttentionAnswerBankSchema();
  const now = new Date().toISOString();
  const saved = [];
  for (const entry of entries ?? []) {
    const text = String(entry.text ?? "").trim().slice(0, 5000);
    const prompt = String(entry.prompt ?? "").trim().slice(0, 800);
    if (!text) continue;
    const fingerprint = String(entry.fingerprint ?? fingerprintPrompt(prompt || text)).slice(0, 120);
    const tags = Array.isArray(entry.tags)
      ? entry.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean).slice(0, 8)
      : [];
    const source = String(entry.source ?? "typed").trim().toLowerCase().slice(0, 40) || "typed";
    await env.DB.prepare(
      `INSERT INTO attention_answer_bank (fingerprint, prompt, text, tags_json, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         prompt=excluded.prompt,
         text=excluded.text,
         tags_json=excluded.tags_json,
         source=excluded.source,
         updated_at=excluded.updated_at`,
    ).bind(fingerprint, prompt || fingerprint, text, JSON.stringify(tags), source, now).run();
    saved.push({ fingerprint, prompt: prompt || fingerprint, text, tags, source, updatedAt: now });
  }
  return saved;
}

export async function listAnswerBank(limit = 40) {
  await ensureAttentionAnswerBankSchema();
  const capped = Math.max(1, Math.min(Number(limit) || 40, 100));
  const rows = await env.DB.prepare(
    `SELECT fingerprint, prompt, text, tags_json AS tagsJson, source, updated_at AS updatedAt
     FROM attention_answer_bank
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).bind(capped).all<{
    fingerprint: string;
    prompt: string;
    text: string;
    tagsJson: string;
    source: string;
    updatedAt: string;
  }>();

  return (rows.results ?? []).map((row) => {
    let tags: string[] = [];
    try {
      tags = JSON.parse(row.tagsJson || "[]");
    } catch {
      tags = [];
    }
    return {
      fingerprint: row.fingerprint,
      prompt: row.prompt,
      text: row.text,
      tags: Array.isArray(tags) ? tags : [],
      source: row.source,
      updatedAt: row.updatedAt,
    };
  });
}
