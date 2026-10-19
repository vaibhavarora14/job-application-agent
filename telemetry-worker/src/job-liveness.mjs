const label = (value) => (typeof value === 'string' && value.trim().length <= 240 && !/[<>]/.test(value) && ![...value].some((char) => char.charCodeAt(0) < 32) ? value.trim() : '');
const title = (value) => label(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Bounded batch size per admin invocation (manual sweep workflow). */
export const DEFAULT_LIVENESS_BATCH_SIZE = 50;
/**
 * Batch size per cron invocation. Workers Free gives cron triggers 10 ms CPU; a
 * 50-job sweep measured ~67 ms CPU p50 (~1.3 ms per job), so a 5-job batch stays
 * around 6-7 ms. The cron runs every 5 minutes (1,440 checks/day), and
 * listDueForLivenessCheck always takes the oldest-checked jobs first, so it still
 * rotates through the whole published set (~1,600 jobs) about once a day, well
 * inside the board's 3-day freshness window and the 26 h staleness alert.
 */
export const CRON_LIVENESS_BATCH_SIZE = 5;
export const DEFAULT_LIVENESS_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 12000;
const LIVENESS_UA = 'JobAppAgentLiveness/1.0 (+https://jobappagent.com/jobs)';

const CLOSED_PHRASING = [
  'no longer accepting',
  'no longer available',
  'no longer open',
  'position has been filled',
  'position is filled',
  'job has been filled',
  'this job is closed',
  'this role is closed',
  'this position is closed',
  'applications are closed',
  'application is closed',
  'applications have closed',
  'posting has expired',
  'job posting has expired',
  'this job posting has been removed',
  'role is no longer',
  'opportunity is no longer',
  'sorry, this position',
  'this vacancy is closed',
];

const CAREERS_INDEX_PATHS = new Set([
  '/careers',
  '/career',
  '/jobs',
  '/job',
  '/join',
  '/join-us',
  '/joinus',
  '/opportunities',
  '/openings',
  '/vacancies',
  '/work-with-us',
  '/work-with-us/',
]);

const ASHBY_JOB_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id
    title
    isListed
  }
}`;

function canonical(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/(?:apply|application)\/?$/, '').replace(/\/$/, '')}`;
  } catch {
    return '';
  }
}

