import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { prepareTelemetryInput, TelemetryClient } from '../scripts/telemetry-client.mjs';
import { createTelemetryEnvelope, sanitizeTelemetryErrorMessage, validateEvent } from '../scripts/telemetry-schema.mjs';
import { createCommunityJobContributionEnvelope, normalizeCommunityJob, normalizeCommunitySource } from '../scripts/source-community-schema.mjs';

const forbiddenProperties = [
  'name', 'email', 'phone', 'exactAddress', 'linkedin', 'github', 'portfolio', 'candidateLocation',
  'workAuthorization', 'personalCompensation', 'resume', 'resumeFilename', 'resumeHash', 'prompt',
  'agentResponse', 'jobDescription', 'formQuestion', 'draftedAnswer', 'note', 'password', 'mfa',
  'captcha', 'legalAnswer', 'demographicAnswer', 'browserData', 'ipAddress', 'requestHeaders',
  'userAgent', 'rawError', 'candidateName', 'candidateEmail',
  'recipient', 'recipientAccount', 'message', 'sentText', 'claimRefs', 'evidence',
  'outreachId', 'opportunityId', 'companyFingerprint', 'recipientFingerprint',
];

const PII_PATTERNS = [
  /candidate@example\.com/i,
  /Test Candidate/i,
  /\+91[\s-]?98765[\s-]?43210/,
  /9876543210/,
  /Lorem ipsum dolor sit amet.*resume/i,
  /curriculum vitae/i,
];

test('privacy audit rejects every prohibited free-form or identity property', () => {
  const base = { command: 'search', result: 'success', durationBucket: 'under-1s' };
  for (const property of forbiddenProperties) {
    assert.throws(() => validateEvent({ event: 'command_completed', properties: { ...base, [property]: 'private-value' } }), /unknown/i, property);
  }
});

test('privacy audit rejects identity-like company and title values', () => {
  const base = { jobHash: 'a'.repeat(64), domain: 'jobs.example.com', ats: 'greenhouse', fitScore: 80, eligibility: 'eligible', decision: 'review', matchTags: [], gapTags: [] };
  for (const company of ['candidate@example.com', '+91 98765 43210', 'https://linkedin.com/in/candidate']) {
    assert.throws(() => validateEvent({ event: 'job_assessed', properties: { ...base, company, title: 'Staff Engineer' } }), /identity/i);
  }
});

test('privacy audit strips the full query and fragment before job URL hashing', async () => {
  const safe = await prepareTelemetryInput({
    event: 'application_started',
    properties: {
      jobUrl: 'https://jobs.example.com/role/123?email=candidate@example.com&token=secret#private',
      ats: 'ashby', approvalMode: 'routine-auto', requiredFieldCount: 12, resumeRequired: true,
      coverLetterRequired: false, referralPresent: false,
    },
  });
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes('candidate@example.com'), false);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('jobs.example.com/role/123'), false);
});

test('privacy audit strips identity-bearing source parameters and rejects personal source metadata', () => {
  const source = normalizeCommunitySource({
    name: 'Example Engineering Board',
    baseUrl: 'https://jobs.example.org/openings/engineering?email=candidate@example.com&token=secret#private',
    kind: 'job-board',
    regions: ['global'],
    roleFamilies: ['engineering'],
    requiresSession: false,
  });
  assert.equal(source.baseUrl, 'https://jobs.example.org/openings/engineering');
  assert.equal(JSON.stringify(source).includes('candidate@example.com'), false);
  assert.throws(() => normalizeCommunitySource({ ...source, name: 'candidate@example.com' }), /identity/i);
  assert.throws(() => normalizeCommunitySource({ ...source, baseUrl: 'https://linkedin.com/in/candidate' }), /profile or personal/i);
});

test('privacy audit permits only sanitized public fields in community jobs', () => {
  const job = normalizeCommunityJob({
    url: 'https://jobs.ashbyhq.com/example/12345678-1234-4123-8123-123456789abc?email=candidate@example.com&token=secret#private',
    company: 'Example',
    role: 'Senior Product Engineer',
    applicationChannel: 'ashby',
    discoverySource: 'job-board',
  });
  const envelope = createCommunityJobContributionEnvelope({
    installationId: '11111111-1111-4111-8111-111111111111',
    token: 'anonymous-relay-token',
    skillVersion: '3.2.0',
    job,
  });
  const serialized = JSON.stringify(envelope.job);
  assert.equal(serialized.includes('candidate@example.com'), false);
  assert.equal(serialized.includes('secret'), false);
  assert.deepEqual(Object.keys(envelope.job).sort(), ['applicationChannel', 'company', 'discoverySource', 'providerUrl', 'role', 'url']);
  assert.throws(() => normalizeCommunityJob({ ...job, answers: { private: true } }), /unknown/i);
  assert.throws(() => normalizeCommunityJob({ ...job, company: 'candidate@example.com' }), /identity/i);
  assert.throws(() => normalizeCommunityJob({ ...job, url: 'https://linkedin.com/in/candidate' }), /personal/i);
});

