import assert from "node:assert/strict";
import test from "node:test";

import { deriveCommunityStats, validateCommunityStats } from "../lib/community-stats.mjs";

const validStats = {
  generatedAt: "2026-08-18T21:09:13.709Z",
  window: { retentionMonths: 24, activityDays: 30 },
  metrics: {
    installations: 195,
    activeInstallations30d: 106,
    jobsAssessed: 1174,
    applicationsSubmitted: 498,
    interviews: 4,
    offers: 0,
  },
  timeline: [
    { day: "2026-08-17", assessed: 9, submitted: 3 },
    { day: "2026-08-18", assessed: 1018, submitted: 350 },
  ],
  breakdowns: {
    ats: [{ label: "ashby", count: 167 }],
    seniority: [{ label: "senior", count: 37 }],
    outcomes: [{ label: "interview", count: 4 }],
  },
  privacy: { aggregateOnly: true, minimumSegmentCount: 3, identityCollected: false },
};

test("accepts and strips a valid aggregate telemetry response", () => {
  const result = validateCommunityStats({ ...validStats, unexpected: "discarded" });
  assert.equal(result.ok, true);
  assert.equal(result.data.metrics.activeInstallations30d, 106);
  assert.equal("unexpected" in result.data, false);
  assert.deepEqual(result.data.disclosure, { includesHistoricalBackfill: true });
});

test("rejects malformed, negative, and identity-bearing telemetry data", () => {
  assert.equal(validateCommunityStats({ ...validStats, metrics: { ...validStats.metrics, jobsAssessed: -1 } }).ok, false);
  assert.equal(validateCommunityStats({ ...validStats, installationId: "private" }).ok, false);
  assert.equal(validateCommunityStats({ ...validStats, timeline: [{ day: "not-a-day", assessed: 1, submitted: 1 }] }).ok, false);
});

test("derives honest community proof without treating installations as people", () => {
  const result = deriveCommunityStats(validStats);
  assert.deepEqual(result, {
    activeInstallations30d: 106,
    applicationsSubmitted: 498,
    jobsAssessed: 1174,
    totalInstallations: 195,
    outcomesReported: 4,
    outcomeCoverage: 0.8,
  });
});
