import assert from 'node:assert/strict';
import test from 'node:test';

import { deliveryProjection, discoveryProjection } from '../scripts/application-accounting.mjs';

const occurredAt = '2026-09-13T10:00:00Z';

function application(overrides = {}) {
  return { id: 'application-1', company: 'Example', role: 'Engineer', source: 'email', url: 'https://example.com/jobs/123', status: 'submitted', submittedAt: '2026-09-12T10:00:00Z', ...overrides };
}

function delivery(overrides = {}) {
  return { version: 1, id: 'bounce-1', applicationId: 'application-1', attemptId: 'initial:application-1', type: 'delivery-failed', occurredAt, evidenceType: 'final-delivery-failure', evidence: 'Final recipient failure matched to the sent application message.', ...overrides };
}

function lead(overrides = {}) {
  return { version: 1, type: 'lead-reviewed', id: 'lead-event-1', roundId: 'round-1', sourceId: 'direct', url: 'https://example.com/jobs/123', company: 'Example', role: 'Engineer', disposition: 'qualified', observedAt: occurredAt, evidence: 'Active employer posting assessed against candidate requirements.', ...overrides };
}

test('email sends count once while their receipt remains unknown', () => {
  const result = deliveryProjection([application()], []);
  assert.equal(result.effectiveSubmissionCount, 1);
  assert.equal(result.receiptUnknownEmailCount, 1);
  assert.equal(result.failedDeliveryCount, 0);
  assert.equal(result.applications[0].receiptUnknown, true);
  assert.equal(result.applications[0].attempts.length, 1);
});

test('confirmed browser applications need no email acknowledgement', () => {
  const result = deliveryProjection([application({ source: 'ashby' })], []);
  assert.equal(result.effectiveSubmissionCount, 1);
  assert.equal(result.receiptUnknownEmailCount, 0);
});

test('a matched final email failure removes the application from effective totals', () => {
  const result = deliveryProjection([application()], [delivery()]);
  assert.equal(result.effectiveSubmissionCount, 0);
  assert.equal(result.failedDeliveryCount, 1);
  assert.equal(result.receiptUnknownEmailCount, 0);
  assert.equal(result.applications[0].counted, false);
  assert.equal(result.applications[0].failed, true);
});

test('notification failure cannot invalidate independent browser confirmation', () => {
  const result = deliveryProjection([application({ source: 'ashby' })], [delivery()]);
  assert.equal(result.effectiveSubmissionCount, 1);
  assert.equal(result.failedDeliveryCount, 0);
});

test('temporary delivery delays and ambiguous failures do not silently change totals', () => {
  for (const evidenceType of ['delivery-delay', 'ambiguous']) {
    const result = deliveryProjection([application()], [delivery({ evidenceType })]);
    assert.equal(result.effectiveSubmissionCount, 1, evidenceType);
    assert.equal(result.failedDeliveryCount, 0, evidenceType);
  }
});

test('unrelated bounce and hiring rejection do not invalidate the submitted application', () => {
  const result = deliveryProjection([application({ outcome: 'rejected' })], [delivery({ applicationId: 'another-application', attemptId: 'initial:another-application' })]);
  assert.equal(result.effectiveSubmissionCount, 1);
  assert.equal(result.failedDeliveryCount, 0);
});

test('receipt confirmation resolves unknown email receipt', () => {
  const result = deliveryProjection([application()], [delivery({ id: 'receipt-1', type: 'receipt-confirmed', evidenceType: 'employer-acknowledgement' })]);
  assert.equal(result.effectiveSubmissionCount, 1);
  assert.equal(result.receiptUnknownEmailCount, 0);
});

test('contradictory receipt and failure remain counted and flag conflict in either arrival order', () => {
  const failure = delivery();
  const receipt = delivery({ id: 'receipt-1', type: 'receipt-confirmed', evidenceType: 'employer-acknowledgement' });
  for (const events of [[failure, receipt], [receipt, failure]]) {
    const result = deliveryProjection([application()], events);
    assert.equal(result.effectiveSubmissionCount, 1);
    assert.equal(result.applications[0].conflict, true);
  }
});

test('explicit correction supersedes a failure without depending on arrival order', () => {
  const failure = delivery();
  const correction = delivery({ id: 'correction-1', type: 'correction', supersedes: failure.id, status: 'receipt-confirmed', evidenceType: 'employer-acknowledgement' });
  for (const events of [[failure, correction], [correction, failure]]) {
    const result = deliveryProjection([application()], events);
    assert.equal(result.effectiveSubmissionCount, 1);
    assert.equal(result.failedDeliveryCount, 0);
    assert.equal(result.applications[0].conflict, false);
    assert.equal(result.receiptUnknownEmailCount, 0);
  }
});

test('correcting a mistaken failure to unknown restores the original email send', () => {
  const result = deliveryProjection([application()], [delivery(), delivery({ id: 'correction-1', type: 'correction', supersedes: 'bounce-1', status: 'unknown', evidenceType: 'ambiguous' })]);
  assert.equal(result.effectiveSubmissionCount, 1);
  assert.equal(result.receiptUnknownEmailCount, 1);
});

