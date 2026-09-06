const label = value => typeof value === 'string' && value.trim().length <= 240 && !/[<>]/.test(value) && ![...value].some(char => char.charCodeAt(0) < 32) ? value.trim() : '';
const unique = values => [...new Set(values.filter(Boolean))];
export function countryLabel(value) {
  if (['USA', 'United States of America'].includes(value)) return 'United States';
  if (value === 'UK') return 'United Kingdom';
  if (!/^[A-Za-z]{2}$/.test(value)) return value;
  return new Intl.DisplayNames(['en'], { type: 'region' }).of(value.toUpperCase()) ?? value;
}
export function locationText(location) {
  if (!location) return '';
  return [location.label, ...location.cities, ...location.countries, ...location.countries.map(countryLabel)].join(' ');
}
const title = value => label(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const canonical = value => { try { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/apply\/?$/, '').replace(/\/$/, '')}`; } catch { return ''; } };

export function atsTarget(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.every(part => /^[\w-]+$/.test(part))) return null;
  const [board, id] = parts;
  if (url.hostname === 'jobs.ashbyhq.com' && board && id) return { kind: 'ashby', id, url: `https://api.ashbyhq.com/posting-api/job-board/${board}` };
  if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname) && parts[1] === 'jobs' && /^\d+$/.test(parts[2])) return { kind: 'greenhouse', id: parts[2], url: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${parts[2]}` };
  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(url.hostname) && board && id) return { kind: 'lever', id, url: `https://${url.hostname === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${board}/${id}` };
  return null;
}

export function extractLocation(job, data) {
  const target = atsTarget(job.url);
  if (!target || !data || typeof data !== 'object') return null;
  let entry, names = [], cities = [], countries = [], workplace = 'unknown';
  if (target.kind === 'ashby') {
    entry = Array.isArray(data.jobs) ? data.jobs.find(item => item?.id === target.id) : null;
    if (!entry || entry.isListed === false || title(entry.title) !== title(job.role) || canonical(entry.jobUrl) !== canonical(job.url)) return null;
    const locations = [entry, ...(Array.isArray(entry.secondaryLocations) ? entry.secondaryLocations : [])];
    names = locations.map(item => label(item?.location));
    cities = locations.map(item => label(item?.address?.postalAddress?.addressLocality));
    countries = locations.map(item => label(item?.address?.postalAddress?.addressCountry));
    workplace = ({ Remote: 'remote', Hybrid: 'hybrid', OnSite: 'onsite' })[entry.workplaceType] ?? (entry.isRemote === true ? 'remote' : 'unknown');
  } else if (target.kind === 'greenhouse') {
    entry = data;
    if (String(entry.id) !== target.id || title(entry.title) !== title(job.role) || canonical(entry.absolute_url).replace('://boards.greenhouse.io/', '://job-boards.greenhouse.io/') !== canonical(job.url).replace('://boards.greenhouse.io/', '://job-boards.greenhouse.io/')) return null;
    names = [label(entry.location?.name)];
    // Only explicit, unambiguous arrangement labels; a city alone never implies on-site.
    const types = names[0].match(/\b(remote|hybrid|on-site|onsite)\b/gi) ?? [];
    if (types.length === 1 && /^(remote|hybrid|on-site|onsite)(?:$|\s|,|\()/i.test(names[0])) workplace = types[0].toLowerCase().replace('on-site', 'onsite');
  } else {
    entry = data;
    if (entry.id !== target.id || title(entry.text) !== title(job.role) || canonical(entry.hostedUrl) !== canonical(job.url)) return null;
    names = Array.isArray(entry.categories?.allLocations) ? entry.categories.allLocations.map(label) : [label(entry.categories?.location)];
    countries = [label(entry.country)];
    workplace = ['remote', 'hybrid', 'on-site'].includes(entry.workplaceType) ? entry.workplaceType.replace('on-site', 'onsite') : 'unknown';
  }
  const result = { label: unique(names).join(' · '), cities: unique(cities), countries: unique(countries), workplace };
  if (!result.label && !result.cities.length && !result.countries.length && workplace === 'unknown') return null;
  return result;
}

export function attachLocations(jobs, index, now = Date.now()) {
  const records = new Map(index.records.map(record => [record.jobId, record]));
  return jobs.map(job => {
    const record = records.get(job.jobId);
    const age = now - Date.parse(record?.checkedAt);
    const valid = record && record.url === job.url && record.role === job.role && record.company === job.company && age >= 0 && age <= 30 * 86400000;
    return { ...job, location: valid ? { ...record, countries: unique(record.countries.map(countryLabel)) } : null };
  });
}
