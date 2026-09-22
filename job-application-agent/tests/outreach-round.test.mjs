import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { deliveryProjection } from '../scripts/application-accounting.mjs';
import { assessment, handoff } from './fixtures/outreach.mjs';
import {
  OUTREACH_ROUND_CHANNEL,
  companyCountKey,
  confirmOutreachTowardRound,
  loadSentVerifiedOutreach,
  projectOutreachRoundCounts,
  resolveOutreachRoundId,
  sentVerifiedFromOutreachItems,
} from '../scripts/outreach-round.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

function application(roundId, company = 'Example') {
  return {
    id: `app-${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    company,
    role: 'Staff Product Engineer',
    url: `https://jobs.fixture.example/${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    employerJobId: `example:${company}`,
    source: 'ashby',
    discoverySource: 'linkedin',
    applicationChannel: 'ashby',
    roundId,
    score: 86,
    status: 'submitted',
    submittedAt: '2026-09-14T10:00:00.000Z',
    approval: 'STANDING AUTHORIZATION',
    answers: {},
  };
}

function verifiedItem(id, company) {
  return {
    id,
    delivery: 'sent-verified',
    content: { assessment: { company: { name: company }, role: 'Staff Product Engineer' } },
  };
}

test('sent-verified outreach increments a round when no apply exists', () => {
  const delivery = deliveryProjection([], []);
  const counts = projectOutreachRoundCounts({
    applications: [],
    delivery,
    roundEvents: [{ type: 'submission-confirmed', roundId: 'round-1', outreachId: 'noon', channel: OUTREACH_ROUND_CHANNEL, company: 'Noon' }],
    sentVerified: sentVerifiedFromOutreachItems([verifiedItem('noon', 'Noon')]),
    roundId: 'round-1',
  });
  assert.equal(counts.applyConfirmationCount, 0);
  assert.equal(counts.outreachConfirmationCount, 1);
  assert.equal(counts.confirmedCount, 1);
});

test('apply plus outreach at the same company counts once', () => {
  const applications = [application('round-1', 'Tricog')];
  const delivery = deliveryProjection(applications, []);
  const counts = projectOutreachRoundCounts({
    applications,
    delivery,
    roundEvents: [{ type: 'submission-confirmed', roundId: 'round-1', outreachId: 'tricog', channel: OUTREACH_ROUND_CHANNEL, company: 'Tricog' }],
    sentVerified: sentVerifiedFromOutreachItems([verifiedItem('tricog', 'Tricog')]),
    roundId: 'round-1',
  });
  assert.equal(counts.applyConfirmationCount, 1);
  assert.equal(counts.outreachConfirmationCount, 0);
  assert.equal(counts.confirmedCount, 1);
});

test('cleared outreach still counts from the durable confirmation company', () => {
  const counts = projectOutreachRoundCounts({
    applications: [],
    delivery: deliveryProjection([], []),
    roundEvents: [{ type: 'submission-confirmed', roundId: 'round-1', outreachId: 'noon', channel: OUTREACH_ROUND_CHANNEL, company: 'Noon' }],
    sentVerified: sentVerifiedFromOutreachItems([{
      id: 'noon',
      delivery: 'sent-verified',
      cleared: true,
      content: { assessment: { company: { name: 'Noon' }, role: 'Staff Product Engineer' } },
    }]),
    roundId: 'round-1',
  });
  assert.equal(counts.applyConfirmationCount, 0);
  assert.equal(counts.outreachConfirmationCount, 1);
  assert.equal(counts.confirmedCount, 1);
});

test('linked company names share one count key', () => {
  assert.equal(companyCountKey('Made Card'), companyCountKey('MadeCard'));
  const applications = [application('round-1', 'MadeCard')];
  const delivery = deliveryProjection(applications, []);
  const counts = projectOutreachRoundCounts({
    applications,
    delivery,
    roundEvents: [{ type: 'submission-confirmed', roundId: 'round-1', outreachId: 'made', channel: OUTREACH_ROUND_CHANNEL, company: 'Made Card' }],
    sentVerified: sentVerifiedFromOutreachItems([verifiedItem('made', 'Made Card')]),
    roundId: 'round-1',
  });
  assert.equal(counts.applyConfirmationCount, 1);
  assert.equal(counts.outreachConfirmationCount, 0);
  assert.equal(counts.confirmedCount, 1);
});

