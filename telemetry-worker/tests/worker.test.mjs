import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { createToken, verifyToken } from '../src/worker.mjs';

function env() {
  const captured = [];
  const sourceRateLimitKeys = [];
  const communitySources = new Map();
  const contributorHashes = new Map();
  return {
    SIGNING_SECRET: 'test-signing-secret-with-sufficient-length',
    POSTHOG_PROJECT_TOKEN: 'phc_test',
    POSTHOG_HOST: 'https://us.i.posthog.com',
    INSTALL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    EVENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SOURCE_RATE_LIMITER: { limit: async ({ key }) => { sourceRateLimitKeys.push(key); return { success: true }; } },
    SOURCE_STORE: {
      async contribute(source, contributorHash) {
        const current = communitySources.get(source.sourceId) ?? {
          ...source,
          publicationStatus: 'pending',
          reviewStatus: 'unreviewed',
        };
        communitySources.set(source.sourceId, current);
        const hashes = contributorHashes.get(source.sourceId) ?? new Set();
        hashes.add(contributorHash);
        contributorHashes.set(source.sourceId, hashes);
        return { publicationStatus: current.publicationStatus, uniqueContributors: hashes.size };
      },
      async listPublished() {
        return [...communitySources.values()]
          .filter((source) => source.publicationStatus === 'published' && source.reviewStatus === 'maintainer-reviewed')
          .map((source) => ({
            sourceId: source.sourceId,
            name: source.name,
            baseUrl: source.baseUrl,
            kind: source.kind,
            regions: source.regions,
            roleFamilies: source.roleFamilies,
            requiresSession: source.requiresSession,
            registryStatus: source.reviewStatus === 'maintainer-reviewed' ? 'community-reviewed' : 'community-unreviewed',
            contributionCount: contributorHashes.get(source.sourceId)?.size ?? 0,
          }));
      },
    },
    POSTHOG_FETCH: async (url, options) => {
      captured.push({ url, options, body: JSON.parse(options.body) });
      return new Response('{}', { status: 200 });
    },
    captured,
    communitySources,
    contributorHashes,
    sourceRateLimitKeys,
  };
}

async function contribution(bindings, installationId, source, token = null) {
  const credential = token ?? await createToken(installationId, bindings.SIGNING_SECRET);
  return worker.fetch(new Request('https://relay.example.com/v1/sources', {
    method: 'POST',
    body: JSON.stringify({ schemaVersion: 1, skillVersion: '3.1.1', installationId, token: credential, source }),
  }), bindings);
}

test('any number of newly minted systems leaves a sanitized source pending while repeat submissions count once', async () => {
  const bindings = env();
  const installationId = '11111111-1111-4111-8111-111111111111';
  const secondInstallationId = '22222222-2222-4222-8222-222222222222';
  const token = await createToken(installationId, bindings.SIGNING_SECRET);
  const secondToken = await createToken(secondInstallationId, bindings.SIGNING_SECRET);
  const contribution = {
    schemaVersion: 1,
    skillVersion: '3.1.1',
    installationId,
    token,
    source: {
      name: 'Example Engineering Board',
      baseUrl: 'https://jobs.example.org/openings/engineering?ref=private#jobs',
      kind: 'job-board',
      regions: ['global'],
      roleFamilies: ['engineering'],
      requiresSession: false,
    },
  };

  const first = await worker.fetch(new Request('https://relay.example.com/v1/sources', { method: 'POST', body: JSON.stringify(contribution) }), bindings);
  const repeated = await worker.fetch(new Request('https://relay.example.com/v1/sources', { method: 'POST', body: JSON.stringify(contribution) }), bindings);
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  assert.equal(firstBody.accepted, true);
  assert.match(firstBody.sourceId, /^community-[0-9a-f]{16}$/);
  assert.equal(firstBody.publicationStatus, 'pending');
  assert.equal(firstBody.uniqueContributors, 1);
  assert.equal((await repeated.json()).uniqueContributors, 1);

  const pendingList = await worker.fetch(new Request('https://relay.example.com/v1/sources'), bindings);
  assert.deepEqual((await pendingList.json()).sources, []);

  const second = await worker.fetch(new Request('https://relay.example.com/v1/sources', {
    method: 'POST',
    body: JSON.stringify({ ...contribution, installationId: secondInstallationId, token: secondToken }),
  }), bindings);
  const secondBody = await second.json();
  assert.equal(secondBody.publicationStatus, 'pending');
  assert.equal(secondBody.uniqueContributors, 2);

  const listed = await worker.fetch(new Request('https://relay.example.com/v1/sources'), bindings);
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.deepEqual(body.sources, []);
  assert.equal(JSON.stringify(body).includes(installationId), false);
  assert.equal(JSON.stringify(body).includes(secondInstallationId), false);
  assert.equal(JSON.stringify(body).includes([...bindings.contributorHashes.values()][0].values().next().value), false);
  assert.equal(JSON.stringify(body).includes('private'), false);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
});

