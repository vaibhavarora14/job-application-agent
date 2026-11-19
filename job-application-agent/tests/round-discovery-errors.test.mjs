import assert from 'node:assert/strict';
import test from 'node:test';

import { validateLead } from '../scripts/application-accounting.mjs';
import {
  knownDiscoverySourceId,
  normalizeRoundStartInput,
  normalizeSourceCoverage,
  skillErrorProperties,
  suggestDiscoverySourceIds,
} from '../scripts/job-application.mjs';

test('lead.sourceId "linkedin" suggests linkedin-jobs-feed and points at sources list (#296)', () => {
  assert.throws(
    () => knownDiscoverySourceId('linkedin', 'lead.sourceId'),
    (error) => {
      assert.match(error.message, /^lead\.sourceId must match a packaged or community source ID\./);
      assert.match(error.message, /Did you mean linkedin-jobs-feed/);
      assert.match(error.message, /Run `sources list` for all ids\./);
      const props = skillErrorProperties(error, 'round');
      assert.equal(props.errorCode, 'invalid_input');
      assert.equal(props.fieldLabel, 'lead.sourceId');
      return true;
    },
  );
  assert.ok(suggestDiscoverySourceIds('linkedin').includes('linkedin-jobs-feed'));
  assert.equal(knownDiscoverySourceId('linkedin-jobs-feed', 'lead.sourceId'), 'linkedin-jobs-feed');
  assert.equal(knownDiscoverySourceId('community-jobs-feed', 'coverage.sourceId'), 'community-jobs-feed');
  assert.equal(knownDiscoverySourceId('community-0123456789abcdef', 'lead.sourceId'), 'community-0123456789abcdef');
});

test('round source folds query and notes into evidence and lists allowed keys (#296)', () => {
  const fromQuery = normalizeSourceCoverage({
    roundId: 'round-1',
    sourceId: 'indeed',
    status: 'searched',
    query: 'senior product engineer remote',
  });
  assert.equal(fromQuery.evidence, 'senior product engineer remote');

  const combined = normalizeSourceCoverage({
    roundId: 'round-1',
    sourceId: 'indeed',
    status: 'searched',
    evidence: 'Reviewed current listings.',
    query: 'staff engineer india remote',
    notes: 'No visa-sponsored roles.',
  });
  assert.equal(combined.evidence, 'Reviewed current listings.\nstaff engineer india remote\nNo visa-sponsored roles.');

  assert.throws(
    () => normalizeSourceCoverage({
      roundId: 'round-1',
      sourceId: 'indeed',
      status: 'searched',
      evidence: 'e'.repeat(1990),
      query: 'q'.repeat(20),
    }),
    (error) => {
      assert.match(error.message, /coverage\.evidence, query, and notes together must be no longer than 2000 characters/);
      assert.match(error.message, /nothing was recorded/);
      assert.doesNotMatch(error.message, /e{10,}/);
      const props = skillErrorProperties(error, 'round');
      assert.equal(props.errorCode, 'invalid_input');
      return true;
    },
  );

  assert.throws(
    () => normalizeSourceCoverage({
      roundId: 'round-1',
      sourceId: 'indeed',
      status: 'searched',
      evidence: 'Reviewed current listings.',
      discoverySource: 'linkedin',
    }),
    (error) => {
      assert.match(error.message, /^Unknown source coverage property: discoverySource\. Allowed: /);
      for (const key of ['roundId', 'sourceId', 'status', 'evidence', 'query', 'notes', 'applicationIds', 'blocker']) {
        assert.match(error.message, new RegExp(`\\b${key}\\b`));
      }
      return true;
    },
  );
});

test('round start with roundId or id explains how to resume (#296)', () => {
  const started = normalizeRoundStartInput({ requestedCount: 8, startedAt: '2026-11-19T12:00:00Z' });
  assert.equal(started.requestedCount, 8);
  assert.equal(started.startedAt, '2026-11-19T12:00:00Z');

  assert.throws(
    () => normalizeRoundStartInput({ requestedCount: 8, roundId: 'round-already-started' }),
    /round start creates a new round and returns its id; to continue an existing round use `round status <round-id>`\. Allowed: requestedCount, startedAt\./,
  );
  assert.throws(
    () => normalizeRoundStartInput({ requestedCount: 8, id: 'round-already-started' }),
    /round start creates a new round and returns its id/,
  );
  assert.throws(
    () => normalizeRoundStartInput({ requestedCount: 8, discoverySource: 'linkedin' }),
    /Unknown round property: discoverySource\. Allowed: requestedCount, startedAt\./,
  );
});

test('unknown lead fields list the allowed accounting keys (#296)', () => {
  assert.throws(
    () => validateLead({
      roundId: 'round-1',
      sourceId: 'indeed',
      url: 'https://example.com/jobs/123',
      company: 'Example',
      disposition: 'qualified',
      evidence: 'Active posting.',
      notes: 'put this on evidence',
    }),
    /Unknown accounting field: notes\. Allowed: version, type, id, roundId, sourceId, url, company, role, employerJobId, disposition, observedAt, evidence, applicationId, supersedes\./,
  );
});
