import { initialOutreach, mutateOutreach } from '../../scripts/outreach-domain.mjs';
export const now = '2026-09-16T10:00:00.000Z';
export function assessment(id = 'opportunity-1', extra = {}) {
  return { operationId: `assess-${id}`, id, company: { name: 'Example', domain: 'example.org', aliases: [] },
    role: 'Staff Product Engineer', channel: 'linkedin', recipient: { account: 'https://www.linkedin.com/in/example-recruiter', aliases: [] },
    source: { kind: 'hiring-post', url: 'https://example.org/jobs/1' },
    qualification: { active: true, companyVerified: true, eligible: true, fit: true, affiliation: true, hiringInvolvement: true },
    gateEvidence: { active: ['role'], companyVerified: ['role'], eligible: ['role'], fit: ['role', 'experience'], affiliation: ['role'], hiringInvolvement: ['role'] },
    evidence: [{ id: 'role', kind: 'role', source: 'https://example.org/jobs/1', observedAt: now, text: 'Active eligible role; recruiter is hiring for this team.' },
      { id: 'experience', kind: 'candidate', source: 'canonical-resume', observedAt: now, text: 'Verified product engineering experience.' }],
    ranking: { hiringSignal: 4, responsibility: 3, fit: 3, freshness: 2, relationship: 0 }, ...extra };
}
export function fixture() {
  let state = initialOutreach();
  const run = (action, input) => { const result = mutateOutreach(state, action, input, { now, actor: 'test-host' }); state = result.state; return result.result; };
  run('policy-enable', { operationId: 'enable', timezone: 'Asia/Kolkata' });
  run('assess', assessment());
  run('draft', { operationId: 'draft-1', id: 'opportunity-1', text: 'Your product engineering role fits my experience. Would a brief conversation be useful?', claimRefs: ['experience'], purpose: 'initial' });
  return { run, get state() { return state; } };
}
export const handoff = (extra = {}) => ({ operationId: 'handoff-1', id: 'opportunity-1', draftRevision: 1, qualificationRevision: 1,
  selectedByUser: true, recheckedAt: now, history: { kind: 'user-reported', noPriorPitch: true, checkedAt: now }, ...extra });
