import { appendFile, chmod, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { deliveryProjection } from './application-accounting.mjs';
import { CloudStateClient, defaultCloudConfigPath } from './cloud-state-client.mjs';
import { readOutreach } from './outreach-domain.mjs';
import { withLocalOutreach } from './outreach-store.mjs';

export const OUTREACH_ROUND_CHANNEL = 'outreach';

export function companyCountKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function outreachConfirmationEvents(roundEvents, roundId) {
  return roundEvents.filter((event) => event.type === 'submission-confirmed' && event.roundId === roundId && typeof event.outreachId === 'string' && event.outreachId && event.channel === OUTREACH_ROUND_CHANNEL);
}

export function countedApplyCompanies(applications, delivery) {
  const companies = new Set();
  applications.forEach((entry, index) => {
    if (delivery.applications[index]?.counted) companies.add(companyCountKey(entry.company));
  });
  return companies;
}

export function sentVerifiedFromOutreachItems(items = []) {
  return items.flatMap((item) => {
    if (item?.delivery !== 'sent-verified' || item.cleared) return [];
    const company = item.content?.assessment?.company?.name;
    if (!company) return [];
    return [{
      id: item.id,
      company,
      role: item.content?.assessment?.role ?? null,
      companyKey: companyCountKey(company),
    }];
  });
}

export function sentVerifiedFromOutreachState(state, now = new Date().toISOString()) {
  if (!state?.opportunities) return [];
  return sentVerifiedFromOutreachItems(Object.keys(state.opportunities).map((id) => readOutreach(state, 'show', { id }, now)));
}

export function resolveOutreachRoundId(roundEvents, { outreachId, roundId = null } = {}) {
  if (roundId) return roundId;
  const attached = roundEvents.find((event) => event.type === 'submission-confirmed' && event.outreachId === outreachId && event.channel === OUTREACH_ROUND_CHANNEL);
  if (attached) return attached.roundId;
  const completed = new Set(roundEvents.filter((event) => event.type === 'completed').map((event) => event.roundId));
  const open = roundEvents.filter((event) => event.type === 'started' && !completed.has(event.roundId));
  return open.at(-1)?.roundId ?? null;
}

export function projectOutreachRoundCounts({ applications, delivery, roundEvents, sentVerified, roundId }) {
  const applyConfirmationCount = delivery.effectiveSubmissionCount;
  const applyCompanies = countedApplyCompanies(applications, delivery);
  const confirmations = outreachConfirmationEvents(roundEvents, roundId);
  const verified = new Map(sentVerified.map((item) => [item.id, item]));
  const countedCompanies = new Set(applyCompanies);
  const countedOutreachIds = [];
  for (const event of confirmations) {
    const item = verified.get(event.outreachId);
    if (!item) continue;
    if (countedCompanies.has(item.companyKey)) continue;
    countedCompanies.add(item.companyKey);
    countedOutreachIds.push(item.id);
  }
  const outreachConfirmationCount = countedOutreachIds.length;
  return {
    applyConfirmationCount,
    outreachConfirmationCount,
    confirmedCount: applyConfirmationCount + outreachConfirmationCount,
    countedOutreachIds,
  };
}

function alreadyCountedOutreachCompany(confirmations, sentVerified, companyKey) {
  const verified = new Map(sentVerified.map((entry) => [entry.id, entry]));
  return confirmations.some((event) => {
    const other = verified.get(event.outreachId);
    return (other?.companyKey ?? companyCountKey(event.company)) === companyKey;
  });
}

function shouldCountOutreach({ sentVerified, applications, delivery, confirmations, outreachId }) {
  const item = sentVerified.find((entry) => entry.id === outreachId);
  if (!item) return { count: false, reason: 'not-sent-verified' };
  if (confirmations.some((event) => event.outreachId === outreachId)) return { count: false, reason: 'already-recorded', item };
  if (countedApplyCompanies(applications, delivery).has(item.companyKey)) return { count: false, reason: 'already-applied', item };
  if (alreadyCountedOutreachCompany(confirmations, sentVerified, item.companyKey)) return { count: false, reason: 'already-counted-outreach', item };
  return { count: true, item };
}

async function jsonLines(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`Invalid JSON on line ${index + 1} of ${basename(file)}.`); }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function withFileLock(directory, name, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockPath = join(directory, `.${name}.lock`);
  let handle;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!handle) throw new Error(`Could not acquire ${name} ledger lock.`);
  try { return await action(); }
  finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function snapshotItemsFromCache(directory) {
  try {
    const cache = JSON.parse(await readFile(join(directory, 'outreach-cloud-cache.json'), 'utf8'));
    return Array.isArray(cache?.snapshot?.items) ? cache.snapshot.items : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function loadSentVerifiedOutreach(directory, cloudClient) {
  const cloud = cloudClient ?? new CloudStateClient({ stateDir: directory, configPath: process.env.JOB_APPLICATION_AGENT_CLOUD_CONFIG ?? defaultCloudConfigPath() });
  if (await cloud.configured()) {
    try {
      const snapshot = await (await cloud.request('/v2/outreach/snapshot')).json();
      if (Array.isArray(snapshot.items)) return sentVerifiedFromOutreachItems(snapshot.items);
    } catch (error) {
      if (!/^Cloud state unavailable:/.test(error.message)) throw error;
    }
    return sentVerifiedFromOutreachItems(await snapshotItemsFromCache(directory));
  }
  try {
    return await withLocalOutreach(directory, (state) => ({ result: sentVerifiedFromOutreachState(state) }));
  } catch (error) {
    if (error.code === 'ENOENT' || /Outreach storage locked|sql/i.test(error.message)) return [];
    return [];
  }
}

export async function confirmOutreachTowardRound({
  directory,
  outreachId,
  roundId = null,
  cloudClient = null,
  requireRoundId = false,
  occurredAt = new Date().toISOString(),
} = {}) {
  const id = String(outreachId ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)) throw new Error('Invalid opaque outreach ID.');
  const cloud = cloudClient ?? new CloudStateClient({ stateDir: directory, configPath: process.env.JOB_APPLICATION_AGENT_CLOUD_CONFIG ?? defaultCloudConfigPath() });
  return withFileLock(directory, 'rounds', async () => {
    const roundEvents = await jsonLines(join(directory, 'rounds.ndjson'));
    const targetRoundId = resolveOutreachRoundId(roundEvents, { outreachId: id, roundId });
    if (!targetRoundId) return { counted: false, reason: requireRoundId ? 'round-not-found' : 'no-active-round', outreachId: id, roundId: null };
    const started = roundEvents.find((event) => event.type === 'started' && event.roundId === targetRoundId);
    if (!started) throw new Error('Application round was not found.');
    if (roundEvents.some((event) => event.type === 'completed' && event.roundId === targetRoundId)) {
      const existing = outreachConfirmationEvents(roundEvents, targetRoundId).some((event) => event.outreachId === id);
      return { counted: existing, reason: existing ? 'already-recorded' : 'round-completed', outreachId: id, roundId: targetRoundId };
    }
    const applications = (await jsonLines(join(directory, 'applications.ndjson'))).filter((entry) => entry.roundId === targetRoundId && entry.status === 'submitted');
    const delivery = deliveryProjection(applications, await jsonLines(join(directory, 'delivery.ndjson')));
    const sentVerified = await loadSentVerifiedOutreach(directory, cloud);
    const confirmations = outreachConfirmationEvents(roundEvents, targetRoundId);
    const decision = shouldCountOutreach({ sentVerified, applications, delivery, confirmations, outreachId: id });
    if (!decision.count) {
      return { counted: decision.reason === 'already-recorded', reason: decision.reason, outreachId: id, roundId: targetRoundId, company: decision.item?.company ?? null };
    }
    const event = {
      type: 'submission-confirmed',
      roundId: targetRoundId,
      outreachId: id,
      channel: OUTREACH_ROUND_CHANNEL,
      company: decision.item.company,
      ...(decision.item.role ? { role: decision.item.role } : {}),
      occurredAt,
    };
    const file = join(directory, 'rounds.ndjson');
    await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    if (await cloud.configured()) {
      await cloud.appendRecord('rounds', event, {
        recordKey: targetRoundId,
        idempotencyKey: `round-confirmation:${targetRoundId}:outreach:${id}`,
        occurredAt,
        queueOnFailure: true,
      });
    }
    return { counted: true, reason: 'recorded', outreachId: id, roundId: targetRoundId, company: decision.item.company };
  });
}
