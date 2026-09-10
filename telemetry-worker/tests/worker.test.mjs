import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { createToken, verifyToken } from '../src/worker.mjs';

function env() {
  const captured = [];
  const sourceRateLimitKeys = [];
  const sourceReadRateLimitKeys = [];
  const communitySources = new Map();
  const contributorHashes = new Map();
  const communityJobs = new Map();
  const jobContributorHashes = new Map();
  return {
    SIGNING_SECRET: 'test-signing-secret-with-sufficient-length',
    POSTHOG_PROJECT_TOKEN: 'phc_test',
    POSTHOG_HOST: 'https://us.i.posthog.com',
    INSTALL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    EVENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SOURCE_RATE_LIMITER: { limit: async ({ key }) => { sourceRateLimitKeys.push(key); return { success: true }; } },
    SOURCE_READ_RATE_LIMITER: { limit: async ({ key }) => { sourceReadRateLimitKeys.push(key); return { success: true }; } },
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
    JOB_STORE: {
      async contribute(job, contributorHash) {
        const current = communityJobs.get(job.jobId) ?? { ...job, publicationStatus: 'pending', reviewStatus: 'unreviewed' };
        communityJobs.set(job.jobId, { ...current, lastSeenAt: job.lastSeenAt });
        const hashes = jobContributorHashes.get(job.jobId) ?? new Set();
        hashes.add(contributorHash);
        jobContributorHashes.set(job.jobId, hashes);
        return { publicationStatus: current.publicationStatus, contributionCount: hashes.size };
      },
      async list({ limit, cursor }) {
        const ordered = [...communityJobs.values()]
          .filter((job) => job.publicationStatus === 'published' && job.reviewStatus === 'maintainer-reviewed')
          .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || right.jobId.localeCompare(left.jobId));
        const start = cursor == null ? 0 : ordered.findIndex((job) => job.lastSeenAt < cursor.lastSeenAt || (job.lastSeenAt === cursor.lastSeenAt && job.jobId < cursor.jobId));
        const jobs = ordered.slice(Math.max(0, start), Math.max(0, start) + limit + 1).map((job) => ({ ...job, contributionCount: jobContributorHashes.get(job.jobId)?.size ?? 0 }));
        return { jobs: jobs.slice(0, limit), hasMore: jobs.length > limit };
      },
    },
    POSTHOG_FETCH: async (url, options) => {
      captured.push({ url, options, body: JSON.parse(options.body) });
      return new Response('{}', { status: 200 });
    },
    captured,
    communitySources,
    contributorHashes,
    communityJobs,
    jobContributorHashes,
    sourceRateLimitKeys,
    sourceReadRateLimitKeys,
  };
}

async function jobContribution(bindings, installationId, job, token = null) {
  const credential = token ?? await createToken(installationId, bindings.SIGNING_SECRET);
  return worker.fetch(new Request('https://relay.example.com/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ schemaVersion: 1, skillVersion: '3.2.0', installationId, token: credential, job }),
  }), bindings);
}

