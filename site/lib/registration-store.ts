import { env } from "cloudflare:workers";

let schemaReady: Promise<void> | undefined;

async function ensureSchema() {
  schemaReady ??= env.DB.prepare(`CREATE TABLE IF NOT EXISTS founding_registrations (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL UNIQUE,
    target_role TEXT NOT NULL,
    target_location TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    consent_version TEXT NOT NULL,
    paid_intent TEXT,
    paid_intent_recorded_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run().then(() => undefined);
  return schemaReady;
}

export async function saveRegistration(data: { email: string; targetRole: string; targetLocation: string; source: string }) {
  await ensureSchema();
  const existing = await env.DB.prepare("SELECT id FROM founding_registrations WHERE email = ?").bind(data.email).first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO founding_registrations (id,email,target_role,target_location,source,consent_version)
    VALUES (?,?,?,?,?,'2026-08-18') ON CONFLICT(email) DO UPDATE SET
    target_role=excluded.target_role,target_location=excluded.target_location,source=excluded.source,updated_at=CURRENT_TIMESTAMP`)
    .bind(id, data.email, data.targetRole, data.targetLocation, data.source).run();
  return id;
}

export async function savePaidIntent(id: string, intent: string) {
  await ensureSchema();
  const result = await env.DB.prepare("UPDATE founding_registrations SET paid_intent=?, paid_intent_recorded_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(intent, id).run();
  return (result.meta?.changes ?? 0) > 0;
}
