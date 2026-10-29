import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { deriveCommunityStats, publicOutcomeEntries } from '../public/dashboard.js';

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
  assert.equal(stats.applicationsPerInstallation, 0.3);
  assert.equal(stats.outcomesReported, 14);
  assert.equal(stats.outcomeCoverage, 14.6);
  assert.equal('interviewProgression' in stats, false);
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
  assert.match(html, /Latest seven-day submissions ÷ total installations/i);
  assert.doesNotMatch(html, /installations active in 30 days/i);
  assert.match(html, /Active days/i);
  // Decision 2026-10-21: the reported-interviews count is not shown publicly.
  assert.doesNotMatch(html, /interview/i);
  assert.equal((html.match(/class="signal-card/g) ?? []).length, 3);
});

test('legacy dashboard hides the interviews outcome and keeps the signal grid balanced', async () => {
  assert.deepEqual(publicOutcomeEntries([
    { label: 'rejected', count: 5 },
    { label: 'interview', count: 2 },
    { label: 'offer', count: 1 },
  ]), [{ label: 'rejected', count: 5 }, { label: 'offer', count: 1 }]);
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.signal-grid \{[^}]*repeat\(3, 1fr\)/);
  const js = await readFile(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /interview-rate|interviewProgression|metrics\.interviews/);
});

test('legacy outcome pills show the rate and the subtitle shows only the awaiting count', async () => {
  const js = await readFile(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  assert.match(js, /setText\('\[data-derived="outcome-coverage"\]', `\$\{community\.outcomeCoverage\}% outcomes reported`\)/);
  assert.match(js, /setText\('\[data-derived="outcome-detail"\]', `\$\{fullFormat\.format\(community\.outcomesUnknown\)\} awaiting an update`\)/);
  assert.doesNotMatch(js, /known ·|outcomesReported\}\//);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/data-derived="outcome-coverage">— outcomes reported</g) ?? []).length, 2);
  const stats = deriveCommunityStats({
    generatedAt: '2026-10-21T05:53:27.483Z',
    metrics: { installations: 1248, applicationsSubmitted: 4377, interviews: 20 },
    timeline: [],
    breakdowns: { outcomes: [{ label: 'rejected', count: 332 }, { label: 'withdrawn', count: 26 }, { label: 'interview', count: 20 }] },
  });
  assert.equal(stats.outcomeCoverage, 8.6);
  assert.equal(stats.outcomesUnknown, 3999);
});

test('legacy withdrawn outcome has a coloured dot and a visible minimum-width segment', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.outcome-withdrawn[^{]*\{ background: var\(--violet\); \}/);
  assert.match(css, /\.outcome-segment \{[^}]*flex-shrink: 0;[^}]*min-width: 2px;/);
});
