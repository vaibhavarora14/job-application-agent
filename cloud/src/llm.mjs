/**
 * Reader/writer only. Never decides Send.
 *
 * Provider order:
 *   1. Ollama on the user's laptop (OLLAMA_HOST over Tailscale)
 *   2. Hosted default (Anthropic, or OpenAI if ANTHROPIC_API_KEY is unset)
 *   3. Keyword-overlap heuristic when no provider is configured
 *
 * If a provider is configured but unreachable, return pending_llm so the
 * rest of the round continues.
 */

const SYSTEM = `You are a careful reader for a job-application agent.
Return JSON only. No markdown. No extra keys.
When you claim the résumé meets a requirement, quote the résumé text that supports it.
If you cannot quote supporting text, use status "unclear" — never invent coverage.`;

const ROLE_FAMILIES = [
  'frontend', 'backend', 'full-stack', 'product-engineering', 'ai-ml', 'platform',
  'infrastructure', 'mobile', 'engineering-management', 'architecture', 'security', 'data', 'other',
];
const SENIORITIES = ['junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'founding', 'unspecified'];
const WORK_MODES = ['remote', 'hybrid', 'onsite', 'unspecified'];

export function resumeHash(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function resumeTextFromProfile(profile = {}, extras = {}) {
  const skills = Array.isArray(profile.skills) ? profile.skills.join(', ') : '';
  return [
    extras.motivationBlurb,
    profile.name,
    profile.workAuthorization,
    skills,
    profile.linkedin,
    profile.github,
    profile.portfolio,
    profile.availability,
    profile.location,
  ].filter(Boolean).join('\n');
}

export function guessRoleFamily(title, description) {
  const hay = `${title}\n${description}`.toLowerCase();
  if (/\b(machine learning|ml engineer|llm|ai engineer|deep learning)\b/.test(hay)) return 'ai-ml';
  if (/\b(full[-\s]?stack)\b/.test(hay)) return 'full-stack';
  if (/\b(front[-\s]?end|react|vue|css)\b/.test(hay)) return 'frontend';
  if (/\b(back[-\s]?end|api engineer|distributed)\b/.test(hay)) return 'backend';
  if (/\b(platform)\b/.test(hay)) return 'platform';
  if (/\b(sre|infrastructure|devops|reliability)\b/.test(hay)) return 'infrastructure';
  if (/\b(ios|android|mobile)\b/.test(hay)) return 'mobile';
  if (/\b(security|appsec)\b/.test(hay)) return 'security';
  if (/\b(data engineer|analytics)\b/.test(hay)) return 'data';
  if (/\b(engineering manager|director of engineering)\b/.test(hay)) return 'engineering-management';
  if (/\b(product engineer|product-minded)\b/.test(hay)) return 'product-engineering';
  return 'other';
}

export function guessSeniority(title) {
  const hay = String(title || '').toLowerCase();
  if (/\b(staff|principal|distinguished|fellow)\b/.test(hay)) return 'staff';
  if (/\b(senior|sr\.?|lead)\b/.test(hay)) return 'senior';
  if (/\b(intern|junior|jr\.?|graduate|entry)\b/.test(hay)) return 'junior';
  if (/\b(manager|director|head of)\b/.test(hay)) return 'manager';
  return 'mid';
}

export function heuristicAssess({ job, resumeText, profile = {} }) {
  const hay = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  const resume = String(resumeText || '').toLowerCase();
  const skills = Array.isArray(profile.skills) ? profile.skills : [];
  const mustHaves = (skills.length ? skills : ['relevant experience']).map((skill) => {
    const token = String(skill).toLowerCase();
    const inJob = token.length >= 3 && hay.includes(token);
    const inResume = token.length >= 3 && resume.includes(token);
    if (inJob && inResume) {
      const idx = resume.indexOf(token);
      return {
        requirement: skill,
        status: 'met',
        evidence: String(resumeText).slice(Math.max(0, idx - 20), idx + token.length + 40).trim(),
      };
    }
    if (inJob && !inResume) return { requirement: skill, status: 'missing' };
    if (!inJob && inResume) return { requirement: skill, status: 'partial', evidence: skill };
    return { requirement: skill, status: 'unclear' };
  });
  return {
    provider: 'heuristic',
    pendingLlm: false,
    eligibility: 'eligible',
    postingStatus: 'active',
    seniority: guessSeniority(job.title),
    roleFamily: guessRoleFamily(job.title, job.description),
    workMode: job.workMode || 'unspecified',
    mustHaves,
  };
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('llm: no JSON object in response');
  return JSON.parse(raw.slice(start, end + 1));
}

function quoteOrUnclear(assessment, resumeText) {
  if (!assessment || typeof assessment !== 'object') return assessment;
  const resume = String(resumeText || '');
  const mustHaves = Array.isArray(assessment.mustHaves) ? assessment.mustHaves.map((item) => {
    if (!item || (item.status !== 'met' && item.status !== 'partial')) return item;
    const evidence = String(item.evidence || '').replace(/^quote:\s*/i, '').trim();
    if (evidence.length >= 8 && resume.toLowerCase().includes(evidence.slice(0, 40).toLowerCase())) return item;
    return { ...item, status: 'unclear', evidence: undefined };
  }) : [];
  return { ...assessment, mustHaves };
}

function clampEnum(value, allowed, fallback) {
  const v = String(value || '').toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

async function ollamaAvailable(env, fetchImpl) {
  const host = env.OLLAMA_HOST;
  if (!host) return false;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1500);
  try {
    const res = await fetchImpl(new URL('/api/tags', host), { signal: ac.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function ollamaComplete(prompt, env, fetchImpl) {
  const host = env.OLLAMA_HOST;
  const model = env.OLLAMA_MODEL || 'llama3.1';
  const res = await fetchImpl(new URL('/api/chat', host), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json();
  return data?.message?.content || '';
}

async function hostedComplete(prompt, env, fetchImpl) {
  if (env.ANTHROPIC_API_KEY) {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const data = await res.json();
    return data?.content?.[0]?.text || '';
  }
  if (env.OPENAI_API_KEY) {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || 'gpt-4.1-mini',
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  }
  throw new Error('no hosted key');
}

function providerConfigured(env) {
  return Boolean(env.OLLAMA_HOST || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);
}

async function completeJson(prompt, env, fetchImpl) {
  if (await ollamaAvailable(env, fetchImpl)) {
    return { provider: 'ollama', data: parseJsonObject(await ollamaComplete(prompt, env, fetchImpl)) };
  }
  if (env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY) {
    const name = env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai';
    return { provider: name, data: parseJsonObject(await hostedComplete(prompt, env, fetchImpl)) };
  }
  return null;
}

function normalizeAssessment(data, job) {
  return {
    eligibility: clampEnum(data.eligibility, ['eligible', 'unclear', 'ineligible'], 'unclear'),
    postingStatus: clampEnum(data.postingStatus, ['active', 'closed', 'unclear'], 'active'),
    seniority: clampEnum(data.seniority, SENIORITIES, guessSeniority(job.title)),
    roleFamily: clampEnum(data.roleFamily, ROLE_FAMILIES, guessRoleFamily(job.title, job.description)),
    workMode: clampEnum(data.workMode, WORK_MODES, job.workMode || 'unspecified'),
    mustHaves: Array.isArray(data.mustHaves) ? data.mustHaves : [],
  };
}

export async function assessJob({ job, resumeText, profile = {}, env = process.env, fetchImpl = fetch }) {
  const prompt = `Assess this role against the résumé.
Return {"eligibility":"eligible|unclear|ineligible","postingStatus":"active|closed|unclear","seniority":"junior|mid|senior|staff|unspecified","roleFamily":"product-engineering|full-stack|ai-ml|backend|frontend|other","workMode":"remote|hybrid|onsite|unspecified","mustHaves":[{"requirement":"…","status":"met|partial|missing|unclear","evidence":"quote from résumé"}]}
Title: ${job.title}
Company: ${job.company}
Listing:
${String(job.description || '').slice(0, 6000)}
Résumé:
${String(resumeText || '').slice(0, 8000)}
Skills: ${JSON.stringify(profile.skills || [])}`;

  try {
    const result = await completeJson(prompt, env, fetchImpl);
    if (result) {
      const cleaned = quoteOrUnclear(normalizeAssessment(result.data, job), resumeText);
      return { ...cleaned, provider: result.provider, pendingLlm: false };
    }
  } catch {
    if (providerConfigured(env)) {
      return {
        provider: 'none',
        pendingLlm: true,
        eligibility: 'unclear',
        postingStatus: 'active',
        seniority: 'unspecified',
        roleFamily: 'other',
        workMode: job.workMode || 'unspecified',
        mustHaves: [],
      };
    }
  }
  if (providerConfigured(env)) {
    return {
      provider: 'none',
      pendingLlm: true,
      eligibility: 'unclear',
      postingStatus: 'active',
      seniority: 'unspecified',
      roleFamily: 'other',
      workMode: job.workMode || 'unspecified',
      mustHaves: [],
    };
  }
  return heuristicAssess({ job, resumeText, profile });
}

export async function mapFields({ labels, profile, resumeText, env = process.env, fetchImpl = fetch }) {
  const prompt = `Map leftover application field labels to profile values.
Return {"mappings":[{"label":"…","value":"…","confidence":0-1}]}
Labels: ${JSON.stringify(labels)}
Profile keys: ${JSON.stringify(Object.keys(profile || {}))}
Résumé excerpt: ${String(resumeText || '').slice(0, 2000)}`;
  try {
    const result = await completeJson(prompt, env, fetchImpl);
    if (result?.data?.mappings) return result.data.mappings;
  } catch {
    // leftover labels stay unclear
  }
  return [];
}

export async function draftAnswer({ prompt: userPrompt, aboutMe, job, env = process.env, fetchImpl = fetch }) {
  const prompt = `Draft a short application answer in first person from the saved blurb only. Do not invent employers or years.
Return {"text":"…"}
Prompt: ${userPrompt}
About me: ${aboutMe || ''}
Role: ${job?.title || ''} at ${job?.company || ''}`;
  try {
    const result = await completeJson(prompt, env, fetchImpl);
    if (result?.data?.text) return String(result.data.text);
  } catch {
    // no draft
  }
  return aboutMe ? String(aboutMe).slice(0, 600) : '';
}

export async function providerStatus(env = process.env, fetchImpl = fetch) {
  const ollama = await ollamaAvailable(env, fetchImpl);
  return {
    ollama,
    hosted: Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY),
    heuristic: !env.OLLAMA_HOST && !env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY,
  };
}
