// Owner-run, read-only network collection. No job moderation or production writes.
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { loadPublishedJobs } from '../lib/jobs-search.mjs';
import { atsTarget, extractLocation, extractEmploymentType, extractExperienceLevel } from '../lib/job-locations.mjs';

const feed = 'https://job-application-agent-telemetry.varora1406.workers.dev';
const snapshot = await loadPublishedJobs((path, options) => fetch(`${feed}${path.replace('/api/community-jobs', '/v1/jobs')}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }));
console.log(`Snapshot: ${snapshot.length} published job IDs`);
const cache = new Map();
async function readJson(url) {
  if (!cache.has(url)) cache.set(url, (async () => {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  })());
  return cache.get(url);
}
const records = [], unresolved = [];
let position = 0, completed = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (position < snapshot.length) {
    const job = snapshot[position++];
    const identity = { jobId: job.jobId, url: job.url, company: job.company, role: job.role };
    const target = atsTarget(job.url);
    try {
      const location = target ? extractLocation(job, await readJson(target.url)) : null;
      if (location) {
        const salary = location.salary || null;
        const employmentType = location.employmentType || extractEmploymentType(job.role);
        const experienceLevel = location.experienceLevel || extractExperienceLevel(job.role);
        records.push({
          ...identity,
          ...location,
          salary,
          employmentType,
          experienceLevel,
          sourceUrl: target.url,
          checkedAt: new Date().toISOString()
        });
      } else {
        unresolved.push({ ...identity, reason: target ? 'No exact matching structured location' : 'Needs page inspection / unsupported ATS' });
      }
    } catch (error) { unresolved.push({ ...identity, reason: error.message }); }
    completed++;
    if (completed % 100 === 0) console.log(`Checked ${completed}/${snapshot.length}; enriched ${records.length}`);
  }
}));

records.sort((a, b) => a.jobId.localeCompare(b.jobId));
unresolved.sort((a, b) => a.jobId.localeCompare(b.jobId));
const directory = new URL('../data/', import.meta.url);
await mkdir(directory, { recursive: true });
const result = { version: 1, collectedAt: new Date().toISOString(), snapshotCount: snapshot.length, records, unresolved };
const temporary = new URL('job-locations.json.tmp', directory);
await writeFile(temporary, JSON.stringify(result, null, 2) + '\n');
await rename(temporary, new URL('job-locations.json', directory));
console.log(JSON.stringify({ checked: snapshot.length, enriched: records.length, unresolved: unresolved.length }));