test('source writes use an endpoint-wide limiter before the installation limiter', async () => {
  const bindings = env();
  const installationId = '11111111-1111-4111-8111-111111111111';
  const source = {
    name: 'Rate Limited Board', baseUrl: 'https://limit.example.com/openings', kind: 'job-board',
    regions: ['global'], roleFamilies: ['engineering'], requiresSession: false,
  };
  assert.equal((await contribution(bindings, installationId, source)).status, 202);
  assert.deepEqual(bindings.sourceRateLimitKeys, ['source-write', installationId]);

  const blocked = env();
  blocked.SOURCE_RATE_LIMITER = { limit: async ({ key }) => ({ success: key !== 'source-write' }) };
  assert.equal((await contribution(blocked, installationId, source)).status, 429);
  assert.equal(blocked.communitySources.size, 0);
});

test('only maintainer-reviewed sources become public while rejected sources never republish automatically', async () => {
  const approvedBindings = env();
  const source = {
    name: 'Maintainer Approved Board',
    baseUrl: 'https://approved.example.com/openings',
    kind: 'job-board',
    regions: ['global'],
    roleFamilies: ['engineering'],
    requiresSession: false,
  };
  const approvedResponse = await contribution(approvedBindings, '11111111-1111-4111-8111-111111111111', source);
  const approvedId = (await approvedResponse.json()).sourceId;
  Object.assign(approvedBindings.communitySources.get(approvedId), {
    publicationStatus: 'published',
    reviewStatus: 'unreviewed',
  });
  assert.deepEqual((await (await worker.fetch(new Request('https://relay.example.com/v1/sources'), approvedBindings)).json()).sources, []);
  Object.assign(approvedBindings.communitySources.get(approvedId), {
    publicationStatus: 'published',
    reviewStatus: 'maintainer-reviewed',
  });
  const approvedList = await worker.fetch(new Request('https://relay.example.com/v1/sources'), approvedBindings);
  const [approved] = (await approvedList.json()).sources;
  assert.equal(approved.registryStatus, 'community-reviewed');
  assert.equal(approved.contributionCount, 1);

  const rejectedBindings = env();
  const rejectedResponse = await contribution(rejectedBindings, '11111111-1111-4111-8111-111111111111', {
    ...source,
    name: 'Rejected Board',
    baseUrl: 'https://rejected.example.com/openings',
  });
  const rejectedId = (await rejectedResponse.json()).sourceId;
  Object.assign(rejectedBindings.communitySources.get(rejectedId), {
    publicationStatus: 'rejected',
    reviewStatus: 'maintainer-reviewed',
  });
  const retried = await contribution(rejectedBindings, '22222222-2222-4222-8222-222222222222', {
    ...source,
    name: 'Later Rewrite Attempt',
    baseUrl: 'https://rejected.example.com/openings',
  });
  assert.equal((await retried.json()).publicationStatus, 'rejected');
  assert.deepEqual((await (await worker.fetch(new Request('https://relay.example.com/v1/sources'), rejectedBindings)).json()).sources, []);
});

