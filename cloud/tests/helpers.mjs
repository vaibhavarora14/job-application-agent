import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sampleProfile = {
  name: 'Test Candidate',
  email: 'candidate@example.com',
  phone: '+1 555 0100',
  location: 'Toronto, Canada',
  workAuthorization: 'Canada',
  linkedin: 'https://linkedin.com/in/example',
  github: 'https://github.com/example',
  roleFamilies: ['product-engineering', 'full-stack', 'ai-ml'],
  seniority: ['senior', 'staff'],
  skills: ['TypeScript', 'Python', 'React'],
  targetLocations: ['Canada', 'Remote'],
  workModes: ['remote'],
  industries: ['AI'],
  submissionMode: 'routine-auto',
  yearsExperience: 10,
  autoSubmitMinScore: 80,
  manualReviewMinScore: 70,
  minMustHaveCoverage: 70,
};

export const sampleExtras = {
  motivationBlurb: 'I build TypeScript and React products for ten years, including Python services.',
  howHeard: 'company careers page',
  authorizedWithoutSponsorship: 'yes',
  needsSponsorship: 'no',
  willingToRelocate: 'no',
};

export async function isolatedEnv(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-h0-'));
  return {
    ...process.env,
    CLOUD_DATA_DIR: dir,
    CLOUD_DB_PATH: join(dir, 'cloud.sqlite'),
    JOB_APPLICATION_AGENT_STATE_DIR: join(dir, 'skill-state'),
    CLOUD_BOARDS_PATH: join(dir, 'boards.json'),
    HOST: '127.0.0.1',
    PORT: '0',
    CLOUD_EMBED_WORKER: '0',
    OLLAMA_HOST: '',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
  };
}
