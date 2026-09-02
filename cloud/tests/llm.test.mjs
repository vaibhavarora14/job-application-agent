import assert from 'node:assert/strict';
import test from 'node:test';

import { assessJob, heuristicAssess } from '../src/llm.mjs';
import { sampleProfile } from './helpers.mjs';

const job = {
  title: 'Senior Product Engineer',
  company: 'Example AI',
  description: 'Build AI products with TypeScript, React and Python. Remote.',
  workMode: 'remote',
};

const resumeText = 'I build TypeScript and React products for ten years, including Python services.';

test('heuristic marks overlapping skills as met when the résumé quotes them', () => {
  const result = heuristicAssess({ job, resumeText, profile: sampleProfile });
  assert.equal(result.provider, 'heuristic');
  assert.equal(result.pendingLlm, false);
  assert.equal(result.seniority, 'senior');
  const ts = result.mustHaves.find((item) => item.requirement === 'TypeScript');
  assert.equal(ts.status, 'met');
  assert.match(ts.evidence, /TypeScript/i);
});

test('assessJob uses heuristic when no provider is configured', async () => {
  const result = await assessJob({
    job,
    resumeText,
    profile: sampleProfile,
    env: { ...process.env, OLLAMA_HOST: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
    fetchImpl: async () => { throw new Error('network should not be used'); },
  });
  assert.equal(result.provider, 'heuristic');
  assert.equal(result.pendingLlm, false);
});

test('assessJob stays pending_llm when a hosted key is set but fetch fails', async () => {
  const result = await assessJob({
    job,
    resumeText,
    profile: sampleProfile,
    env: { ...process.env, OLLAMA_HOST: '', ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: '' },
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(result.pendingLlm, true);
  assert.equal(result.provider, 'none');
});

test('assessJob accepts hosted JSON and downgrades unquoted met claims', async () => {
  const result = await assessJob({
    job,
    resumeText,
    profile: sampleProfile,
    env: { ...process.env, OLLAMA_HOST: '', ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: '' },
    fetchImpl: async (url) => {
      if (String(url).includes('/api/tags')) return { ok: false };
      return {
        ok: true,
        json: async () => ({
          content: [{
            text: JSON.stringify({
              eligibility: 'eligible',
              postingStatus: 'active',
              seniority: 'senior',
              roleFamily: 'product-engineering',
              workMode: 'remote',
              mustHaves: [
                { requirement: 'TypeScript', status: 'met', evidence: 'I build TypeScript and React products' },
                { requirement: 'GraphQL', status: 'met', evidence: 'invented-not-in-resume' },
              ],
            }),
          }],
        }),
      };
    },
  });
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.mustHaves[0].status, 'met');
  assert.equal(result.mustHaves[1].status, 'unclear');
});
