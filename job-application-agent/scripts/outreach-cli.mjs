import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CloudStateClient, defaultCloudConfigPath } from './cloud-state-client.mjs';
import { migrateLegacyStateDir, resolveStateDir } from './secret-store.mjs';
import { mutateOutreach, readOutreach, OUTREACH_CAPABILITY } from './outreach-domain.mjs';
import { privateOutreachWrite, withLocalOutreach, withOutreachLock } from './outreach-store.mjs';

const READS = new Set(['policy-status', 'list', 'show', 'review']);
const MUTATIONS = new Set(['policy-enable', 'policy-disable', 'assess', 'draft', 'handoff', 'record', 'suppress', 'clear']);
async function readInput() {
  let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 32000) throw new Error('Outreach input too large'); }
  try { return JSON.parse(text); } catch { throw new Error('Invalid outreach JSON'); }
}
async function downgradeGuard() {
  const agentHome = process.env.JOB_APPLICATION_AGENT_HOME || join(homedir(), '.agents');
  const path = join(agentHome, 'job-application-agent', 'install.json');
  let config; try { config = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  config.requiredCapabilities = [...new Set([...(config.requiredCapabilities ?? []), OUTREACH_CAPABILITY])].sort();
  await privateOutreachWrite(path, JSON.stringify(config, null, 2));
}
function fromSnapshot(snapshot, action, input) {
  if (action === 'policy-status') return snapshot.policy;
  if (action === 'review') return snapshot.review;
  if (action === 'show') { const item = snapshot.items.find(i => i.id === input.id); if (!item) throw new Error('Opportunity not found'); return item; }
  return { items: snapshot.items.map(({ content, events, ...item }) => item) };
}

export async function outreachCache(directory, binding, operation, { generation, snapshot } = {}) {
  return withOutreachLock(directory, 'outreach-cache.lock', async () => {
    const path = join(directory, 'outreach-cloud-cache.json');
    let cache;
    try { cache = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cache?.binding !== binding) cache = { binding, generation: 0, revision: -1 };
    if (operation === 'invalidate') {
      cache = { binding, generation: cache.generation + 1, revision: cache.revision };
      await privateOutreachWrite(path, JSON.stringify(cache));
    } else if (operation === 'write' && cache.generation === generation) {
      // A lower revision may be a restored backend or a delayed response. Neither
      // may retain older sensitive content; invalidate all in-flight writers too.
      cache = snapshot.revision < cache.revision
        ? { binding, generation: generation + 1, revision: -1 }
        : { binding, generation, revision: snapshot.revision, cachedAt: new Date().toISOString(), snapshot };
      await privateOutreachWrite(path, JSON.stringify(cache));
    }
    return cache;
  });
}

export async function runOutreach(args, { input: suppliedInput, stateDirectory = resolveStateDir(), cloudClient, guard = downgradeGuard, migrate = migrateLegacyStateDir } = {}) {
  let [action, value, rest, extra] = args;
  if (action === 'policy') { action = `policy-${value}`; value = rest; rest = extra; }
  const read = READS.has(action);
  if ((!read && !MUTATIONS.has(action)) || rest !== undefined || (read ? (action !== 'show' && value !== undefined) || (action === 'show' && !value) : value !== '--stdin')) {
    throw new Error('Usage: outreach policy status|enable --stdin|disable --stdin; outreach assess|draft|handoff|record|suppress|clear --stdin; outreach list|show <id>|review');
  }
  const input = read ? (action === 'show' ? { id: value } : {}) : suppliedInput ?? await readInput();
  await migrate(stateDirectory);
  const cloud = cloudClient ?? new CloudStateClient({ stateDir: stateDirectory, configPath: process.env.JOB_APPLICATION_AGENT_CLOUD_CONFIG ?? defaultCloudConfigPath() });
  const config = await cloud.config(true);
  let result;
  if (config) {
    if (config.version !== 2) throw new Error('Outreach requires cloud-state-v2');
    const binding = createHash('sha256').update(`${config.url}:${config.token}`).digest('hex');
    const { generation } = await outreachCache(stateDirectory, binding, read ? 'read' : 'invalidate');
    try {
      const status = await cloud.status();
      if (!status.capabilities?.includes(OUTREACH_CAPABILITY)) throw new Error('Backend upgrade required: outreach-tracking-v1 is missing');
      if (!read) result = await (await cloud.request('/v2/outreach/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, input }) })).json();
      // Failure after a successful mutation must not disguise that committed result.
      try {
        const snapshot = await (await cloud.request('/v2/outreach/snapshot')).json();
        await outreachCache(stateDirectory, binding, 'write', { generation, snapshot });
        if (read) result = { ...fromSnapshot(snapshot, action, input), stale: false };
      } catch (error) { if (read) throw error; result = { ...result, cacheRefreshed: false }; }
    } catch (error) {
      if (!read || !/^Cloud state unavailable:/.test(error.message)) throw error;
      const cached = await outreachCache(stateDirectory, binding, 'read');
      if (!cached.snapshot) throw error;
      result = { ...fromSnapshot(cached.snapshot, action, input), stale: true, cachedAt: cached.cachedAt, warning: 'Offline cache may contain content cleared on another host; no mutations are allowed.' };
    }
  } else {
    const context = { applications: [], outcomes: [] };
    if ((action === 'assess' && input.applicationId) || action === 'handoff') {
      for (const stream of ['applications', 'outcomes']) {
        try { context[stream] = (await readFile(join(stateDirectory, `${stream}.ndjson`), 'utf8')).split('\n').filter(Boolean).map(row => JSON.parse(row)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    result = await withLocalOutreach(stateDirectory, state => read ? { result: readOutreach(state, action, input) } : mutateOutreach(state, action, input, { ...context, actor: 'local' }));
  }
  if (action === 'policy-enable') await guard();
  return result;
}
