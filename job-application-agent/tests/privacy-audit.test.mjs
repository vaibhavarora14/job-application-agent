import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareTelemetryInput } from '../scripts/telemetry-client.mjs';
import { validateEvent } from '../scripts/telemetry-schema.mjs';

const forbiddenProperties = [
  'name', 'email', 'phone', 'exactAddress', 'linkedin', 'github', 'portfolio', 'candidateLocation',
  'workAuthorization', 'personalCompensation', 'resume', 'resumeFilename', 'resumeHash', 'prompt',
  'agentResponse', 'jobDescription', 'formQuestion', 'draftedAnswer', 'note', 'password', 'mfa',
  'captcha', 'legalAnswer', 'demographicAnswer', 'browserData', 'ipAddress', 'requestHeaders',
  'userAgent', 'rawError',
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
