import assert from 'node:assert/strict';
import test from 'node:test';

import { skipReasonFromAssessment, telemetryApplicationSkipped } from '../scripts/job-application.mjs';

const skip = (gaps, decision = 'skip') => ({ decision, score: 0, gaps });

test('automatic fit-0 cut-offs get their own reason, never candidate-choice (#227)', () => {
  assert.equal(skipReasonFromAssessment(skip(['Published compensation is unavailable or not directly comparable.', 'Must-have evidence coverage is 40%, below 60%.'])), 'low-fit');
  assert.equal(skipReasonFromAssessment(skip(['Location or work mode is not an explicit match.', 'Published compensation maximum is below the configured floor.'])), 'salary');
  assert.equal(skipReasonFromAssessment(skip(['Seniority is outside the candidate target: junior.'])), 'seniority');
  assert.equal(skipReasonFromAssessment(skip(['Posting is in an excluded location.'], 'exclude')), 'location');
  assert.equal(skipReasonFromAssessment(skip(['Posting or application channel is closed or stale.'], 'exclude')), 'closed');
  assert.equal(skipReasonFromAssessment(skip(['Company is excluded by the candidate.'], 'exclude')), 'ineligible');
  assert.equal(skipReasonFromAssessment({ decision: 'skip', score: 41, gaps: [] }), 'low-fit', 'a score below the review threshold is a low fit');
  assert.equal(skipReasonFromAssessment({ decision: 'exclude', score: 0, gaps: [] }), 'ineligible');
  for (const decision of ['skip', 'exclude']) {
    assert.notEqual(skipReasonFromAssessment({ decision, score: 0, gaps: ['Something new.'] }), 'candidate-choice');
  }
});

test('application_skipped carries the automatic reason with an existing SKIP_REASONS value', async () => {
  const event = await telemetryApplicationSkipped({ url: 'https://jobs.lever.co/acme/1', eligibility: 'eligible' }, skip(['Must-have evidence coverage is 10%, below 60%.']));
  assert.equal(event.properties.reason, 'low-fit');
  const { EVENT_SCHEMAS } = await import('../scripts/telemetry-schema.mjs');
  assert.ok(EVENT_SCHEMAS.application_skipped);
});
