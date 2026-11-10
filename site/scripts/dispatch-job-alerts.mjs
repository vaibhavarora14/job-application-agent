/**
 * Daily saved-search digest. Runs in GitHub Actions (Node), not in the Worker:
 * matching the board exceeds the Workers Free cron CPU limit. The Worker only
 * stores rows and sends mail with the Resend key it already has.
 *
 * Prints counts only. Never prints emails, tokens, or the cron secret.
 */
import { planDigest } from "../lib/job-alerts.mjs";
import { collectLiveJobs } from "../lib/job-alerts-jobs.mjs";
import { loadJobsBoard } from "../lib/load-jobs-board.mjs";

const secret = process.env.JOB_ALERTS_CRON_SECRET ?? "";
const site = (process.env.JOB_ALERTS_SITE_URL || "https://jobappagent.com").replace(/\/$/, "");
const upstream = process.env.COMMUNITY_JOBS_LIVE_UPSTREAM
  || "https://job-application-agent-telemetry.varora1406.workers.dev/v1/jobs/live";
const dryRun = process.argv.includes("--dry-run");

if (!secret) {
  console.log("job alerts disabled: JOB_ALERTS_CRON_SECRET is not set");
  process.exit(0);
}

async function call(action, extra = {}) {
  const response = await fetch(`${site}/api/internal/job-alerts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ action, ...extra }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok === false) {
    throw new Error(`job alerts ${action} failed (${response.status})`);
  }
  return data;
}

const counts = { due: 0, sent: 0, advanced: 0, failed: 0, skipped: 0 };
let openJobs = null;

async function board() {
  if (openJobs) return openJobs;
  const raw = await collectLiveJobs(fetch, upstream);
  if (raw.length === 0) throw new Error("live jobs feed was empty");
  const loaded = await loadJobsBoard({ loadLive: async () => raw, useFixtures: false, now: Date.now() });
  openJobs = loaded.open;
  return openJobs;
}

try {
  if (!dryRun) await call("purge");
  for (let round = 0; round < 20; round += 1) {
    const listed = await call("due");
    const due = Array.isArray(listed.due) ? listed.due : [];
    if (due.length === 0) break;
    counts.due += due.length;
    const now = Date.now();
    const jobs = await board();
    const plan = planDigest(due.map((row) => ({ ...row, status: "active" })), jobs, now);
    for (const row of plan.advance) {
      if (dryRun) {
        counts.advanced += 1;
        continue;
      }
      try {
        const result = await call("advance", { id: row.id, expectedLastSentAt: row.lastSentAt });
        if (result.skipped) counts.skipped += 1;
        else counts.advanced += 1;
      } catch {
        counts.failed += 1;
      }
    }
    for (const item of plan.deliver) {
      if (dryRun) {
        counts.sent += 1;
        continue;
      }
      try {
        const result = await call("deliver", {
          id: item.row.id,
          expectedLastSentAt: item.row.lastSentAt,
          roles: item.roles,
        });
        if (result.skipped) counts.skipped += 1;
        else counts.sent += 1;
      } catch {
        counts.failed += 1;
      }
    }
    if (dryRun) break;
  }
  console.log(JSON.stringify(counts));
  if (counts.failed > 0) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : "job alerts failed");
  process.exit(1);
}
