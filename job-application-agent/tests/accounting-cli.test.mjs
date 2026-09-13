import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
const script = new URL('../scripts/job-application.mjs', import.meta.url).pathname;
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'accounting-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'telemetry.json'), JSON.stringify({ enabled: false, disclosed: true }));
  const env = { ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: dir, JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(dir, 'absent.json'), JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9' };
  const run = (args, input) => JSON.parse(execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8', input: JSON.stringify(input) }));
  const fail = (args, input) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', input: JSON.stringify(input) });
  return { dir, run, fail };
}
const application = (roundId) => ({ id: 'app', company: 'Example', role: 'Senior Engineer', url: 'https://example.test/jobs/1', source: 'email', discoverySourceId: 'indeed', score: 90, status: 'submitted', submittedAt: '2026-01-01T00:00:00Z', approval: 'STANDING AUTHORIZATION', roundId });
const failure = { id: 'bounce-1', applicationId: 'app', attemptId: 'initial:app', type: 'delivery-failed', evidenceType: 'final-delivery-failure', evidence: 'Matched final failure for the original recruiting message.', occurredAt: '2026-01-02T00:00:00Z' };

test('late delivery failure corrects completed round and review without rewriting applications', async (t) => {
  const {dir, run} = await fixture(t);
  const roundId = 'legacy-round';
  await writeFile(join(dir, 'rounds.ndjson'), [ { type:'started', roundId, requestedCount:1, occurredAt:'2026-01-01T00:00:00Z'}, {type:'completed',roundId,occurredAt:'2026-01-01T01:00:00Z'} ].map(JSON.stringify).join('\n')+'\n');
  const raw = JSON.stringify(application(roundId))+'\n';
  await writeFile(join(dir, 'applications.ndjson'), raw);
  run(['ledger','delivery','--stdin'], failure);
  run(['ledger','delivery','--stdin'], failure);
  const status = run(['round','status',roundId]);
  assert.equal(status.completed,true);
  assert.equal(status.confirmedCount,0);
  assert.equal(status.shortfallCount,1);
  assert.equal(status.needsRecovery,true);
  assert.equal(run(['ledger','review']).submittedTotal,0);
  assert.equal(await readFile(join(dir,'applications.ndjson'),'utf8'),raw);
  assert.equal((await readFile(join(dir,'delivery.ndjson'),'utf8')).trim().split('\n').length,1);
});

test('new rounds derive source totals and require qualified lead linkage', async (t) => {
  const {run,fail} = await fixture(t);
  const {roundId} = run(['round','start','--stdin'],{requestedCount:1});
  assert.notEqual(fail(['round','source','--stdin'],{roundId,sourceId:'indeed',status:'searched',reviewedCount:20,qualifiedCount:1,evidence:'Unsupported summary'}).status,0);
  const lead = { id:'lead-1',roundId,sourceId:'indeed',company:'Example',role:'Senior Engineer',url:'https://example.test/jobs/1',disposition:'qualified',evidence:'Meets the evidenced target requirements.',applicationId:'app',observedAt:'2026-01-01T00:00:00Z' };
  run(['round','lead','--stdin'],lead);
  run(['round','lead','--stdin'],lead);
  for(const sourceId of ['indeed','linkedin-jobs-feed','hacker-news-who-is-hiring']) run(['round','source','--stdin'],{roundId,sourceId,status:'searched',evidence:'Actual synthetic search'});
  run(['ledger','add','--stdin'],application(roundId));
  const status=run(['round','status',roundId]);
  assert.equal(status.discovery.sources.find(s=>s.sourceId==='indeed').reviewedCount,1);
  assert.equal(run(['round','leads',roundId]).leads.length,1);
  assert.equal(run(['round','complete','--stdin'],{roundId,concentrationReason:'stronger-fit',concentrationEvidence:'Only this source had a qualified role.'}).completed,true);
  run(['round','lead','--stdin'],{...lead,id:'revision',supersedes:lead.id,disposition:'closed-stale'});
  assert.equal(run(['round','status',roundId]).completed,true);
  assert.equal(run(['round','leads',roundId]).qualifiedCount,0);
  assert.notEqual(fail(['round','lead','--stdin'],{...lead,id:'new-lead',url:'https://different.example/job'}).status,0);
});
