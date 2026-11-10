import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fixtureLiveJobs } from "../lib/jobs-board-data.mjs";
import {
  canonicalFilterQuery,
  confirmSavedSearch,
  confirmTokenState,
  deliverSavedSearch,
  previousUtcDayEnd,
  handleJobAlertsAction,
  renderAlertEmail,
  runSavedSearchDigest,
  subscribeSavedSearch,
  unsubscribeSavedSearch,
} from "../lib/job-alerts.mjs";
import { collectLiveJobs } from "../lib/job-alerts-jobs.mjs";
import { createJobAlertMailer } from "../lib/job-alerts-mail.mjs";
import { createMemoryAlertStore, createSqlAlertStore, ensureSavedSearchSchema } from "../lib/job-alerts-store.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const ORIGIN = "https://jobappagent.com";

function box() {
  const sent = [];
  return {
    enabled: true,
    sent,
    async send(message) {
      sent.push(message);
      return { ok: true };
    },
  };
}

function job(now, overrides = {}) {
  const hex = String(overrides.id ?? "1").padStart(16, "0");
  return {
    jobId: `community-job-${hex}`,
    slug: `acme-engineer-${hex}`,
    url: `https://jobs.ashbyhq.com/acme/${hex}`,
    company: overrides.company ?? "Acme",
    role: overrides.role ?? "Software Engineer",
    applicationChannel: "ashby",
    firstSeenAt: overrides.firstSeenAt ?? new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    lastCheckedAt: new Date(now).toISOString(),
    livenessStatus: overrides.livenessStatus ?? "open",
    location: { workplace: overrides.workplace ?? "remote", label: "Remote" },
  };
}

function tokenFrom(message, kind) {
  const url = kind === "confirm" ? message.toLinks.confirmUrl : message.toLinks.unsubscribeUrl;
  return new URL(url).searchParams.get("token");
}

async function openStores() {
  const opened = [["memory", createMemoryAlertStore()]];
  try {
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(":memory:");
    const wrapped = {
      prepare(sql) {
        return {
          bind(...args) {
            const stmt = db.prepare(sql);
            return {
              async first() {
                return stmt.get(...args) ?? null;
              },
              async all() {
                return { results: stmt.all(...args) };
              },
              async run() {
                const info = stmt.run(...args);
                return { meta: { changes: Number(info.changes) } };
              },
            };
          },
        };
      },
    };
    await ensureSavedSearchSchema(wrapped);
    opened.push(["sql", createSqlAlertStore(wrapped)]);
  } catch {
    // Node 20 has no node:sqlite. Memory coverage still runs.
  }
  return opened;
}

async function saved(store, mail, { cadence = "daily", filterQuery = "workplace=remote", now = NOW, email = "reader@example.com" } = {}) {
  const result = await subscribeSavedSearch(store, mail, { email, cadence, filterQuery, origin: ORIGIN, now });
  assert.equal(result.ok, true, result.error);
  const confirm = tokenFrom(mail.sent.at(-1), "confirm");
  assert.equal(await confirmTokenState(store, confirm, now), "ready");
  const before = await store.getByEmailQuery(email, "workplace=remote");
  assert.equal(before.status, "pending");
  assert.equal((await confirmSavedSearch(store, confirm, now)).ok, true);
  const after = await store.getByEmailQuery(email, "workplace=remote");
  assert.equal(after.status, "active");
  assert.equal(after.confirmTokenHash, null);
  assert.equal(after.watermarkAt, previousUtcDayEnd(now));
  return { confirm, unsubscribe: after.unsubscribeToken, row: after };
}

test("canonical filter query keeps filters and drops paging", () => {
  assert.deepEqual(canonicalFilterQuery("workplace=remote&show=150&design=error&utm_source=ad"), {
    ok: true,
    filterQuery: "workplace=remote",
  });
  assert.equal(canonicalFilterQuery("x".repeat(501)).ok, false);
});

