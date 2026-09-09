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

export const canonical = value => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/(?:apply|application)\/?$/, '').replace(/\/$/, '')}`;
  } catch {
    return '';
  }
};

const title = value => label(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function titlesMatch(atsTitle, jobTitle) {
  const a = title(atsTitle);
  const b = title(jobTitle);
  if (!a || !b) return false;
  if (a === b) return true;
  const stripSuffix = val => label(val)
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

export function atsTarget(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const parts = url.pathname.split('/').filter(Boolean).filter(part => !['apply', 'application'].includes(part));
  if (parts.length < 2) return null;

  if (url.hostname === 'jobs.ashbyhq.com') {
    const [board, id] = parts;
    if (/^[\w.-]+$/.test(board) && /^[\w-]+$/.test(id)) {
      return { kind: 'ashby', id, url: `https://api.ashbyhq.com/posting-api/job-board/${board}` };
    }
  }

  if (['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'].includes(url.hostname)) {
    const [board, segment, id] = parts;
    if (segment === 'jobs' && /^\d+$/.test(id) && /^[\w-]+$/.test(board)) {
      return { kind: 'greenhouse', id, url: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}` };
    }
  }

  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(url.hostname)) {
    const [board, id] = parts;
    if (/^[\w-]+$/.test(board) && /^[\w-]+$/.test(id)) {
      return { kind: 'lever', id, url: `https://${url.hostname === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${board}/${id}` };
    }
  }

  if (url.hostname === 'apply.workable.com') {
    const [account, segment, id] = parts;
    if (segment === 'j' && /^[\w-]+$/.test(account) && /^[\w-]+$/.test(id)) {
      return { kind: 'workable', id, url: `https://apply.workable.com/api/v2/accounts/${account}/jobs/${id}` };
    }
  }

  return null;
}

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–'
};

export function parseSalaryDetails(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp|mdash|ndash);/g, match => HTML_ENTITIES[match] || match)
    .replace(/<[^>]+>/g, ' ');

  const rangeRegex = /(?:([$€£]|CAD\s*\$|USD\s*\$)\s*)?([\d,]+(?:\.\d+)?)\s*([kK])?\s*(?:[-–—]|to)\s*([$€£]|CAD\s*\$|USD\s*\$)?\s*([\d,]+(?:\.\d+)?)\s*([kK])?\s*(USD|EUR|GBP|CAD)?(?:\s*(?:\/|\bper\b)\s*(year|yr|annum|annual|month|mo|hour|hr))?/i;
  const singleRegex = /(?:([$€£]|CAD\s*\$|USD\s*\$)\s*)?([\d,]+(?:\.\d+)?)\s*([kK])?\s*(USD|EUR|GBP|CAD)?(?:\s*(?:\/|\bper\b)\s*(year|yr|annum|annual|month|mo|hour|hr))?/i;

  const keywords = /(?:salary|compensation|pay\s+range|pay\s+rate|remuneration|wage|ote|base\s+pay)[^.\n;]{0,120}/gi;
  let candidates = [];
  let kw;
  while ((kw = keywords.exec(clean)) !== null) {
    candidates.push(kw[0]);
  }
  if (candidates.length === 0) {
    // If no keyword sentence, check for prominent explicit range patterns
    const m = clean.match(/[$€£]\s*[\d,]+\s*(?:k|K)?\s*[-–—]\s*[$€£]?\s*[\d,]+\s*(?:k|K)?/);
    if (m) candidates.push(m[0]);
  }

  for (const cand of candidates) {
    const rm = cand.match(rangeRegex);
    if (rm && (rm[1] || rm[4] || rm[3] || rm[6] || rm[7] || rm[8])) {
      const currSymbol = rm[1] || rm[4] || '$';
      const currency = rm[7] || (currSymbol.includes('€') ? 'EUR' : currSymbol.includes('£') ? 'GBP' : currSymbol.includes('CAD') ? 'CAD' : 'USD');
      let min = parseFloat(rm[2].replace(/,/g, ''));
      let max = parseFloat(rm[5].replace(/,/g, ''));
      if (rm[3] || (rm[6] && min < 1000)) min *= 1000;
      if (rm[6]) max *= 1000;
      if (min < 1000 && max < 1000 && (rm[0].includes('k') || rm[0].includes('K'))) {
        min *= 1000; max *= 1000;
      }
      const period = rm[8] ? (rm[8].startsWith('m') ? 'month' : rm[8].startsWith('h') ? 'hour' : 'year') : (min > 30000 ? 'year' : min > 3000 ? 'month' : 'hour');
      if (min > 0 && max >= min && max < 2000000) {
        return formatSalary(min, max, currency, period, false, 'employer');
      }
    }

    const sm = cand.match(singleRegex);
    if (sm && (sm[1] || sm[3] || sm[4] || sm[5])) {
      const currSymbol = sm[1] || '$';
      const currency = sm[4] || (currSymbol.includes('€') ? 'EUR' : currSymbol.includes('£') ? 'GBP' : currSymbol.includes('CAD') ? 'CAD' : 'USD');
      let val = parseFloat(sm[2].replace(/,/g, ''));
      if (sm[3] || (val < 1000 && (sm[0].includes('k') || sm[0].includes('K')))) val *= 1000;
      const period = sm[5] ? (sm[5].startsWith('m') ? 'month' : sm[5].startsWith('h') ? 'hour' : 'year') : (val > 30000 ? 'year' : val > 3000 ? 'month' : 'hour');
      if (val >= 15 && val < 2000000) {
        return formatSalary(val, val, currency, period, false, 'employer');
      }
    }
  }

  return null;
}

