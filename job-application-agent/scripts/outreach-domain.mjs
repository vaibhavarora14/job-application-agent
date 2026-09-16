import { createHmac, randomBytes } from 'node:crypto';
import { stableJson } from './application-accounting.mjs';

export const OUTREACH_CAPABILITY = 'outreach-tracking-v1';
export const OUTREACH_TABLES = ['opportunities', 'contents', 'events', 'reservations', 'operations', 'tombstones'];
const GATES = ['active', 'companyVerified', 'eligible', 'fit', 'affiliation', 'hiringInvolvement'];
const DELIVERY = ['not-sent', 'uncertain', 'sent-user-reported', 'sent-verified', 'failed'];
const PROGRESSION = ['replied', 'referral-promised', 'referred', 'screen-proposed', 'screen-scheduled', 'interview', 'rejected', 'closed-no-response'];
const STOP = ['replied', 'referral-promised', 'referred', 'screen-proposed', 'screen-scheduled', 'interview', 'rejected'];
const RANKING = { hiringSignal: 4, responsibility: 3, fit: 3, freshness: 2, relationship: 2 };
const DAY = 86400000;

function check(condition, message) { if (!condition) throw new Error(message); }
function entry(index, key) { return Object.hasOwn(index, key) ? index[key] : undefined; }
function object(value, name) { check(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`); return value; }
function keys(value, allowed) { object(value, 'input'); check(Object.keys(value).every(k => allowed.includes(k)), 'Unknown outreach property'); }
function text(value, name, max = 2000) { check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${name} is required and must be bounded text`); return value.trim(); }
function id(value) { check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value), 'Invalid opaque ID'); return value; }
function timestamp(value) { check(typeof value === 'string' && /T/.test(value) && Number.isFinite(Date.parse(value)), 'ISO timestamp required'); return new Date(value).toISOString(); }
function url(value) { const parsed = new URL(text(value, 'URL', 1000)); check(parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'HTTPS URL without credentials required'); return parsed.href; }
function secretScan(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    check(!/^(passwords?|cookies?|mfa(code)?|totp|ssn|passport|aadhaar|government.?id|credentials?|session.?token)$/i.test(key), 'Forbidden sensitive field');
    secretScan(item);
  }
}
const fingerprint = (state, kind, value) => createHmac('sha256', state.meta.key).update(`${kind}:${value}`).digest('hex');
export function initialOutreach() {
  return { meta: { revision: 0, key: randomBytes(32).toString('hex'), enabled: false, timezone: 'UTC', recoveryBlocked: false },
    ...Object.fromEntries(OUTREACH_TABLES.map(name => [name, {}])) };
}
function localDate(value, timezone) { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)); }
export function businessDate(value, timezone, days) {
  const date = new Date(`${localDate(value, timezone)}T12:00:00Z`);
  for (let added = 0; added < days;) { date.setUTCDate(date.getUTCDate() + 1); if (![0, 6].includes(date.getUTCDay())) added++; }
  return date.toISOString().slice(0, 10);
}
function recent(value, now) { const t = Date.parse(timestamp(value)); check(t <= Date.parse(now) && t >= Date.parse(now) - DAY, 'Recheck must be within the previous 24 hours'); }
function activeEvents(state, opportunityId) {
  const events = Object.values(state.events).filter(e => e.opportunityId === opportunityId);
  const superseded = new Set(events.flatMap(e => e.supersedes ?? []));
  return events.filter(e => !superseded.has(e.id));
}
function projection(state, opportunityId, now) {
  const opportunity = entry(state.opportunities, opportunityId);
  check(opportunity, 'Opportunity not found');
  const events = activeEvents(state, opportunityId);
  const attempts = events.filter(e => e.type === 'handoff').map(e => {
    const observations = events.filter(o => o.attemptId === e.id && DELIVERY.includes(o.type));
    const types = [...new Set(observations.map(o => o.type))];
    const conflict = types.length > 1 && !(types.length === 2 && types.every(t => t.startsWith('sent-')));
    return { id: e.id, purpose: e.purpose, draftRevision: e.draftRevision,
      delivery: conflict ? 'conflict' : types.includes('sent-verified') ? 'sent-verified' : types[0] ?? 'pending-handoff',
      sentAt: observations.filter(o => o.type.startsWith('sent-')).map(o => o.occurredAt).sort()[0] ?? null };
  });
  const progression = [...new Set(events.filter(e => PROGRESSION.includes(e.type)).map(e => e.type))];
  const suppressed = opportunity.suppressed || Object.values(state.reservations).some(r => r.suppressed && reservationMatches(r, opportunity));
  const stopped = progression.some(p => STOP.includes(p)) || suppressed || opportunity.cleared;
  const initial = attempts.find(a => a.purpose === 'initial' && a.delivery.startsWith('sent-'));
  const followup = attempts.find(a => a.purpose === 'follow-up' && a.delivery.startsWith('sent-'));
  const blocked = attempts.some(a => ['conflict', 'pending-handoff', 'uncertain'].includes(a.delivery));
  const eligible = GATES.every(g => entry(state.contents, opportunityId)?.assessment?.qualification[g] === true);
  const dueOn = initial ? businessDate(initial.sentAt, state.meta.timezone, 7) : null;
  const closeOn = followup ? businessDate(followup.sentAt, state.meta.timezone, 7) : null;
  return { id: opportunityId, cleared: opportunity.cleared, suppressed,
    qualificationRevision: opportunity.qualificationRevision, eligible, score: opportunity.score, attempts,
    delivery: attempts.at(-1)?.delivery ?? 'not-sent', progression,
    followupDueOn: dueOn,
    followupDue: Boolean(!stopped && !blocked && eligible && dueOn && localDate(now, state.meta.timezone) >= dueOn && !attempts.some(a => a.purpose === 'follow-up' && a.delivery !== 'not-sent')),
    noResponse: Boolean(!stopped && !blocked && closeOn && localDate(now, state.meta.timezone) >= closeOn) };
}
function identities(state, assessment) {
  const companies = [assessment.company.domain, ...assessment.company.aliases].map(v => text(v, 'company domain', 253).toLowerCase().replace(/^www\./, ''));
  check(companies.every(v => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(v)), 'Company identity must be an employer domain');
  const recipients = [assessment.recipient.account, ...assessment.recipient.aliases].map((v, index) => {
    const parsed = new URL(url(v));
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^twitter\.com$/, 'x.com');
    const path = parsed.pathname.replace(/\/$/, '').toLowerCase();
    check((host === 'linkedin.com' && /^\/in\/[^/]+$/.test(path)) || (host === 'x.com' && /^\/[a-z0-9_]+$/.test(path)) || assessment.channel === 'email', 'Use a verified recipient profile URL');
    if (index === 0 && assessment.channel !== 'email') check(host === (assessment.channel === 'linkedin' ? 'linkedin.com' : 'x.com'), 'Primary recipient account must match the channel');
    return `https://${host}${path}`;
  });
  return { companies: [...new Set(companies)].map(v => fingerprint(state, 'company', v)), recipients: [...new Set(recipients)].map(v => fingerprint(state, 'recipient', v)) };
}
function overlaps(a, b) { return a.some(v => b.includes(v)); }
function reservationMatches(reservation, opportunity) { return overlaps(reservation.companies, opportunity.companies) || overlaps(reservation.recipients, opportunity.recipients); }
function requireOpportunity(state, input) { const op = entry(state.opportunities, id(input.id)); check(op, 'Opportunity not found'); check(!op.cleared, 'Opportunity was cleared'); return op; }
function checkLinkedApplication(content, applications, outcomes) {
  const applicationId = content?.assessment.applicationId;
  if (!applicationId) return;
  check(applications.some(app => app.id === applicationId && app.status === 'submitted'), 'Linked application must still be verified');
  check(!outcomes.some(outcome => outcome.id === applicationId && ['rejected', 'withdrawn', 'offer', 'interview'].includes(outcome.status)), 'Linked application already has a hiring outcome; review the conversation instead');
}
function resultFor(state, action, input, now) {
  if (action.startsWith('policy-')) return { enabled: state.meta.enabled, timezone: state.meta.timezone, recoveryBlocked: state.meta.recoveryBlocked, mode: 'draft-and-track' };
  if (action === 'clear') return { cleared: input.ids, backupRetentionDays: 30, disconnectedCachesMayRemain: true };
  const result = projection(state, input.id, now);
  if (action === 'handoff' && !result.cleared && !result.suppressed && result.eligible && state.meta.enabled && !state.meta.recoveryBlocked && !result.progression.some(p => STOP.includes(p)) && result.attempts.find(a => a.id === input.operationId)?.delivery === 'pending-handoff' && result.qualificationRevision === input.qualificationRevision && Date.parse(now) - Date.parse(input.recheckedAt) <= DAY) {
    result.copyableText = entry(state.contents, input.id)?.drafts?.find(d => d.revision === input.draftRevision)?.text;
  }
  return result;
}