test('explicit confirm cannot reassign an attached outreach to another round', () => {
  assert.throws(() => resolveOutreachRoundId([
    { type: 'started', roundId: 'round-a', requestedCount: 30, occurredAt: '2026-09-14T10:00:00.000Z' },
    { type: 'submission-confirmed', roundId: 'round-a', outreachId: 'noon', channel: OUTREACH_ROUND_CHANNEL, company: 'Noon' },
    { type: 'started', roundId: 'round-b', requestedCount: 30, occurredAt: '2026-09-14T11:00:00.000Z' },
  ], { outreachId: 'noon', roundId: 'round-b' }), /already attached to another round/);
});

test('apply-only still increments without outreach', () => {
  const applications = [application('round-1', 'MadeCard')];
  const delivery = deliveryProjection(applications, []);
  const counts = projectOutreachRoundCounts({
    applications,
    delivery,
    roundEvents: [],
    sentVerified: [],
    roundId: 'round-1',
  });
  assert.equal(counts.applyConfirmationCount, 1);
  assert.equal(counts.outreachConfirmationCount, 0);
  assert.equal(counts.confirmedCount, 1);
});

async function fixture(t, label) {
  const directory = await mkdtemp(join(tmpdir(), `outreach-round-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({
    version: 1,
    enabled: false,
    disclosed: true,
    graceConsumed: true,
    installationEventPending: false,
  }));
  const env = {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
  };
  const cli = (args, input) => JSON.parse(execFileSync(process.execPath, [script, ...args], {
    env,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  }));
  return { directory, env, cli };
}

function recordVerifiedOutreach(cli, { id, company, domain }) {
  cli(['outreach', 'policy', 'enable', '--stdin'], { operationId: `enable-${id}`, timezone: 'Asia/Kolkata' });
  cli(['outreach', 'assess', '--stdin'], assessment(id, {
    operationId: `assess-${id}`,
    company: { name: company, domain, aliases: [] },
    recipient: { account: `https://www.linkedin.com/in/${id}-recruiter`, aliases: [] },
  }));
  cli(['outreach', 'draft', '--stdin'], {
    operationId: `draft-${id}`,
    id,
    text: 'Your product engineering role fits my experience. Would a brief conversation be useful?',
    claimRefs: ['experience'],
    purpose: 'initial',
  });
  const recheckedAt = new Date().toISOString();
  cli(['outreach', 'handoff', '--stdin'], handoff({
    operationId: `handoff-${id}`,
    id,
    recheckedAt,
    history: { kind: 'user-reported', noPriorPitch: true, checkedAt: recheckedAt },
  }));
  const occurredAt = new Date().toISOString();
  return cli(['outreach', 'record', '--stdin'], {
    operationId: `sent-${id}`,
    id,
    attemptId: `handoff-${id}`,
    type: 'sent-verified',
    occurredAt,
    evidence: 'Visible sent message in the conversation.',
    messageRef: `visible-message-${id}`,
  });
}

test('CLI sent-verified outreach increments the active round', async (t) => {
  const { cli } = await fixture(t, 'outreach-only');
  const { roundId } = cli(['round', 'start', '--stdin'], { requestedCount: 30 });
  const recorded = recordVerifiedOutreach(cli, { id: 'noon', company: 'Noon', domain: 'noon.com' });
  assert.equal(recorded.delivery, 'sent-verified');
  assert.equal(recorded.roundConfirmation.counted, true);
  assert.equal(recorded.roundConfirmation.roundId, roundId);
  const status = cli(['round', 'status', roundId]);
  assert.equal(status.applyConfirmationCount, 0);
  assert.equal(status.outreachConfirmationCount, 1);
  assert.equal(status.confirmedCount, 1);
  assert.equal(status.effectiveSubmissionCount, 0);
  const again = cli(['round', 'confirm', '--stdin'], { roundId, outreachId: 'noon' });
  assert.equal(again.confirmations[0].reason, 'already-recorded');
  assert.equal(again.confirmedCount, 1);
});

