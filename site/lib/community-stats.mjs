const FORBIDDEN_KEYS = new Set([
  "distinct_id", "email", "installation_hash", "installationId", "name", "profile", "resume",
]);

function isRecord(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function containsIdentity(value) {
  if (Array.isArray(value)) return value.some(containsIdentity);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => FORBIDDEN_KEYS.has(key) || containsIdentity(entry));
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function metricSet(input) {
  if (!isRecord(input)) return null;
  const keys = ["installations", "activeInstallations30d", "jobsAssessed", "applicationsSubmitted", "interviews", "offers"];
  const result = {};
  for (const key of keys) {
    const value = integer(input[key]);
    if (value == null) return null;
    result[key] = value;
  }
  return result;
}

function entries(input, maximum) {
  if (!Array.isArray(input) || input.length > maximum) return null;
  const result = [];
  for (const entry of input) {
    if (!isRecord(entry) || typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 80) return null;
    const count = integer(entry.count);
    if (count == null) return null;
    result.push({ label: entry.label.trim(), count });
  }
  return result;
}

export function validateCommunityStats(input) {
  if (!isRecord(input) || containsIdentity(input)) return { ok: false, error: "invalid_stats" };
  if (typeof input.generatedAt !== "string" || !Number.isFinite(Date.parse(input.generatedAt))) return { ok: false, error: "invalid_stats" };
  const metrics = metricSet(input.metrics);
  if (!metrics || !isRecord(input.window) || input.window.retentionMonths !== 24 || input.window.activityDays !== 30) return { ok: false, error: "invalid_stats" };
  if (!Array.isArray(input.timeline) || input.timeline.length > 31) return { ok: false, error: "invalid_stats" };
  const timeline = [];
  for (const entry of input.timeline) {
    if (!isRecord(entry) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day)) return { ok: false, error: "invalid_stats" };
    const assessed = integer(entry.assessed);
    const submitted = integer(entry.submitted);
    if (assessed == null || submitted == null) return { ok: false, error: "invalid_stats" };
    timeline.push({ day: entry.day, assessed, submitted });
  }
  const ats = entries(input.breakdowns?.ats, 12);
  const seniority = entries(input.breakdowns?.seniority, 12);
  const outcomes = entries(input.breakdowns?.outcomes, 12);
  if (!ats || !seniority || !outcomes) return { ok: false, error: "invalid_stats" };
  if (input.privacy?.aggregateOnly !== true || input.privacy?.identityCollected !== false || integer(input.privacy?.minimumSegmentCount) == null) {
    return { ok: false, error: "invalid_stats" };
  }
  return { ok: true, data: {
    generatedAt: new Date(input.generatedAt).toISOString(),
    window: { retentionMonths: 24, activityDays: 30 },
    metrics,
    timeline,
    breakdowns: { ats, seniority, outcomes },
    privacy: {
      aggregateOnly: true,
      minimumSegmentCount: input.privacy.minimumSegmentCount,
      identityCollected: false,
    },
    disclosure: { includesHistoricalBackfill: true },
  } };
}

export function deriveCommunityStats(input) {
  const metrics = input.metrics;
  const outcomesReported = input.breakdowns.outcomes.reduce((sum, entry) => sum + entry.count, 0);
  return {
    activeInstallations30d: metrics.activeInstallations30d,
    applicationsSubmitted: metrics.applicationsSubmitted,
    jobsAssessed: metrics.jobsAssessed,
    totalInstallations: metrics.installations,
    outcomesReported,
    outcomeCoverage: metrics.applicationsSubmitted
      ? Math.round((outcomesReported / metrics.applicationsSubmitted) * 1000) / 10
      : 0,
  };
}