test('first valid metadata wins and contributor hashes are source-scoped and never public', async () => {
  const bindings = env();
  const firstInstallation = '11111111-1111-4111-8111-111111111111';
  const secondInstallation = '22222222-2222-4222-8222-222222222222';
  const original = {
    name: 'Original Board Name',
    baseUrl: 'https://metadata.example.com/careers',
    kind: 'job-board',
    regions: ['global'],
    roleFamilies: ['engineering'],
    requiresSession: false,
  };
  const firstResponse = await contribution(bindings, firstInstallation, original);
  const sourceId = (await firstResponse.json()).sourceId;
  await contribution(bindings, secondInstallation, {
    ...original,
    name: 'Untrusted Rewrite',
    kind: 'social-feed',
    regions: ['private-region'],
    roleFamilies: ['sales'],
    requiresSession: true,
  });

  Object.assign(bindings.communitySources.get(sourceId), {
    publicationStatus: 'published',
    reviewStatus: 'maintainer-reviewed',
  });

  const body = await (await worker.fetch(new Request('https://relay.example.com/v1/sources'), bindings)).json();
  assert.equal(body.sources[0].name, original.name);
  assert.equal(body.sources[0].kind, original.kind);
  assert.deepEqual(body.sources[0].regions, original.regions);
  assert.deepEqual(body.sources[0].roleFamilies, original.roleFamilies);
  assert.equal(body.sources[0].requiresSession, false);

  await contribution(bindings, firstInstallation, { ...original, baseUrl: 'https://second.example.com/job-index' });
  const firstHash = [...bindings.contributorHashes.get(sourceId)][0];
  const secondSourceId = [...bindings.contributorHashes.keys()].find((id) => id !== sourceId);
  const secondHash = [...bindings.contributorHashes.get(secondSourceId)][0];
  assert.match(firstHash, /^[0-9a-f]{64}$/);
  assert.notEqual(firstHash, secondHash);
  assert.equal(JSON.stringify(body).includes(firstHash), false);
  assert.equal(JSON.stringify(body).includes(firstInstallation), false);
  assert.equal(JSON.stringify(body).includes('publicationStatus'), false);
  assert.equal(JSON.stringify(body).includes('reviewStatus'), false);
});

test('source contribution endpoint independently rejects identity, one-off jobs, bad tokens, and rate limits', async () => {
  const bindings = env();
  const installationId = '11111111-1111-4111-8111-111111111111';
  const token = await createToken(installationId, bindings.SIGNING_SECRET);
  const base = {
    schemaVersion: 1,
    skillVersion: '3.1.1',
    installationId,
    token,
    source: { name: 'Example Board', baseUrl: 'https://jobs.example.org/openings/engineering', kind: 'job-board', regions: ['global'], roleFamilies: ['engineering'], requiresSession: false },
  };
  const personal = await worker.fetch(new Request('https://relay.example.com/v1/sources', { method: 'POST', body: JSON.stringify({ ...base, source: { ...base.source, baseUrl: 'https://linkedin.com/in/person' } }) }), bindings);
  assert.equal(personal.status, 400);
  const oneOff = await worker.fetch(new Request('https://relay.example.com/v1/sources', { method: 'POST', body: JSON.stringify({ ...base, source: { ...base.source, baseUrl: 'https://jobs.example.org/jobs/987654' } }) }), bindings);
  assert.equal(oneOff.status, 400);
  const badToken = await worker.fetch(new Request('https://relay.example.com/v1/sources', { method: 'POST', body: JSON.stringify({ ...base, token: `${token}x` }) }), bindings);
  assert.equal(badToken.status, 401);
  bindings.SOURCE_RATE_LIMITER = { limit: async () => ({ success: false }) };
  const limited = await worker.fetch(new Request('https://relay.example.com/v1/sources', { method: 'POST', body: JSON.stringify(base) }), bindings);
  assert.equal(limited.status, 429);
});

test('health endpoint exposes no analytics or identity data', async () => {
  const response = await worker.fetch(new Request('https://relay.example.com/healthz'), env());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, schemaVersion: 1 });
});

test('legacy dashboard root redirects to the branded community domain', async () => {
  const response = await worker.fetch(new Request('https://relay.example.com/'), env());
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://stats.jobappagent.com/');
});

test('install issues a signed anonymous identity and supports verified refresh', async () => {
  const bindings = env();
  const first = await worker.fetch(new Request('https://relay.example.com/v1/install', { method: 'POST', body: '{}' }), bindings);
  assert.equal(first.status, 201);
  const identity = await first.json();
  assert.match(identity.installationId, /^[0-9a-f-]{36}$/);
  assert.equal((await verifyToken(identity.token, bindings.SIGNING_SECRET)).installationId, identity.installationId);

  const refresh = await worker.fetch(new Request('https://relay.example.com/v1/install', { method: 'POST', body: JSON.stringify({ installationId: identity.installationId, token: identity.token }) }), bindings);
  assert.equal((await refresh.json()).installationId, identity.installationId);
});