test('CLI apply plus outreach for the same company counts once', async (t) => {
  const { cli } = await fixture(t, 'apply-and-outreach');
  const { roundId } = cli(['round', 'start', '--stdin'], { requestedCount: 30 });
  cli(['ledger', 'add', '--stdin'], application(roundId, 'Tricog'));
  const recorded = recordVerifiedOutreach(cli, { id: 'tricog', company: 'Tricog', domain: 'tricog.com' });
  assert.equal(recorded.roundConfirmation.counted, false);
  assert.equal(recorded.roundConfirmation.reason, 'already-applied');
  const status = cli(['round', 'status', roundId]);
  assert.equal(status.applyConfirmationCount, 1);
  assert.equal(status.outreachConfirmationCount, 0);
  assert.equal(status.confirmedCount, 1);
  assert.equal(status.effectiveSubmissionCount, 1);
});

test('CLI apply-only still increments the round', async (t) => {
  const { cli } = await fixture(t, 'apply-only');
  const { roundId } = cli(['round', 'start', '--stdin'], { requestedCount: 30 });
  cli(['ledger', 'add', '--stdin'], application(roundId, 'MadeCard'));
  const status = cli(['round', 'status', roundId]);
  assert.equal(status.applyConfirmationCount, 1);
  assert.equal(status.outreachConfirmationCount, 0);
  assert.equal(status.confirmedCount, 1);
  assert.equal(status.effectiveSubmissionCount, 1);
});

test('later progression records do not auto-attach a historical send', async (t) => {
  const { cli } = await fixture(t, 'reply-does-not-count');
  const recorded = recordVerifiedOutreach(cli, { id: 'noon', company: 'Noon', domain: 'noon.com' });
  assert.equal(recorded.roundConfirmation.counted, false);
  assert.equal(recorded.roundConfirmation.reason, 'no-active-round');
  const { roundId } = cli(['round', 'start', '--stdin'], { requestedCount: 30 });
  const reply = cli(['outreach', 'record', '--stdin'], {
    operationId: 'reply-noon',
    id: 'noon',
    type: 'replied',
    occurredAt: new Date().toISOString(),
    evidence: 'Recruiter replied in the conversation.',
    replyTone: 'neutral',
  });
  assert.equal(reply.delivery, 'sent-verified');
  assert.equal(reply.roundConfirmation, undefined);
  const status = cli(['round', 'status', roundId]);
  assert.equal(status.outreachConfirmationCount, 0);
  assert.equal(status.confirmedCount, 0);
});

test('batch confirm validates every ID before committing any', async (t) => {
  const { cli } = await fixture(t, 'batch-validate');
  recordVerifiedOutreach(cli, { id: 'noon', company: 'Noon', domain: 'noon.com' });
  const { roundId } = cli(['round', 'start', '--stdin'], { requestedCount: 30 });
  assert.throws(
    () => cli(['round', 'confirm', '--stdin'], { roundId, outreachIds: ['noon', 'missing'] }),
    /not sent-verified/,
  );
  const status = cli(['round', 'status', roundId]);
  assert.equal(status.outreachConfirmationCount, 0);
  assert.equal(status.confirmedCount, 0);
});

test('sent-verified confirm then clear leaves confirmedCount unchanged', async (t) => {
  const { cli } = await fixture(t, 'clear-keeps-count');
  const { roundId } = cli(['round', 'start', '--stdin'], { requestedCount: 30 });
  const recorded = recordVerifiedOutreach(cli, { id: 'noon', company: 'Noon', domain: 'noon.com' });
  assert.equal(recorded.roundConfirmation.counted, true);
  const before = cli(['round', 'status', roundId]);
  assert.equal(before.confirmedCount, 1);
  assert.equal(before.outreachConfirmationCount, 1);
  cli(['outreach', 'clear', '--stdin'], { operationId: 'clear-noon', ids: ['noon'] });
  const after = cli(['round', 'status', roundId]);
  assert.equal(after.confirmedCount, before.confirmedCount);
  assert.equal(after.outreachConfirmationCount, 1);
  assert.equal(after.applyConfirmationCount, 0);
});

