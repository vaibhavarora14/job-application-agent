/**
 * Saved-search rows. Email, canonical filter query, cadence, the confirmation
 * token hash, the unsubscribe token, and send/watermark timestamps. Nothing else.
 */
import { dueBefore, isDue } from "./job-alerts.mjs";

export const SAVED_SEARCH_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS saved_searches (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    filter_query TEXT NOT NULL,
    cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
    confirm_token_hash TEXT,
    unsubscribe_token TEXT NOT NULL,
    confirm_expires_at TEXT,
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    last_sent_at TEXT,
    watermark_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_searches_email_query ON saved_searches (email, filter_query)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_searches_unsubscribe_token ON saved_searches (unsubscribe_token)",
  "CREATE INDEX IF NOT EXISTS idx_saved_searches_confirm_token_hash ON saved_searches (confirm_token_hash)",
  "CREATE INDEX IF NOT EXISTS idx_saved_searches_due ON saved_searches (status, cadence, last_sent_at)",
]);

/** @param {{ prepare: (sql: string) => { bind: (...args: unknown[]) => { run: () => Promise<unknown> } } }} db */
export async function ensureSavedSearchSchema(db) {
  for (const sql of SAVED_SEARCH_SCHEMA) await db.prepare(sql).bind().run();
}

const COLUMNS = "id, email, filter_query, cadence, status, confirm_token_hash, unsubscribe_token, confirm_expires_at, created_at, confirmed_at, last_sent_at, watermark_at, updated_at";

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    filterQuery: row.filter_query,
    cadence: row.cadence,
    status: row.status,
    confirmTokenHash: row.confirm_token_hash,
    unsubscribeToken: row.unsubscribe_token,
    confirmExpiresAt: row.confirm_expires_at,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    lastSentAt: row.last_sent_at,
    watermarkAt: row.watermark_at,
    updatedAt: row.updated_at,
  };
}

async function first(db, sql, args) {
  const row = await db.prepare(sql).bind(...args).first();
  return fromRow(row);
}

async function all(db, sql, args) {
  const result = await db.prepare(sql).bind(...args).all();
  const rows = result?.results ?? result ?? [];
  return rows.map((row) => fromRow(row));
}

async function changes(db, sql, args) {
  const result = await db.prepare(sql).bind(...args).run();
  return result?.meta?.changes ?? result?.changes ?? 0;
}