function formatSalary(min, max, currency, period, isEstimated, source) {
  const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'CAD' ? 'CA$' : '$';
  const periodLabel = period === 'year' ? '/yr' : period === 'month' ? '/mo' : '/hr';
  const formatVal = v => v >= 1000 ? (v % 1000 === 0 ? `${v / 1000}k` : `${(v / 1000).toFixed(v % 100 === 0 ? 1 : 0)}k`) : `${v}`;
  const label = (isEstimated ? 'Est. ' : '') + (min === max ? `${sym}${formatVal(min)} ${periodLabel}` : `${sym}${formatVal(min)} – ${sym}${formatVal(max)} ${periodLabel}`);
  const multiplier = period === 'year' ? 1 : period === 'month' ? 12 : 2080;
  return {
    min,
    max,
    annualMin: Math.round(min * multiplier),
    annualMax: Math.round(max * multiplier),
    currency,
    period,
    label,
    isEstimated,
    source
  };
}

export function extractExperienceLevel(role) {
  const r = role.toLowerCase();
  if (/\b(intern|internship|co-op)\b/.test(r)) return 'intern';
  if (/\b(junior|jr\b|graduate|associate|entry)\b/.test(r)) return 'entry';
  if (/\b(staff|principal|distinguished|fellow|architect)\b/.test(r)) return 'staff';
  if (/\b(director|vp\b|head\s+of|chief)\b/.test(r)) return 'executive';
  if (/\b(senior|sr\b|lead|specialist)\b/.test(r)) return 'senior';
  return 'mid';
}

export function extractEmploymentType(role, atsType) {
  if (typeof atsType === 'string') {
    const norm = atsType.toLowerCase();
    if (norm.includes('contract') || norm.includes('freelance')) return 'contract';
    if (norm.includes('intern')) return 'internship';
    if (norm.includes('part')) return 'part-time';
    if (norm.includes('full')) return 'full-time';
  }
  const r = role.toLowerCase();
  if (/\b(intern|internship|co-op)\b/.test(r)) return 'internship';
  if (/\b(contract|contractor|freelance|temp\b)\b/.test(r)) return 'contract';
  if (/\b(part-time|part time)\b/.test(r)) return 'part-time';
  return 'full-time';
}

