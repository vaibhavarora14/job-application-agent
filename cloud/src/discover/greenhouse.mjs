import { canonicalJob, guessWorkMode } from './normalize.mjs';

export async function fetchGreenhouseBoard(slug, company, fetchImpl = fetch) {
  const response = await fetchImpl(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
  if (!response.ok) throw new Error(`Greenhouse ${slug} returned HTTP ${response.status}.`);
  const body = await response.json();
  return (body.jobs || []).map((job) => canonicalJob({
    company: company || slug,
    role: job.title,
    title: job.title,
    description: stripHtml(job.content || job.title),
    url: job.absolute_url,
    employerJobId: job.id != null ? `greenhouse:${job.id}` : null,
    applicationChannel: 'greenhouse',
    discoverySource: 'direct-company',
    locations: job.location?.name ? [job.location.name] : [],
    workMode: guessWorkMode(`${job.title}\n${job.content || ''}\n${job.location?.name || ''}`),
    questions: job.questions || null,
    raw: { id: job.id, updated_at: job.updated_at },
  }));
}

function stripHtml(value) {
  return String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