function titlesMatch(atsTitle, jobTitle) {
  const a = title(atsTitle);
  const b = title(jobTitle);
  if (!a || !b) return false;
  if (a === b) return true;
  const stripSuffix = (val) => label(val)
    .replace(/\s*\([^)]*\)$/, '')
    .replace(/\s*-[^-]+$/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const aClean = stripSuffix(atsTitle);
  const bClean = stripSuffix(jobTitle);
  if (aClean === b || a === bClean || (aClean && aClean === bClean)) return true;
  if (a.length > 8 && b.length > 8 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

/** Board/account tokens may include dots and spaces (URL-encoded). */
function isBoardToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 120 && !/[<>\s/#?]/.test(value);
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function atsTarget(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const parts = url.pathname.split('/').filter(Boolean).filter((part) => !['apply', 'application'].includes(part.toLowerCase()));
  if (parts.length < 2) return null;

  if (url.hostname === 'jobs.ashbyhq.com') {
    const board = decodePathSegment(parts[0]);
    const id = decodePathSegment(parts[1]);
    // Ashby board names can include spaces; IDs are UUIDs.
    if (board && id && /^[\w.-]+(?:\s+[\w.-]+)*$/u.test(board) && /^[\w-]+$/.test(id)) {
      return {
        kind: 'ashby',
        id,
        board,
        url: `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting`,
        boardApiUrl: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`,
      };
    }
  }

  if (['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'].includes(url.hostname)) {
    const [board, segment, id] = parts.map(decodePathSegment);
    if (segment === 'jobs' && /^\d+$/.test(id) && isBoardToken(board)) {
      const apiHost = url.hostname.includes('.eu.')
        ? 'boards-api.greenhouse.io'
        : 'boards-api.greenhouse.io';
      return { kind: 'greenhouse', id, url: `https://${apiHost}/v1/boards/${encodeURIComponent(board)}/jobs/${id}` };
    }
  }

  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(url.hostname)) {
    const board = decodePathSegment(parts[0]);
    const id = decodePathSegment(parts[1]);
    // Lever site tokens can include dots (trustedhousesitters.com).
    if (isBoardToken(board) && /^[\w.-]+$/.test(board) && /^[\w-]+$/.test(id)) {
      return {
        kind: 'lever',
        id,
        url: `https://${url.hostname === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${encodeURIComponent(board)}/${id}`,
      };
    }
  }

  if (url.hostname === 'apply.workable.com') {
    const [account, segment, id] = parts.map(decodePathSegment);
    if (segment === 'j' && isBoardToken(account) && /^[\w-]+$/.test(id)) {
      return { kind: 'workable', id, url: `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(account)}/jobs/${id}` };
    }
  }

  return null;
}

function checked(status, checkedAt, reason) {
  return { status, checkedAt, reason };
}

function classifyAshby(job, posting, checkedAt) {
  if (!posting) return checked('closed', checkedAt, 'ats_closed_missing');
  if (posting.isListed === false) return checked('closed', checkedAt, 'ats_closed_unlisted');
  if (!titlesMatch(posting.title, job.role)) return checked('closed', checkedAt, 'ats_closed_title');
  return checked('open', checkedAt, 'ats_open');
}

function postingMatches(job, target, data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'ats_closed_missing' };

  if (target.kind === 'ashby') {
    // GraphQL single-job shape
    if (data.data?.jobPosting) {
      const posting = data.data.jobPosting;
      if (posting.id && posting.id !== target.id) return { ok: false, reason: 'ats_closed_missing' };
      if (posting.isListed === false) return { ok: false, reason: 'ats_closed_unlisted' };
      if (!titlesMatch(posting.title, job.role)) return { ok: false, reason: 'ats_closed_title' };
      return { ok: true, reason: 'ats_open' };
    }
    // Legacy board JSON fallback
    const entry = Array.isArray(data.jobs) ? data.jobs.find((item) => item?.id === target.id) : null;
    if (!entry || entry.isListed === false) return { ok: false, reason: entry ? 'ats_closed_unlisted' : 'ats_closed_missing' };
    if (!titlesMatch(entry.title, job.role)) return { ok: false, reason: 'ats_closed_title' };
    if (entry.jobUrl && canonical(entry.jobUrl) !== canonical(job.url)) return { ok: false, reason: 'ats_closed_url' };
    return { ok: true, reason: 'ats_open' };
  }

  if (target.kind === 'greenhouse') {
    if (String(data.id) !== target.id) return { ok: false, reason: 'ats_closed_missing' };
    if (!titlesMatch(data.title, job.role)) return { ok: false, reason: 'ats_closed_title' };
    if (data.absolute_url) {
      let isGreenhouseHost = false;
      try {
        const host = new URL(data.absolute_url).hostname;
        isGreenhouseHost = host === 'greenhouse.io' || host.endsWith('.greenhouse.io');
      } catch {
        isGreenhouseHost = false;
      }
      if (isGreenhouseHost) {
        const normalize = (value) => canonical(value).replace('://boards.greenhouse.io/', '://job-boards.greenhouse.io/');
        if (normalize(data.absolute_url) !== normalize(job.url)) return { ok: false, reason: 'ats_closed_url' };
      }
    }
    return { ok: true, reason: 'ats_open' };
  }

  if (target.kind === 'lever') {
    if (data.id !== target.id) return { ok: false, reason: 'ats_closed_missing' };
    if (!titlesMatch(data.text, job.role)) return { ok: false, reason: 'ats_closed_title' };
    if (data.hostedUrl && canonical(data.hostedUrl) !== canonical(job.url)) return { ok: false, reason: 'ats_closed_url' };
    return { ok: true, reason: 'ats_open' };
  }

  if (target.kind === 'workable') {
    if (data.state && !['published', 'open'].includes(String(data.state).toLowerCase())) {
      return { ok: false, reason: 'ats_closed_unlisted' };
    }
    if (!titlesMatch(data.title, job.role)) return { ok: false, reason: 'ats_closed_title' };
    return { ok: true, reason: 'ats_open' };
  }

  return { ok: false, reason: 'ats_closed_missing' };
}

function isCareersIndexPath(pathname) {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (CAREERS_INDEX_PATHS.has(normalized) || CAREERS_INDEX_PATHS.has(`${normalized}/`)) return true;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length >= 1 && parts.length <= 2) {
    const leaf = parts.at(-1)?.toLowerCase() ?? '';
    if (['careers', 'career', 'jobs', 'job', 'join', 'join-us', 'opportunities', 'openings', 'vacancies'].includes(leaf)) {
      return true;
    }
  }
  return false;
}

/** True when a redirect landed on a generic careers/jobs index (posting gone). */
export function isCareersIndexRedirect(originalUrl, finalUrl) {
  let original;
  let final;
  try {
    original = new URL(originalUrl);
    final = new URL(finalUrl);
  } catch {
    return false;
  }
  if (canonical(original.href) === canonical(final.href)) return false;
  if (final.origin !== original.origin && !isCareersIndexPath(final.pathname)) return false;
  return isCareersIndexPath(final.pathname);
}

function htmlLooksClosed(text) {
  const lower = text.toLowerCase();
  return CLOSED_PHRASING.some((phrase) => lower.includes(phrase));
}

function htmlContainsRoleTitle(text, role) {
  const needle = title(role);
  if (!needle || needle.length < 3) return false;
  const hay = title(text.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' '));
  return hay.includes(needle);
}

