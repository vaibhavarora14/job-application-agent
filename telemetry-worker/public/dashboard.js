const format = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fullFormat = new Intl.NumberFormat('en-US');

function emptyState() {
  return document.querySelector('#empty-template').content.cloneNode(true);
}

function renderMetrics(metrics) {
  document.querySelectorAll('[data-metric]').forEach((element) => {
    const value = Number(metrics[element.dataset.metric] ?? 0);
    element.textContent = format.format(value);
    element.title = fullFormat.format(value);
  });
}

function lastThirtyDays(entries) {
  const byDay = new Map(entries.map((entry) => [entry.day, entry]));
  const anchor = entries.length ? new Date(`${entries.at(-1).day}T00:00:00Z`) : new Date();
  return Array.from({ length: 30 }, (_, index) => {
    const day = new Date(anchor);
    day.setUTCDate(anchor.getUTCDate() - (29 - index));
    const key = day.toISOString().slice(0, 10);
    return byDay.get(key) ?? { day: key, assessed: 0, submitted: 0 };
  });
}

function renderTimeline(entries) {
  const chart = document.querySelector('#timeline-chart');
  chart.replaceChildren();
  if (!entries.some((entry) => entry.assessed || entry.submitted)) {
    chart.append(emptyState());
    chart.style.display = 'block';
    return;
  }
  const days = lastThirtyDays(entries);
  const max = Math.max(1, ...days.flatMap((day) => [day.assessed, day.submitted]));
  for (const day of days) {
    const column = document.createElement('div');
    column.className = 'chart-column';
    column.title = `${day.day}: ${day.assessed} assessed, ${day.submitted} submitted`;
    for (const key of ['assessed', 'submitted']) {
      const bar = document.createElement('span');
      bar.className = `bar ${key}`;
      bar.style.height = `${(day[key] / max) * 100}%`;
      column.append(bar);
    }
    chart.append(column);
  }
}

function renderBreakdown(id, entries) {
  const container = document.querySelector(id);
  container.replaceChildren();
  if (!entries.length) {
    container.append(emptyState());
    return;
  }
  const max = Math.max(...entries.map((entry) => entry.count), 1);
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'breakdown-row';
    const label = document.createElement('span');
    label.className = 'breakdown-label';
    label.textContent = entry.label.replaceAll('-', ' ');
    const track = document.createElement('span');
    track.className = 'track';
    const fill = document.createElement('span');
    fill.className = 'fill';
    fill.style.width = `${(entry.count / max) * 100}%`;
    track.append(fill);
    const value = document.createElement('span');
    value.className = 'breakdown-value';
    value.textContent = fullFormat.format(entry.count);
    row.append(label, track, value);
    container.append(row);
  }
}

async function loadDashboard() {
  const status = document.querySelector('.status-line');
  try {
    const response = await fetch('/api/public-stats', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('The live aggregate feed is unavailable.');
    const data = await response.json();
    renderMetrics(data.metrics);
    renderTimeline(data.timeline);
    renderBreakdown('#ats-breakdown', data.breakdowns.ats);
    renderBreakdown('#seniority-breakdown', data.breakdowns.seniority);
    renderBreakdown('#outcomes-breakdown', data.breakdowns.outcomes);
    status.classList.add('ready');
    document.querySelector('#data-status').textContent = data.metrics.installations ? 'Live aggregate data' : 'Live feed connected · waiting for first anonymous events';
    document.querySelector('#updated-at').textContent = `Updated ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.generatedAt))}`;
  } catch {
    status.classList.add('error');
    document.querySelector('#data-status').textContent = 'Live aggregate data is temporarily unavailable';
    document.querySelectorAll('.chart, .breakdown-list').forEach((element) => {
      element.replaceChildren(emptyState());
      if (element.classList.contains('chart')) element.style.display = 'block';
    });
  }
}

loadDashboard();
