import { lookupAnswer } from '../answers.mjs';

const SYNONYMS = [
  { key: 'name', labels: ['full name', 'legal name', 'candidate name', 'your name'] },
  { key: 'firstName', labels: ['first name', 'given name', 'fname', 'forename'] },
  { key: 'lastName', labels: ['last name', 'family name', 'surname', 'lname'] },
  { key: 'email', labels: ['email', 'e-mail', 'corporate e-mail', 'work email', 'email address'] },
  { key: 'phone', labels: ['phone', 'mobile', 'telephone', 'phone number', 'mobile phone'] },
  { key: 'location', labels: ['location', 'city', 'current location', 'where are you based'] },
  { key: 'linkedin', labels: ['linkedin', 'linkedin url', 'linkedin profile'] },
  { key: 'github', labels: ['github', 'github url', 'git hub'] },
  { key: 'portfolio', labels: ['portfolio', 'website', 'personal website', 'personal url'] },
  { key: 'availability', labels: ['availability', 'notice', 'notice period', 'start date', 'notice (days)'] },
  { key: 'workAuthorization', labels: ['work authorization', 'authorized to work', 'right to work'] },
  { key: 'authorizedWithoutSponsorship', labels: ['authorized to work without sponsorship', 'require sponsorship', 'need sponsorship'] },
  { key: 'willingToRelocate', labels: ['willing to relocate', 'relocate', 'open to relocation'] },
  { key: 'howHeard', labels: ['how did you hear', 'how you heard', 'how did you find'] },
  { key: 'motivationBlurb', labels: ['why us', 'why this company', 'cover letter', 'why do you want', 'what interests you'] },
  { key: 'currentCompensation', labels: ['current compensation', 'current salary'] },
  { key: 'targetCompensation', labels: ['expected compensation', 'salary expectation', 'desired salary', 'compensation expectation'] },
];

export function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export function normalizeLabel(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function profileValueMap(profile = {}, extras = {}) {
  const { firstName, lastName } = splitName(profile.name);
  return {
    name: profile.name,
    firstName,
    lastName,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    linkedin: profile.linkedin,
    github: profile.github,
    portfolio: profile.portfolio,
    availability: profile.availability,
    workAuthorization: profile.workAuthorization,
    authorizedWithoutSponsorship: extras.authorizedWithoutSponsorship,
    needsSponsorship: extras.needsSponsorship,
    willingToRelocate: extras.willingToRelocate,
    howHeard: extras.howHeard,
    motivationBlurb: extras.motivationBlurb,
    currentCompensation: profile.currentCompensation,
    targetCompensation: profile.targetCompensation,
  };
}

export function mapLabel(label, profile, extras, { channel = 'greenhouse', env = process.env } = {}) {
  const stored = lookupAnswer(label, channel, env);
  if (stored) return { key: 'stored', value: stored, source: 'answer' };
  const norm = normalizeLabel(label);
  if (!norm) return { key: null, value: null, source: 'unclear' };
  const values = profileValueMap(profile, extras);
  for (const entry of SYNONYMS) {
    if (entry.labels.some((item) => {
      const alias = normalizeLabel(item);
      return norm === alias || norm.includes(alias) || alias.includes(norm);
    })) {
      const value = values[entry.key];
      if (value && value !== 'unclear') return { key: entry.key, value: String(value), source: 'profile' };
    }
  }
  return { key: null, value: null, source: 'unclear' };
}

export function mapQuestions(questions, profile, extras, options = {}) {
  const mapped = [];
  const leftover = [];
  for (const question of questions || []) {
    const label = question.label || question.name || question.id || '';
    const match = mapLabel(label, profile, extras, options);
    if (match.value) mapped.push({ ...question, label, ...match });
    else leftover.push({ ...question, label });
  }
  return { mapped, leftover };
}
