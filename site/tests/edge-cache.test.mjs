import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_CACHE_STATUS_HEADER,
  edgeCacheKey,
  edgeCacheTtlSeconds,
  isEdgeCacheablePath,
  isEdgeCacheableRequest,
  isEdgeStorableResponse,
  serveWithEdgeCache,
} from '../lib/edge-cache.mjs';

const ORIGIN = 'https://job-application-agent-site.varora1406.workers.dev';

class MemoryCache {
  constructor() { this.store = new Map(); }
  async match(request) {
    const hit = this.store.get(request.url);
    return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined;
  }
  async put(request, response) {
    this.store.set(request.url, { body: await response.text(), status: response.status, headers: new Headers(response.headers) });
  }
}

function page(path, init = {}) {
  return new Request(`${ORIGIN}${path}`, { headers: { 'x-forwarded-host': 'jobappagent.com', ...(init.headers ?? {}) }, method: init.method ?? 'GET' });
}

test('only public document paths are cacheable', () => {
  for (const path of ['/', '/jobs', '/jobs/senior-engineer-acme-abc123', '/platforms', '/platforms/greenhouse', '/privacy', '/terms', '/community-view', '/sitemap.xml', '/robots.txt']) {
    assert.equal(isEdgeCacheablePath(path), true, path);
  }
  for (const path of ['/api/community-stats', '/api/community-jobs', '/api/community-jobs-live']) {
    assert.equal(isEdgeCacheablePath(path), true, path);
  }
  for (const path of ['/attention/abc', '/checkout/return', '/api/checkout', '/api/checkout/status', '/api/health', '/api/attention/x/answers', '/api/webhooks/dodo', '/jobs/a/b', '/_vinext/image']) {
    assert.equal(isEdgeCacheablePath(path), false, path);
  }
});

test('router, query, auth and non-GET requests bypass the cache', () => {
  assert.equal(isEdgeCacheableRequest(page('/jobs')), true);
  assert.equal(isEdgeCacheableRequest(page('/jobs?role=x')), false);
  assert.equal(isEdgeCacheableRequest(page('/jobs', { headers: { RSC: '1' } })), false);
  assert.equal(isEdgeCacheableRequest(page('/jobs', { headers: { 'Next-Router-Prefetch': '1' } })), false);
  assert.equal(isEdgeCacheableRequest(page('/jobs', { headers: { authorization: 'Bearer x' } })), false);
  assert.equal(isEdgeCacheableRequest(page('/jobs', { method: 'POST' })), false);
  assert.equal(isEdgeCacheableRequest(page('/jobs', { method: 'HEAD' })), false);
});

test('cache key separates hosts and releases', () => {
  const apex = edgeCacheKey(page('/'), 'abc').url;
  const stats = edgeCacheKey(new Request(`${ORIGIN}/`, { headers: { 'x-forwarded-host': 'stats.jobappagent.com' } }), 'abc').url;
  const nextRelease = edgeCacheKey(page('/'), 'def').url;
  assert.notEqual(apex, stats);
  assert.notEqual(apex, nextRelease);
  assert.ok(apex.startsWith(`${ORIGIN}/__jaa-edge-cache/index?`));
});

test('set-cookie and error responses are never stored', () => {
  assert.equal(isEdgeStorableResponse(page('/jobs'), new Response('x', { status: 200 })), true);
  assert.equal(isEdgeStorableResponse(page('/jobs'), new Response('x', { status: 200, headers: { 'set-cookie': 'a=b' } })), false);
  assert.equal(isEdgeStorableResponse(page('/jobs'), new Response('x', { status: 500 })), false);
  assert.equal(isEdgeStorableResponse(page('/jobs/gone-role-abc'), new Response('x', { status: 404 })), true);
  assert.equal(isEdgeStorableResponse(page('/privacy'), new Response('x', { status: 404 })), false);
});

test('second request is served from cache with original client headers', async () => {
  const cache = new MemoryCache();
  const pending = [];
  let renders = 0;
  const render = async () => {
    renders += 1;
    return new Response(`<html>render ${renders}</html>`, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, must-revalidate', vary: 'RSC', 'x-frame-options': 'DENY' },
    });
  };
  const options = { cache, release: 'r1', waitUntil: (p) => pending.push(p), render };
  const first = await serveWithEdgeCache(page('/jobs'), options);
  assert.equal(first.headers.get(EDGE_CACHE_STATUS_HEADER), 'MISS');
  assert.equal(await first.text(), '<html>render 1</html>');
  await Promise.all(pending);

  const second = await serveWithEdgeCache(page('/jobs'), options);
  assert.equal(renders, 1);
  assert.equal(second.headers.get(EDGE_CACHE_STATUS_HEADER), 'HIT');
  assert.equal(second.headers.get('cache-control'), 'no-store, must-revalidate');
  assert.equal(second.headers.get('vary'), 'RSC');
  assert.equal(second.headers.get('x-frame-options'), 'DENY');
  assert.equal(await second.text(), '<html>render 1</html>');

  const rsc = await serveWithEdgeCache(page('/jobs', { headers: { RSC: '1' } }), options);
  assert.equal(renders, 2);
  assert.equal(rsc.headers.get(EDGE_CACHE_STATUS_HEADER), null);
});

test('no cache available falls through to render', async () => {
  const response = await serveWithEdgeCache(page('/jobs'), { cache: undefined, waitUntil: () => {}, render: async () => new Response('ok') });
  assert.equal(await response.text(), 'ok');
});

test('public API JSON keeps its query in the key; pages with a query still bypass', () => {
  assert.equal(isEdgeCacheableRequest(page('/api/community-jobs?limit=1')), true);
  assert.equal(isEdgeCacheableRequest(page('/api/community-stats')), true);
  assert.equal(isEdgeCacheableRequest(page('/jobs?limit=1')), false);
  assert.notEqual(edgeCacheKey(page('/api/community-jobs?limit=1'), 'r').url, edgeCacheKey(page('/api/community-jobs?limit=2'), 'r').url);
  assert.equal(isEdgeStorableResponse(page('/api/community-stats'), Response.json({ ok: true })), true);
  assert.equal(isEdgeStorableResponse(page('/api/community-stats'), Response.json({ error: 'x' }, { status: 503 })), false);
  assert.equal(isEdgeStorableResponse(page('/api/community-stats'), new Response('<html>', { headers: { 'content-type': 'text/html' } })), false);
});

test('static pages get a longer TTL than data-backed pages', () => {
  assert.equal(edgeCacheTtlSeconds('/privacy'), 3600);
  assert.equal(edgeCacheTtlSeconds('/platforms/greenhouse'), 3600);
  assert.equal(edgeCacheTtlSeconds('/jobs'), 300);
  assert.equal(edgeCacheTtlSeconds('/api/community-stats'), 300);
});