test('explicit confirm rejects moving an attached outreach to another round', async (t) => {
  const { cli } = await fixture(t, 'no-reassign');
  const first = cli(['round', 'start', '--stdin'], { requestedCount: 30 });
  recordVerifiedOutreach(cli, { id: 'noon', company: 'Noon', domain: 'noon.com' });
  const second = cli(['round', 'start', '--stdin'], { requestedCount: 30 });
  assert.throws(
    () => cli(['round', 'confirm', '--stdin'], { roundId: second.roundId, outreachId: 'noon' }),
    /already attached to another round/,
  );
  assert.equal(cli(['round', 'status', first.roundId]).confirmedCount, 1);
  assert.equal(cli(['round', 'status', second.roundId]).confirmedCount, 0);
});

test('auto-attach reconciles authenticated cloud rounds before choosing a destination', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'outreach-round-reconcile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const started = { type: 'started', roundId: 'cloud-round', requestedCount: 30, occurredAt: '2026-09-14T10:00:00.000Z' };
  const reconcileCalls = [];
  const cloudClient = {
    configured: async () => true,
    status: async () => ({ configured: true, capabilities: ['outreach-tracking-v1'] }),
    request: async () => ({ json: async () => ({ items: [verifiedItem('noon', 'Noon')] }) }),
    reconcile: async (options) => {
      reconcileCalls.push(options);
      await writeFile(join(directory, 'rounds.ndjson'), `${JSON.stringify(started)}\n`);
    },
    appendRecord: async () => {},
  };
  const result = await confirmOutreachTowardRound({
    directory,
    outreachId: 'noon',
    cloudClient,
    occurredAt: '2026-09-14T11:00:00.000Z',
  });
  assert.deepEqual(reconcileCalls, [{ dryRun: false, provenance: 'outreach-round-attach', streams: ['rounds'] }]);
  assert.equal(result.counted, true);
  assert.equal(result.roundId, 'cloud-round');
  assert.equal(result.company, 'Noon');
});

test('unmigrated outreach backend is an empty verified set', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'outreach-round-unmigrated-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missingCapability = await loadSentVerifiedOutreach(directory, {
    configured: async () => true,
    status: async () => ({ configured: true, capabilities: ['application-accounting-v1'] }),
    request: async () => {
      throw new Error('Cloud state request failed (409): Outreach backend migration required');
    },
  });
  assert.deepEqual(missingCapability, []);
  const migrationConflict = await loadSentVerifiedOutreach(directory, {
    configured: async () => true,
    status: async () => ({ configured: true, capabilities: ['application-accounting-v1', 'outreach-tracking-v1'] }),
    request: async () => {
      throw new Error('Cloud state request failed (409): Outreach backend migration required');
    },
  });
  assert.deepEqual(migrationConflict, []);
});

test('local outreach read failures stay visible to round status', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'outreach-round-locked-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'outreach.lock'), 'stale-lock');
  await assert.rejects(
    () => loadSentVerifiedOutreach(directory, { configured: async () => false }),
    /Outreach store is unavailable/,
  );
});

test('round attachment failure does not disguise a committed send', async (t) => {
  const { directory, cli } = await fixture(t, 'attachment-failed');
  const { roundId } = cli(['round', 'start', '--stdin'], { requestedCount: 30 });
  await writeFile(join(directory, 'rounds.ndjson'), `${JSON.stringify({ type: 'started', roundId, requestedCount: 30, occurredAt: '2026-09-14T10:00:00.000Z' })}\nnot-json\n`);
  const recorded = recordVerifiedOutreach(cli, { id: 'noon', company: 'Noon', domain: 'noon.com' });
  assert.equal(recorded.delivery, 'sent-verified');
  assert.equal(recorded.roundConfirmation.counted, false);
  assert.equal(recorded.roundConfirmation.reason, 'attachment-failed');
});
