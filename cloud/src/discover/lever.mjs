import { canonicalJob, guessWorkMode } from './normalize.mjs';

export async function fetchLeverBoard(slug, company, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  if (!response.ok) throw new Error(`Lever ${slug} returned HTTP ${response.status}.`);
  const body = await response.json();
  return (Array.isArray(body) ? body : []).map((job) => canonicalJob({
    company: company || slug,
    role: job.text,
    title: job.text,
    description: stripHtml(job.descriptionPlain || job.description || job.text),
    url: job.hostedUrl || job.applyUrl,
    employerJobId: job.id ? `lever:${job.id}` : null,
    applicationChannel: 'lever',
    discoverySource: 'direct-company',
    locations: job.categories?.location ? [job.categories.location] : [],
    workMode: guessWorkMode(`${job.text}\n${job.descriptionPlain || ''}\n${job.categories?.location || ''}`),
    raw: { id: job.id },
  }));
}

function stripHtml(value) {
  return String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