test('confirmed jobs are logged pending, deduplicated, and listed only after maintainer review', async () => {
  const bindings = env();
  const firstInstallation = '11111111-1111-4111-8111-111111111111';
  const secondInstallation = '22222222-2222-4222-8222-222222222222';
  const job = {
    url: 'https://jobs.ashbyhq.com/example/12345678-1234-4123-8123-123456789abc?ref=private#apply',
    company: 'Example',
    role: 'Senior Product Engineer',
    applicationChannel: 'ashby',
    discoverySource: 'job-board',
  };

  const first = await jobContribution(bindings, firstInstallation, job);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    accepted: true,
    jobId: await import('../../job-application-agent/scripts/source-community-schema.mjs').then(({ communityJobId }) => communityJobId(job)),
    publicationStatus: 'pending',
    contributionCount: 1,
  });
  assert.equal((await (await jobContribution(bindings, firstInstallation, job)).json()).contributionCount, 1);
  assert.equal((await (await jobContribution(bindings, secondInstallation, { ...job, company: 'Untrusted Rewrite' })).json()).contributionCount, 2);

  const listed = await worker.fetch(new Request('https://relay.example.com/v1/jobs?limit=1'), bindings);
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).jobs, []);
  const firstJobId = [...bindings.communityJobs.keys()][0];
  Object.assign(bindings.communityJobs.get(firstJobId), { publicationStatus: 'published', reviewStatus: 'maintainer-reviewed' });
  const body = await (await worker.fetch(new Request('https://relay.example.com/v1/jobs?limit=1'), bindings)).json();
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].company, 'Example');
  assert.equal(body.jobs[0].url.includes('private'), false);
  assert.equal(body.jobs[0].providerUrl, 'https://jobs.ashbyhq.com/example');
  assert.equal(body.jobs[0].contributionCount, 2);
  assert.match(body.jobs[0].firstSeenAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.match(body.jobs[0].lastSeenAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.equal(body.nextCursor, null);
  assert.equal(JSON.stringify(body).includes(firstInstallation), false);
  assert.equal(JSON.stringify(body).includes([...bindings.jobContributorHashes.values()][0].values().next().value), false);

  const secondJob = { ...job, url: 'https://job-boards.greenhouse.io/another/jobs/7654321', company: 'Another' };
  await jobContribution(bindings, firstInstallation, secondJob);
  const secondJobId = [...bindings.communityJobs.keys()].find((id) => id !== firstJobId);
  Object.assign(bindings.communityJobs.get(secondJobId), { publicationStatus: 'published', reviewStatus: 'maintainer-reviewed' });
  const firstPage = await (await worker.fetch(new Request('https://relay.example.com/v1/jobs?limit=1'), bindings)).json();
  assert.equal(firstPage.jobs.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await (await worker.fetch(new Request(`https://relay.example.com/v1/jobs?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`), bindings)).json();
  assert.equal(secondPage.jobs.length, 1);
  assert.notEqual(secondPage.jobs[0].jobId, firstPage.jobs[0].jobId);
});

test('community job endpoint rejects private payloads, invalid cursors, bad tokens, and rate limits', async () => {
  const bindings = env();
  const installationId = '11111111-1111-4111-8111-111111111111';
  const token = await createToken(installationId, bindings.SIGNING_SECRET);
  const job = { url: 'https://company.example/jobs/123', company: 'Example', role: 'Engineer', applicationChannel: 'company' };
  assert.equal((await jobContribution(bindings, installationId, { ...job, answers: { private: true } }, token)).status, 400);
  assert.equal((await jobContribution(bindings, installationId, { ...job, url: 'https://linkedin.com/in/person' }, token)).status, 400);
  assert.equal((await jobContribution(bindings, installationId, job, `${token}x`)).status, 401);
  assert.equal((await worker.fetch(new Request('https://relay.example.com/v1/jobs?cursor=not-valid'), bindings)).status, 400);
  bindings.SOURCE_RATE_LIMITER = { limit: async () => ({ success: false }) };
  assert.equal((await jobContribution(bindings, installationId, job, token)).status, 429);
});

test('community job reads rate-limit a secret-derived client bucket without retaining the address', async () => {
  const bindings = env();
  const response = await worker.fetch(new Request('https://relay.example.com/v1/jobs', {
    headers: { 'cf-connecting-ip': '203.0.113.42' },
  }), bindings);
  assert.equal(response.status, 200);
  assert.equal(bindings.sourceReadRateLimitKeys.length, 1);
  assert.match(bindings.sourceReadRateLimitKeys[0], /^jobs:[0-9a-f]{64}$/);
  assert.equal(bindings.sourceReadRateLimitKeys[0].includes('203.0.113.42'), false);
});

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

test('source reads use an independent high-capacity limiter before querying the registry', async () => {
  const bindings = env();
  const response = await worker.fetch(new Request('https://relay.example.com/v1/sources'), bindings);
  assert.equal(response.status, 200);
  assert.deepEqual(bindings.sourceRateLimitKeys, []);
  assert.deepEqual(bindings.sourceReadRateLimitKeys, ['registry']);

  const blocked = env();
  blocked.SOURCE_READ_RATE_LIMITER = { limit: async ({ key }) => ({ success: key !== 'registry' }) };
  blocked.SOURCE_STORE.listPublished = async () => { throw new Error('registry must not be queried'); };
  const limited = await worker.fetch(new Request('https://relay.example.com/v1/sources'), blocked);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'rate_limited' });
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

test('identity is validated and forwarded only to private analytics, never the aggregate store', async () => {
  const bindings = env();
  const stored = [];
  bindings.PUBLIC_STATS_DB = { prepare: (sql) => ({ bind: (...args) => ({ run: async () => { stored.push({ sql, args }); } }) }) };
  const installationId = '11111111-1111-4111-8111-111111111111';
  const token = await createToken(installationId, bindings.SIGNING_SECRET);
  const payload = { schemaVersion: 1, skillVersion: '3.3.0', installationId, token, event: 'installation_started', properties: { osFamily: 'macos', nodeMajor: 24, submissionMode: 'unconfigured' }, identity: { name: 'Test Candidate', email: 'candidate@example.com' } };
  const send = (body) => worker.fetch(new Request('https://relay.example.com/v1/events', { method: 'POST', body: JSON.stringify(body) }), bindings);
  assert.equal((await send(payload)).status, 202);
  assert.equal(bindings.captured[0].body.distinct_id, installationId);
  assert.equal(bindings.captured[0].body.properties.candidateName, 'Test Candidate');
  assert.equal(bindings.captured[0].body.properties.candidateEmail, 'candidate@example.com');
  assert.equal(bindings.captured[0].body.properties.$process_person_profile, false);
  assert.ok(stored.length > 0);
  assert.equal(JSON.stringify(stored).includes('Test Candidate'), false);
  assert.equal(JSON.stringify(stored).includes('candidate@example.com'), false);
  assert.equal((await send({ ...payload, identity: { ...payload.identity, phone: 'private' } })).status, 400);
  assert.equal((await send({ ...payload, identity: { email: 'invalid' } })).status, 400);
  assert.equal(bindings.captured.length, 1);
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
