import { canonicalJob, guessWorkMode } from './normalize.mjs';

export async function fetchAshbyBoard(slug, company, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
  if (!response.ok) throw new Error(`Ashby ${slug} returned HTTP ${response.status}.`);
  const body = await response.json();
  return (body.jobs || []).filter((job) => job.isListed !== false).map((job) => canonicalJob({
    company: company || slug,
    role: job.title,
    title: job.title,
    description: stripHtml(job.descriptionPlain || job.descriptionHtml || job.title),
    url: job.jobUrl || job.applyUrl,
    employerJobId: job.id ? `ashby:${job.id}` : null,
    applicationChannel: 'ashby',
    discoverySource: 'direct-company',
    locations: [job.location, ...(job.secondaryLocations || []).map((item) => item.location)].filter(Boolean),
    salaryMaximum: job.compensation?.max ?? null,
    salaryCurrency: job.compensation?.currency ?? null,
    workMode: guessWorkMode(`${job.title}\n${job.location || ''}`),
    raw: { id: job.id },
  }));
}

function stripHtml(value) {
  return String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
