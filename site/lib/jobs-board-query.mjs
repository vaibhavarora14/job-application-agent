/**
 * /jobs filter, sort and paging rules, shared by the server page, the count API
 * and the client filter UI. Pure functions over board jobs; no I/O.
 */
import { classifyRoleFamily, employerSalary, isListedOpenJob, locationLabel, postedDate } from './live-jobs.mjs';
import { toUsd } from './fx-rates.mjs';

export const JOBS_PAGE_SIZE = 50;
const MAX_SHOW = 2000;
const DAY_MS = 86400000;

export const WORKPLACE_OPTIONS = Object.freeze([
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On-site' },
]);
/** Minimum pay thresholds, USD per year (thousands). */
export const PAY_OPTIONS = Object.freeze([
  { value: 0, label: 'Any' },
  { value: 100, label: '$100K+' },
  { value: 150, label: '$150K+' },
  { value: 200, label: '$200K+' },
]);
export const LEVEL_OPTIONS = Object.freeze([
  { value: 'entry', label: 'Entry' },
  { value: 'mid', label: 'Mid' },
  { value: 'senior', label: 'Senior' },
  { value: 'staff', label: 'Staff+' },
  { value: 'intern', label: 'Intern' },
]);
export const POSTED_OPTIONS = Object.freeze([
  { value: 0, label: 'Any time' },
  { value: 1, label: '24 hours' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
]);
export const ROLE_OPTIONS = Object.freeze(['Engineering', 'Data', 'Design', 'Product', 'Other']);

/** Query keys the board understands (anything else is ignored). */
export const JOBS_QUERY_KEYS = Object.freeze(['workplace', 'loc', 'pay', 'nopay', 'level', 'posted', 'role', 'show', 'design']);

const WORKPLACES = new Set(WORKPLACE_OPTIONS.map((o) => o.value));
const LEVELS = new Set(LEVEL_OPTIONS.map((o) => o.value));
const PAYS = new Set(PAY_OPTIONS.map((o) => o.value));
const POSTEDS = new Set(POSTED_OPTIONS.map((o) => o.value));
const ROLES = new Set(ROLE_OPTIONS);
const DESIGN_STATES = new Set(['loading', 'error']);

/**
 * @typedef {{
 *   workplace: string[], loc: string, pay: number, nopay: boolean,
 *   level: string[], posted: number, role: string[], show: number, design: string | null,
 * }} BoardQuery
 */

/** @returns {BoardQuery} */
export function emptyBoardQuery() {
  return { workplace: [], loc: '', pay: 0, nopay: true, level: [], posted: 0, role: [], show: JOBS_PAGE_SIZE, design: null };
}

function first(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function list(value, allowed) {
  const raw = first(value);
  if (typeof raw !== 'string' || !raw) return [];
  const out = [];
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (allowed.has(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Parse URLSearchParams or a Next `searchParams` record into a validated query.
 * @param {URLSearchParams | Record<string, string | string[] | undefined> | null | undefined} input
 * @returns {BoardQuery}
 */
export function parseBoardQuery(input) {
  const get = (key) => {
    if (!input) return undefined;
    if (typeof input.get === 'function') return input.get(key) ?? undefined;
    return first(input[key]);
  };
  const query = emptyBoardQuery();
  query.workplace = list(get('workplace'), WORKPLACES);
  query.level = list(get('level'), LEVELS);
  query.role = list(get('role'), ROLES);
  const loc = get('loc');
  if (typeof loc === 'string') query.loc = loc.trim().replace(/\s+/g, ' ').slice(0, 80);
  const pay = Number(get('pay'));
  if (PAYS.has(pay)) query.pay = pay;
  if (get('nopay') === '0') query.nopay = false;
  const posted = Number(get('posted'));
  if (POSTEDS.has(posted)) query.posted = posted;
  const show = Number(get('show'));
  if (Number.isFinite(show) && show > JOBS_PAGE_SIZE) {
    query.show = Math.min(MAX_SHOW, Math.ceil(show / JOBS_PAGE_SIZE) * JOBS_PAGE_SIZE);
  }
  const design = get('design');
  if (typeof design === 'string' && DESIGN_STATES.has(design)) query.design = design;
  return query;
}

/**
 * Canonical query string (stable key order, defaults omitted). No leading "?".
 * @param {BoardQuery} query
 * @param {{ keepShow?: boolean, keepDesign?: boolean }} [options]
 */
export function boardQueryString(query, { keepShow = false, keepDesign = false } = {}) {
  const params = new URLSearchParams();
  if (query.level.length) params.set('level', query.level.join(','));
  if (query.loc) params.set('loc', query.loc);
  if (query.nopay === false) params.set('nopay', '0');
  if (query.pay) params.set('pay', String(query.pay));
  if (query.posted) params.set('posted', String(query.posted));
  if (query.role.length) params.set('role', query.role.join(','));
  if (keepShow && query.show > JOBS_PAGE_SIZE) params.set('show', String(query.show));
  if (query.workplace.length) params.set('workplace', query.workplace.join(','));
  if (keepDesign && query.design) params.set('design', query.design);
  return params.toString();
}

/** @param {BoardQuery} query @param {{ keepShow?: boolean }} [options] */
export function boardHref(query, options = {}) {
  const qs = boardQueryString(query, options);
  return qs ? `/jobs?${qs}` : '/jobs';
}

/** Number of filter groups in use (the Filters button badge). */
export function activeFilterCount(query) {
  let n = 0;
  if (query.workplace.length) n++;
  if (query.loc) n++;
  if (query.pay) n++;
  if (!query.nopay) n++;
  if (query.level.length) n++;
  if (query.posted) n++;
  if (query.role.length) n++;
  return n;
}

const label = (options, value) => options.find((o) => o.value === value)?.label ?? String(value);

/**
 * Removable chips for the active filters: one per value, each with the query that removes it.
 * @param {BoardQuery} query
 * @returns {{ key: string, label: string, query: BoardQuery }[]}
 */
export function activeFilterChips(query) {
  /** @type {{ key: string, label: string, query: BoardQuery }[]} */
  const chips = [];
  const without = (patch) => ({ ...query, show: JOBS_PAGE_SIZE, ...patch });
  for (const value of query.workplace) {
    chips.push({ key: `workplace:${value}`, label: label(WORKPLACE_OPTIONS, value), query: without({ workplace: query.workplace.filter((v) => v !== value) }) });
  }
  if (query.loc) chips.push({ key: 'loc', label: query.loc, query: without({ loc: '' }) });
  if (query.pay) chips.push({ key: 'pay', label: label(PAY_OPTIONS, query.pay), query: without({ pay: 0 }) });
  if (!query.nopay) chips.push({ key: 'nopay', label: 'Pay listed only', query: without({ nopay: true }) });
  for (const value of query.level) {
    chips.push({ key: `level:${value}`, label: label(LEVEL_OPTIONS, value), query: without({ level: query.level.filter((v) => v !== value) }) });
  }
  if (query.posted) {
    chips.push({ key: 'posted', label: query.posted === 1 ? 'Last 24 hours' : `Last ${query.posted} days`, query: without({ posted: 0 }) });
  }
  for (const value of query.role) {
    chips.push({ key: `role:${value}`, label: value, query: without({ role: query.role.filter((v) => v !== value) }) });
  }
  return chips;
}

const PERIOD_MULTIPLIER = { year: 1, month: 12, week: 52, day: 260, hour: 2080 };

/**
 * Highest employer-stated annual pay in USD across every listed band (monthly FX rates),
 * or null when the job lists no pay or only currencies without a rate.
 */
export function usdAnnualMax(job) {
  const salary = employerSalary(job);
  if (!salary) return null;
  const ranges = Array.isArray(salary.ranges) && salary.ranges.length ? salary.ranges : [salary];
  let best = null;
  for (const range of ranges) {
    const multiplier = PERIOD_MULTIPLIER[range?.period];
    if (!multiplier || !Number.isFinite(range.max)) continue;
    const usd = toUsd(range.max * multiplier, range.currency);
    if (usd != null && (best == null || usd > best)) best = usd;
  }
  return best;
}

/** Workplace chip label, or null when the employer did not state one. */
export function workplaceLabel(job) {
  const value = job?.location?.workplace;
  return WORKPLACE_OPTIONS.find((o) => o.value === value)?.label ?? null;
}

const WORKPLACE_WORD = /^(remote|hybrid|on-?site|in[- ]office|anywhere)$/i;

/** Short card location: first place plus "+N" for the rest ("Boston +3"); "" when unknown. */
export function compactLocation(job) {
  const full = locationLabel(job);
  if (!full) return '';
  const parts = full
    .split(' · ')
    .map((p) => p.trim().replace(/^remote\s*\((.+)\)$/i, '$1').replace(/^remote\s*[-–:,]\s*/i, ''))
    .filter((p) => p && !WORKPLACE_WORD.test(p));
  if (parts.length === 0) return '';
  return parts.length === 1 ? parts[0] : `${parts[0]} +${parts.length - 1}`;
}

/** "24 Sep" this year, "18 Dec 2025" otherwise. */
export function shortPostedLabel(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const sameYear = date.getUTCFullYear() === new Date(now).getUTCFullYear();
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' }).format(date);
}

function matches(job, query, now) {
  if (query.workplace.length && !query.workplace.includes(job.location?.workplace ?? '')) return false;
  if (query.level.length) {
    const level = job.location?.experienceLevel ?? '';
    const normalised = level === 'executive' ? 'staff' : level;
    if (!query.level.includes(normalised)) return false;
  }
  if (query.role.length && !query.role.includes(classifyRoleFamily(job.role))) return false;
  if (query.loc) {
    const hay = `${locationLabel(job)} ${(job.location?.cities ?? []).join(' ')} ${(job.location?.countries ?? []).join(' ')}`.toLowerCase();
    if (!query.loc.toLowerCase().split(' ').filter(Boolean).every((term) => hay.includes(term))) return false;
  }
  if (query.pay || !query.nopay) {
    if (!employerSalary(job)) {
      if (!query.nopay) return false;
    } else if (query.pay) {
      // Listed pay must reach the threshold; a currency without a rate never does.
      const usd = usdAnnualMax(job);
      if (usd == null || usd < query.pay * 1000) return false;
    }
  }
  if (query.posted) {
    const posted = Date.parse(postedDate(job, now));
    if (!Number.isFinite(posted) || now - posted > query.posted * DAY_MS) return false;
  }
  return true;
}

/** Listed-open jobs matching the query, newest posted first. */
export function filterAndSortJobs(jobs, query, now = Date.now()) {
  const out = [];
  for (const job of jobs ?? []) {
    if (isListedOpenJob(job, now) && matches(job, query, now)) out.push(job);
  }
  const posted = new Map(out.map((job) => [job, Date.parse(postedDate(job, now)) || 0]));
  return out.sort((a, b) => posted.get(b) - posted.get(a) || a.company.localeCompare(b.company));
}

/** Count only (sheet "Show N roles"). */
export function countMatchingJobs(jobs, query, now = Date.now()) {
  let n = 0;
  for (const job of jobs ?? []) if (isListedOpenJob(job, now) && matches(job, query, now)) n++;
  return n;
}

/**
 * Zero-results diagnosis: the one active filter whose removal brings back the most roles.
 * @returns {{ chip: { key: string, label: string, query: BoardQuery }, count: number } | null}
 */
export function likelyZeroCause(jobs, query, now = Date.now()) {
  let best = null;
  for (const chip of activeFilterChips(query)) {
    const count = countMatchingJobs(jobs, chip.query, now);
    if (count > 0 && (!best || count > best.count)) best = { chip, count };
  }
  return best;
}