test('a failed email followed by confirmed ATS recovery remains one application with two attempts', () => {
  const retry = delivery({ id: 'retry-1', attemptId: 'replacement-1', type: 'retry-confirmed', channel: 'browser', url: 'https://jobs.ashbyhq.com/example/123', evidenceType: 'browser-confirmation', occurredAt: '2026-09-13T11:00:00Z' });
  const result = deliveryProjection([application()], [delivery(), retry, retry]);
  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].attempts.length, 2);
  assert.equal(result.effectiveSubmissionCount, 1);
  assert.equal(result.failedDeliveryCount, 0);
  assert.equal(result.receiptUnknownEmailCount, 0);
});

test('replayed delivery event IDs cannot duplicate failures', () => {
  const failure = delivery();
  const result = deliveryProjection([application()], [failure, { ...failure }, failure]);
  assert.equal(result.failedDeliveryCount, 1);
  assert.equal(result.applications[0].attempts.length, 1);
});

test('legacy unfamiliar discovery rows remain outside the new projection', () => {
  const result = discoveryProjection([{ id: 'legacy', reviewedCount: 19, qualifiedCount: 2 }, { type: 'unknown-future-record', roundId: 'round-1' }], { roundId: 'round-1' });
  assert.equal(result.reviewedCount, 0);
  assert.equal(result.qualifiedCount, 0);
  assert.equal(result.leads.length, 0);
});

test('replayed lead event IDs and other rounds do not inflate reviewed counts', () => {
  const first = lead();
  const result = discoveryProjection([first, { ...first }, lead({ id: 'other-round', roundId: 'round-2' })], { roundId: 'round-1' });
  assert.equal(result.reviewedCount, 1);
  assert.equal(result.qualifiedCount, 1);
  assert.equal(result.uniqueLeadCount, 1);
});

test('explicit assessment revision replaces its prior disposition without inflating totals', () => {
  const original = lead();
  const revision = lead({ id: 'lead-event-2', supersedes: original.id, disposition: 'closed-stale', observedAt: '2026-09-14T10:00:00Z' });
  for (const events of [[original, revision], [revision, original]]) {
    const result = discoveryProjection(events, { roundId: 'round-1' });
    assert.equal(result.reviewedCount, 1);
    assert.equal(result.qualifiedCount, 0);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.leads[0].disposition, 'closed-stale');
  }
});

test('competing assessment revisions surface a conflict regardless of arrival order', () => {
  const first = lead();
  const conflicting = lead({ id: 'lead-event-2', disposition: 'blocked' });
  for (const events of [[first, conflicting], [conflicting, first]]) {
    const result = discoveryProjection(events, { roundId: 'round-1' });
    assert.equal(result.reviewedCount, 1);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.qualifiedCount, 0);
  }
});

test('cross-source sightings preserve source reviews while deduplicating the requisition', () => {
  const result = discoveryProjection([lead({ employerJobId: 'example:123' }), lead({ id: 'linkedin-sighting', sourceId: 'linkedin', url: 'https://linkedin.com/jobs/view/987', employerJobId: 'example:123' })], { roundId: 'round-1' });
  assert.equal(result.reviewedCount, 2);
  assert.equal(result.qualifiedCount, 2);
  assert.equal(result.uniqueLeadCount, 1);
  assert.equal(result.leads.length, 2);
});

test('distinct employer requisitions remain separate even for the same company and role', () => {
  const result = discoveryProjection([lead({ employerJobId: 'example:123' }), lead({ id: 'second-role', url: 'https://example.com/jobs/456', employerJobId: 'example:456' })], { roundId: 'round-1' });
  assert.equal(result.reviewedCount, 2);
  assert.equal(result.uniqueLeadCount, 2);
});

test('competing corrections cannot silently choose failure over an unknown disposition', () => {
  const original = delivery();
  const unknown = delivery({id:'clear-bounce',type:'correction',supersedes:original.id,status:'unknown'});
  const failed = delivery({id:'keep-bounce',type:'correction',supersedes:original.id,status:'delivery-failed'});
  const result = deliveryProjection([application()], [original, unknown, failed]);
  assert.equal(result.applications[0].conflict, true);
  assert.equal(result.effectiveSubmissionCount, 1);
});

test('verified requisition aliases with the same assessment count as one lead without conflict', () => {
  const result = discoveryProjection([lead({employerJobId:'REQ-1'}),lead({id:'alias',url:'https://ats.example.com/REQ-1',employerJobId:'REQ-1'})], {roundId:'round-1'});
  assert.equal(result.reviewedCount,1);
  assert.equal(result.qualifiedCount,1);
  assert.equal(result.conflicts.length,0);
});

test('a later verified requisition ID enriches a URL-only lead without inflating counts', () => {
  const first = lead();
  const enriched = lead({ id:'enriched',employerJobId:'REQ-1',supersedes:first.id });
  const result = discoveryProjection([first,enriched],{roundId:'round-1'});
  assert.equal(result.reviewedCount,1);
  assert.equal(result.uniqueLeadCount,1);
  assert.equal(result.leads[0].employerJobId,'REQ-1');
});
