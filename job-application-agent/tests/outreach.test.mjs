import assert from 'node:assert/strict';
import test from 'node:test';
import { initialOutreach, mutateOutreach, readOutreach, businessDate } from '../scripts/outreach-domain.mjs';

import { assessment, fixture, handoff, now } from './fixtures/outreach.mjs';

test('qualified hiring posts can be drafted and handed off without an application or transmission', () => {
  const f = fixture();
  const result = f.run('handoff', handoff());
  assert.equal(result.delivery, 'pending-handoff');
  assert.match(result.copyableText, /product engineering/);
  assert.equal(readOutreach(f.state, 'review', {}, now).sentVerified, 0);
  assert.deepEqual(f.run('handoff', handoff()), result);
  assert.throws(() => f.run('handoff', handoff({ draftRevision: 2 })), /operation.*content/i);
});
test('false qualification and missing candidate claim references block handoff or draft', () => {
  const f = fixture();
  assert.throws(() => f.run('draft', { operationId: 'bad', id: 'opportunity-1', text: 'Hello', claimRefs: ['invented'], purpose: 'initial' }), /claim/i);
  f.run('assess', assessment('opportunity-1', { operationId: 'reassess', qualification: { active: true, companyVerified: true, eligible: false, fit: true, affiliation: true, hiringInvolvement: true } }));
  assert.throws(() => f.run('handoff', handoff({ qualificationRevision: 2 })), /qualification/i);
});
test('company reservation blocks other channels and does not expire after uncertain handoff', () => {
  const f = fixture(); f.run('handoff', handoff());
  f.run('record', { operationId: 'uncertain', id: 'opportunity-1', type: 'uncertain', attemptId: 'handoff-1', occurredAt: now, evidence: 'User cannot confirm sending.' });
  f.run('assess', assessment('second', { channel: 'x', recipient: { account: 'https://x.com/example_hiring', aliases: [] } }));
  f.run('draft', { operationId: 'draft-2', id: 'second', text: 'Hello', claimRefs: [], purpose: 'initial' });
  assert.throws(() => f.run('handoff', handoff({ operationId: 'handoff-2', id: 'second' })), /reserved|contact/i);
});
test('clear removes sensitive material, retains suppression, and refuses resurrection', () => {
  const f = fixture(); f.run('handoff', handoff());
  f.run('clear', { operationId: 'clear', ids: ['opportunity-1'] });
  const serialized = JSON.stringify(f.state);
  for (const privateText of ['example.org', 'example-recruiter', 'canonical-resume', 'brief conversation']) assert.equal(serialized.includes(privateText), false);
  assert.throws(() => f.run('assess', assessment('opportunity-1', { operationId: 'resurrect' })), /cleared/i);
  assert.equal(f.run('handoff', handoff()).cleared, true);
});
test('business dates use local calendar weekdays across weekends', () => {
  assert.equal(businessDate('2026-09-18T23:30:00Z', 'Asia/Kolkata', 7), '2026-09-29');
});

test('ranking does not exclude qualified contacts and aliases identify the same recipient', () => {
  const f = fixture();
  f.run('assess', assessment('opportunity-1', { operationId: 'low-rank', ranking: { hiringSignal: 0, responsibility: 0, fit: 0, freshness: 0, relationship: 0 } }));
  f.run('draft', { operationId: 'new-draft', id: 'opportunity-1', text: 'Hello', claimRefs: [], purpose: 'initial' });
  assert.equal(f.run('handoff', handoff({ draftRevision: 2, qualificationRevision: 2 })).score, 0);
  f.run('assess', assessment('other-company', { company: { name: 'Second', domain: 'second.example', aliases: [] }, recipient: { account: 'https://linkedin.com/in/EXAMPLE-RECRUITER/?tracking=1', aliases: [] } }));
  f.run('draft', { operationId: 'other-draft', id: 'other-company', text: 'Hello', claimRefs: [], purpose: 'initial' });
  assert.throws(() => f.run('handoff', handoff({ operationId: 'other-handoff', id: 'other-company' })), /reserved/);
});

