import assert from "node:assert/strict";
import test from "node:test";

import { deriveCommunityStats, publicOutcomeEntries, validateCommunityStats } from "../lib/community-stats.mjs";

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

test("public outcome entries never surface the interviews count", () => {
  const outcomes = [
    { label: "rejected", count: 332 },
    { label: "withdrawn", count: 26 },
    { label: "interview", count: 20 },
    { label: " Interviews ", count: 1 },
  ];
  assert.deepEqual(publicOutcomeEntries(outcomes), [
    { label: "rejected", count: 332 },
    { label: "withdrawn", count: 26 },
  ]);
  assert.deepEqual(publicOutcomeEntries(), []);
  // The API keeps collecting and returning the field for older clients.
  const result = validateCommunityStats(validStats);
  assert.equal(result.ok, true);
  assert.equal(result.data.metrics.interviews, 4);
});

test("stats dashboard and homepage proof render outcomes through the public filter only", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/components/CommunityDashboard.tsx", import.meta.url), "utf8");
  const proof = await readFile(new URL("../app/components/CommunityProof.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /publicOutcomeEntries\(data\?\.breakdowns\.outcomes/);
  assert.doesNotMatch(dashboard, /breakdowns\.outcomes\.map/);
  for (const source of [dashboard, proof]) assert.doesNotMatch(source, /metrics\.interviews|"interviews"|Interview/);
});

test("stats outcome coverage card leads with the live rate, never an outcome count", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(new URL("../app/components/CommunityDashboard.tsx", import.meta.url), "utf8");
  const card = dashboard.slice(dashboard.indexOf('className="dashboard-panel outcome-panel"'), dashboard.indexOf("</article>", dashboard.indexOf('className="dashboard-panel outcome-panel"')));
  assert.match(card, /<strong className="outcome-number">\{data \? `\$\{outcomeCoverage\}%`/);
  assert.match(card, /of \{data \? fullNumber\.format\(data\.metrics\.applicationsSubmitted\) : "—"\} verified applications have a reported outcome/);
  // No visible known-outcome count (it would include interviews) and no duplicate rate pill.
  assert.doesNotMatch(card, /format\(outcomesReported\)|known outcomes|% reported|className="tag"/);
  assert.match(card, /publicOutcomeEntries/);
  assert.equal(deriveCommunityStats({ ...validStats, metrics: { ...validStats.metrics, applicationsSubmitted: 4377 }, breakdowns: { ...validStats.breakdowns, outcomes: [
    { label: "rejected", count: 332 }, { label: "withdrawn", count: 26 }, { label: "interview", count: 20 },
  ] } }).outcomeCoverage, 8.6);
});
