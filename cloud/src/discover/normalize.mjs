import { createHash } from 'node:crypto';

export function jobId({ company, role, employerJobId, url }) {
  const basis = employerJobId || url;
  const slug = `${String(company || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${String(role || 'role').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return `${slug.slice(0, 80)}-${createHash('sha1').update(String(basis)).digest('hex').slice(0, 10)}`;
}

export function guessWorkMode(text, remoteFlag) {
  const hay = String(text || '').toLowerCase();
  if (remoteFlag === true || /\bremote\b/.test(hay)) return 'remote';
  if (/\bhybrid\b/.test(hay)) return 'hybrid';
  if (/\bonsite\b|\bon-site\b|\bin office\b|\boffice\b/.test(hay)) return 'onsite';
  return 'unspecified';
}

export function canonicalJob(input) {
  const url = String(input.url || '').split('#')[0];
  if (!url.startsWith('https://')) throw new Error('Job url must be https.');
  const company = String(input.company || '').trim();
  const role = String(input.role || input.title || '').trim();
  const title = String(input.title || role).trim();
  const description = String(input.description || title);
  const applicationChannel = input.applicationChannel;
  const employerJobId = input.employerJobId ? String(input.employerJobId) : null;
  return {
    id: jobId({ company, role, employerJobId, url }),
    company,
    role,
    title,
    description,
    url,
    employerJobId,
    applicationChannel,
    discoverySource: input.discoverySource || 'direct-company',
    locations: input.locations || [],
    salaryMaximum: input.salaryMaximum ?? null,
    salaryCurrency: input.salaryCurrency ?? null,
    workMode: input.workMode || guessWorkMode(`${title}\n${description}\n${(input.locations || []).join(' ')}`, input.remote),
    questions: input.questions || null,
    raw: input.raw || null,
  };
}