function classifyFetchError(error) {
  const message = String(error?.message ?? error ?? '');
  if (/timeout|aborted|AbortError/i.test(message) || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return 'ats_timeout';
  }
  if (/redirect/i.test(message)) return 'ats_redirect';
  if (/Too many subrequests/i.test(message)) return 'ats_subrequest_limit';
  return 'ats_fetch_error';
}

async function fetchJson(fetchImpl, url, { method = 'GET', body = null, kind = 'ats' } = {}) {
  try {
    const response = await fetchImpl(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        'user-agent': LIVENESS_UA,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    });
    if (response.status === 404 || response.status === 410) {
      return { ok: false, status: response.status, reason: `${kind}_http_${response.status}` };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, reason: `${kind}_http_${response.status}` };
    }
    try {
      return { ok: true, status: response.status, data: await response.json() };
    } catch {
      return { ok: false, status: response.status, reason: `${kind}_bad_json` };
    }
  } catch (error) {
    return { ok: false, status: 0, reason: kind === 'ats' ? classifyFetchError(error) : `generic_${classifyFetchError(error).replace(/^ats_/, '')}` };
  }
}

/**
 * Conservative generic HTML liveness for non-ATS URLs.
 */
export async function checkGenericHtmlLiveness(job, { fetchImpl = fetch, now = new Date() } = {}) {
  const checkedAt = now.toISOString();
  let url;
  try {
    url = new URL(job?.url);
  } catch {
    return checked('unknown', checkedAt, 'generic_bad_url');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return checked('unknown', checkedAt, 'generic_bad_url');
  }

  let response;
  try {
    response = await fetchImpl(url.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'user-agent': LIVENESS_UA,
      },
    });
  } catch (error) {
    const reason = classifyFetchError(error).replace(/^ats_/, 'generic_');
    return checked('unknown', checkedAt, reason === 'generic_fetch_error' ? 'generic_fetch_error' : reason);
  }

  if (response.status === 404 || response.status === 410) {
    return checked('closed', checkedAt, `generic_http_${response.status}`);
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location && isCareersIndexRedirect(url.href, new URL(location, url).href)) {
      return checked('closed', checkedAt, 'generic_careers_redirect');
    }
    return checked('unknown', checkedAt, `generic_http_${response.status}`);
  }
  if (!response.ok) return checked('unknown', checkedAt, `generic_http_${response.status}`);

  const finalUrl = response.url || url.href;
  if (isCareersIndexRedirect(url.href, finalUrl)) {
    return checked('closed', checkedAt, 'generic_careers_redirect');
  }

  let body;
  try {
    body = await response.text();
  } catch {
    return checked('unknown', checkedAt, 'generic_fetch_error');
  }
  const sample = body.length > 500_000 ? body.slice(0, 500_000) : body;
  if (htmlLooksClosed(sample)) return checked('unknown', checkedAt, 'generic_closed_phrasing');
  if (!htmlContainsRoleTitle(sample, job.role)) return checked('unknown', checkedAt, 'generic_no_title');
  return checked('open', checkedAt, 'generic_open');
}

async function checkAshbyLiveness(job, target, { fetchImpl, checkedAt }) {
  // Prefer single-job GraphQL — avoids multi-MB board downloads that blow Worker CPU/time.
  const graphql = await fetchJson(fetchImpl, target.url, {
    method: 'POST',
    body: JSON.stringify({
      operationName: 'ApiJobPosting',
      query: ASHBY_JOB_QUERY,
      variables: {
        organizationHostedJobsPageName: target.board,
        jobPostingId: target.id,
      },
    }),
  });

  if (graphql.ok) {
    const posting = graphql.data?.data?.jobPosting ?? null;
    if (posting == null && Array.isArray(graphql.data?.errors) && graphql.data.errors.length > 0) {
      // Fall through to board API when GraphQL schema/auth fails.
    } else {
      return classifyAshby(job, posting, checkedAt);
    }
  } else if (graphql.reason === 'ats_http_404' || graphql.reason === 'ats_http_410') {
    return checked('closed', checkedAt, graphql.reason);
  }

  // Fallback: board JSON (may be large — still better than leaving every Ashby job unknown).
  const board = await fetchJson(fetchImpl, target.boardApiUrl);
  if (!board.ok) {
    return checked(
      board.reason === 'ats_http_404' || board.reason === 'ats_http_410' ? 'closed' : 'unknown',
      checkedAt,
      board.reason === 'ats_http_404' || board.reason === 'ats_http_410' ? board.reason : (graphql.ok ? board.reason : graphql.reason),
    );
  }
  const match = postingMatches(job, target, board.data);
  return checked(match.ok ? 'open' : 'closed', checkedAt, match.reason);
}