test("subscribe, confirm, unsubscribe, matching roles, and cadence", async () => {
  for (const [name, store] of await openStores()) {
    const mail = box();
    const pendingOnly = box();
    const held = await subscribeSavedSearch(store, pendingOnly, {
      email: "held@example.com", cadence: "daily", filterQuery: "", origin: ORIGIN, now: NOW,
    });
    assert.equal(held.state, "pending", name);
    const tooEarly = await runSavedSearchDigest({
      store, jobs: [job(NOW, { id: "2", firstSeenAt: new Date(NOW + 1000).toISOString() })], mailer: mail, origin: ORIGIN, now: NOW + 2000,
    });
    assert.equal(tooEarly.sent, 0, name);

    const { unsubscribe } = await saved(store, mail, { filterQuery: "workplace=remote" });
    const seenBefore = job(NOW, { id: "3", firstSeenAt: new Date(NOW - DAY).toISOString(), workplace: "remote" });
    const remote = job(NOW + 60_000, { id: "4", firstSeenAt: new Date(NOW + 60_000).toISOString(), workplace: "remote", role: "Backend Engineer" });
    const onsite = job(NOW + 60_000, { id: "5", firstSeenAt: new Date(NOW + 60_000).toISOString(), workplace: "onsite", company: "Other" });
    const closed = job(NOW + 60_000, { id: "6", firstSeenAt: new Date(NOW + 60_000).toISOString(), livenessStatus: "closed" });
    const sameDay = job(NOW, { id: "7", firstSeenAt: `${new Date(NOW).toISOString().slice(0, 10)}T00:00:00.000Z`, role: "Same Day Engineer" });
    const first = await runSavedSearchDigest({
      store, jobs: [seenBefore, remote, onsite, closed, sameDay], mailer: mail, origin: ORIGIN, now: NOW + 120_000,
    });
    assert.equal(first.sent, 1, name);
    const alert = mail.sent.at(-1);
    assert.match(alert.subject, /2 new roles/);
    assert.match(alert.html, /Same Day Engineer/);
    assert.match(alert.html, new RegExp(`https://jobappagent.com/jobs/${remote.slug}`));
    assert.match(alert.text, new RegExp(`https://jobappagent.com/jobs/${remote.slug}`));
    assert.match(alert.html, /Unsubscribe/);
    assert.match(alert.text, new RegExp(unsubscribe));
    assert.equal(/<img/i.test(alert.html), false);
    assert.equal(alert.html.includes(onsite.slug), false);
    assert.equal(alert.html.includes(seenBefore.slug), false);
    assert.equal(alert.html.includes("reader@example.com"), false);

    const quiet = await runSavedSearchDigest({
      store, jobs: [remote], mailer: mail, origin: ORIGIN, now: NOW + 120_000 + 60 * 60 * 1000,
    });
    assert.equal(quiet.sent, 0, name);

    const later = NOW + 120_000 + 25 * 60 * 60 * 1000;
    const newer = job(later, { id: "8", firstSeenAt: new Date(later - 1000).toISOString(), role: "Staff Engineer" });
    const second = await runSavedSearchDigest({ store, jobs: [sameDay, newer], mailer: mail, origin: ORIGIN, now: later });
    assert.equal(second.sent, 1, name);
    assert.match(mail.sent.at(-1).html, new RegExp(newer.slug));
    assert.equal(mail.sent.at(-1).html.includes(sameDay.slug), false);

    assert.equal((await unsubscribeSavedSearch(store, unsubscribe)).removed, true);
    assert.equal(await store.getByEmailQuery("reader@example.com", "workplace=remote"), null);
    const after = await runSavedSearchDigest({
      store, jobs: [job(later + DAY, { id: "9", firstSeenAt: new Date(later + DAY).toISOString() })], mailer: mail, origin: ORIGIN, now: later + DAY,
    });
    assert.equal(after.sent, 0, name);
  }
});

