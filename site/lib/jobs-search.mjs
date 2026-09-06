import { validateCommunityJobs } from './community-jobs.mjs';
export async function loadPublishedJobs(fetcher, signal) {
  const jobs = new Map();
  const cursors = new Set();
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetcher(`/api/community-jobs?${query}`, { signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Jobs unavailable');
    const validated = validateCommunityJobs(await response.json());
    if (!validated.ok) throw new Error('Invalid jobs response');
    for (const job of validated.data.jobs) jobs.set(job.jobId, job);
    cursor = validated.data.nextCursor;
    if (!cursor) return [...jobs.values()];
    if (cursors.has(cursor)) throw new Error('Repeated jobs cursor');
    cursors.add(cursor);
  }
  throw new Error('Jobs page limit exceeded');
}
export function searchJobs(jobs, { query = '', company = '', channel = '', sort = 'newest' } = {}) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return jobs.filter(job => {
    const text = `${job.role} ${job.company} ${new URL(job.url).hostname}`.toLowerCase();
    return (!company || job.company === company) && (!channel || job.applicationChannel === channel) && terms.every(term => text.includes(term));
  }).sort((a, b) => {
    const order = sort === 'company' ? a.company.localeCompare(b.company) || a.role.localeCompare(b.role)
      : sort === 'oldest' ? a.firstSeenAt.localeCompare(b.firstSeenAt) : b.firstSeenAt.localeCompare(a.firstSeenAt);
    return order || a.jobId.localeCompare(b.jobId);
  });
}