async function checkAtsLiveness(job, target, { fetchImpl, checkedAt }) {
  if (target.kind === 'ashby') {
    return checkAshbyLiveness(job, target, { fetchImpl, checkedAt });
  }

  const fetched = await fetchJson(fetchImpl, target.url);
  if (!fetched.ok) {
    if (fetched.reason === 'ats_http_404' || fetched.reason === 'ats_http_410') {
      return checked('closed', checkedAt, fetched.reason);
    }
    return checked('unknown', checkedAt, fetched.reason);
  }

  const match = postingMatches(job, target, fetched.data);
  return checked(match.ok ? 'open' : 'closed', checkedAt, match.reason);
}

export async function checkJobLiveness(job, { fetchImpl = fetch, now = new Date() } = {}) {
  const checkedAt = now.toISOString();
  const target = atsTarget(job?.url);
  if (target) return checkAtsLiveness(job, target, { fetchImpl, checkedAt });
  return checkGenericHtmlLiveness(job, { fetchImpl, now });
}

function closedAtFor(job, result) {
  const existingClosedAt = job.closedAt ?? null;
  if (result.status === 'closed') return existingClosedAt ?? result.checkedAt;
  if (result.status === 'open') return null;
  return existingClosedAt;
}

function summarize(results) {
  let open = 0;
  let closed = 0;
  let unknown = 0;
  const reasons = {};
  for (const result of results) {
    if (result.status === 'open') open += 1;
    else if (result.status === 'closed') closed += 1;
    else unknown += 1;
    const reason = result.reason || 'unspecified';
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return { open, closed, unknown, reasons };
}

/**
 * Process a bounded batch of oldest-checked published jobs.
 * Writes via store.updateLivenessBatch (D1 db.batch) when available.
 */
export async function runJobLivenessSweep(env, {
  fetchImpl = fetch,
  now = new Date(),
  concurrency = DEFAULT_LIVENESS_CONCURRENCY,
  limit = DEFAULT_LIVENESS_BATCH_SIZE,
  store,
  log = console.log,
} = {}) {
  const jobStore = store ?? env.JOB_STORE;
  if (!jobStore?.listDueForLivenessCheck) throw new Error('Job store unavailable.');
  if (!jobStore?.updateLivenessBatch && !jobStore?.updateLiveness) throw new Error('Job store unavailable.');

  const batchLimit = Math.max(1, Math.min(100, Number(limit) || DEFAULT_LIVENESS_BATCH_SIZE));
  const page = await jobStore.listDueForLivenessCheck({ limit: batchLimit });
  const jobs = page?.jobs ?? [];
  const results = new Array(jobs.length);
  let position = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (position < jobs.length) {
      const index = position++;
      const job = jobs[index];
      const result = await checkJobLiveness(job, { fetchImpl, now });
      results[index] = {
        jobId: job.jobId,
        status: result.status,
        checkedAt: result.checkedAt,
        closedAt: closedAtFor(job, result),
        reason: result.reason,
      };
    }
  });
  await Promise.all(workers);

  if (results.length > 0) {
    if (jobStore.updateLivenessBatch) {
      await jobStore.updateLivenessBatch(results.map(({ jobId, status, checkedAt, closedAt }) => ({
        jobId, status, checkedAt, closedAt,
      })));
    } else {
      for (const patch of results) {
        await jobStore.updateLiveness(patch.jobId, patch);
      }
    }
  }

  const counts = summarize(results);
  const summary = {
    checked: results.length,
    open: counts.open,
    closed: counts.closed,
    unknown: counts.unknown,
    reasons: counts.reasons,
    hasMore: Boolean(page?.hasMore),
  };
  const reasonParts = Object.entries(counts.reasons)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(' ');
  log(`[liveness] checked=${summary.checked} open=${summary.open} closed=${summary.closed} unknown=${summary.unknown} hasMore=${summary.hasMore} ${reasonParts}`);
  return summary;
}
