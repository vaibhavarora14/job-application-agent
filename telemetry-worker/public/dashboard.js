const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fullFormat = new Intl.NumberFormat('en-US');

const number = (value) => {
  const result = Number(value ?? 0);
  return Number.isFinite(result) && result >= 0 ? result : 0;
};

const percent = (numerator, denominator) => denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;

const total = (entries = []) => entries.reduce((sum, entry) => sum + number(entry.count), 0);

const countFor = (entries = [], labels = []) => entries
  .filter((entry) => labels.includes(String(entry.label).toLowerCase()))
  .reduce((sum, entry) => sum + number(entry.count), 0);

export function deriveCommunityStats(data) {
  const metrics = data?.metrics ?? {};
  const timeline = Array.isArray(data?.timeline) ? data.timeline : [];
  const seniority = data?.breakdowns?.seniority ?? [];
  const outcomes = data?.breakdowns?.outcomes ?? [];
  const submitted = number(metrics.applicationsSubmitted);
  const activeInstallations = number(metrics.activeInstallations30d);
  const interviews = number(metrics.interviews);
  const outcomesReported = total(outcomes);
  const seniorRoles = countFor(seniority, ['senior', 'staff', 'principal', 'founding', 'manager']);
  const seniorityTotal = total(seniority);
  const anchor = new Date(data?.generatedAt ?? Date.now());
  const recentThreshold = new Date(anchor);
  recentThreshold.setUTCDate(anchor.getUTCDate() - 6);
  recentThreshold.setUTCHours(0, 0, 0, 0);
  const recent = timeline.filter((day) => {
    const date = new Date(`${day.day}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date >= recentThreshold && date <= anchor;
  });
  const lastSevenSubmissions = recent.reduce((sum, day) => sum + number(day.submitted), 0);

  return {
    lastSevenSubmissions,
    peakSubmissions: Math.max(0, ...timeline.map((day) => number(day.submitted))),
    activeDays: timeline.filter((day) => number(day.assessed) || number(day.submitted)).length,
    applicationsPerActiveInstallation: activeInstallations ? Math.round((lastSevenSubmissions / activeInstallations) * 10) / 10 : 0,
    outcomesReported,
    outcomesUnknown: Math.max(0, submitted - outcomesReported),
    outcomeCoverage: percent(outcomesReported, submitted),
    interviewProgression: percent(interviews, submitted),
    seniorTargeting: percent(seniorRoles, seniorityTotal),
  };
}

function setText(selector, value, { title } = {}) {
  document.querySelectorAll(selector).forEach((element) => {
    element.textContent = value;
    if (title != null) element.title = String(title);
  });
}

function emptyState() {
  return document.querySelector('#empty-template').content.cloneNode(true);
}

function renderMetrics(metrics, community) {
  document.querySelectorAll('[data-metric]').forEach((element) => {
    const value = number(metrics[element.dataset.metric]);
    element.textContent = compactFormat.format(value);
    element.title = fullFormat.format(value);
  });
  setText('[data-derived="weekly-submissions"]', compactFormat.format(community.lastSevenSubmissions), { title: community.lastSevenSubmissions });
  setText('[data-derived="peak-submissions"]', compactFormat.format(community.peakSubmissions), { title: community.peakSubmissions });
  setText('[data-derived="per-installation"]', fullFormat.format(community.applicationsPerActiveInstallation));
  setText('[data-derived="interview-rate"]', `${community.interviewProgression}%`);
  setText('[data-derived="active-days"]', `${community.activeDays} ${community.activeDays === 1 ? 'day' : 'days'}`);
  setText('[data-derived="senior-targeting"]', `${community.seniorTargeting}%`);
  setText('[data-derived="outcome-coverage"]', `${community.outcomesReported}/${number(metrics.applicationsSubmitted)} outcomes reported`);
  setText('[data-derived="outcome-detail"]', `${community.outcomesReported} known · ${community.outcomesUnknown} awaiting an update`);
}

function renderVelocity(entries) {
  const chart = document.querySelector('#velocity-chart');
  chart.replaceChildren();
  const days = entries.slice(-14);
  if (!days.some((day) => number(day.submitted))) {
    chart.append(emptyState());
    return;
  }
  const max = Math.max(1, ...days.map((day) => number(day.submitted)));
  const date = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' });
  for (const day of days) {
    const value = number(day.submitted);
    const column = document.createElement('div');
    column.className = 'velocity-column';
    column.title = `${day.day}: ${value} verified submissions`;

    const count = document.createElement('strong');
    count.textContent = fullFormat.format(value);
    const bar = document.createElement('span');
    bar.className = 'velocity-bar';
    bar.style.height = `${Math.max(3, (value / max) * 100)}%`;
    const label = document.createElement('small');
    label.textContent = date.format(new Date(`${day.day}T00:00:00Z`));
    column.append(count, bar, label);
    chart.append(column);
  }
}

function renderLeaderboard(id, entries, totalCount) {
  const container = document.querySelector(id);
  container.replaceChildren();
  if (!entries.length) {
    container.append(emptyState());
    return;
  }
  const max = Math.max(1, ...entries.map((entry) => number(entry.count)));
  entries.slice(0, 6).forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'leaderboard-row';
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(index + 1);
    const label = document.createElement('span');
    label.className = 'leaderboard-label';
    label.textContent = String(entry.label).replaceAll('-', ' ');
    const track = document.createElement('span');
    track.className = 'leaderboard-track';
    const fill = document.createElement('span');
    fill.style.width = `${(number(entry.count) / max) * 100}%`;
    track.append(fill);
    const value = document.createElement('strong');
    value.textContent = fullFormat.format(number(entry.count));
    value.title = `${percent(number(entry.count), totalCount)}% of the visible total`;
    row.append(rank, label, track, value);
    container.append(row);
  });
}

function renderOutcomeBar(outcomes, submitted) {
  const bar = document.querySelector('#outcome-bar');
  const legend = document.querySelector('#outcome-legend');
  bar.replaceChildren();
  legend.replaceChildren();
  const known = total(outcomes);
  const entries = [...outcomes, { label: 'awaiting update', count: Math.max(0, submitted - known) }];
  for (const entry of entries) {
    if (!entry.count) continue;
    const segment = document.createElement('span');
    segment.className = `outcome-segment outcome-${String(entry.label).replaceAll(' ', '-')}`;
    segment.style.width = `${percent(number(entry.count), submitted)}%`;
    segment.title = `${entry.label}: ${fullFormat.format(number(entry.count))}`;
    bar.append(segment);

    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.className = segment.className;
    item.append(dot, `${fullFormat.format(number(entry.count))} ${entry.label}`);
    legend.append(item);
  }
}

function setupCopyAction() {
  const button = document.querySelector('#copy-install');
  button?.addEventListener('click', async () => {
    const command = 'npx job-application-agent@latest';
    try {
      await navigator.clipboard.writeText(command);
      button.textContent = 'Copied';
    } catch {
      button.textContent = command;
    }
    window.setTimeout(() => { button.textContent = 'Copy'; }, 1800);
  });
}

async function loadDashboard() {
  const status = document.querySelector('.status-line');
  try {
    const response = await fetch('/api/public-stats?v=3', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('The live aggregate feed is unavailable.');
    const data = await response.json();
    const community = deriveCommunityStats(data);
    renderMetrics(data.metrics, community);
    renderVelocity(data.timeline ?? []);
    renderLeaderboard('#seniority-leaderboard', data.breakdowns?.seniority ?? [], total(data.breakdowns?.seniority));
    renderLeaderboard('#ats-leaderboard', data.breakdowns?.ats ?? [], number(data.metrics.applicationsSubmitted));
    renderOutcomeBar(data.breakdowns?.outcomes ?? [], number(data.metrics.applicationsSubmitted));
    status.classList.add('ready');
    setText('#data-status', data.metrics.installations ? 'Live anonymous community data' : 'Live feed connected · waiting for first anonymous events');
    setText('#updated-at', `Updated ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.generatedAt))}`);
  } catch {
    status.classList.add('error');
    setText('#data-status', 'Live aggregate data is temporarily unavailable');
    document.querySelectorAll('.dynamic-view').forEach((element) => {
      element.replaceChildren(emptyState());
    });
  }
}

if (typeof document !== 'undefined') {
  setupCopyAction();
  loadDashboard();
}
