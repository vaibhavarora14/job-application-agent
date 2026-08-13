import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { deriveCommunityStats } from '../public/dashboard.js';

test('community statistics are derived from aggregate data without invented values', () => {
  const stats = deriveCommunityStats({
    generatedAt: '2026-08-13T12:00:00Z',
    metrics: {
      installations: 42,
      activeInstallations30d: 2,
      jobsAssessed: 310,
      applicationsSubmitted: 96,
      interviews: 12,
      offers: 2,
    },
    timeline: [
      { day: '2026-08-01', assessed: 25, submitted: 20 },
      { day: '2026-08-12', assessed: 14, submitted: 5 },
      { day: '2026-08-13', assessed: 21, submitted: 8 },
    ],
    breakdowns: {
      ats: [{ label: 'ashby', count: 30 }],
      seniority: [
        { label: 'senior', count: 50 },
        { label: 'staff', count: 25 },
        { label: 'other', count: 1 },
      ],
      outcomes: [
        { label: 'interview', count: 12 },
        { label: 'offer', count: 2 },
      ],
    },
  });

  assert.equal(stats.lastSevenSubmissions, 13);
  assert.equal(stats.peakSubmissions, 20);
  assert.equal(stats.activeDays, 3);
  assert.equal(stats.applicationsPerActiveInstallation, 6.5);
  assert.equal(stats.outcomesReported, 14);
  assert.equal(stats.outcomeCoverage, 14.6);
  assert.equal(stats.interviewProgression, 12.5);
  assert.equal(stats.seniorTargeting, 98.7);
});

test('community dashboard exposes its primary actions and honest data labels', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(html, /The job-search agents are moving/i);
  assert.match(html, /Install agent/i);
  assert.match(html, /Record an outcome/i);
  assert.match(html, /Share impact/i);
  assert.match(html, /View methodology/i);
  assert.match(html, /backfill/i);
  assert.match(html, /outcomes reported/i);
});