test("weekly cadence waits seven days and an empty digest does not repeat", async () => {
  const store = createMemoryAlertStore();
  const mail = box();
  await saved(store, mail, { cadence: "weekly" });
  const firstAt = NOW + 1000;
  const role = job(firstAt, { id: "a", firstSeenAt: new Date(firstAt).toISOString() });
  assert.equal((await runSavedSearchDigest({ store, jobs: [role], mailer: mail, origin: ORIGIN, now: firstAt + 1000 })).sent, 1);
  assert.equal((await runSavedSearchDigest({
    store,
    jobs: [job(firstAt + 3 * DAY, { id: "b", firstSeenAt: new Date(firstAt + 3 * DAY).toISOString() })],
    mail,
    origin: ORIGIN,
    now: firstAt + 3 * DAY,
  })).sent, 0);
  const week = firstAt + 8 * DAY;
  const weekly = job(week, { id: "c", firstSeenAt: new Date(week - 1000).toISOString(), role: "Weekly Engineer" });
  assert.equal((await runSavedSearchDigest({ store, jobs: [weekly], mailer: mail, origin: ORIGIN, now: week })).sent, 1);
  assert.match(mail.sent.at(-1).html, /weekly-engineer|Weekly Engineer/);

  const empty = await runSavedSearchDigest({ store, jobs: [], mailer: mail, origin: ORIGIN, now: week + 8 * DAY });
  assert.equal(empty.sent, 0);
  assert.equal(empty.advanced, 1);
  const again = await runSavedSearchDigest({ store, jobs: [], mailer: mail, origin: ORIGIN, now: week + 8 * DAY + 1000 });
  assert.equal(again.advanced, 0);
});

test("disabled mailer stores nothing and a failed send rolls back", async () => {
  const store = createMemoryAlertStore();
  const disabled = { enabled: false, async send() { throw new Error("sent"); } };
  const blocked = await subscribeSavedSearch(store, disabled, {
    email: "reader@example.com", cadence: "daily", filterQuery: "", origin: ORIGIN, now: NOW,
  });
  assert.equal(blocked.error, "alerts_disabled");
  assert.equal(await store.countForEmail("reader@example.com"), 0);

  const failing = { enabled: true, async send() { return { ok: false, error: "mail_failed" }; } };
  const failed = await subscribeSavedSearch(store, failing, {
    email: "reader@example.com", cadence: "daily", filterQuery: "", origin: ORIGIN, now: NOW,
  });
  assert.equal(failed.error, "mail_failed");
  assert.equal(await store.countForEmail("reader@example.com"), 0);
});

test("confirmation expires, a second confirm is refused, and an active search only updates cadence", async () => {
  const store = createMemoryAlertStore();
  const mail = box();
  const subscribed = await subscribeSavedSearch(store, mail, {
    email: "reader@example.com", cadence: "daily", filterQuery: "workplace=remote", origin: ORIGIN, now: NOW,
  });
  assert.equal(subscribed.state, "pending");
  const token = tokenFrom(mail.sent[0], "confirm");
  assert.equal(await confirmTokenState(store, token, NOW + 3 * DAY), "expired");
  assert.equal(await store.countForEmail("reader@example.com"), 0);
  assert.equal((await confirmSavedSearch(store, token, NOW + 3 * DAY)).ok, false);

  const again = box();
  await saved(store, again);
  const before = again.sent.length;
  const updated = await subscribeSavedSearch(store, again, {
    email: "reader@example.com", cadence: "weekly", filterQuery: "workplace=remote", origin: ORIGIN, now: NOW + 1000,
  });
  assert.equal(updated.state, "active");
  assert.equal(again.sent.length, before);
  assert.equal((await store.getByEmailQuery("reader@example.com", "workplace=remote")).cadence, "daily");
});

test("resending a confirmation restarts the retention window", async () => {
  const store = createMemoryAlertStore();
  const mail = box();
  await subscribeSavedSearch(store, mail, {
    email: "reader@example.com", cadence: "daily", filterQuery: "", origin: ORIGIN, now: NOW,
  });
  const later = NOW + 6 * DAY;
  await subscribeSavedSearch(store, mail, {
    email: "reader@example.com", cadence: "weekly", filterQuery: "", origin: ORIGIN, now: later,
  });
  const row = await store.getByEmailQuery("reader@example.com", "");
  assert.equal(row.createdAt, new Date(later).toISOString());
  assert.equal(row.confirmExpiresAt, new Date(later + 2 * DAY).toISOString());
  const token = tokenFrom(mail.sent.at(-1), "confirm");
  assert.equal((await confirmSavedSearch(store, token, later + DAY)).ok, true);
});

