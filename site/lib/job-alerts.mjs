/**
 * Saved-search alerts for /jobs.
 * Stores an email, the canonical filter query, cadence, token material, and
 * send timestamps. Confirmation is required before any alert. Digests include
 * only roles whose firstSeenAt is newer than the watermark.
 */
import { activeFilterChips, boardQueryString, filterAndSortJobs, parseBoardQuery } from "./jobs-board-query.mjs";

export const DAILY_MS = 24 * 60 * 60 * 1000;
export const WEEKLY_MS = 7 * DAILY_MS;
export const CONFIRM_TTL_MS = 2 * DAILY_MS;
export const PENDING_RETENTION_MS = 7 * DAILY_MS;
export const MAX_SAVED_SEARCHES = 20;
export const MAX_ROLES_PER_EMAIL = 20;
export const MAX_FILTER_QUERY_CHARS = 500;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){0,40}$/;
const CADENCES = new Set(["daily", "weekly"]);

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeAlertEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

/**
 * Canonical filter query. Drops paging, design, and unknown keys.
 * @param {unknown} input
 * @returns {{ ok: true, filterQuery: string } | { ok: false, error: "invalid_query" }}
 */
export function canonicalFilterQuery(input) {
  if (typeof input !== "string" || input.length > MAX_FILTER_QUERY_CHARS) return { ok: false, error: "invalid_query" };
  const raw = input.startsWith("?") ? input.slice(1) : input;
  const query = parseBoardQuery(new URLSearchParams(raw));
  return { ok: true, filterQuery: boardQueryString(query) };
}

/** @param {string} filterQuery */
export function describeSavedSearch(filterQuery) {
  const chips = activeFilterChips(parseBoardQuery(new URLSearchParams(filterQuery)));
  return chips.length ? chips.map((chip) => chip.label).join(", ") : "All open roles";
}

/** @param {number} now */
export function dueBefore(now) {
  return {
    daily: new Date(now - DAILY_MS).toISOString(),
    weekly: new Date(now - WEEKLY_MS).toISOString(),
  };
}

/**
 * @param {{ status: string, cadence: string, lastSentAt: string | null }} row
 * @param {number} now
 */
export function isDue(row, now) {
  if (row?.status !== "active") return false;
  if (row.cadence !== "daily" && row.cadence !== "weekly") return false;
  if (!row.lastSentAt) return true;
  const sent = Date.parse(row.lastSentAt);
  if (!Number.isFinite(sent)) return true;
  const wait = row.cadence === "weekly" ? WEEKLY_MS : DAILY_MS;
  return now - sent >= wait;
}

export function newAlertToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** @param {string} token */
export async function hashAlertToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string} expected
 * @param {string} supplied
 */
export async function tokensMatch(expected, supplied) {
  if (!expected || !supplied) return false;
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * @param {unknown[]} jobs
 * @param {{ filterQuery: string, watermarkAt: string }} row
 * @param {number} now
 */
export function rolesForAlert(jobs, row, now) {
  const watermark = Date.parse(row.watermarkAt);
  if (!Number.isFinite(watermark)) return [];
  const query = parseBoardQuery(new URLSearchParams(row.filterQuery));
  const matched = filterAndSortJobs(jobs, query, now);
  const fresh = [];
  for (const job of matched) {
    const seen = Date.parse(job.firstSeenAt);
    if (!Number.isFinite(seen) || seen <= watermark) continue;
    fresh.push(job);
  }
  return fresh;
}

/**
 * @param {Array<{ id: string, status: string, cadence: string, lastSentAt: string | null, filterQuery: string, watermarkAt: string }>} rows
 * @param {unknown[]} jobs
 * @param {number} now
 */
export function planDigest(rows, jobs, now) {
  /** @type {{ row: typeof rows[number], roles: ReturnType<typeof sanitizeAlertRoles> }[]} */
  const deliver = [];
  /** @type {typeof rows} */
  const advance = [];
  for (const row of rows) {
    if (!isDue(row, now)) continue;
    const roles = sanitizeAlertRoles(rolesForAlert(jobs, row, now).map((job) => ({
      slug: job.slug,
      role: job.role,
      company: job.company,
    })));
    if (roles.length === 0) advance.push(row);
    else deliver.push({ row, roles });
  }
  return { deliver, advance };
}

/** @param {unknown} roles */
export function sanitizeAlertRoles(roles) {
  if (!Array.isArray(roles)) return [];
  const out = [];
  for (const role of roles) {
    if (out.length >= MAX_ROLES_PER_EMAIL) break;
    const slug = typeof role?.slug === "string" ? role.slug : "";
    if (!SLUG_PATTERN.test(slug) || slug.length > 180) continue;
    out.push({
      slug,
      role: cleanLabel(role?.role, "Role"),
      company: cleanLabel(role?.company, "Company"),
    });
  }
  return out;
}

function cleanLabel(value, fallback) {
  let text = "";
  for (const char of String(value ?? "")) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127 || char === "<" || char === ">") continue;
    text += char;
  }
  const trimmed = text.trim().slice(0, 120);
  return trimmed || fallback;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** @param {string} origin */