test('follow-up depends on actual send dates, and replies cancel it', () => {
  const f = fixture(); f.run('handoff', handoff());
  f.run('record', { operationId: 'sent', id: 'opportunity-1', attemptId: 'handoff-1', type: 'sent-user-reported', occurredAt: now, evidence: 'User reports manual send.' });
  assert.equal(readOutreach(f.state, 'show', { id: 'opportunity-1' }, '2026-09-24T10:00:00Z').followupDue, false);
  assert.equal(readOutreach(f.state, 'show', { id: 'opportunity-1' }, '2026-09-25T10:00:00Z').followupDue, true);
  f.run('draft', { operationId: 'followup-draft', id: 'opportunity-1', text: 'Following up on the role.', claimRefs: [], purpose: 'follow-up' });
  assert.equal(readOutreach(f.state, 'show', { id: 'opportunity-1' }, '2026-10-20T10:00:00Z').noResponse, false);
  f.run('record', { operationId: 'reply', id: 'opportunity-1', type: 'screen-proposed', occurredAt: now, evidence: 'Recruiter proposed a discussion.' });
  assert.equal(readOutreach(f.state, 'show', { id: 'opportunity-1' }, '2026-10-20T10:00:00Z').followupDue, false);
  assert.equal(readOutreach(f.state, 'review', {}, now).outcomes['screen-scheduled'], 0);
  assert.throws(() => f.run('record', { operationId: 'bad-schedule', id: 'opportunity-1', type: 'screen-scheduled', occurredAt: now, evidence: 'They mentioned a discussion.' }), /object/);
});

test('conflicting delivery evidence requires explicit correction; not-sent release can be corrected safely', () => {
  const f = fixture(); f.run('handoff', handoff());
  const record = (operationId, type, extra = {}) => f.run('record', { operationId, id: 'opportunity-1', attemptId: 'handoff-1', type, occurredAt: now, evidence: 'Synthetic observation.', ...extra });
  record('uncertain', 'uncertain');
  assert.equal(record('sent', 'sent-user-reported').delivery, 'conflict');
  assert.equal(record('fixed', 'not-sent', { supersedes: ['uncertain', 'sent'] }).delivery, 'not-sent');
  assert.equal(Object.keys(f.state.reservations).length, 0);
  assert.equal(f.run('handoff', handoff()).copyableText, undefined);
  record('later-proof', 'sent-verified', { supersedes: ['fixed'], messageRef: 'message-1' });
  assert.equal(Object.keys(f.state.reservations).length, 1);
  assert.equal(readOutreach(f.state, 'show', { id: 'opportunity-1' }, now).delivery, 'sent-verified');
});

test('linked applications must match both company and role', () => {
  const f = fixture();
  const input = assessment('applied', { applicationId: 'app-1', source: { kind: 'application', url: 'https://example.org/jobs/1' } });
  assert.throws(() => mutateOutreach(f.state, 'assess', input, { now, applications: [{ id: 'app-1', company: 'Wrong Company', role: input.role, status: 'submitted' }] }), /company/i);
  const result = mutateOutreach(f.state, 'assess', input, { now, applications: [{ id: 'app-1', company: 'Example', role: input.role, status: 'submitted' }] });
  assert.equal(result.result.eligible, true);
});

test('common fabricated application and commitment claims are rejected; disabled grants stop handoff', () => {
  const f = fixture();
  for (const [index, text] of ['I applied for this role.', 'I am available immediately.', 'I built AI agents.'].entries()) {
    assert.throws(() => f.run('draft', { operationId: `invalid-${index}`, id: 'opportunity-1', text, claimRefs: [], purpose: 'initial' }), /claim|commitment|evidence/);
  }
  f.run('policy-disable', { operationId: 'disable' });
  assert.throws(() => f.run('handoff', handoff()), /disabled/);
});

test('recipient and company suppression cannot be overridden by an exception', () => {
  const f = fixture();
  f.run('suppress', { operationId: 'stop', id: 'opportunity-1', scope: 'company', reason: 'Candidate requested no contact.' });
  assert.throws(() => f.run('handoff', handoff({ exception: { approvedByUser: true, reason: 'Attempted bypass.' } })), /suppressed/);
});