export function estimateBenchmarkSalary(role, country) {
  const r = role.toLowerCase();
  let family = 'software-eng';
  if (/\b(ai|ml|machine\s+learning|deep\s+learning|llm|nlp|research\s+scientist|computer\s+vision)\b/.test(r)) {
    family = 'ai-ml';
  } else if (/\b(devops|sre|site\s+reliability|infrastructure|cloud|platform\s+engineer|security|cyber)\b/.test(r)) {
    family = 'infra-sre-security';
  } else if (/\b(data\s+engineer|data\s+analyst|analytics|business\s+intelligence)\b/.test(r)) {
    family = 'data';
  } else if (/\b(product\s+manager|product\s+lead|designer|product\s+design|ux|ui)\b/.test(r)) {
    family = 'product-design';
  } else if (/\b(sales|account\s+executive|bdr|sdr|marketing|growth|customer\s+success)\b/.test(r)) {
    family = 'gtm-sales-marketing';
  }

  const level = extractExperienceLevel(role);

  const benchmarks = {
    'ai-ml': {
      intern: [55000, 95000], entry: [125000, 175000], mid: [160000, 225000],
      senior: [200000, 285000], staff: [260000, 380000], executive: [300000, 450000]
    },
    'software-eng': {
      intern: [40000, 80000], entry: [105000, 145000], mid: [135000, 185000],
      senior: [170000, 235000], staff: [220000, 320000], executive: [260000, 380000]
    },
    'infra-sre-security': {
      intern: [40000, 75000], entry: [100000, 140000], mid: [130000, 180000],
      senior: [165000, 230000], staff: [215000, 300000], executive: [250000, 360000]
    },
    'data': {
      intern: [35000, 70000], entry: [90000, 130000], mid: [120000, 165000],
      senior: [155000, 215000], staff: [200000, 280000], executive: [240000, 340000]
    },
    'product-design': {
      intern: [35000, 70000], entry: [95000, 135000], mid: [130000, 175000],
      senior: [165000, 225000], staff: [210000, 290000], executive: [250000, 360000]
    },
    'gtm-sales-marketing': {
      intern: [30000, 60000], entry: [60000, 90000], mid: [90000, 140000],
      senior: [130000, 190000], staff: [160000, 230000], executive: [200000, 320000]
    }
  };

  const [baseMin, baseMax] = benchmarks[family][level];
  let currency = 'USD';
  let factor = 1.0;
  if (country === 'United Kingdom' || country === 'GB') {
    currency = 'GBP';
    factor = 0.65;
  } else if (['Germany', 'France', 'Netherlands', 'Spain', 'Italy', 'Ireland', 'Sweden', 'DE', 'FR', 'NL', 'ES', 'IT', 'IE', 'SE'].includes(country)) {
    currency = 'EUR';
    factor = 0.65;
  } else if (country === 'Canada' || country === 'CA') {
    currency = 'CAD';
    factor = 1.05;
  } else if (country && !['United States', 'USA', 'US'].includes(country)) {
    factor = 0.60;
  }

  const min = Math.round((baseMin * factor) / 5000) * 5000;
  const max = Math.round((baseMax * factor) / 5000) * 5000;
  return formatSalary(min, max, currency, 'year', true, 'market-benchmark');
}

