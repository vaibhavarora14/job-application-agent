import { attachLocations, countryLabel } from './job-locations.mjs';

const JOB_ID = /^community-job-[0-9a-f]{16}$/;
const CHANNELS = new Set(['linkedin', 'greenhouse', 'lever', 'ashby', 'workable', 'comeet', 'workday', 'rippling', 'smartrecruiters', 'google-form', 'company', 'email', 'other']);
const DISCOVERY_SOURCES = new Set(['direct-company', 'linkedin', 'x', 'yc', 'hacker-news', 'job-board', 'email', 'user-supplied', 'web-search', 'other']);
const LIVENESS = new Set(['open', 'closed', 'unknown']);
const STALE_MS = 3 * 86400000;
const VALID_THROUGH_MS = 30 * 86400000;
const TRUST_LINE = 'Reviewed and live, checked daily';
const CHANNEL_LABELS = {
  linkedin: 'LinkedIn',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  comeet: 'Comeet',
  workday: 'Workday',
  rippling: 'Rippling',
  smartrecruiters: 'SmartRecruiters',
  'google-form': 'Google Form',
  company: 'company careers page',
  email: 'email',
  other: 'public posting',
};

function isRecord(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value, maximum) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum;
}

function publicHttps(value, maximum = 2048) {
  if (!boundedString(value, maximum)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function isoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function nullableIso(value) {
  return value === null || isoDate(value);
}

export { TRUST_LINE, STALE_MS };

export function slugifyPart(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'role';
}

/** Slug from company + role + job_id (stable, URL-safe). */
export function jobSlug(job) {
  const id = String(job.jobId ?? '').replace(/^community-job-/, '');
  return `${slugifyPart(job.company)}-${slugifyPart(job.role)}-${id}`;
}

export function jobIdFromSlug(slug) {
  const match = String(slug ?? '').match(/-([0-9a-f]{16})$/i);
  return match ? `community-job-${match[1].toLowerCase()}` : null;
}

export function validateLiveJobs(input) {
  const rootKeys = new Set(['version', 'jobs', 'nextCursor', 'meta']);
  if (!isRecord(input) || !exactKeys(input, rootKeys) || input.version !== 1 || !Array.isArray(input.jobs) || input.jobs.length > 100) {
    return { ok: false, error: 'invalid_jobs' };
  }
  if (input.nextCursor !== null && !boundedString(input.nextCursor, 1024)) return { ok: false, error: 'invalid_jobs' };
  let meta = null;
  if (input.meta !== undefined) {
    if (!isRecord(input.meta) || !exactKeys(input.meta, new Set(['newestLastCheckedAt'])) || !nullableIso(input.meta.newestLastCheckedAt)) {
      return { ok: false, error: 'invalid_jobs' };
    }
    meta = { newestLastCheckedAt: input.meta.newestLastCheckedAt };
  }

  const jobKeys = new Set([
    'jobId', 'url', 'company', 'role', 'applicationChannel', 'discoverySource', 'providerUrl',
    'firstSeenAt', 'lastSeenAt', 'contributionCount', 'livenessStatus', 'lastCheckedAt', 'closedAt',
  ]);
  const jobs = [];
  for (const job of input.jobs) {
    if (!isRecord(job) || !exactKeys(job, jobKeys) || !JOB_ID.test(job.jobId)) return { ok: false, error: 'invalid_jobs' };
    if (!publicHttps(job.url) || !publicHttps(job.providerUrl) || !boundedString(job.company, 160) || !boundedString(job.role, 200)) return { ok: false, error: 'invalid_jobs' };
    if (!CHANNELS.has(job.applicationChannel) || (job.discoverySource != null && !DISCOVERY_SOURCES.has(job.discoverySource))) return { ok: false, error: 'invalid_jobs' };
    if (!isoDate(job.firstSeenAt) || !isoDate(job.lastSeenAt) || !Number.isSafeInteger(job.contributionCount) || job.contributionCount < 1 || job.contributionCount > 1_000_000_000) return { ok: false, error: 'invalid_jobs' };
    if (!LIVENESS.has(job.livenessStatus) || !nullableIso(job.lastCheckedAt) || !nullableIso(job.closedAt)) return { ok: false, error: 'invalid_jobs' };
    jobs.push({
      jobId: job.jobId,
      url: job.url,
      company: job.company,
      role: job.role,
      applicationChannel: job.applicationChannel,
      ...(job.discoverySource == null ? {} : { discoverySource: job.discoverySource }),
      providerUrl: job.providerUrl,
      firstSeenAt: job.firstSeenAt,
      lastSeenAt: job.lastSeenAt,
      contributionCount: job.contributionCount,
      livenessStatus: job.livenessStatus,
      lastCheckedAt: job.lastCheckedAt,
      closedAt: job.closedAt,
      slug: jobSlug(job),
    });
  }
  return {
    ok: true,
    data: {
      version: 1,
      jobs,
      nextCursor: input.nextCursor,
      ...(meta ? { meta } : {}),
    },
  };
}

/** Upstream pages carry at most this many jobs; validateLiveJobs enforces it. */
export const LIVE_JOBS_PAGE_SIZE = 100;

/**
 * Validate an aggregated board payload (all pages merged, e.g. the Cache API copy
 * written by fetch-live-jobs) with the same per-job rules as validateLiveJobs.
 * validateLiveJobs alone rejects more than one page of jobs, so the merged copy is
 * checked in page-sized slices. Each job must use the upstream wire keys (no `slug`).
 */
export function validateLiveJobsBoard(input) {
  if (!isRecord(input) || !Array.isArray(input.jobs)) return { ok: false, error: 'invalid_jobs' };
  const jobs = [];
  let first = null;
  for (let start = 0; start === 0 || start < input.jobs.length; start += LIVE_JOBS_PAGE_SIZE) {
    const page = validateLiveJobs({ ...input, jobs: input.jobs.slice(start, start + LIVE_JOBS_PAGE_SIZE) });
    if (!page.ok) return page;
    first ??= page;
    for (const job of page.data.jobs) jobs.push(job);
  }
  return { ok: true, data: { ...first.data, jobs } };
}

/** Wire shape of a validated job (drops the derived `slug`) for re-caching. */
export function liveJobWireRecord(job) {
  const wire = { ...job };
  delete wire.slug;
  return wire;
}

export function jobPostingDescription(job) {
  const place = locationLabel(job);
  const channel = CHANNEL_LABELS[job.applicationChannel] ?? job.applicationChannel;
  const parts = [
    `${job.role} at ${job.company}.`,
    place ? `Location: ${place}.` : null,
    `Application channel: ${channel}.`,
    TRUST_LINE + '.',
    'Apply through JobAppAgent on the employer\'s own posting; nothing is auto-submitted.',
  ].filter(Boolean);
  return parts.join(' ');
}

const LIVE_STATUSES = new Set(['open', 'closed', 'unknown']);

export function communityJobsLiveUpstreamUrl(upstream, requestUrl) {
  let target;
  try { target = new URL(upstream); } catch { throw new Error('invalid upstream'); }
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('invalid upstream');
  for (const key of requestUrl.searchParams.keys()) {
    if (!['limit', 'cursor', 'status'].includes(key)) throw new Error('invalid query');
  }
  const rawLimit = requestUrl.searchParams.get('limit');
  const limit = rawLimit == null ? 25 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid query');
  const cursor = requestUrl.searchParams.get('cursor');
  if (cursor !== null && (!cursor || cursor.length > 1024)) throw new Error('invalid query');
  const status = requestUrl.searchParams.get('status');
  if (status !== null && !LIVE_STATUSES.has(status)) throw new Error('invalid query');
  target.search = '';
  target.hash = '';
  target.searchParams.set('limit', String(limit));
  if (cursor !== null) target.searchParams.set('cursor', cursor);
  if (status !== null) target.searchParams.set('status', status);
  return target.toString();
}

/** Hide roles whose last check is older than 3 days (or never checked). Closed roles stay findable by slug. */
export function isFreshForBoard(job, now = Date.now()) {
  if (!job?.lastCheckedAt) return false;
  const checked = Date.parse(job.lastCheckedAt);
  if (!Number.isFinite(checked)) return false;
  return now - checked <= STALE_MS;
}

export function isListedOpenJob(job, now = Date.now()) {
  return job?.livenessStatus === 'open' && isFreshForBoard(job, now);
}

export function classifyRoleFamily(role) {
  const text = String(role ?? '').toLowerCase();
  if (/\b(design|designer|ux|ui|product design)\b/.test(text)) return 'Design';
  if (/\b(data|ml|machine learning|analytics|scientist)\b/.test(text)) return 'Data';
  if (/\b(product manager|product owner|\bpm\b)\b/.test(text)) return 'Product';
  if (/\b(engineer|engineering|developer|sre|backend|frontend|full[- ]?stack|platform|software)\b/.test(text)) return 'Engineering';
  return 'Other';
}

export function formatReviewedDate(isoDate, timeZone = 'UTC') {
  try {
    const target = Date.parse(isoDate);
    if (!Number.isFinite(target)) return '';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(new Date(target));
  } catch {
    return String(isoDate ?? '').slice(0, 10);
  }
}

export function formatClosedDate(isoDate, timeZone = 'UTC') {
  try {
    const target = Date.parse(isoDate);
    if (!Number.isFinite(target)) return '';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(new Date(target));
  } catch {
    return String(isoDate ?? '').slice(0, 10);
  }
}

export function locationLabel(job) {
  if (job?.location?.label) return job.location.label;
  if (job?.location?.workplace === 'remote') return 'Remote';
  if (job?.location?.workplace === 'hybrid') return 'Hybrid';
  if (job?.location?.workplace === 'onsite') return 'On-site';
  return '';
}

export function similarOpenRoles(job, openJobs, limit = 3) {
  const family = classifyRoleFamily(job.role);
  const scored = openJobs
    .filter((candidate) => candidate.jobId !== job.jobId)
    .map((candidate) => {
      let score = 0;
      if (classifyRoleFamily(candidate.role) === family) score += 3;
      if (candidate.company === job.company) score += 1;
      if ((candidate.location?.workplace ?? '') === (job.location?.workplace ?? '')) score += 1;
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score || b.candidate.lastCheckedAt.localeCompare(a.candidate.lastCheckedAt));
  return scored.slice(0, limit).map((row) => row.candidate);
}

export function filterBoardJobs(jobs, { role = '', location = '', postedDays = 0, now = Date.now() } = {}) {
  const days = Number(postedDays) || 0;
  return jobs.filter((job) => {
    if (!isListedOpenJob(job, now)) return false;
    if (role && classifyRoleFamily(job.role) !== role) return false;
    if (location) {
      const hay = `${locationLabel(job)} ${job.location?.cities?.join(' ') ?? ''} ${job.location?.countries?.join(' ') ?? ''}`.toLowerCase();
      if (!location.toLowerCase().split(/\s+/).filter(Boolean).every((term) => hay.includes(term))) return false;
    }
    if (days > 0) {
      const seen = Date.parse(job.firstSeenAt);
      if (!Number.isFinite(seen) || now - seen > days * 86400000) return false;
    }
    return true;
  });
}

export function attachBoardLocations(jobs, locationIndex, now = Date.now()) {
  return attachLocations(jobs, locationIndex, now);
}

export function jobPostingJsonLd(job, { siteUrl = 'https://jobappagent.com' } = {}) {
  const url = `${siteUrl}/jobs/${job.slug}`;
  const closed = job.livenessStatus === 'closed';
  const remote = job.location?.workplace === 'remote';
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.role,
    description: jobPostingDescription(job),
    datePosted: job.firstSeenAt.slice(0, 10),
    hiringOrganization: {
      '@type': 'Organization',
      name: job.company,
      sameAs: job.providerUrl,
    },
    url,
    directApply: false,
    identifier: {
      '@type': 'PropertyValue',
      name: 'JobAppAgent',
      value: job.jobId,
    },
  };
  if (job.lastCheckedAt) posting.dateModified = job.lastCheckedAt.slice(0, 10);
  if (closed && job.closedAt) {
    posting.validThrough = job.closedAt.slice(0, 10);
  } else if (!closed) {
    const base = Date.parse(job.lastCheckedAt ?? job.firstSeenAt);
    if (Number.isFinite(base)) {
      posting.validThrough = new Date(base + VALID_THROUGH_MS).toISOString().slice(0, 10);
    }
  }

  const place = locationLabel(job);
  const countries = Array.isArray(job.location?.countries) ? job.location.countries.filter(Boolean) : [];
  if (remote) {
    posting.jobLocationType = 'TELECOMMUTE';
    const requirements = countries.length > 0
      ? countries.map((code) => ({
        '@type': 'Country',
        name: countryLabel(code),
        ...(/^[A-Za-z]{2}$/.test(code) ? { identifier: code.toUpperCase() } : {}),
      }))
      : [{ '@type': 'Country', name: place && place !== 'Remote' ? place.replace(/^Remote(?:\s*[·|,]\s*)?/i, '').trim() || 'Worldwide' : 'Worldwide' }];
    posting.applicantLocationRequirements = requirements.length === 1 ? requirements[0] : requirements;
  }
  if (place || countries.length > 0) {
    const address = { '@type': 'PostalAddress' };
    if (place) address.addressLocality = place;
    if (countries.length === 1 && /^[A-Za-z]{2}$/.test(countries[0])) {
      address.addressCountry = countries[0].toUpperCase();
    } else if (countries.length === 1) {
      address.addressCountry = countryLabel(countries[0]);
    }
    posting.jobLocation = { '@type': 'Place', address };
  }
  if (job.location?.employmentType) {
    const map = {
      'full-time': 'FULL_TIME',
      'part-time': 'PART_TIME',
      contract: 'CONTRACTOR',
      internship: 'INTERN',
    };
    posting.employmentType = map[job.location.employmentType] ?? job.location.employmentType.toUpperCase();
  }
  return posting;
}