test('company suppression cancels due suggestions for other opportunities', () => {
  const f = fixture(); f.run('handoff', handoff());
  f.run('record', { operationId: 'sent', id: 'opportunity-1', attemptId: 'handoff-1', type: 'sent-user-reported', occurredAt: now, evidence: 'User reports sending.' });
  f.run('assess', assessment('other'));
  f.run('suppress', { operationId: 'stop-other', id: 'other', scope: 'company', reason: 'Company-wide stop.' });
  assert.equal(readOutreach(f.state, 'show', { id: 'opportunity-1' }, '2026-10-01T10:00:00Z').followupDue, false);
});

test('one follow-up can close as no response only after it was sent', () => {
  const f = fixture(); f.run('handoff', handoff());
  f.run('record', { operationId: 'initial-sent', id: 'opportunity-1', type: 'sent-user-reported', attemptId: 'handoff-1', occurredAt: now, evidence: 'User reports sending.' });
  f.run('draft', { operationId: 'followup', id: 'opportunity-1', text: 'Following up on the role.', claimRefs: [], purpose: 'follow-up' });
  const later = '2026-09-25T10:00:00Z';
  let state = mutateOutreach(f.state, 'handoff', handoff({ operationId: 'followup-handoff', draftRevision: 2, recheckedAt: later, history: { kind: 'verified', noPriorPitch: false, checkedAt: later } }), { now: later }).state;
  assert.equal(readOutreach(state, 'show', { id: 'opportunity-1' }, '2026-10-20T10:00:00Z').noResponse, false);
  state = mutateOutreach(state, 'record', { operationId: 'followup-sent', id: 'opportunity-1', type: 'sent-user-reported', attemptId: 'followup-handoff', occurredAt: later, evidence: 'User reports follow-up.' }, { now: later }).state;
  assert.equal(readOutreach(state, 'show', { id: 'opportunity-1' }, '2026-10-06T10:00:00Z').noResponse, true);
  assert.equal(readOutreach(state, 'show', { id: 'opportunity-1' }, '2026-10-06T10:00:00Z').followupDue, false);
});

test('progression corrections cannot supersede delivery evidence and bypass an unresolved reservation', () => {
  const f = fixture(); f.run('handoff', handoff());
  f.run('record', { operationId: 'sent', id: 'opportunity-1', type: 'sent-user-reported', attemptId: 'handoff-1', occurredAt: now, evidence: 'User reports sending.' });
  assert.throws(() => f.run('record', { operationId: 'bad-correction', id: 'opportunity-1', type: 'replied', supersedes: ['sent'], occurredAt: now, evidence: 'Wrong category.' }), /category|delivery/i);
  f.run('record', { operationId: 'uncertain-correction', id: 'opportunity-1', type: 'uncertain', attemptId: 'handoff-1', supersedes: ['sent'], occurredAt: now, evidence: 'Send could not be verified.' });
  f.run('assess', assessment('second'));
  f.run('draft', { operationId: 'second-draft', id: 'second', text: 'Hello', claimRefs: [], purpose: 'initial' });
  assert.throws(() => f.run('handoff', handoff({ operationId: 'second-handoff', id: 'second', exception: { approvedByUser: true, reason: 'Try another contact.' } })), /unresolved/);
});

test('valid opaque IDs may match Object.prototype property names', () => {
  const f = fixture();
  assert.throws(() => f.run('clear', { operationId: 'bad-clear', ids: ['constructor'] }), /not found/);
  assert.equal(Object.hasOwn(f.state.reservations, 'clear-constructor'), false);
  f.run('assess', assessment('constructor', { operationId: 'toString' }));
  f.run('draft', { operationId: 'constructor', id: 'constructor', text: 'Hello', claimRefs: [], purpose: 'initial' });
  assert.equal(readOutreach(f.state, 'show', { id: 'constructor' }, now).content.drafts.length, 1);
  assert.equal(readOutreach(f.state, 'show', { id: 'constructor' }, now).cleared, false);
  assert.equal(f.run('draft', { operationId: 'constructor', id: 'constructor', text: 'Hello', claimRefs: [], purpose: 'initial' }).cleared, false);
});