test('no telemetry event payload may contain name, email, phone, or résumé text', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'privacy-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const captured = [];
  const client = new TelemetryClient({
    stateDir: directory,
    endpoint: 'https://relay.example.com',
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      captured.push({ url, body });
      if (String(url).endsWith('/v1/install')) {
        return Response.json({ installationId: '11111111-1111-4111-8111-111111111111', token: 'relay-token', expiresAt: '2099-01-01T00:00:00.000Z' });
      }
      return Response.json({ accepted: true }, { status: 202 });
    },
    stderr: () => {},
    readIdentity: () => ({ name: 'Test Candidate', email: 'candidate@example.com', phone: '+91 98765 43210' }),
  });
  const session = await client.beginCommand('apply');
  const samples = [
    { event: 'installation_started', properties: { osFamily: 'macos', nodeMajor: 24, submissionMode: 'unconfigured' } },
    { event: 'command_completed', properties: { command: 'apply', result: 'success', durationBucket: '1-5s' } },
    { event: 'application_started', properties: { jobHash: 'a'.repeat(64), ats: 'greenhouse', approvalMode: 'routine-auto', requiredFieldCount: 4, resumeRequired: true, coverLetterRequired: false, referralPresent: false } },
    { event: 'application_skipped', properties: { jobHash: 'a'.repeat(64), reason: 'low-fit', fitScore: 40, eligibility: 'eligible' } },
    { event: 'application_submitted', properties: { company: 'Example', title: 'Engineer', jobHash: 'a'.repeat(64), domain: 'jobs.example.com', ats: 'greenhouse', durationBucket: '2-5m', fieldsFilled: 8, shortAnswerCount: 1, resumeUploaded: true, approvalMode: 'routine-auto', telemetrySupplied: true, thinSubmissionOverrideUsed: false } },
    { event: 'skill_error', properties: { errorCode: 'invalid_input', stage: 'contact', recoverable: true, errorCategory: 'validation', sanitizedMessage: sanitizeTelemetryErrorMessage('profile.email must be valid; got candidate@example.com and https://evil.example/a?q=1'), fieldLabel: 'profile.email' } },
  ];
  for (const sample of samples) {
    const validated = validateEvent(sample);
    assert.throws(() => createTelemetryEnvelope({
      installationId: '11111111-1111-4111-8111-111111111111',
      token: 'relay-token',
      event: validated,
      skillVersion: '3.7.5',
      identity: { name: 'Test Candidate', email: 'candidate@example.com' },
    }), /identity/i);
    const envelope = createTelemetryEnvelope({
      installationId: '11111111-1111-4111-8111-111111111111',
      token: 'relay-token',
      event: validated,
      skillVersion: '3.7.5',
    });
    const serialized = JSON.stringify({ validated, envelope });
    for (const pattern of PII_PATTERNS) assert.equal(pattern.test(serialized), false, `${sample.event} leaked ${pattern}`);
    assert.equal((await client.record(sample, session)).sent, true);
  }
  const wire = JSON.stringify(captured);
  for (const pattern of PII_PATTERNS) assert.equal(pattern.test(wire), false, `wire payload leaked ${pattern}`);
  assert.equal(wire.includes('candidateName'), false);
  assert.equal(wire.includes('candidateEmail'), false);
  assert.ok(captured.every(({ body }) => body?.identity === undefined || !('identity' in (body ?? {}))));
});

test('job-board saved searches store only the declared alert fields and say so', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const schema = readFileSync(join(root, 'site/lib/job-alerts-store.mjs'), 'utf8');
  const migration = readFileSync(join(root, 'site/drizzle/0007_saved_searches.sql'), 'utf8');
  for (const source of [schema, migration]) {
    for (const column of ['email', 'filter_query', 'cadence', 'confirm_token_hash', 'unsubscribe_token', 'last_sent_at', 'watermark_at']) {
      assert.match(source, new RegExp(column));
    }
    assert.doesNotMatch(source, /user_agent|ip_address|phone|resume/i);
  }
  const mail = readFileSync(join(root, 'site/lib/job-alerts-mail.mjs'), 'utf8');
  const alerts = readFileSync(join(root, 'site/lib/job-alerts.mjs'), 'utf8');
  assert.doesNotMatch(mail, /<img|telemetry-client|posthog/i);
  assert.doesNotMatch(alerts, /telemetry-client|<img/i);
  const phrases = [
    'filter query',
    'daily or weekly',
    'confirmation token hash',
    'unsubscribe token',
    'watermark',
    'confirmation email',
    'Unsubscribing deletes that saved search',
    '7 days',
    'no tracking pixels',
  ];
  for (const relative of ['site/app/privacy/page.tsx', 'README.md', 'plugins/job-application-agent/PRIVACY.md']) {
    const text = readFileSync(join(root, relative), 'utf8');
    for (const phrase of phrases) assert.match(text, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${relative} missing ${phrase}`);
  }
});