test("honeypot and the due list omit the email", async () => {
  const store = createMemoryAlertStore();
  const mail = box();
  const hidden = await subscribeSavedSearch(store, mail, {
    email: "reader@example.com", cadence: "daily", filterQuery: "", company: "Acme Inc", origin: ORIGIN, now: NOW,
  });
  assert.equal(hidden.state, "pending");
  assert.equal(mail.sent.length, 0);
  assert.equal(await store.countForEmail("reader@example.com"), 0);

  await saved(store, mail);
  const due = await handleJobAlertsAction(store, mail, { action: "due" }, { origin: ORIGIN, now: NOW + 1000 });
  assert.equal(JSON.stringify(due).includes("reader@example.com"), false);
  assert.equal(JSON.stringify(due).includes(mail.sent[0].toLinks.unsubscribeUrl), false);
  assert.equal(due.due.length, 1);
  assert.equal(due.due[0].cadence, "daily");
});

test("a failed alert send does not advance the watermark", async () => {
  const store = createMemoryAlertStore();
  const mail = box();
  const { row } = await saved(store, mail);
  const failing = { enabled: true, async send() { return { ok: false, error: "mail_failed" }; } };
  const result = await deliverSavedSearch(store, failing, {
    id: row.id,
    expectedLastSentAt: null,
    roles: [{ slug: row.filterQuery ? "acme-engineer-0000000000000004" : "acme-engineer-0000000000000001", role: "Software Engineer", company: "Acme" }],
    origin: ORIGIN,
    now: NOW + 5000,
  });
  assert.equal(result.ok, false);
  const current = await store.getById(row.id);
  assert.equal(current.lastSentAt, null);
  assert.equal(current.watermarkAt, row.watermarkAt);
});

test("resend mailer is a no-op without a key and sends no image when configured", async () => {
  const off = createJobAlertMailer({ apiKey: "", fetchImpl: async () => { throw new Error("called"); } });
  assert.equal(off.enabled, false);
  const message = renderAlertEmail({
    origin: ORIGIN,
    unsubscribeToken: "a".repeat(43),
    filterQuery: "",
    roles: [{ slug: "acme-engineer-0000000000000001", role: "Software Engineer", company: "Acme" }],
  });
  assert.equal((await off.send({ ...message, to: "reader@example.com" })).error, "disabled");
  assert.equal(/<img/i.test(message.html), false);

  let captured = null;
  const on = createJobAlertMailer({
    apiKey: "test-key",
    from: "JobAppAgent <alerts@example.com>",
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    },
  });
  assert.equal((await on.send({ ...message, to: "reader@example.com" })).ok, true);
  assert.equal(captured.to[0], "reader@example.com");
  assert.equal(/<img/i.test(captured.html), false);
  assert.match(captured.headers["List-Unsubscribe"], /api\/jobs\/alerts\/unsubscribe/);
  assert.equal(captured.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("collectLiveJobs follows the cursor", async () => {
  const sample = fixtureLiveJobs(NOW)[0];
  const wire = { ...sample };
  delete wire.location;
  delete wire.slug;
  let calls = 0;
  const jobs = await collectLiveJobs(async () => {
    calls += 1;
    const body = calls === 1
      ? { version: 1, jobs: [wire], nextCursor: "page-2", meta: { newestLastCheckedAt: null } }
      : { version: 1, jobs: [{ ...wire, jobId: "community-job-bbbbbbbbbbbbbbbb" }], nextCursor: null, meta: { newestLastCheckedAt: null } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }, "https://example.test/v1/jobs/live");
  assert.equal(jobs.length, 2);
});

test("migration stores only the alert columns", () => {
  const migration = readFileSync(new URL("../drizzle/0007_saved_searches.sql", import.meta.url), "utf8");
  for (const column of ["email", "filter_query", "cadence", "confirm_token_hash", "unsubscribe_token", "last_sent_at", "watermark_at"]) {
    assert.match(migration, new RegExp(column));
  }
  assert.doesNotMatch(migration, /user_agent|ip_address|phone|resume/i);
});
