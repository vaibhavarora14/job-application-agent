// Shared by the packaged CLI and private Worker. No candidate state or network access.
import { createHash } from 'node:crypto';

export const ACCOUNTING_CAPABILITY = 'application-accounting-v1';
export const DISPOSITIONS = Object.freeze(['qualified', 'duplicate', 'no-relevant-opening', 'location-authorization-conflict', 'compensation-below-floor', 'seniority-mismatch', 'insufficient-must-have-coverage', 'closed-stale', 'blocked']);
const DELIVERY_TYPES = ['receipt-confirmed', 'delivery-failed', 'correction', 'retry-confirmed'];
const EVIDENCE_TYPES = ['employer-acknowledgement', 'final-delivery-failure', 'browser-confirmation', 'sent-email', 'ambiguous', 'delivery-delay'];
function required(value, name, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty text (maximum ${max}).`);
  return value;
}
function date(value, name) { required(value, name, 80); if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO date.`); return new Date(value).toISOString(); }
function object(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Accounting event must be an object.');
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown accounting field: ${key}.`);
}
export function canonicalUrl(value) {
  const url = new URL(required(value, 'url', 2048));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('A public HTTP(S) URL is required.');
  url.hash = '';
  // Unknown parameters may identify a requisition (for example SAP career_job_req_id).
  for (const key of [...url.searchParams.keys()]) if (/^(utm_.*|ref|refid|referrer|source|gh_src|tracking_?id|trk|trkinfo|gclid|fbclid|msclkid|mc_cid|mc_eid|lever-source|lever-origin)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(stableJson(value)).digest('hex');
export function eventId(value, prefix) { return `${prefix}-${digest(value)}`; }
export function validateDelivery(input) {
  object(input, ['version','id','applicationId','attemptId','type','occurredAt','evidenceType','evidence','messageRef','supersedes','status','channel','url','channelVerifiedAt','approval']);
  const v = { ...input, version: 1 };
  if (input.version != null && input.version !== 1) throw new Error('Unsupported delivery version.');
  for (const name of ['applicationId','attemptId']) required(v[name], name);
  if (!DELIVERY_TYPES.includes(v.type)) throw new Error('Invalid delivery type.');
  if (!EVIDENCE_TYPES.includes(v.evidenceType)) throw new Error('Invalid evidenceType.');
  required(v.evidence, 'evidence', 2000);
  v.occurredAt = date(v.occurredAt, 'occurredAt');
  if (v.messageRef != null) required(v.messageRef, 'messageRef', 500);
  if (v.type === 'correction') {
    if (!['receipt-confirmed','delivery-failed','unknown'].includes(v.status)) throw new Error('Invalid correction status.');
    const refs = Array.isArray(v.supersedes) ? v.supersedes : [v.supersedes];
    if (!refs.length || refs.length > 100) throw new Error('Correction requires superseded event IDs.');
    refs.forEach(ref => required(ref,'supersedes'));
    v.supersedes = [...new Set(refs)].sort();
  } else if (v.supersedes != null || v.status != null) throw new Error('Only corrections supersede delivery evidence.');
  if (v.type === 'retry-confirmed') {
    if (!['email','browser'].includes(v.channel)) throw new Error('Retry channel must be email or browser.');
    v.url = canonicalUrl(v.url);
    v.channelVerifiedAt = date(v.channelVerifiedAt,'channelVerifiedAt');
    if (Date.parse(v.channelVerifiedAt) > Date.parse(v.occurredAt) || Date.parse(v.occurredAt) - Date.parse(v.channelVerifiedAt) > 86400000) throw new Error('Retry channel must be verified within 24 hours before transmission.');
    if (!['STANDING AUTHORIZATION','APPROVE SUBMIT'].includes(v.approval)) throw new Error('Retry requires existing candidate authorization.');
    if (v.evidenceType !== (v.channel === 'email' ? 'sent-email' : 'browser-confirmation')) throw new Error('Retry requires verified transmission evidence.');
    if (v.attemptId.startsWith('initial:')) throw new Error('Retry requires a new attemptId.');
  } else if (['channel','url','channelVerifiedAt','approval'].some(k => v[k] != null)) throw new Error('Transmission fields are only allowed on retry-confirmed.');
  v.id ??= eventId(v, 'delivery');
  required(v.id, 'id');
  return v;
}

// A revision graph, never last-write-wins. Different children of one revision conflict.
function heads(events) {
  const versions = new Map();
  for (const e of events) {
    const key = stableJson(e);
    if (!versions.has(e.id)) versions.set(e.id, new Map());
    versions.get(e.id).set(key, e);
  }
  const all = [...versions.values()].flatMap(v => [...v.values()]);
  const invalidIds = new Set([...versions].filter(([,v]) => v.size > 1).map(([id]) => id));
  const referenced = new Set(all.flatMap(e => e.supersedes == null ? [] : Array.isArray(e.supersedes) ? e.supersedes : [e.supersedes]));
  const missing = [...referenced].some(id => !versions.has(id));
  const current = all.filter(e => !referenced.has(e.id));
  return { current, conflict: invalidIds.size > 0 || missing || (all.length > 0 && !current.length) };
}
function refs(event) { return event.supersedes == null ? [] : Array.isArray(event.supersedes) ? event.supersedes : [event.supersedes]; }
const normalized = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function accountingApplicationKey(entry, fallback = '') {
  if (entry.employerJobId) return `job:${normalized(entry.company)}:${String(entry.employerJobId).toLowerCase()}`;
  if (entry.company && entry.role) return `legacy-role:${normalized(entry.company)}:${normalized(entry.role)}`;
  if (entry.url) return `url:${canonicalUrl(entry.url).replace(/\/$/, '').toLowerCase()}`;
  return `id:${entry.id ?? fallback}`;
}
export function deliveryProjection(entries, events = []) {
  const applications = entries.map(app => {
    const selected = events.filter(e => e.version === 1 && e.applicationId === app.id && DELIVERY_TYPES.includes(e.type));
    const initial = { attemptId: `initial:${app.id}`, channel: (app.applicationChannel ?? app.source) === 'email' ? 'email' : 'browser', url: app.url };
    // A stable representative keeps even conflicting retry projections independent of arrival order.
    const retries = [...new Map(selected.filter(e => e.type === 'retry-confirmed').sort((a, b) => stableJson(a).localeCompare(stableJson(b))).map(e => [e.attemptId, e])).values()];
    const attempts = [initial, ...retries].map(attempt => {
      const observations = selected.filter(e => e.attemptId === attempt.attemptId && e.type !== 'retry-confirmed');
      const graph = heads(observations);
      const states = new Set();
      const ancestors = event => {
        const seen = new Set();
        const pending = [...refs(event)];
        while (pending.length) {
          const id = pending.pop();
          if (seen.has(id)) continue;
          seen.add(id);
          const parent = observations.find(e => e.id === id);
          if (parent) pending.push(...refs(parent));
        }
        return seen;
      };
      const correctionFork = graph.current.some((left, index) => graph.current.slice(index + 1).some(right => {
        if (left.status === right.status) return false;
        const lineage = ancestors(left);
        return [...ancestors(right)].some(id => lineage.has(id));
      }));
      let ambiguous = graph.conflict || correctionFork;
      for (const e of graph.current) {
        const status = e.type === 'correction' ? e.status : e.type;
        if (status === 'unknown') continue;
        if (e.evidenceType === 'delivery-delay') continue;
        if (e.evidenceType === 'ambiguous') { ambiguous = true; continue; }
        if (status === 'delivery-failed') {
          if (e.evidenceType !== 'final-delivery-failure') { ambiguous = true; continue; }
          if (attempt.channel === 'email') states.add('failed');
        } else if (status === 'receipt-confirmed') {
          if (!['employer-acknowledgement','browser-confirmation'].includes(e.evidenceType)) { ambiguous = true; continue; }
          states.add('received');
        }
      }
      const retryCopies = selected.filter(e => e.type === 'retry-confirmed' && e.attemptId === attempt.attemptId);
      if (new Set(retryCopies.map(stableJson)).size > 1) ambiguous = true;
      const conflict = ambiguous || states.size > 1;
      const failed = !conflict && states.has('failed');
      return { ...attempt, failed, conflict, counted: !failed, receiptUnknown: attempt.channel === 'email' && !failed && !states.has('received'), status: conflict ? 'needs-review' : failed ? 'delivery-failed' : attempt.channel !== 'email' || states.has('received') ? 'receipt-confirmed' : 'receipt-unknown' };
    });
    const orphan = selected.some(e => !attempts.some(a => a.attemptId === e.attemptId));
    return { applicationId: app.id, counted: attempts.some(a => a.counted), failed: attempts.every(a => a.failed), receiptUnknown: attempts.some(a => a.counted && a.receiptUnknown), conflict: orphan || attempts.some(a => a.conflict), attempts };
  });
  // Preserve the established canonical grouping contract (job ID, otherwise URL).
  const groups = new Map();
  entries.forEach((app,index) => {
    const key = accountingApplicationKey(app, index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(applications[index]);
  });
  const canonical = [...groups.values()];
  return { applications, recordedSubmissionCount: canonical.length, effectiveSubmissionCount: canonical.filter(g => g.some(a => a.counted)).length, failedDeliveryCount: canonical.filter(g => g.every(a => a.failed)).length, receiptUnknownEmailCount: canonical.filter(g => g.some(a => a.receiptUnknown)).length };
}
export function validateDeliveryReferences(event, applications, events, { preparedRetry = false } = {}) {
  const app = applications.find(a => a.id === event.applicationId);
  if (!app) throw new Error('Delivery applicationId is not recorded.');
  const existing = events.filter(e => e.id === event.id);
  if (existing.some(e => stableJson(e) !== stableJson(event))) throw new Error('Conflicting event ID; append a correction with a new ID.');
  if (existing.length) return;
  if (event.type === 'retry-confirmed') {
    const related = applications.filter(a => accountingApplicationKey(a) === accountingApplicationKey(app));
    const all = deliveryProjection(related, events).applications;
    const current = all.find(a => a.applicationId === app.id);
    if (!preparedRetry && all.some(a => !a.failed || a.conflict)) throw new Error('Retry requires verified failure of every prior attempt and no conflicts.');
    if (current.attempts.some(a => a.attemptId === event.attemptId)) throw new Error('Retry attemptId already exists.');
  } else if (event.attemptId !== `initial:${app.id}` && !events.some(e => e.type === 'retry-confirmed' && e.attemptId === event.attemptId && e.applicationId === app.id)) throw new Error('Delivery attemptId is not recorded.');
  for (const id of refs(event)) {
    const parent = events.find(e => e.id === id);
    if (!parent || parent.type === 'retry-confirmed' || parent.applicationId !== event.applicationId || parent.attemptId !== event.attemptId) throw new Error('Correction must reference existing evidence for the same attempt.');
  }
}

export function validateLead(input) {
  object(input,['version','type','id','roundId','sourceId','url','company','role','employerJobId','disposition','observedAt','evidence','applicationId','supersedes']);
  if (input.version != null && input.version !== 1) throw new Error('Unsupported discovery version.');
  if (input.type != null && input.type !== 'lead-reviewed') throw new Error('Invalid discovery event type.');
  const v = { ...input, version: 1, type: 'lead-reviewed', url: canonicalUrl(input.url) };
  for (const key of ['roundId','sourceId','company']) required(v[key],key);
  for (const key of ['role','employerJobId','applicationId']) if(v[key] != null) required(v[key],key);
  if (!DISPOSITIONS.includes(v.disposition)) throw new Error('Invalid lead disposition.');
  v.observedAt = date(v.observedAt,'observedAt');
  required(v.evidence,'evidence',2000);
  if (v.supersedes != null) {
    const parents = Array.isArray(v.supersedes) ? v.supersedes : [v.supersedes];
    if (!parents.length || parents.length > 100) throw new Error('Invalid lead supersedes.');
    parents.forEach(id => required(id,'supersedes'));
    v.supersedes = [...new Set(parents)].sort();
  }
  v.id ??= eventId(v, 'lead'); required(v.id,'id');
  return v;
}
function requisitionKey(e) { return e.employerJobId ? `${normalized(e.company)}:${e.employerJobId.toLowerCase()}` : canonicalUrl(e.url); }
export function leadKey(e) { return `${e.roundId}:${e.sourceId}:${requisitionKey(e)}`; }
export function validateLeadReferences(event, events) {
  for (const previous of events.filter(e => e.id === event.id)) if (stableJson(previous) !== stableJson(event)) throw new Error('Conflicting lead event ID.');
  for (const id of refs(event)) {
    const parent = events.find(e => e.version === 1 && e.id === id);
    const enrichment = parent && parent.roundId === event.roundId && parent.sourceId === event.sourceId && normalized(parent.company) === normalized(event.company) && canonicalUrl(parent.url) === canonicalUrl(event.url) && (!parent.employerJobId && Boolean(event.employerJobId));
    if (!parent || (leadKey(parent) !== leadKey(event) && !enrichment)) throw new Error('Lead revision must reference the same round, source and requisition.');
  }
}
export function discoveryProjection(events, { roundId } = {}) {
  const selected = events.filter(e => e.version === 1 && e.type === 'lead-reviewed' && (roundId == null || e.roundId === roundId));
  const aliases = new Map();
  const aliasKey = e => `${e.roundId}:${normalized(e.company)}:${canonicalUrl(e.url)}`;
  for (const e of selected.filter(e => e.employerJobId)) {
    const key = aliasKey(e);
    if (!aliases.has(key)) aliases.set(key, new Set());
    aliases.get(key).add(requisitionKey(e));
  }
  const resolvedKey = e => !e.employerJobId && aliases.get(aliasKey(e))?.size === 1 ? [...aliases.get(aliasKey(e))][0] : requisitionKey(e);
  const keyFor = e => `${e.roundId}:${e.sourceId}:${resolvedKey(e)}`;
  const roots = new Map(selected.map(e => [keyFor(e), keyFor(e)]));
  const root = key => { while (roots.get(key) !== key) key = roots.get(key); return key; };
  const byId = new Map();
  for (const e of selected) { if (!byId.has(e.id)) byId.set(e.id, []); byId.get(e.id).push(e); }
  // Explicit revisions keep their lineage even when a shared careers URL later
  // acquires another requisition. Forked enrichments stay together for conflict review.
  for (const e of selected) for (const id of [e.id, ...refs(e)]) for (const parent of byId.get(id) ?? []) {
    if (parent.roundId !== e.roundId || parent.sourceId !== e.sourceId) continue;
    const left = root(keyFor(e)); const right = root(keyFor(parent));
    if (left !== right) roots.set(left < right ? right : left, left < right ? left : right);
  }
  const groups = new Map();
  for (const e of selected) { const key = root(keyFor(e)); if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(e); }
  const leads = []; const conflicts = [];
  for (const [key, values] of groups) {
    const graph = heads(values);
    const comparable = e => stableJson(Object.fromEntries(Object.entries({ ...e, company: normalized(e.company), ...(e.employerJobId ? { employerJobId: e.employerJobId.toLowerCase() } : { url: canonicalUrl(e.url) }) }).filter(([k]) => !['id','observedAt','supersedes', ...(e.employerJobId ? ['url'] : [])].includes(k))));
    const conflict = graph.conflict || new Set(graph.current.map(comparable)).size > 1;
    if (conflict) conflicts.push({ key, eventIds: [...new Set(values.map(e => e.id))].sort() });
    const lead = [...graph.current].sort((a,b) => a.id.localeCompare(b.id))[0] ?? values[0];
    leads.push({ ...lead, key, conflict });
  }
  leads.sort((a,b) => a.key.localeCompare(b.key));
  return { leads, conflicts, reviewedCount: leads.length, qualifiedCount: leads.filter(e => !e.conflict && e.disposition === 'qualified').length, uniqueLeadCount: new Set(leads.map(resolvedKey)).size, dispositionCounts: Object.fromEntries(DISPOSITIONS.map(d => [d,leads.filter(e => !e.conflict && e.disposition === d).length])) };
}
