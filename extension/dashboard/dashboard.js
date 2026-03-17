const BACKEND = "http://localhost:3001";

// ── GAUGE ──────────────────────────────────────────────────────
const gCtx = document.getElementById('miniGauge').getContext('2d');
const gauge = new Chart(gCtx, {
  type: 'doughnut',
  data: { datasets: [{ data: [0,100], backgroundColor: ['#6366f1','#1a2235'], borderWidth: 0, circumference: 180, rotation: 270 }] },
  options: { responsive: false, cutout: '72%', plugins: { legend: { display: false }, tooltip: { enabled: false } } }
});

// ── DLS LINE CHART ─────────────────────────────────────────────
const dlsHistory = [];
const dlsCtx = document.getElementById('dlsChart').getContext('2d');
const dlsChart = new Chart(dlsCtx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      { label: 'DLS', data: [], borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,.1)', borderWidth: 2, pointRadius: 2, fill: true, tension: 0.4 },
      { label: 'Tier 1', data: [], borderColor: '#f59e0b', borderWidth: 1, borderDash: [4,4], pointRadius: 0, fill: false },
    ]
  },
  options: {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      y: { min: 0, max: 1, grid: { color: '#1a2235' }, ticks: { color: '#64748b', font: { size: 10 }, callback: v => Math.round(v*100)+'%' } },
      x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 8 } }
    }
  }
});

// ── HISTORY CHART ──────────────────────────────────────────────
const hCtx = document.getElementById('histChart').getContext('2d');
const histChart = new Chart(hCtx, {
  type: 'bar',
  data: { labels: [], datasets: [{ label: 'Focus Score', data: [], backgroundColor: 'rgba(99,102,241,.6)', borderRadius: 4 }] },
  options: {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      y: { min: 0, max: 100, grid: { color: '#1a2235' }, ticks: { color: '#64748b', font: { size: 10 } } },
      x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 9 } } }
    }
  }
});

const TIER_INFO = [
  { cls: 'tier-0', text: '✅ Focused' },
  { cls: 'tier-1', text: '⚠️ Warning' },
  { cls: 'tier-2', text: '📚 Research Mode' },
  { cls: 'tier-3', text: '🚫 Blocked' }
];
const SIGNAL_NAMES = {
  tabSwitchFreq: 'Tab Switch Freq', idleDuration: 'Idle Duration',
  scrollIrregularity: 'Scroll Irregularity', keystrokeVariance: 'Keystroke Variance',
  domainRevisitFreq: 'Distracting Domains', timeOfDayWeight: 'Time-of-Day Factor'
};

function sigColor(v) { return v < .3 ? '#10b981' : v < .65 ? '#f59e0b' : '#ef4444'; }

function updateDashboard(data) {
  const dls = data.currentDLS || 0;
  const pct = Math.round(dls * 100);

  // Gauge
  const col = dls < .5 ? '#10b981' : dls < .65 ? '#f59e0b' : dls < .78 ? '#fb923c' : '#ef4444';
  gauge.data.datasets[0].data = [pct, 100 - pct];
  gauge.data.datasets[0].backgroundColor[0] = col;
  gauge.update('none');
  document.getElementById('dlsNum').textContent = pct + '%';
  document.getElementById('dlsNum').style.color = col;

  const tier = data.currentTier || 0;
  const chip = document.getElementById('tierChip');
  chip.className = 'tier-chip ' + TIER_INFO[tier].cls;
  chip.textContent = TIER_INFO[tier].text;

  // Metrics
  document.getElementById('focusScore').textContent = data.focusScore ?? '—';
  document.getElementById('patienceIdx').textContent = (data.patienceIndex ?? '—') + '%';
  document.getElementById('distrPct').textContent = (data.distractionPercentage ?? '—') + '%';
  document.getElementById('streak').textContent = data.longestStreak ?? '—';
  document.getElementById('interventions').textContent = data.interventionCount ?? '—';
  document.getElementById('complianceRate').textContent = data.complianceRate != null ? data.complianceRate + '%' : '—';

  // DLS chart — append point every refresh
  if (dls !== undefined) {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    dlsChart.data.labels.push(t);
    dlsChart.data.datasets[0].data.push(dls);
    dlsChart.data.datasets[1].data.push(0.5); // tier 1 line
    if (dlsChart.data.labels.length > 40) {
      dlsChart.data.labels.shift();
      dlsChart.data.datasets[0].data.shift();
      dlsChart.data.datasets[1].data.shift();
    }
    dlsChart.update('none');
  }

  // Signals
  if (data.features) {
    const grid = document.getElementById('signalsGrid');
    grid.innerHTML = Object.entries(data.features).map(([k, v]) => `
      <div class="signal-card">
        <div class="signal-name">${SIGNAL_NAMES[k] || k}</div>
        <div class="signal-bar-bg"><div class="signal-bar" style="width:${Math.round(v*100)}%;background:${sigColor(v)}"></div></div>
        <div class="signal-val" style="color:${sigColor(v)}">${Math.round(v*100)}%</div>
      </div>
    `).join('');
  }
}

let currentHistMetric = 'focusScore';
let cachedSessions = [];

