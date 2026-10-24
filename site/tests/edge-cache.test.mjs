import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_CACHE_404_TTL_SECONDS,
  EDGE_CACHE_API_SWR_SECONDS,
  EDGE_CACHE_API_TTL_SECONDS,
  EDGE_CACHE_SWR_SECONDS,
  EDGE_CACHE_STATUS_HEADER,
  EDGE_CACHE_TTL_SECONDS,
  edgeCacheKey,
  edgeCacheSwrSeconds,
  edgeCacheTtlSeconds,
  hasEdgeCacheAuthCookie,
  isEdgeCacheablePath,
  isEdgeCacheableRequest,
  isEdgeStorableResponse,
  normalizeEdgeCacheSearch,
  resetEdgeCacheInflight,
  serveWithEdgeCache,
} from '../lib/edge-cache.mjs';

const ORIGIN = 'https://job-application-agent-site.varora1406.workers.dev';

class MemoryCache {
  constructor() { this.store = new Map(); }
  async match(request) {
    const hit = this.store.get(request.url);
    return hit ? new Response(hit.body.slice(0), { status: hit.status, statusText: hit.statusText, headers: new Headers(hit.headers) }) : undefined;
  }
  async put(request, response) {
    this.store.set(request.url, {
      body: await response.arrayBuffer(),
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  }
}

function page(path, init = {}) {
  return new Request(`${ORIGIN}${path}`, {
    headers: { 'x-forwarded-host': 'jobappagent.com', ...(init.headers ?? {}) },
    method: init.method ?? 'GET',
  });
}

beforeEach(() => {
  resetEdgeCacheInflight();
});

test('only public document paths are cacheable', () => {
  for (const path of ['/', '/jobs', '/jobs/senior-engineer-acme-abc123', '/platforms', '/platforms/greenhouse', '/privacy', '/terms', '/community-view', '/open-source', '/compare', '/sitemap.xml', '/robots.txt']) {
    assert.equal(isEdgeCacheablePath(path), true, path);
  }
  for (const path of ['/api/community-stats', '/api/community-jobs']) {
    assert.equal(isEdgeCacheablePath(path), true, path);
  }
  for (const path of ['/api/community-jobs-live', '/attention/abc', '/checkout/return', '/api/checkout', '/api/checkout/status', '/api/health', '/api/attention/x/answers', '/api/webhooks/dodo', '/jobs/a/b', '/_vinext/image']) {
    assert.equal(isEdgeCacheablePath(path), false, path);
  }
});

test('/jobs index is cacheable for anonymous GET (no personalised content)', () => {
  assert.equal(isEdgeCacheableRequest(page('/jobs')), true);
  assert.equal(isEdgeCacheablePath('/jobs'), true);
});

test('router, content query, auth and non-GET/HEAD requests bypass the cache', () => {
  assert.equal(isEdgeCacheableRequest(page('/jobs')), true);
  assert.equal(isEdgeCacheableRequest(page('/jobs?role=x')), false);
  assert.equal(isEdgeCacheableRequest(page('/jobs', { headers: { RSC: '1' } })), false);
  assert.equal(isEdgeCacheableRequest(page('/jobs', { headers: { 'Next-Router-Prefetch': '1' } })), false);
  assert.equal(isEdgeCacheableRequest(page('/jobs', { headers: { authorization: 'Bearer x' } })), false);
  assert.equal(isEdgeCacheableRequest(page('/jobs', { method: 'POST' })), false);
  assert.equal(isEdgeCacheableRequest(page('/jobs', { method: 'HEAD' })), true);
});

test('tracking query params are ignored; founding_purchase cookie bypasses', () => {
  assert.equal(normalizeEdgeCacheSearch('/jobs', new URLSearchParams('utm_source=twitter&utm_campaign=c')).toString(), '');
  assert.equal(isEdgeCacheableRequest(page('/jobs?utm_source=twitter&utm_medium=cpc')), true);
  assert.equal(
    edgeCacheKey(page('/jobs?utm_source=x'), 'r').url,
    edgeCacheKey(page('/jobs'), 'r').url,
  );
  assert.equal(hasEdgeCacheAuthCookie('founding_purchase=abc; Path=/'), true);
  assert.equal(hasEdgeCacheAuthCookie('other=1'), false);
  assert.equal(isEdgeCacheableRequest(page('/jobs', { headers: { cookie: 'founding_purchase=11111111-1111-4111-8111-111111111111' } })), false);
});

test('cache key separates hosts and releases', () => {
  const apex = edgeCacheKey(page('/'), 'abc').url;
  const stats = edgeCacheKey(new Request(`${ORIGIN}/`, { headers: { 'x-forwarded-host': 'stats.jobappagent.com' } }), 'abc').url;
  const nextRelease = edgeCacheKey(page('/'), 'def').url;
  assert.notEqual(apex, stats);
  assert.notEqual(apex, nextRelease);
  assert.ok(apex.startsWith(`${ORIGIN}/__jaa-edge-cache/index?`));
});

test('set-cookie and non-200 responses are never stored; job 404s are', () => {
  assert.equal(isEdgeStorableResponse(page('/jobs'), new Response('x', { status: 200 })), true);
  assert.equal(isEdgeStorableResponse(page('/jobs'), new Response('x', { status: 200, headers: { 'set-cookie': 'a=b' } })), false);
  assert.equal(isEdgeStorableResponse(page('/jobs'), new Response('x', { status: 500 })), false);
  assert.equal(isEdgeStorableResponse(page('/jobs/gone-role-abc'), new Response('x', { status: 404 })), true);
  assert.equal(isEdgeStorableResponse(page('/privacy'), new Response('x', { status: 404 })), false);
});

test('miss then hit: second request is served from cache without re-render', async () => {
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
  assert.match(second.headers.get('cache-control') ?? '', /s-maxage=3600/);
  assert.equal(second.headers.get('vary'), 'RSC');
  assert.equal(second.headers.get('x-frame-options'), 'DENY');
  assert.equal(await second.text(), '<html>render 1</html>');

  const rsc = await serveWithEdgeCache(page('/jobs', { headers: { RSC: '1' } }), options);
  assert.equal(renders, 2);
  assert.equal(rsc.headers.get(EDGE_CACHE_STATUS_HEADER), null);
});

test('stale-while-revalidate serves STALE and refreshes once in the background', async () => {
  const cache = new MemoryCache();
  const pending = [];
  let renders = 0;
  let clock = 1_000_000;
  const render = async () => {
    renders += 1;
    return new Response(`<html>v${renders}</html>`, { headers: { 'content-type': 'text/html' } });
  };
  const options = {
    cache,
    release: 'r1',
    waitUntil: (p) => pending.push(p),
    render,
    now: () => clock,
  };

  assert.equal((await serveWithEdgeCache(page('/jobs/slug-a'), options)).headers.get(EDGE_CACHE_STATUS_HEADER), 'MISS');
  await Promise.all(pending.splice(0));
  assert.equal(renders, 1);

  clock += (EDGE_CACHE_TTL_SECONDS + 1) * 1000;
  const stale = await serveWithEdgeCache(page('/jobs/slug-a'), options);
  assert.equal(stale.headers.get(EDGE_CACHE_STATUS_HEADER), 'STALE');
  assert.equal(await stale.text(), '<html>v1</html>');

  // Burst of stale hits must coalesce to one background render.
  const burst = await Promise.all([
    serveWithEdgeCache(page('/jobs/slug-a'), options),
    serveWithEdgeCache(page('/jobs/slug-a'), options),
    serveWithEdgeCache(page('/jobs/slug-a'), options),
  ]);
  for (const response of burst) assert.equal(response.headers.get(EDGE_CACHE_STATUS_HEADER), 'STALE');
  await Promise.all(pending.splice(0));
  assert.equal(renders, 2);

  clock += 1;
  const after = await serveWithEdgeCache(page('/jobs/slug-a'), options);
  assert.equal(after.headers.get(EDGE_CACHE_STATUS_HEADER), 'HIT');
  assert.equal(await after.text(), '<html>v2</html>');
});

test('cookie bypass returns BYPASS and does not store', async () => {
  const cache = new MemoryCache();
  const pending = [];
  let renders = 0;
  const render = async () => {
    renders += 1;
    return new Response('private', { headers: { 'content-type': 'text/html' } });
  };
  const req = page('/jobs', { headers: { cookie: 'founding_purchase=11111111-1111-4111-8111-111111111111' } });
  const response = await serveWithEdgeCache(req, { cache, release: 'r1', waitUntil: (p) => pending.push(p), render });
  assert.equal(response.headers.get(EDGE_CACHE_STATUS_HEADER), 'BYPASS');
  assert.equal(await response.text(), 'private');
  await Promise.all(pending);
  assert.equal(cache.store.size, 0);
  assert.equal(renders, 1);
});

test('content-affecting query bypass returns BYPASS', async () => {
  const cache = new MemoryCache();
  const pending = [];
  const response = await serveWithEdgeCache(page('/jobs?role=backend'), {
    cache,
    release: 'r1',
    waitUntil: (p) => pending.push(p),
    render: async () => new Response('fresh'),
  });
  assert.equal(response.headers.get(EDGE_CACHE_STATUS_HEADER), 'BYPASS');
  assert.equal(cache.store.size, 0);
});

test('Set-Cookie responses are not stored (BYPASS after render)', async () => {
  const cache = new MemoryCache();
  const pending = [];
  const response = await serveWithEdgeCache(page('/jobs'), {
    cache,
    release: 'r1',
    waitUntil: (p) => pending.push(p),
    render: async () => new Response('x', { status: 200, headers: { 'set-cookie': 'founding_purchase=abc' } }),
  });
  assert.equal(response.headers.get(EDGE_CACHE_STATUS_HEADER), 'BYPASS');
  await Promise.all(pending);
  assert.equal(cache.store.size, 0);
});

test('non-200 responses are not cached', async () => {
  const cache = new MemoryCache();
  const pending = [];
  const response = await serveWithEdgeCache(page('/jobs'), {
    cache,
    release: 'r1',
    waitUntil: (p) => pending.push(p),
    render: async () => new Response('err', { status: 503 }),
  });
  assert.equal(response.headers.get(EDGE_CACHE_STATUS_HEADER), 'BYPASS');
  await Promise.all(pending);
  assert.equal(cache.store.size, 0);
});

test('404 on /jobs/<slug> is stored with a short TTL', async () => {
  const cache = new MemoryCache();
  const pending = [];
  let clock = 5_000_000;
  const response = await serveWithEdgeCache(page('/jobs/missing-role-abc'), {
    cache,
    release: 'r1',
    waitUntil: (p) => pending.push(p),
    render: async () => new Response('gone', { status: 404 }),
    now: () => clock,
  });
  assert.equal(response.headers.get(EDGE_CACHE_STATUS_HEADER), 'MISS');
  assert.equal(edgeCacheTtlSeconds('/jobs/missing-role-abc', 404), EDGE_CACHE_404_TTL_SECONDS);
  await Promise.all(pending);
  assert.equal(cache.store.size, 1);
  const stored = [...cache.store.values()][0];
  assert.equal(stored.status, 404);
  assert.match(stored.headers.get('cache-control') ?? '', new RegExp(`max-age=${EDGE_CACHE_404_TTL_SECONDS}`));

  const hit = await serveWithEdgeCache(page('/jobs/missing-role-abc'), {
    cache,
    release: 'r1',
    waitUntil: (p) => pending.push(p),
    render: async () => new Response('should-not-run', { status: 404 }),
    now: () => clock,
  });
  assert.equal(hit.headers.get(EDGE_CACHE_STATUS_HEADER), 'HIT');
  assert.equal(await hit.text(), 'gone');
});

test('HEAD is answered from cache without a second body render', async () => {
  const cache = new MemoryCache();
  const pending = [];
  let renders = 0;
  /** @type {string[]} */
  const methods = [];
  const render = async (req = page('/jobs')) => {
    renders += 1;
    methods.push(req.method);
    return new Response('<html>body</html>', { headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' } });
  };
  const options = { cache, release: 'r1', waitUntil: (p) => pending.push(p), render };

  const headMiss = await serveWithEdgeCache(page('/jobs', { method: 'HEAD' }), options);
  assert.equal(headMiss.headers.get(EDGE_CACHE_STATUS_HEADER), 'MISS');
  assert.equal(headMiss.headers.get('x-frame-options'), 'DENY');
  assert.equal(await headMiss.text(), '');
  assert.deepEqual(methods, ['GET']);
  await Promise.all(pending.splice(0));

  const headHit = await serveWithEdgeCache(page('/jobs', { method: 'HEAD' }), options);
  assert.equal(headHit.headers.get(EDGE_CACHE_STATUS_HEADER), 'HIT');
  assert.equal(await headHit.text(), '');
  assert.equal(renders, 1);

  const getHit = await serveWithEdgeCache(page('/jobs'), options);
  assert.equal(getHit.headers.get(EDGE_CACHE_STATUS_HEADER), 'HIT');
  assert.equal(await getHit.text(), '<html>body</html>');
  assert.equal(renders, 1);
});

test('concurrent misses on the same key render once', async () => {
  const cache = new MemoryCache();
  const pending = [];
  let renders = 0;
  let releaseRender;
  const gate = new Promise((resolve) => { releaseRender = resolve; });
  const render = async () => {
    renders += 1;
    await gate;
    return new Response(`once-${renders}`, { headers: { 'content-type': 'text/html' } });
  };
  const options = { cache, release: 'r1', waitUntil: (p) => pending.push(p), render };
  const tasks = Promise.all([
    serveWithEdgeCache(page('/jobs/slug-b'), options),
    serveWithEdgeCache(page('/jobs/slug-b'), options),
    serveWithEdgeCache(page('/jobs/slug-b'), options),
  ]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(renders, 1);
  releaseRender();
  const responses = await tasks;
  for (const response of responses) {
    assert.equal(response.headers.get(EDGE_CACHE_STATUS_HEADER), 'MISS');
    assert.equal(await response.text(), 'once-1');
  }
  await Promise.all(pending);
  assert.equal(renders, 1);
});

test('no cache available falls through to render', async () => {
  const response = await serveWithEdgeCache(page('/jobs'), { cache: undefined, waitUntil: () => {}, render: async () => new Response('ok') });
  assert.equal(await response.text(), 'ok');
});

test('public API JSON keeps its query in the key; pages with a content query still bypass', () => {
  assert.equal(isEdgeCacheableRequest(page('/api/community-jobs?limit=1')), true);
  assert.equal(isEdgeCacheableRequest(page('/api/community-stats')), true);
  assert.equal(isEdgeCacheableRequest(page('/jobs?limit=1')), false);
  assert.notEqual(edgeCacheKey(page('/api/community-jobs?limit=1'), 'r').url, edgeCacheKey(page('/api/community-jobs?limit=2'), 'r').url);
  assert.equal(isEdgeStorableResponse(page('/api/community-stats'), Response.json({ ok: true })), true);
  assert.equal(isEdgeStorableResponse(page('/api/community-stats'), Response.json({ error: 'x' }, { status: 503 })), false);
  assert.equal(isEdgeStorableResponse(page('/api/community-stats'), new Response('<html>', { headers: { 'content-type': 'text/html' } })), false);
});

test('/api/community-jobs-live always bypasses: no cache match/put, render every request', async () => {
  assert.equal(isEdgeCacheablePath('/api/community-jobs-live'), false);
  assert.equal(isEdgeCacheableRequest(page('/api/community-jobs-live?limit=1')), false);

  let matches = 0;
  let puts = 0;
  const cache = {
    async match() {
      matches += 1;
      return undefined;
    },
    async put() {
      puts += 1;
    },
  };
  const pending = [];
  let renders = 0;
  const render = async () => {
    renders += 1;
    return Response.json({ jobs: [], nextCursor: null, render: renders });
  };
  const options = { cache, release: 'r1', waitUntil: (p) => pending.push(p), render };

  const first = await serveWithEdgeCache(page('/api/community-jobs-live?limit=1'), options);
  const second = await serveWithEdgeCache(page('/api/community-jobs-live?limit=1'), options);
  await Promise.all(pending);

  assert.equal(first.headers.get(EDGE_CACHE_STATUS_HEADER), 'BYPASS');
  assert.equal(second.headers.get(EDGE_CACHE_STATUS_HEADER), 'BYPASS');
  assert.equal(renders, 2);
  assert.equal(matches, 0);
  assert.equal(puts, 0);
  assert.deepEqual(await first.json(), { jobs: [], nextCursor: null, render: 1 });
  assert.deepEqual(await second.json(), { jobs: [], nextCursor: null, render: 2 });
});

test('community-stats and community-jobs use 300s fresh + 300s SWR', async () => {
  assert.equal(EDGE_CACHE_API_TTL_SECONDS, 300);
  assert.equal(EDGE_CACHE_API_SWR_SECONDS, 300);
  assert.equal(edgeCacheTtlSeconds('/api/community-stats'), 300);
  assert.equal(edgeCacheSwrSeconds('/api/community-stats'), 300);
  assert.equal(edgeCacheTtlSeconds('/api/community-jobs'), 300);
  assert.equal(edgeCacheSwrSeconds('/api/community-jobs'), 300);

  const cache = new MemoryCache();
  const pending = [];
  const response = await serveWithEdgeCache(page('/api/community-stats'), {
    cache,
    release: 'r1',
    waitUntil: (p) => pending.push(p),
    render: async () => Response.json({ ok: true }),
  });
  assert.equal(response.headers.get(EDGE_CACHE_STATUS_HEADER), 'MISS');
  assert.match(response.headers.get('cache-control') ?? '', /s-maxage=300/);
  assert.match(response.headers.get('cache-control') ?? '', /stale-while-revalidate=300/);
  await Promise.all(pending);
  const stored = [...cache.store.values()][0];
  assert.match(stored.headers.get('cache-control') ?? '', /max-age=600/);
});

test('chosen TTLs: pages 3600+3600, APIs 300+300, job 404 60s', () => {
  assert.equal(EDGE_CACHE_TTL_SECONDS, 3600);
  assert.equal(EDGE_CACHE_SWR_SECONDS, 3600);
  assert.equal(EDGE_CACHE_API_TTL_SECONDS, 300);
  assert.equal(EDGE_CACHE_API_SWR_SECONDS, 300);
  assert.equal(EDGE_CACHE_404_TTL_SECONDS, 60);
  for (const path of ['/', '/jobs', '/jobs/slug-a', '/platforms', '/platforms/greenhouse', '/privacy', '/terms', '/open-source', '/compare', '/sitemap.xml', '/robots.txt', '/manifest.webmanifest', '/community-view']) {
    assert.equal(edgeCacheTtlSeconds(path), 3600, path);
    assert.equal(edgeCacheSwrSeconds(path), 3600, path);
  }
  assert.equal(edgeCacheTtlSeconds('/jobs/slug', 404), 60);
  assert.equal(edgeCacheSwrSeconds('/jobs/slug', 404), 0);
  assert.equal(edgeCacheTtlSeconds('/api/community-stats'), 300);
  assert.equal(edgeCacheTtlSeconds('/api/community-jobs'), 300);
});