test('install refreshes an expired valid token without changing the installation ID', async () => {
  const bindings = env();
  const installationId = '11111111-1111-4111-8111-111111111111';
  const expired = await createToken(installationId, bindings.SIGNING_SECRET, new Date('2026-01-01T00:00:00Z'), -1);
  const refresh = await worker.fetch(new Request('https://relay.example.com/v1/install', { method: 'POST', body: JSON.stringify({ installationId, token: expired }) }), bindings);
  assert.equal(refresh.status, 201);
  assert.equal((await refresh.json()).installationId, installationId);
});

test('install rejects undocumented properties', async () => {
  const response = await worker.fetch(new Request('https://relay.example.com/v1/install', { method: 'POST', body: JSON.stringify({ profile: 'private' }) }), env());
  assert.equal(response.status, 400);
});

test('token verification rejects tampering and expiry', async () => {
  const token = await createToken('11111111-1111-4111-8111-111111111111', 'secret-secret-secret-secret', new Date('2026-01-01T00:00:00Z'), 60);
  await assert.rejects(() => verifyToken(`${token}x`, 'secret-secret-secret-secret', new Date('2026-01-01T00:00:01Z')), /token/i);
  await assert.rejects(() => verifyToken(token, 'secret-secret-secret-secret', new Date('2026-01-01T00:02:00Z')), /expired/i);
});

test('event endpoint revalidates schema and forwards a personless PostHog event', async () => {
  const bindings = env();
  const installationId = '11111111-1111-4111-8111-111111111111';
  const token = await createToken(installationId, bindings.SIGNING_SECRET);
  const payload = {
    schemaVersion: 1,
    skillVersion: '1.1.0',
    installationId,
    token,
    event: 'application_submitted',
    properties: {
      company: 'Example AI', title: 'Staff Engineer', jobHash: 'a'.repeat(64), domain: 'jobs.example.com', ats: 'greenhouse', durationBucket: '5-15m', fieldsFilled: 12,
      shortAnswerCount: 2, resumeUploaded: true, approvalMode: 'routine-auto',
    },
  };
  const response = await worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'private-agent' }, body: JSON.stringify(payload) }), bindings);
  assert.equal(response.status, 202);
  assert.equal(bindings.captured.length, 1);
  assert.equal(bindings.captured[0].body.properties.$process_person_profile, false);
  assert.equal(bindings.captured[0].body.properties.$geoip_disable, true);
  assert.equal(bindings.captured[0].body.distinct_id, installationId);
  assert.equal(JSON.stringify(bindings.captured[0]).includes('private-agent'), false);
  assert.equal(bindings.captured[0].body.timestamp != null, true);
});

test('event endpoint rejects identity fields, malformed payloads, and rate limits', async () => {
  const bindings = env();
  const installationId = '11111111-1111-4111-8111-111111111111';
  const token = await createToken(installationId, bindings.SIGNING_SECRET);
  const base = { schemaVersion: 1, skillVersion: '1.1.0', installationId, token, event: 'command_completed', properties: { command: 'search', result: 'success', durationBucket: 'under-1s' } };
  const identity = await worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', body: JSON.stringify({ ...base, properties: { ...base.properties, email: 'candidate@example.com' } }) }), bindings);
  assert.equal(identity.status, 400);
  const oversized = await worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', body: JSON.stringify({ ...base, padding: 'x'.repeat(5000) }) }), bindings);
  assert.equal(oversized.status, 413);
  bindings.EVENT_RATE_LIMITER = { limit: async () => ({ success: false }) };
  const limited = await worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', body: JSON.stringify(base) }), bindings);
  assert.equal(limited.status, 429);
});

test('PostHog failures return a retryable relay error without leaking details', async () => {
  const bindings = env();
  bindings.POSTHOG_FETCH = async () => { throw new Error('upstream secret detail'); };
  const installationId = '11111111-1111-4111-8111-111111111111';
  const token = await createToken(installationId, bindings.SIGNING_SECRET);
  const payload = { schemaVersion: 1, skillVersion: '1.1.0', installationId, token, event: 'command_completed', properties: { command: 'search', result: 'success', durationBucket: 'under-1s' } };
  const response = await worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', body: JSON.stringify(payload) }), bindings);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'upstream_unavailable' });
});