function updateHistory(sessions) {
  if (!sessions?.length) return;
  cachedSessions = sessions;

  // Bar chart — plot selected metric
  const last8 = sessions.slice(-8);
  histChart.data.labels = last8.map((_, i) => `S${sessions.length - last8.length + i + 1}`);
  histChart.data.datasets[0].data = last8.map(s => s[currentHistMetric] || 0);
  histChart.data.datasets[0].label = currentHistMetric;
  
  // Adjust Y-axis based on metric
  const maxVal = currentHistMetric === 'longestStreak' ? Math.max(...last8.map(s => s.longestStreak || 0), 10) : 100;
  histChart.options.scales.y.max = maxVal;
  histChart.update('none');

  // Table — enriched with all columns
  const tbody = document.getElementById('historyBody');
  tbody.innerHTML = [...sessions].reverse().map((s, i) => {
    const dt = s.sessionId ? new Date(s.sessionId).toLocaleString() : '—';
    const score = s.focusScore ?? '—';
    const color = score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444';
    return `<tr>
      <td>${sessions.length - i}</td>
      <td>${dt}</td>
      <td>${s.sessionDuration ?? '—'} min</td>
      <td style="color:${color};font-weight:600">${score}</td>
      <td>${s.distractionPct ?? '—'}%</td>
      <td>${s.patienceIndex ?? '—'}%</td>
      <td>${s.longestStreak ?? '—'} min</td>
      <td>${s.interventionCount ?? '—'}</td>
      <td>${s.complianceRate != null ? s.complianceRate + '%' : '—'}</td>
    </tr>`;
  }).join('');
}

// Metric selector for history chart
document.querySelectorAll('.metric-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.metric-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentHistMetric = btn.dataset.metric;
    if (cachedSessions.length) updateHistory(cachedSessions);
  });
});

// ── BACKEND STATUS ─────────────────────────────────────────────
let backendOnline = false;
async function checkBackend() {
  try {
    const res = await fetch(`${BACKEND}/api/status`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    backendOnline = true;
    document.getElementById('backendBadge').className = 'backend-status backend-online';
    document.getElementById('backendBadge').textContent = '✅ Backend: Online';
    document.getElementById('serverStatus').textContent = '🟢 Online';
    document.getElementById('dbSessions').textContent = data.totalSessions ?? '—';
    document.getElementById('dbSnapshots').textContent = data.totalSnapshots ?? '—';
    document.getElementById('lastSync').textContent = new Date().toLocaleTimeString();
  } catch {
    backendOnline = false;
    document.getElementById('backendBadge').className = 'backend-status backend-offline';
    document.getElementById('backendBadge').textContent = '⚠️ Backend: Offline';
    document.getElementById('serverStatus').textContent = '🔴 Offline — run: node backend/server.js';
  }
}

async function fetchWeights() {
  try {
    const res = await fetch(`${BACKEND}/api/model/weights`);
    const { weights } = await res.json();
    const el = document.getElementById('weightsDisplay');
    el.innerHTML = Object.entries(weights).map(([k, v]) => `
      <div class="stat-row">
        <span class="k">${k}</span>
        <span class="v">${(v * 100).toFixed(1)}%</span>
      </div>`).join('');
  } catch {
    document.getElementById('weightsDisplay').innerHTML = '<div style="color:var(--muted);font-size:13px">Backend offline — weights loaded from local storage</div>';
    const { modelWeights } = await chrome.storage.local.get('modelWeights');
    const w = modelWeights || {};
    document.getElementById('weightsDisplay').innerHTML = Object.entries(w).map(([k,v]) =>
      `<div class="stat-row"><span class="k">${k}</span><span class="v">${(v*100).toFixed(1)}%</span></div>`
    ).join('') || '<div style="color:var(--muted);font-size:13px">No weights found</div>';
  }
}

// ── LOAD DATA ──────────────────────────────────────────────────
async function loadAll() {
  const { liveData, sessionHistory } = await chrome.storage.local.get(['liveData','sessionHistory']);
  if (liveData) updateDashboard(liveData);
  if (sessionHistory) updateHistory(sessionHistory);
}

loadAll();
setInterval(loadAll, 5000);
checkBackend();
setInterval(checkBackend, 15000);

// ── NAV ────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('page-' + item.dataset.page)?.classList.add('active');
    if (item.dataset.page === 'backend') { checkBackend(); fetchWeights(); }
  });
});

// ── BUTTONS ────────────────────────────────────────────────────
document.getElementById('newSessionBtn').addEventListener('click', async () => {
  if (confirm('Start a new session? Current session data will be saved.')) {
    chrome.runtime.sendMessage({ type: 'RESET_SESSION' });
    await chrome.storage.local.remove('liveData');
    dlsChart.data.labels = []; dlsChart.data.datasets.forEach(d => d.data = []); dlsChart.update();
    loadAll();
  }
});

document.getElementById('forceNotifBtn').addEventListener('click', () => {
  chrome.notifications?.create('test_' + Date.now(), {
    type: 'basic', iconUrl: '../icons/icon48.png',
    title: '🔔 Test Notification', message: 'StudyGuard notifications are working!'
  });
});

document.getElementById('clearDataBtn').addEventListener('click', async () => {
  if (confirm('Delete ALL session history? This cannot be undone.')) {
    await chrome.storage.local.clear();
    loadAll();
  }
});

document.getElementById('testBackendBtn')?.addEventListener('click', checkBackend);
document.getElementById('forceSyncBtn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'FORCE_SYNC' });
  setTimeout(checkBackend, 1500);
});
document.getElementById('fetchWeightsBtn')?.addEventListener('click', fetchWeights);