/** @param {{ prepare: Function }} db */
export function createSqlAlertStore(db) {
  return {
    async getByEmailQuery(email, filterQuery) {
      return first(db, `SELECT ${COLUMNS} FROM saved_searches WHERE email = ? AND filter_query = ?`, [email, filterQuery]);
    },
    async countForEmail(email) {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM saved_searches WHERE email = ?").bind(email).first();
      return Number(row?.n ?? 0);
    },
    async insert(row) {
      await changes(db, `INSERT INTO saved_searches (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        row.id, row.email, row.filterQuery, row.cadence, row.status, row.confirmTokenHash, row.unsubscribeToken,
        row.confirmExpiresAt, row.createdAt, row.confirmedAt, row.lastSentAt, row.watermarkAt, row.updatedAt,
      ]);
    },
    async replacePending(row) {
      await changes(db, `UPDATE saved_searches SET cadence = ?, status = 'pending', confirm_token_hash = ?, unsubscribe_token = ?, confirm_expires_at = ?, confirmed_at = NULL, last_sent_at = NULL, updated_at = ? WHERE id = ?`, [
        row.cadence, row.confirmTokenHash, row.unsubscribeToken, row.confirmExpiresAt, row.updatedAt, row.id,
      ]);
    },
    async setCadence(id, cadence, nowIso) {
      await changes(db, "UPDATE saved_searches SET cadence = ?, updated_at = ? WHERE id = ? AND status = 'active'", [cadence, nowIso, id]);
    },
    async getByConfirmHash(hash) {
      return first(db, `SELECT ${COLUMNS} FROM saved_searches WHERE confirm_token_hash = ?`, [hash]);
    },
    async activate(id, nowIso) {
      const n = await changes(db, "UPDATE saved_searches SET status = 'active', confirmed_at = ?, watermark_at = ?, confirm_token_hash = NULL, confirm_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending'", [nowIso, nowIso, nowIso, id]);
      return n === 1;
    },
    async getById(id) {
      return first(db, `SELECT ${COLUMNS} FROM saved_searches WHERE id = ?`, [id]);
    },
    async deleteById(id) {
      return await changes(db, "DELETE FROM saved_searches WHERE id = ?", [id]) === 1;
    },
    async deleteByUnsubscribeToken(token) {
      return await changes(db, "DELETE FROM saved_searches WHERE unsubscribe_token = ?", [token]) === 1;
    },
    async listDue(now) {
      const cutoff = dueBefore(now);
      return all(db, `SELECT ${COLUMNS} FROM saved_searches WHERE status = 'active' AND (last_sent_at IS NULL OR (cadence = 'daily' AND last_sent_at <= ?) OR (cadence = 'weekly' AND last_sent_at <= ?)) ORDER BY COALESCE(last_sent_at, '') LIMIT 100`, [cutoff.daily, cutoff.weekly]);
    },
    async claim(id, expectedLastSentAt, nowIso) {
      const row = await first(db, `SELECT ${COLUMNS} FROM saved_searches WHERE id = ?`, [id]);
      if (!row || row.status !== "active") return null;
      if ((row.lastSentAt ?? null) !== (expectedLastSentAt ?? null)) return null;
      const n = await changes(db, "UPDATE saved_searches SET last_sent_at = ?, watermark_at = ?, updated_at = ? WHERE id = ? AND status = 'active' AND ((? IS NULL AND last_sent_at IS NULL) OR last_sent_at = ?)", [nowIso, nowIso, nowIso, id, expectedLastSentAt ?? null, expectedLastSentAt ?? null]);
      if (n !== 1) return null;
      return { lastSentAt: row.lastSentAt, watermarkAt: row.watermarkAt };
    },
    async revertClaim(id, previous, claimedAt) {
      const n = await changes(db, "UPDATE saved_searches SET last_sent_at = ?, watermark_at = ?, updated_at = ? WHERE id = ? AND last_sent_at = ?", [previous.lastSentAt, previous.watermarkAt, claimedAt, id, claimedAt]);
      return n === 1;
    },
    async deleteExpiredPending(cutoffIso) {
      return changes(db, "DELETE FROM saved_searches WHERE status = 'pending' AND created_at <= ?", [cutoffIso]);
    },
  };
}

export function createMemoryAlertStore() {
  /** @type {Map<string, object>} */
  const rows = new Map();
  const list = () => [...rows.values()];
  return {
    rows,
    async getByEmailQuery(email, filterQuery) {
      return list().find((row) => row.email === email && row.filterQuery === filterQuery) ?? null;
    },
    async countForEmail(email) {
      return list().filter((row) => row.email === email).length;
    },
    async insert(row) {
      rows.set(row.id, { ...row });
    },
    async replacePending(row) {
      const current = rows.get(row.id);
      if (!current) return;
      rows.set(row.id, {
        ...current,
        cadence: row.cadence,
        status: "pending",
        confirmTokenHash: row.confirmTokenHash,
        unsubscribeToken: row.unsubscribeToken,
        confirmExpiresAt: row.confirmExpiresAt,
        confirmedAt: null,
        lastSentAt: null,
        updatedAt: row.updatedAt,
      });
    },
    async setCadence(id, cadence, nowIso) {
      const row = rows.get(id);
      if (!row || row.status !== "active") return;
      row.cadence = cadence;
      row.updatedAt = nowIso;
    },
    async getByConfirmHash(hash) {
      return list().find((row) => row.confirmTokenHash === hash) ?? null;
    },
    async activate(id, nowIso) {
      const row = rows.get(id);
      if (!row || row.status !== "pending") return false;
      row.status = "active";
      row.confirmedAt = nowIso;
      row.watermarkAt = nowIso;
      row.confirmTokenHash = null;
      row.confirmExpiresAt = null;
      row.updatedAt = nowIso;
      return true;
    },
    async getById(id) {
      return rows.get(id) ?? null;
    },
    async deleteById(id) {
      return rows.delete(id);
    },
    async deleteByUnsubscribeToken(token) {
      const row = list().find((item) => item.unsubscribeToken === token);
      if (!row) return false;
      rows.delete(row.id);
      return true;
    },
    async listDue(now) {
      return list().filter((row) => isDue(row, now)).sort((a, b) => String(a.lastSentAt ?? "").localeCompare(String(b.lastSentAt ?? ""))).slice(0, 100);
    },
    async claim(id, expectedLastSentAt, nowIso) {
      const row = rows.get(id);
      if (!row || row.status !== "active") return null;
      if ((row.lastSentAt ?? null) !== (expectedLastSentAt ?? null)) return null;
      const previous = { lastSentAt: row.lastSentAt, watermarkAt: row.watermarkAt };
      row.lastSentAt = nowIso;
      row.watermarkAt = nowIso;
      row.updatedAt = nowIso;
      return previous;
    },
    async revertClaim(id, previous, claimedAt) {
      const row = rows.get(id);
      if (!row || row.lastSentAt !== claimedAt) return false;
      row.lastSentAt = previous.lastSentAt;
      row.watermarkAt = previous.watermarkAt;
      row.updatedAt = claimedAt;
      return true;
    },
    async deleteExpiredPending(cutoffIso) {
      let n = 0;
      for (const row of list()) {
        if (row.status === "pending" && row.createdAt <= cutoffIso) {
          rows.delete(row.id);
          n += 1;
        }
      }
      return n;
    },
  };
}