export function mutateOutreach(original, action, input, { now = new Date().toISOString(), actor = 'local', applications = [], outcomes = [] } = {}) {
  object(input, 'input'); secretScan(input);
  check(JSON.stringify(input).length <= 32000, 'Outreach input too large');
  const operationId = id(input.operationId);
  const digest = fingerprint(original, 'operation', stableJson({ action, input }));
  const prior = entry(original.operations, operationId);
  if (prior) {
    check(prior.digest === digest, 'Operation ID reused with different content');
    if (action === 'handoff') checkLinkedApplication(entry(original.contents, input.id), applications, outcomes);
    return { state: original, result: resultFor(original, action, input, now) };
  }
  const state = structuredClone(original);
  let event = null;
  const addEvent = (type, extra = {}) => { event = { id: operationId, opportunityId: input.id, type, occurredAt: now, actor, ...extra }; state.events[operationId] = event; };
  if (action === 'policy-enable' || action === 'policy-disable') {
    keys(input, ['operationId', 'timezone', 'recoveryReviewed']);
    if (action === 'policy-enable') {
      check(!state.meta.recoveryBlocked || input.recoveryReviewed === true, 'Restore recovery review required before enabling handoffs');
      if (input.recoveryReviewed === true) state.meta.recoveryBlocked = false;
      text(input.timezone, 'timezone', 100); localDate(now, input.timezone); state.meta.timezone = input.timezone;
    }
    state.meta.enabled = action === 'policy-enable';
  } else if (action === 'assess') {
    keys(input, ['operationId', 'id', 'company', 'recipient', 'role', 'channel', 'source', 'applicationId', 'qualification', 'gateEvidence', 'evidence', 'ranking', 'aliasesVerified']);
    check(state.meta.enabled, 'Outreach is disabled'); id(input.id);
    check(!entry(state.tombstones, input.id), 'Opportunity was cleared');
    keys(input.company, ['name', 'domain', 'aliases']); text(input.company.name, 'company name', 200); keys(input.recipient, ['account', 'aliases']);
    check(Array.isArray(input.company.aliases) && input.company.aliases.length <= 10 && Array.isArray(input.recipient.aliases) && input.recipient.aliases.length <= 10, 'Bounded alias arrays required');
    if (input.company.aliases.length || input.recipient.aliases.length) check(input.aliasesVerified === true, 'Aliases require verified identity evidence');
    text(input.role, 'role', 200); check(['linkedin', 'x', 'email'].includes(input.channel), 'Unsupported channel');
    keys(input.source, ['kind', 'url']); url(input.source.url);
    check(['hiring-post', 'application'].includes(input.source.kind), 'Source must be application or user-shared hiring-post');
    if (input.applicationId) {
      const app = applications.find(a => a.id === input.applicationId && a.status === 'submitted');
      check(app, 'Verified submitted application required');
      check(app.role === input.role, 'Application role must match assessment');
      const normalize = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
      check(normalize(app.company) === normalize(input.company.name), 'Application company must match assessment');
    } else check(input.source.kind === 'hiring-post', 'Application source requires a submitted application link');
    keys(input.qualification, GATES); check(GATES.every(g => [true, false, null].includes(input.qualification[g])), 'All qualification gates required (true, false, or null)');
    check(Array.isArray(input.evidence) && input.evidence.length > 0 && input.evidence.length <= 20, 'Qualification evidence required');
    const evidenceIds = new Set();
    for (const e of input.evidence) {
      keys(e, ['id', 'kind', 'source', 'observedAt', 'text']); id(e.id); check(!evidenceIds.has(e.id), 'Duplicate evidence ID'); evidenceIds.add(e.id);
      check(['candidate', 'role', 'recipient', 'history'].includes(e.kind), 'Invalid evidence kind'); text(e.source, 'evidence source', 1000); timestamp(e.observedAt); text(e.text, 'evidence');
    }
    keys(input.gateEvidence, GATES);
    for (const gate of GATES) check(Array.isArray(input.gateEvidence[gate]) && input.gateEvidence[gate].length > 0 && input.gateEvidence[gate].length <= 20 && input.gateEvidence[gate].every(ref => evidenceIds.has(ref)), 'Every qualification gate needs evidence references');
    keys(input.ranking, Object.keys(RANKING));
    for (const [key, max] of Object.entries(RANKING)) check(Number.isInteger(input.ranking[key]) && input.ranking[key] >= 0 && input.ranking[key] <= max, 'Invalid ranking');
    const existing = entry(state.opportunities, input.id);
    const identity = identities(state, input);
    if (existing) check(overlaps(existing.companies, identity.companies) && overlaps(existing.recipients, identity.recipients), 'Cannot replace opportunity identity; use a new opportunity');
    if (existing) for (const key of ['companies', 'recipients']) identity[key] = [...new Set([...existing[key], ...identity[key]])];
    state.opportunities[input.id] = { ...identity, id: input.id, qualificationRevision: (existing?.qualificationRevision ?? 0) + 1,
      score: Object.values(input.ranking).reduce((a, b) => a + b, 0), cleared: false, suppressed: existing?.suppressed ?? false };
    const content = entry(state.contents, input.id) ?? { drafts: [], evidence: {} };
    content.assessment = structuredClone(input); delete content.assessment.operationId; state.contents[input.id] = content;
    addEvent('assessed');
  } else if (action === 'clear') {
    keys(input, ['operationId', 'ids']); check(Array.isArray(input.ids) && input.ids.length > 0 && input.ids.length <= 50, 'Opportunity IDs required');
    for (const opportunityId of input.ids) {
      const op = entry(state.opportunities, id(opportunityId)); check(op, 'Opportunity not found');
      delete state.contents[opportunityId]; op.cleared = true; op.suppressed = true;
      state.tombstones[opportunityId] = { id: opportunityId, clearedAt: now, actor };
      state.reservations[`clear:${opportunityId}`] = { opportunityId, companies: op.companies, recipients: op.recipients, suppressed: true };
    }
  } else {
    const op = requireOpportunity(state, input); const content = entry(state.contents, input.id);
    if (action === 'draft') {
      keys(input, ['operationId', 'id', 'text', 'claimRefs', 'purpose']); check(state.meta.enabled, 'Outreach is disabled');
      text(input.text, 'draft', 4000); check(['initial', 'follow-up'].includes(input.purpose), 'Draft purpose required');
      check(Array.isArray(input.claimRefs) && input.claimRefs.length <= 20, 'Claim references required');
      check(input.claimRefs.every(ref => content.assessment.evidence.some(e => e.id === ref && e.kind === 'candidate')), 'Candidate claim reference not found');
      if (/\b(?:I|my)\b.*\b(?:experience|built|led|worked|created|delivered|implemented|engineer|developed|shipped|MCP|AI)\b/i.test(input.text)) check(input.claimRefs.length > 0, 'Candidate experience claims require evidence references');
      check(!/\b(I (?:currently work|am employed)|(?:my|a) (?:salary|pay) (?:is|will)|I (?:can|will) (?:start|join|work)|I (?:have|hold) (?:work authorization|a visa)|(?:you referred|we met|we worked))\b/i.test(input.text), 'Draft contains a forbidden employment, familiarity, or commitment claim');
      check(!/\b(available (?:to start|immediately)|authorized to work|(?:need|require) no sponsorship|currently (?:at|employed by)|my current employer)\b/i.test(input.text), 'Draft contains a forbidden employment, availability, or authorization commitment');
      if (!content.assessment.applicationId) check(!/\b(I(?:'ve| have)? applied|my application|submitted (?:an |my )?application)\b/i.test(input.text), 'Cannot claim an application without a verified application link');
      content.drafts.push({ revision: content.drafts.length + 1, qualificationRevision: op.qualificationRevision, text: input.text,
        claimRefs: input.claimRefs, purpose: input.purpose, createdAt: now }); addEvent('drafted');
    } else if (action === 'handoff') {
      keys(input, ['operationId', 'id', 'draftRevision', 'qualificationRevision', 'selectedByUser', 'recheckedAt', 'history', 'exception']);
      check(state.meta.enabled && !state.meta.recoveryBlocked, 'Outreach disabled or restore recovery blocked');
      check(input.selectedByUser === true, 'Exact draft selection by the user required'); recent(input.recheckedAt, now);
      checkLinkedApplication(content, applications, outcomes);
      check(input.qualificationRevision === op.qualificationRevision && GATES.every(g => content.assessment.qualification[g] === true), 'Qualification gates or revision do not match');
      const draft = content.drafts.find(d => d.revision === input.draftRevision);
      check(draft && draft.qualificationRevision === op.qualificationRevision, 'Draft revision must match current qualification');
      keys(input.history, ['kind', 'noPriorPitch', 'checkedAt']);
      check(['verified', 'user-reported'].includes(input.history.kind), 'Conversation history evidence required'); recent(input.history.checkedAt, now);
      check(typeof input.history.noPriorPitch === 'boolean', 'Prior pitch declaration required');
      const view = projection(state, input.id, now);
      check(!view.attempts.some(a => ['pending-handoff', 'uncertain', 'conflict'].includes(a.delivery)), 'Unresolved handoff requires reconciliation');
      const reservations = Object.values(state.reservations).filter(r => reservationMatches(r, op));
      check(!op.suppressed && !reservations.some(r => r.suppressed) && !view.progression.some(p => STOP.includes(p)), 'Contact suppressed or conversation already progressed');
      check(!reservations.some(r => r.pending), 'Company or recipient reserved by an unresolved handoff');
      if (draft.purpose === 'follow-up') check(view.followupDue, 'Follow-up is not due or already used');
      else {
        if (reservations.length || !input.history.noPriorPitch) {
          check(input.exception, 'Additional company or recipient contact requires an explicit user exception');
          keys(input.exception, ['approvedByUser', 'reason']); check(input.exception.approvedByUser === true, 'Additional contact requires explicit user exception'); text(input.exception.reason, 'exception reason');
        }
      }
      content.evidence[operationId] = { history: input.history, recheckedAt: input.recheckedAt, ...(input.exception ? { exception: input.exception } : {}) };
      state.reservations[operationId] = { opportunityId: input.id, companies: op.companies, recipients: op.recipients, pending: true, suppressed: false };
      addEvent('handoff', { purpose: draft.purpose, draftRevision: draft.revision });
    } else if (action === 'record') {
      keys(input, ['operationId', 'id', 'type', 'attemptId', 'occurredAt', 'evidence', 'messageRef', 'supersedes', 'schedule', 'sentText', 'minutesSpent', 'replyTone']);
      check([...DELIVERY, ...PROGRESSION].includes(input.type), 'Unsupported outcome');
      const occurredAt = timestamp(input.occurredAt); check(Date.parse(occurredAt) <= Date.parse(now), 'Future observation is invalid'); text(input.evidence, 'evidence');
      const supersedes = input.supersedes ?? []; check(Array.isArray(supersedes) && supersedes.length <= 20, 'Invalid correction');
      const category = DELIVERY.includes(input.type) ? DELIVERY : PROGRESSION;
      for (const old of supersedes) {
        const previous = entry(state.events, old);
        check(previous?.opportunityId === input.id && category.includes(previous.type), 'Corrections must reference observations in the same delivery/progression category');
      }
      if (DELIVERY.includes(input.type)) {
        const attempt = entry(state.events, input.attemptId); check(attempt?.type === 'handoff' && attempt.opportunityId === input.id, 'Delivery observation requires its handoff');
        check(Date.parse(occurredAt) >= Date.parse(attempt.occurredAt), 'Observation precedes handoff');
        check(supersedes.every(old => entry(state.events, old).attemptId === input.attemptId), 'Delivery corrections must match attempt');
        if (input.type === 'sent-verified') text(input.messageRef, 'visible message reference', 1000);
        if (input.sentText) text(input.sentText, 'actual sent text', 4000);
      }
      if (input.type === 'screen-scheduled') {
        keys(input.schedule, ['at', 'timezone']); timestamp(input.schedule.at); localDate(input.schedule.at, input.schedule.timezone); text(input.schedule.timezone, 'meeting timezone', 100);
      }
      if (input.type === 'closed-no-response') check(projection(state, input.id, now).noResponse, 'No-response timing requires a recorded follow-up send');
      if (input.minutesSpent !== undefined) check(Number.isInteger(input.minutesSpent) && input.minutesSpent >= 0 && input.minutesSpent <= 10080, 'Invalid minutes spent');
      if (input.replyTone !== undefined) check(input.type === 'replied' && ['positive', 'neutral', 'negative'].includes(input.replyTone), 'Reply tone requires a reply');
      content.evidence[operationId] = { text: input.evidence, ...(input.messageRef ? { messageRef: input.messageRef } : {}), ...(input.schedule ? { schedule: input.schedule } : {}), ...(input.sentText ? { sentText: input.sentText } : {}) };
      addEvent(input.type, { occurredAt, ...(input.attemptId ? { attemptId: input.attemptId } : {}), ...(supersedes.length ? { supersedes } : {}), ...(input.minutesSpent !== undefined ? { minutesSpent: input.minutesSpent } : {}), ...(input.replyTone ? { replyTone: input.replyTone } : {}) });
      const view = projection(state, input.id, now);
      if (input.attemptId) {
        const attempt = view.attempts.find(a => a.id === input.attemptId);
        const reservation = entry(state.reservations, input.attemptId) ?? { opportunityId: input.id, companies: op.companies, recipients: op.recipients, pending: true, suppressed: false };
        if (attempt.delivery === 'not-sent') delete state.reservations[input.attemptId];
        else { reservation.pending = ['pending-handoff', 'uncertain', 'conflict'].includes(attempt.delivery); state.reservations[input.attemptId] = reservation; }
      }
      const rejectionKey = `rejected:${input.id}`;
      if (view.progression.includes('rejected')) {
        state.reservations[rejectionKey] = { opportunityId: input.id, companies: op.companies, recipients: op.recipients, suppressed: true };
      } else delete state.reservations[rejectionKey];
    } else if (action === 'suppress') {
      keys(input, ['operationId', 'id', 'scope', 'reason']); check(['company', 'recipient'].includes(input.scope), 'Suppression scope required'); text(input.reason, 'reason');
      op.suppressed = true;
      state.reservations[operationId] = { opportunityId: input.id, companies: input.scope === 'company' ? op.companies : [], recipients: input.scope === 'recipient' ? op.recipients : [], suppressed: true };
      content.evidence[operationId] = { reason: input.reason }; addEvent('suppressed');
    } else throw new Error('Unknown outreach mutation');
  }
  state.operations[operationId] = { digest, action, opportunityId: input.id ?? null };
  state.meta.revision++;
  return { state, result: resultFor(state, action, input, now) };
}

export function readOutreach(state, action, input = {}, now = new Date().toISOString()) {
  if (action === 'policy-status') return resultFor(state, action, input, now);
  if (action === 'show') {
    const view = projection(state, id(input.id), now);
    return { ...view, content: entry(state.contents, input.id) ?? null, events: Object.values(state.events).filter(e => e.opportunityId === input.id) };
  }
  const items = Object.keys(state.opportunities).map(opportunityId => projection(state, opportunityId, now)).sort((a, b) => b.score - a.score);
  if (action === 'list') return { items };
  if (action === 'review') {
    const attempts = items.flatMap(i => i.attempts);
    const sent = attempts.filter(a => a.delivery.startsWith('sent-'));
    const companies = [];
    for (const item of items.filter(i => i.attempts.some(a => a.delivery.startsWith('sent-')))) {
      let group = new Set(state.opportunities[item.id].companies);
      for (let i = companies.length - 1; i >= 0; i--) if ([...group].some(key => companies[i].has(key))) { group = new Set([...group, ...companies[i]]); companies.splice(i, 1); }
      companies.push(group);
    }
    const first = sent.map(a => a.sentAt).sort()[0];
    const events = items.flatMap(item => activeEvents(state, item.id));
    return { opportunities: items.length, companiesContacted: companies.length, sentUserReported: sent.filter(a => a.delivery === 'sent-user-reported').length,
      sentVerified: sent.filter(a => a.delivery === 'sent-verified').length, unresolved: attempts.filter(a => ['conflict', 'pending-handoff', 'uncertain'].includes(a.delivery)).length,
      outcomes: Object.fromEntries(PROGRESSION.map(p => [p, items.filter(i => i.progression.includes(p) || (p === 'closed-no-response' && i.noResponse)).length])),
      sampleSize: items.filter(i => i.attempts.some(a => a.delivery.startsWith('sent-'))).length, sampleUnit: 'contacted-opportunities', cohortAgeDays: first ? Math.floor((Date.parse(now) - Date.parse(first)) / DAY) : 0,
      outcomeReviewDue: Boolean(first && localDate(now, state.meta.timezone) >= businessDate(first, state.meta.timezone, 20)),
      pilotReviewDue: attempts.length >= 10, positiveReplies: new Set(events.filter(e => e.type === 'replied' && e.replyTone === 'positive').map(e => e.opportunityId)).size,
      reportedMinutesSpent: events.reduce((total, e) => total + (e.minutesSpent ?? 0), 0), comparison: 'observational; selection bias; no causal ROI claim' };
  }
  throw new Error('Unknown outreach read');
}
