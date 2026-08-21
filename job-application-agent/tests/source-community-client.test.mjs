import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SourceCommunityClient } from '../scripts/source-community-client.mjs';

const source = {
  name: 'Example Engineering Board',
  baseUrl: 'https://jobs.example.org/openings/engineering?ref=candidate@example.com#openings',
  kind: 'job-board',
  regions: ['global', 'remote'],
  roleFamilies: ['engineering'],
  requiresSession: false,
};

function relay() {
  const requests = [];
  const community = [{
    sourceId: 'community-abcdef1234567890',
    name: 'Example Engineering Board',
    baseUrl: 'https://jobs.example.org/openings/engineering',
    kind: 'job-board',
    regions: ['global', 'remote'],
    roleFamilies: ['engineering'],
    requiresSession: false,
    registryStatus: 'community-reviewed',
    contributionCount: 2,
  }];
  const fetch = async (url, options = {}) => {
    requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/v1/install')) return Response.json({ installationId: '11111111-1111-4111-8111-111111111111', token: 'source-token', expiresAt: '2099-01-01T00:00:00.000Z' }, { status: 201 });
    if (url.endsWith('/v1/sources') && options.method === 'POST') return Response.json({ accepted: true, sourceId: 'community-abcdef1234567890', publicationStatus: 'pending', uniqueContributors: 1 }, { status: 202 });
    return Response.json({ version: 1, sources: community });
  };
  return { fetch, requests };
}

test('source sharing is enabled by default, disclosed, sanitized, and sent immediately', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'source-community-default-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const network = relay();
  let notice = '';
  const client = new SourceCommunityClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: network.fetch, stderr: (value) => { notice += value; } });

  const result = await client.contribute(source);

  assert.deepEqual(result, { shared: true, sourceId: 'community-abcdef1234567890', publicationStatus: 'pending', uniqueContributors: 1 });
  assert.match(notice, /community source sharing is enabled by default/i);
  assert.equal(network.requests.length, 2);
  assert.equal(network.requests[1].url, 'https://relay.example.com/v1/sources');
  assert.equal(network.requests[1].body.source.baseUrl, 'https://jobs.example.org/openings/engineering');
  assert.equal(JSON.stringify(network.requests[1].body).includes('candidate@example.com'), false);
  const stored = JSON.parse(await readFile(join(directory, 'source-sharing.json'), 'utf8'));
  assert.equal(stored.enabled, true);
  assert.equal(stored.disclosed, true);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'source-sharing.json'))).mode & 0o777, 0o600);
});

test('community source listing validates the public response before reuse', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'source-community-list-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const network = relay();
  const client = new SourceCommunityClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: network.fetch, stderr: () => {} });
  const [listed] = await client.list();
  assert.equal(listed.sourceId, 'community-abcdef1234567890');
  assert.equal(listed.baseUrl, 'https://jobs.example.org/openings/engineering');
  assert.equal(listed.contributionCount, 2);
  assert.equal(listed.registryStatus, 'community-reviewed');
});

test('source sharing can be disabled independently and never blocks local collection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'source-community-disabled-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const network = relay();
  const client = new SourceCommunityClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: network.fetch, stderr: () => {} });

  assert.equal((await client.configure('disable')).enabled, false);
  assert.deepEqual(await client.contribute(source), { shared: false, reason: 'disabled' });
  assert.equal(network.requests.length, 0);
  assert.equal((await client.configure('enable')).enabled, true);
  assert.equal((await client.contribute(source)).shared, true);
});

test('source sharing rejects personal and one-off job URLs before network transmission', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'source-community-reject-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const network = relay();
  const client = new SourceCommunityClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: network.fetch, stderr: () => {} });

  await assert.rejects(() => client.preview({ ...source, baseUrl: 'https://linkedin.com/in/some-person' }), /profile or personal/i);
  await assert.rejects(() => client.preview({ ...source, baseUrl: 'https://jobs.example.org/jobs/123456' }), /repeatable discovery surface/i);
  await assert.rejects(() => client.preview({ ...source, baseUrl: 'https://jobs.example.org/candidate@example.com/openings' }), /identity-like content/i);
  await assert.rejects(() => client.preview({ ...source, baseUrl: 'https://127.0.0.1/jobs' }), /public internet hostname/i);
  await assert.rejects(() => client.preview({ ...source, baseUrl: 'https://careers.internal.local/jobs' }), /public internet hostname/i);
  assert.equal(network.requests.length, 0);
});

test('network failures are best effort and return an unavailable result', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'source-community-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new SourceCommunityClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch: async () => { throw new Error('offline'); }, stderr: () => {} });
  assert.deepEqual(await client.contribute(source), { shared: false, reason: 'unavailable' });
});

test('invalid stored relay credentials are replaced once and persisted', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'source-community-credential-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldInstallationId = '11111111-1111-4111-8111-111111111111';
  const newInstallationId = '22222222-2222-4222-8222-222222222222';
  await writeFile(join(directory, 'source-sharing.json'), JSON.stringify({
    version: 1,
    enabled: true,
    disclosed: true,
    installationId: oldInstallationId,
    token: 'invalid-old-token',
    tokenExpiresAt: '2099-01-01T00:00:00.000Z',
  }));
  const requests = [];
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    if (url.endsWith('/v1/sources') && body.installationId === oldInstallationId) return Response.json({ error: 'invalid_token' }, { status: 401 });
    if (url.endsWith('/v1/install') && body.installationId === oldInstallationId) return Response.json({ error: 'invalid_token' }, { status: 401 });
    if (url.endsWith('/v1/install')) return Response.json({ installationId: newInstallationId, token: 'new-token', expiresAt: '2099-01-01T00:00:00.000Z' }, { status: 201 });
    return Response.json({ accepted: true, sourceId: 'community-abcdef1234567890', publicationStatus: 'pending', uniqueContributors: 1 }, { status: 202 });
  };
  const client = new SourceCommunityClient({ stateDir: directory, endpoint: 'https://relay.example.com', fetch, stderr: () => {} });

  const result = await client.contribute(source);

  assert.equal(result.shared, true);
  assert.ok(requests.some((request) => request.url.endsWith('/v1/install') && request.body.installationId === oldInstallationId));
  assert.ok(requests.some((request) => request.url.endsWith('/v1/install') && Object.keys(request.body).length === 0));
  const stored = JSON.parse(await readFile(join(directory, 'source-sharing.json'), 'utf8'));
  assert.equal(stored.installationId, newInstallationId);
  assert.equal(stored.token, 'new-token');
});