export function alertLinks(origin, unsubscribeToken, confirmToken = "") {
  const base = String(origin || "https://jobappagent.com").replace(/\/$/, "");
  const unsubscribeUrl = `${base}/jobs/alerts/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
  return {
    unsubscribeUrl,
    oneClickUrl: `${base}/api/jobs/alerts/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,
    confirmUrl: confirmToken ? `${base}/jobs/alerts/confirm?token=${encodeURIComponent(confirmToken)}` : "",
  };
}

function listUnsubscribeHeaders(oneClickUrl) {
  return {
    "List-Unsubscribe": `<${oneClickUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * @param {{ origin: string, cadence: string, filterQuery: string, confirmToken: string, unsubscribeToken: string }} input
 */
export function renderConfirmEmail(input) {
  const links = alertLinks(input.origin, input.unsubscribeToken, input.confirmToken);
  const cadence = input.cadence === "weekly" ? "weekly" : "daily";
  const filters = describeSavedSearch(input.filterQuery);
  const subject = "Confirm your job search alert";
  const text = [
    `Confirm this ${cadence} search to get new matching roles.`,
    "",
    filters,
    "",
    links.confirmUrl,
    "",
    `Unsubscribe: ${links.unsubscribeUrl}`,
  ].join("\n");
  const html = [
    "<!DOCTYPE html>",
    '<html lang="en"><body style="margin:0;background:#ffffff;color:#0f172a">',
    '<div style="max-width:560px;margin:0 auto;padding:24px;font:16px/24px system-ui,sans-serif">',
    `<p style="margin:0 0 12px;font:24px/32px Georgia,serif">${escapeHtml(subject)}</p>`,
    `<p style="margin:0 0 12px;color:#334155">${escapeHtml(filters)}. ${escapeHtml(cadence[0].toUpperCase() + cadence.slice(1))}.</p>`,
    `<p style="margin:0 0 16px"><a href="${escapeHtml(links.confirmUrl)}" style="color:#1d4ed8">Confirm alerts</a></p>`,
    `<p style="margin:0"><a href="${escapeHtml(links.unsubscribeUrl)}" style="color:#1d4ed8">Unsubscribe</a></p>`,
    "</div></body></html>",
  ].join("");
  return { subject, text, html, headers: listUnsubscribeHeaders(links.oneClickUrl), toLinks: links };
}

/**
 * @param {{ origin: string, unsubscribeToken: string, filterQuery: string, roles: { slug: string, role: string, company: string }[] }} input
 */
export function renderAlertEmail(input) {
  const links = alertLinks(input.origin, input.unsubscribeToken);
  const roles = sanitizeAlertRoles(input.roles);
  const count = roles.length;
  const subject = count === 1 ? "1 new role" : `${count} new roles`;
  const base = String(input.origin || "https://jobappagent.com").replace(/\/$/, "");
  const lines = [subject, ""];
  const blocks = [
    "<!DOCTYPE html>",
    '<html lang="en"><body style="margin:0;background:#ffffff;color:#0f172a">',
    '<div style="max-width:560px;margin:0 auto;padding:24px;font:16px/24px system-ui,sans-serif">',
    `<p style="margin:0 0 16px;font:24px/32px Georgia,serif">${escapeHtml(subject)}</p>`,
  ];
  for (const role of roles) {
    const href = `${base}/jobs/${role.slug}`;
    lines.push(`${role.role} — ${role.company}`, href, "");
    blocks.push(
      `<p style="margin:0 0 14px"><a href="${escapeHtml(href)}" style="color:#1d4ed8;font-weight:600">${escapeHtml(role.role)}</a><br><span style="color:#334155">${escapeHtml(role.company)}</span></p>`,
    );
  }
  if (count >= MAX_ROLES_PER_EMAIL) {
    const more = `${base}/jobs${input.filterQuery ? `?${input.filterQuery}` : ""}`;
    lines.push(more, "");
    blocks.push(`<p style="margin:0 0 16px"><a href="${escapeHtml(more)}" style="color:#1d4ed8">More on the board</a></p>`);
  }
  lines.push(`Unsubscribe: ${links.unsubscribeUrl}`);
  blocks.push(`<p style="margin:16px 0 0"><a href="${escapeHtml(links.unsubscribeUrl)}" style="color:#1d4ed8">Unsubscribe</a></p>`);
  blocks.push("</div></body></html>");
  return { subject, text: lines.join("\n"), html: blocks.join(""), headers: listUnsubscribeHeaders(links.oneClickUrl) };
}

/**
 * @param {object} store
 * @param {{ enabled: boolean, send: Function }} mailer
 * @param {{ email: unknown, cadence: unknown, filterQuery: unknown, company?: unknown, origin: string, now: number }} input
 */
export async function subscribeSavedSearch(store, mailer, input) {
  if (typeof input.company === "string" && input.company.trim()) return { ok: true, state: "pending" };
  const email = normalizeAlertEmail(input.email);
  if (!email) return { ok: false, error: "invalid_email" };
  if (!CADENCES.has(input.cadence)) return { ok: false, error: "invalid_cadence" };
  const filters = canonicalFilterQuery(input.filterQuery);
  if (!filters.ok) return filters;
  const nowIso = new Date(input.now).toISOString();
  const existing = await store.getByEmailQuery(email, filters.filterQuery);
  if (!existing && await store.countForEmail(email) >= MAX_SAVED_SEARCHES) return { ok: false, error: "too_many" };
  if (existing?.status === "active") {
    await store.setCadence(existing.id, input.cadence, nowIso);
    return { ok: true, state: "active" };
  }
  if (!mailer.enabled) return { ok: false, error: "alerts_disabled" };

  const confirmToken = newAlertToken();
  const confirmTokenHash = await hashAlertToken(confirmToken);
  const unsubscribeToken = existing?.unsubscribeToken || newAlertToken();
  const row = {
    id: existing?.id || crypto.randomUUID(),
    email,
    filterQuery: filters.filterQuery,
    cadence: input.cadence,
    status: "pending",
    confirmTokenHash,
    unsubscribeToken,
    confirmExpiresAt: new Date(input.now + CONFIRM_TTL_MS).toISOString(),
    createdAt: existing?.createdAt || nowIso,
    confirmedAt: null,
    lastSentAt: null,
    watermarkAt: existing?.watermarkAt || nowIso,
    updatedAt: nowIso,
  };
  if (existing) await store.replacePending(row);
  else await store.insert(row);

  const message = renderConfirmEmail({
    origin: input.origin,
    cadence: input.cadence,
    filterQuery: filters.filterQuery,
    confirmToken,
    unsubscribeToken,
  });
  const sent = await mailer.send({ ...message, to: email });
  if (!sent.ok) {
    if (existing) await store.replacePending(existing);
    else await store.deleteById(row.id);
    return { ok: false, error: sent.error === "disabled" ? "alerts_disabled" : "mail_failed" };
  }
  return { ok: true, state: "pending" };
}

/** @param {object} store @param {string} token */
export async function confirmTokenReady(store, token) {
  return (await confirmTokenState(store, token, Date.now())) === "ready";
}

/**
 * @param {object} store
 * @param {string} token
 * @param {number} now
 * @returns {Promise<"ready" | "invalid" | "expired">}
 */
export async function confirmTokenState(store, token, now) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || "")) return "invalid";
  const row = await store.getByConfirmHash(await hashAlertToken(token));
  if (!row || row.status !== "pending") return "invalid";
  if (Date.parse(row.confirmExpiresAt) <= now) {
    await store.deleteById(row.id);
    return "expired";
  }
  return "ready";
}

/**
 * @param {object} store
 * @param {string} token
 * @param {number} now
 */
export async function confirmSavedSearch(store, token, now) {
  const state = await confirmTokenState(store, token, now);
  if (state !== "ready") return { ok: false, error: state };
  const row = await store.getByConfirmHash(await hashAlertToken(token));
  if (!row) return { ok: false, error: "invalid" };
  const nowIso = new Date(now).toISOString();
  const activated = await store.activate(row.id, nowIso);
  if (!activated) return { ok: false, error: "invalid" };
  return { ok: true };
}

/**
 * @param {object} store
 * @param {string} token
 */
export async function unsubscribeSavedSearch(store, token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || "")) return { ok: true, removed: false };
  const removed = await store.deleteByUnsubscribeToken(token);
  return { ok: true, removed };
}

/**
 * @param {object} store
 * @param {{ enabled: boolean, send: Function }} mailer
 * @param {{ id: string, expectedLastSentAt: string | null, roles: unknown, origin: string, now: number }} input
 */
export async function deliverSavedSearch(store, mailer, input) {
  if (!mailer.enabled) return { ok: false, error: "disabled" };
  const roles = sanitizeAlertRoles(input.roles);
  if (roles.length === 0) return advanceSavedSearch(store, input);
  const row = await store.getById(input.id);
  if (!row || row.status !== "active") return { ok: false, error: "not_found" };
  const nowIso = new Date(input.now).toISOString();
  const claimed = await store.claim(row.id, input.expectedLastSentAt ?? null, nowIso);
  if (!claimed) return { ok: true, skipped: true };
  const message = renderAlertEmail({
    origin: input.origin,
    unsubscribeToken: row.unsubscribeToken,
    filterQuery: row.filterQuery,
    roles,
  });
  const sent = await mailer.send({ ...message, to: row.email });
  if (!sent.ok) {
    await store.revertClaim(row.id, claimed, nowIso);
    return { ok: false, error: sent.error || "mail_failed" };
  }
  return { ok: true, sent: true };
}

/**
 * @param {object} store
 * @param {{ id: string, expectedLastSentAt: string | null, now: number }} input
 */
export async function advanceSavedSearch(store, input) {
  const nowIso = new Date(input.now).toISOString();
  const claimed = await store.claim(input.id, input.expectedLastSentAt ?? null, nowIso);
  if (!claimed) return { ok: true, skipped: true };
  return { ok: true, advanced: true };
}

/**
 * In-process digest used by tests and by any caller that already has the board.
 * @param {{ store: object, jobs: unknown[], mailer: { enabled: boolean, send: Function }, origin: string, now: number }} input
 */
export async function runSavedSearchDigest(input) {
  const cutoff = new Date(input.now - PENDING_RETENTION_MS).toISOString();
  const purged = await input.store.deleteExpiredPending(cutoff);
  const due = await input.store.listDue(input.now);
  const plan = planDigest(due, input.jobs, input.now);
  const results = { purged, sent: 0, advanced: 0, failed: 0, skipped: 0 };
  for (const row of plan.advance) {
    const result = await advanceSavedSearch(input.store, { id: row.id, expectedLastSentAt: row.lastSentAt, now: input.now });
    if (result.skipped) results.skipped += 1;
    else results.advanced += 1;
  }
  for (const item of plan.deliver) {
    const result = await deliverSavedSearch(input.store, input.mailer, {
      id: item.row.id,
      expectedLastSentAt: item.row.lastSentAt,
      roles: item.roles,
      origin: input.origin,
      now: input.now,
    });
    if (result.skipped) results.skipped += 1;
    else if (!result.ok) results.failed += 1;
    else results.sent += 1;
  }
  return results;
}

/**
 * @param {object} store
 * @param {{ enabled: boolean, send: Function }} mailer
 * @param {{ action?: string, id?: string, expectedLastSentAt?: string | null, roles?: unknown }} body
 * @param {{ origin: string, now: number }} context
 */
export async function handleJobAlertsAction(store, mailer, body, context) {
  const action = body?.action;
  if (action === "purge") {
    const deleted = await store.deleteExpiredPending(new Date(context.now - PENDING_RETENTION_MS).toISOString());
    return { ok: true, deleted };
  }
  if (action === "due") {
    const due = await store.listDue(context.now);
    return {
      ok: true,
      due: due.map((row) => ({
        id: row.id,
        filterQuery: row.filterQuery,
        cadence: row.cadence,
        watermarkAt: row.watermarkAt,
        lastSentAt: row.lastSentAt,
      })),
    };
  }
  if (action === "deliver") {
    return deliverSavedSearch(store, mailer, {
      id: String(body.id || ""),
      expectedLastSentAt: body.expectedLastSentAt ?? null,
      roles: body.roles,
      origin: context.origin,
      now: context.now,
    });
  }
  if (action === "advance") {
    return advanceSavedSearch(store, {
      id: String(body.id || ""),
      expectedLastSentAt: body.expectedLastSentAt ?? null,
      now: context.now,
    });
  }
  return { ok: false, error: "invalid_action" };
}
