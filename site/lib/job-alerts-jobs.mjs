/**
 * Page the public live-jobs feed in Node (the digest runner). The site Worker
 * stays out of this loop: board matching is over the Workers Free CPU budget.
 */
import { validateLiveJobs } from "./live-jobs.mjs";

const DEFAULT_UPSTREAM = "https://job-application-agent-telemetry.varora1406.workers.dev/v1/jobs/live";

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} [base]
 */
export async function collectLiveJobs(fetchImpl, base = DEFAULT_UPSTREAM) {
  const jobs = new Map();
  const cursors = new Set();
  let cursor = null;
  for (let page = 0; page < 200; page += 1) {
    const target = new URL(base);
    target.searchParams.set("limit", "100");
    target.searchParams.set("status", "open");
    if (cursor) target.searchParams.set("cursor", cursor);
    const response = await fetchImpl(target);
    if (!response.ok) throw new Error(`Live jobs unavailable (${response.status})`);
    const validated = validateLiveJobs(await response.json());
    if (!validated.ok) throw new Error("Invalid live jobs response");
    for (const job of validated.data.jobs) jobs.set(job.jobId, job);
    cursor = validated.data.nextCursor;
    if (!cursor) return [...jobs.values()];
    if (cursors.has(cursor)) throw new Error("Repeated live jobs cursor");
    cursors.add(cursor);
  }
  throw new Error("Live jobs page limit exceeded");
}