export function extractLocation(job, data) {
  const target = atsTarget(job.url);
  if (!target || !data || typeof data !== 'object') return null;
  let entry, names = [], cities = [], countries = [], workplace = 'unknown';
  let salary = null, atsEmploymentType = null;

  if (target.kind === 'ashby') {
    entry = Array.isArray(data.jobs) ? data.jobs.find(item => item?.id === target.id) : null;
    if (!entry || entry.isListed === false || !titlesMatch(entry.title, job.role) || canonical(entry.jobUrl) !== canonical(job.url)) return null;
    const locations = [entry, ...(Array.isArray(entry.secondaryLocations) ? entry.secondaryLocations : [])];
    names = locations.map(item => label(item?.location));
    cities = locations.map(item => label(item?.address?.postalAddress?.addressLocality));
    countries = locations.map(item => label(item?.address?.postalAddress?.addressCountry));
    workplace = ({ Remote: 'remote', Hybrid: 'hybrid', OnSite: 'onsite' })[entry.workplaceType] ?? (entry.isRemote === true ? 'remote' : 'unknown');
    atsEmploymentType = entry.employmentType;
    salary = parseSalaryDetails(entry.descriptionPlain || entry.descriptionHtml);
  } else if (target.kind === 'greenhouse') {
    entry = data;
    if (String(entry.id) !== target.id || !titlesMatch(entry.title, job.role)) return null;
    let isGreenhouseHost = false;
    if (entry.absolute_url) {
      try {
        const host = new URL(entry.absolute_url).hostname;
        isGreenhouseHost = host === 'greenhouse.io' || host.endsWith('.greenhouse.io');
      } catch {}
    }
    if (isGreenhouseHost && canonical(entry.absolute_url).replace('://boards.greenhouse.io/', '://job-boards.greenhouse.io/') !== canonical(job.url).replace('://boards.greenhouse.io/', '://job-boards.greenhouse.io/')) return null;

    names = [label(entry.location?.name)];
    if (Array.isArray(entry.offices)) {
      for (const off of entry.offices) {
        if (off?.name) names.push(label(off.name));
        if (off?.location) names.push(label(off.location));
      }
    }
    const combinedLabels = names.filter(Boolean).join(' ');
    const types = combinedLabels.match(/\b(remote|hybrid|on-site|onsite)\b/gi) ?? [];
    if (types.length === 1 && /^(remote|hybrid|on-site|onsite)(?:$|\s|,|\()/i.test(names[0] || combinedLabels)) {
      workplace = types[0].toLowerCase().replace('on-site', 'onsite');
    } else if (combinedLabels.toLowerCase().includes('remote')) {
      workplace = 'remote';
    } else if (combinedLabels.toLowerCase().includes('hybrid')) {
      workplace = 'hybrid';
    }
    salary = parseSalaryDetails(entry.content);
  } else if (target.kind === 'lever') {
    entry = data;
    if (entry.id !== target.id || !titlesMatch(entry.text, job.role) || canonical(entry.hostedUrl) !== canonical(job.url)) return null;
    names = Array.isArray(entry.categories?.allLocations) ? entry.categories.allLocations.map(label) : [label(entry.categories?.location)];
    countries = [label(entry.country)];
    workplace = ['remote', 'hybrid', 'on-site'].includes(entry.workplaceType) ? entry.workplaceType.replace('on-site', 'onsite') : 'unknown';
    atsEmploymentType = entry.categories?.commitment;
    salary = parseSalaryDetails(entry.additionalPlain || entry.additional || entry.descriptionPlain);
  } else if (target.kind === 'workable') {
    entry = data;
    if (!titlesMatch(entry.title, job.role)) return null;
    if (entry.location) {
      if (entry.location.city) cities.push(label(entry.location.city));
      if (entry.location.country) countries.push(label(entry.location.country));
      if (entry.location.region) names.push(label(entry.location.region));
      if (entry.location.country) names.push(label(entry.location.country));
    }
    if (entry.workplace) {
      workplace = entry.workplace === 'on_site' ? 'onsite' : entry.workplace;
    } else if (entry.remote) {
      workplace = 'remote';
    }
    atsEmploymentType = entry.employment_type;
    salary = parseSalaryDetails(entry.salary || entry.description);
  }

  const result = {
    label: unique(names).join(' · '),
    cities: unique(cities),
    countries: unique(countries),
    workplace,
    salary: salary || null,
    employmentType: extractEmploymentType(job.role, atsEmploymentType),
    experienceLevel: extractExperienceLevel(job.role)
  };

  if (!result.label && !result.cities.length && !result.countries.length && workplace === 'unknown') return null;
  return result;
}

export function attachLocations(jobs, index, now = Date.now()) {
  const records = new Map(index.records.map(record => [record.jobId, record]));
  return jobs.map(job => {
    const record = records.get(job.jobId);
    const age = now - Date.parse(record?.checkedAt);
    const valid = record && record.url === job.url && record.role === job.role && record.company === job.company && age >= 0 && age <= 30 * 86400000;
    if (!valid) return { ...job, location: null };

    const countries = unique((record.countries || []).map(countryLabel));
    const salary = record.salary || estimateBenchmarkSalary(job.role, countries[0]);
    const employmentType = record.employmentType || extractEmploymentType(job.role);
    const experienceLevel = record.experienceLevel || extractExperienceLevel(job.role);

    return {
      ...job,
      location: {
        ...record,
        countries,
        salary,
        employmentType,
        experienceLevel
      }
    };
  });
}

