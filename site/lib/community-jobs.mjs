const JOB_ID = /^community-job-[0-9a-f]{16}$/;
const CHANNELS = new Set(["linkedin", "greenhouse", "lever", "ashby", "workable", "comeet", "workday", "rippling", "smartrecruiters", "google-form", "company", "email", "other"]);
const DISCOVERY_SOURCES = new Set(["direct-company", "linkedin", "x", "yc", "hacker-news", "job-board", "email", "user-supplied", "web-search", "other"]);

function isRecord(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value, maximum) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum;
}

function publicHttps(value, maximum = 2048) {
  if (!boundedString(value, maximum)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function isoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validateCommunityJobs(input) {
  const rootKeys = new Set(["version", "jobs", "nextCursor"]);
  if (!isRecord(input) || !exactKeys(input, rootKeys) || input.version !== 1 || !Array.isArray(input.jobs) || input.jobs.length > 100) {
    return { ok: false, error: "invalid_jobs" };
  }
  if (input.nextCursor !== null && !boundedString(input.nextCursor, 1024)) return { ok: false, error: "invalid_jobs" };

  const jobKeys = new Set(["jobId", "url", "company", "role", "applicationChannel", "discoverySource", "providerUrl", "firstSeenAt", "lastSeenAt", "contributionCount"]);
  const jobs = [];
  for (const job of input.jobs) {
    if (!isRecord(job) || !exactKeys(job, jobKeys) || !JOB_ID.test(job.jobId)) return { ok: false, error: "invalid_jobs" };
    if (!publicHttps(job.url) || !publicHttps(job.providerUrl) || !boundedString(job.company, 160) || !boundedString(job.role, 200)) return { ok: false, error: "invalid_jobs" };
    if (!CHANNELS.has(job.applicationChannel) || (job.discoverySource != null && !DISCOVERY_SOURCES.has(job.discoverySource))) return { ok: false, error: "invalid_jobs" };
    if (!isoDate(job.firstSeenAt) || !isoDate(job.lastSeenAt) || !Number.isSafeInteger(job.contributionCount) || job.contributionCount < 1 || job.contributionCount > 1_000_000_000) return { ok: false, error: "invalid_jobs" };
    jobs.push({
      jobId: job.jobId,
      url: job.url,
      company: job.company,
      role: job.role,
      applicationChannel: job.applicationChannel,
      ...(job.discoverySource == null ? {} : { discoverySource: job.discoverySource }),
      providerUrl: job.providerUrl,
      firstSeenAt: job.firstSeenAt,
      lastSeenAt: job.lastSeenAt,
      contributionCount: job.contributionCount,
    });
  }
  return { ok: true, data: { version: 1, jobs, nextCursor: input.nextCursor } };
}

export function communityJobsUpstreamUrl(upstream, requestUrl) {
  let target;
  try { target = new URL(upstream); } catch { throw new Error("invalid upstream"); }
  if (target.protocol !== "https:" || target.username || target.password) throw new Error("invalid upstream");
  for (const key of requestUrl.searchParams.keys()) if (!["limit", "cursor"].includes(key)) throw new Error("invalid query");
  const rawLimit = requestUrl.searchParams.get("limit");
  const limit = rawLimit == null ? 25 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid query");
  const cursor = requestUrl.searchParams.get("cursor");
  if (cursor !== null && (!cursor || cursor.length > 1024)) throw new Error("invalid query");
  target.search = "";
  target.hash = "";
  target.searchParams.set("limit", String(limit));
  if (cursor !== null) target.searchParams.set("cursor", cursor);
  return target.toString();
}
