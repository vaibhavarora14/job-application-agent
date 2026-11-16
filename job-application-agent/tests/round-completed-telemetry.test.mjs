// round_completed used to send skippedCount: 0 even when assessment-skips.json
// held skips inside the round. The count is those skip/exclude times only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { roundCompletedTelemetry } from '../scripts/job-application.mjs';

const START = '2026-11-01T10:00:00.000Z';
const END = '2026-11-01T10:20:00.000Z';

function roundFixture(overrides = {}) {
  return {
    requestedCount: 3,
    applyConfirmationCount: 2,
    effectiveSubmissionCount: 9,
    blockedCount: 1,
    startedAt: START,
    completedAt: END,
    discovery: {
      attemptedSourceCount: 4,
      searchedSourceCount: 3,
      blockedSourceCount: 1,
      maxSourceSharePercent: 50,
    },
    ...overrides,
  };
}

async function withSkipFile(t, jobs, run) {
  const directory = await mkdtemp(join(tmpdir(), 'jaa-round-skips-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (jobs != null) {
    await writeFile(join(directory, 'assessment-skips.json'), `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`);
  }
  const previous = process.env.JOB_APPLICATION_AGENT_STATE_DIR;
  process.env.JOB_APPLICATION_AGENT_STATE_DIR = directory;
  try {
    return await run();
  } finally {
    if (previous == null) delete process.env.JOB_APPLICATION_AGENT_STATE_DIR;
    else process.env.JOB_APPLICATION_AGENT_STATE_DIR = previous;
  }
}

describe('roundCompletedTelemetry skip window', { concurrency: false }, () => {
  test('counts skip and exclude records whose time falls inside the round', async (t) => {
    const before = new Date(Date.parse(START) - 1).toISOString();
    const after = new Date(Date.parse(END) + 1).toISOString();
    const middle = new Date(Date.parse(START) + 60_000).toISOString();
    const { event, fallback } = await withSkipFile(t, {
      atStart: { decision: 'skip', reason: 'low-fit', at: START },
      atEnd: { decision: 'exclude', reason: 'ineligible', at: END },
      inMiddle: { decision: 'skip', reason: 'salary', at: middle },
      before: { decision: 'skip', reason: 'low-fit', at: before },
      after: { decision: 'skip', reason: 'location', at: after },
      blocked: { decision: 'blocked', reason: 'invalid-input-retries', at: middle },
      undated: { decision: 'skip', reason: 'low-fit', at: 'not-a-time' },
    }, async () => ({
      event: await roundCompletedTelemetry(roundFixture()),
      fallback: await roundCompletedTelemetry({ ...roundFixture(), applyConfirmationCount: undefined }),
    }));

    assert.equal(event.event, 'round_completed');
    assert.equal(event.properties.skippedCount, 3);
    assert.equal(event.properties.errorCount, 0);
    assert.equal(event.properties.submittedCount, 2);
    assert.equal(event.properties.assessedCount, 2);
    assert.equal(event.properties.pausedCount, 1);
    assert.equal(event.properties.requestedCount, 3);
    assert.equal(event.properties.durationBucket, '15m-plus');
    assert.equal(fallback.properties.submittedCount, 9);
    assert.equal(fallback.properties.assessedCount, 9);
    assert.equal(fallback.properties.skippedCount, 3);
  });

  test('reports zero skips when assessment-skips.json is absent', async (t) => {
    const event = await withSkipFile(t, null, () => roundCompletedTelemetry(roundFixture()));
    assert.equal(event.properties.skippedCount, 0);
    assert.equal(event.properties.errorCount, 0);
    assert.equal(event.properties.assessedCount, event.properties.submittedCount);
  });
});
