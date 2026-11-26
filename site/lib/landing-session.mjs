/**
 * Per-tab PostHog session id (sessionStorage). Idle 30 minutes or 24h max → new UUIDv7.
 * Matches PostHog custom session id rules: https://posthog.com/docs/data/sessions#custom-session-ids
 */

import { isUuidV7, uuidv7 } from "./uuidv7.mjs";

export const LANDING_SESSION_STORAGE_KEY = "jaa_ph_session";
export const LANDING_SESSION_IDLE_MS = 30 * 60 * 1000;
export const LANDING_SESSION_MAX_MS = 24 * 60 * 60 * 1000;

/** @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} SessionStore */

/** @type {{ id: string, startedAt: number, lastActivityAt: number } | null} */
let memorySession = null;

/**
 * @returns {SessionStore | null}
 */
function browserSessionStorage() {
  try {
    if (typeof sessionStorage === "undefined") return null;
    sessionStorage.getItem(LANDING_SESSION_STORAGE_KEY);
    return sessionStorage;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, startedAt: number, lastActivityAt: number } | null}
 */
export function parseLandingSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  if (!isUuidV7(record.id)) return null;
  const startedAt = Number(record.startedAt);
  const lastActivityAt = Number(record.lastActivityAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(lastActivityAt)) return null;
  return { id: record.id, startedAt, lastActivityAt };
}

/**
 * @param {{ id: string, startedAt: number, lastActivityAt: number }} session
 * @param {number} now
 */
export function shouldRotateLandingSession(session, now) {
  if (now < session.startedAt) return true;
  if (now - session.lastActivityAt >= LANDING_SESSION_IDLE_MS) return true;
  if (now - session.startedAt >= LANDING_SESSION_MAX_MS) return true;
  return false;
}

/**
 * @param {SessionStore | null} store
 */
function readStoredSession(store) {
  if (!store) return memorySession;
  try {
    const raw = store.getItem(LANDING_SESSION_STORAGE_KEY);
    if (!raw) return null;
    return parseLandingSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * @param {SessionStore | null} store
 * @param {{ id: string, startedAt: number, lastActivityAt: number }} session
 */
function writeStoredSession(store, session) {
  memorySession = session;
  if (!store) return;
  try {
    store.setItem(LANDING_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* Quota / private mode — in-memory copy still works for this page. */
  }
}

/**
 * @param {{ sessionStore?: SessionStore | null, now?: number }} [options]
 * @returns {string}
 */
export function getOrCreateLandingSessionId(options = {}) {
  const now = options.now ?? Date.now();
  const store = options.sessionStore === undefined ? browserSessionStorage() : options.sessionStore;
  const existing = readStoredSession(store);
  if (existing && !shouldRotateLandingSession(existing, now)) {
    const next = { ...existing, lastActivityAt: now };
    writeStoredSession(store, next);
    return next.id;
  }
  const created = { id: uuidv7(now), startedAt: now, lastActivityAt: now };
  writeStoredSession(store, created);
  return created.id;
}

export function resetLandingSessionForTests() {
  memorySession = null;
}
