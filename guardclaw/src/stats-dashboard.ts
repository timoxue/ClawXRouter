/**
 * GuardClaw Stats Dashboard
 *
 * HTTP handler that serves:
 *   - GET  /plugins/guardclaw/stats          → Dashboard HTML (inline SPA)
 *   - GET  /plugins/guardclaw/stats/api/summary  → JSON summary
 *   - GET  /plugins/guardclaw/stats/api/hourly   → JSON hourly timeline
 *   - GET  /plugins/guardclaw/stats/api/config   → current guardclaw config
 *   - POST /plugins/guardclaw/stats/api/config   → update config (hot-reload + persist)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getGlobalCollector } from "./token-stats.js";
import { getLiveConfig, updateLiveConfig } from "./live-config.js";

type ConfigWriteFn = (cfg: unknown) => Promise<void>;
type ConfigLoadFn = () => Promise<unknown>;

export type DashboardDeps = {
  loadConfig: ConfigLoadFn;
  writeConfigFile: ConfigWriteFn;
  pluginId: string;
};

let deps: DashboardDeps | null = null;

export function initDashboard(d: DashboardDeps): void {
  deps = d;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

export async function statsHttpHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "";
  const path = url.split("?")[0];
  const base = "/plugins/guardclaw/stats";

  if (!path.startsWith(base)) return false;

  const sub = path.slice(base.length) || "/";

  if (req.method === "GET" && sub === "/") {
    html(res, dashboardHtml());
    return true;
  }

  if (req.method === "GET" && sub === "/api/summary") {
    const collector = getGlobalCollector();
    if (!collector) { json(res, { error: "not initialized" }, 503); return true; }
    json(res, collector.getSummary());
    return true;
  }

  if (req.method === "GET" && sub === "/api/hourly") {
    const collector = getGlobalCollector();
    if (!collector) { json(res, { error: "not initialized" }, 503); return true; }
    json(res, collector.getHourly());
    return true;
  }

  if (req.method === "GET" && sub === "/api/sessions") {
    const collector = getGlobalCollector();
    if (!collector) { json(res, { error: "not initialized" }, 503); return true; }
    json(res, collector.getSessionStats());
    return true;
  }

  if (req.method === "GET" && sub === "/api/config") {
    const liveConfig = getLiveConfig();
    json(res, {
      privacy: {
        localModel: liveConfig.localModel,
        guardAgent: liveConfig.guardAgent,
        s2Policy: liveConfig.s2Policy,
        rules: liveConfig.rules,
      },
    });
    return true;
  }

  if (req.method === "POST" && sub === "/api/config") {
    if (!deps) { json(res, { error: "dashboard not initialized" }, 503); return true; }
    try {
      const body = JSON.parse(await readBody(req));

      // Update privacy config (hot-reload via liveConfig + persist to disk)
      if (body.privacy) {
        updateLiveConfig(body.privacy);

        const fullConfig = await deps.loadConfig() as Record<string, unknown>;
        const plugins = (fullConfig.plugins ?? {}) as Record<string, unknown>;
        const entries = (plugins.entries ?? {}) as Record<string, unknown>;
        const guardclaw = (entries[deps.pluginId] ?? {}) as Record<string, unknown>;
        const existingConfig = (guardclaw.config ?? {}) as Record<string, unknown>;
        const existingPrivacy = (existingConfig.privacy ?? {}) as Record<string, unknown>;

        const updatedConfig = {
          ...fullConfig,
          plugins: {
            ...plugins,
            entries: {
              ...entries,
              [deps.pluginId]: {
                ...guardclaw,
                config: {
                  ...existingConfig,
                  privacy: { ...existingPrivacy, ...body.privacy },
                },
              },
            },
          },
        };

        await deps.writeConfigFile(updatedConfig);
      }

      json(res, { ok: true });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
    return true;
  }

  return false;
}

// ── Dashboard HTML ──

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GuardClaw Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .header { padding: 20px 24px; border-bottom: 1px solid #1e293b; display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 20px; font-weight: 600; }
  .tabs { display: flex; gap: 0; padding: 0 24px; border-bottom: 1px solid #1e293b; }
  .tab { padding: 12px 20px; cursor: pointer; border-bottom: 2px solid transparent; color: #94a3b8; font-size: 14px; }
  .tab.active { color: #38bdf8; border-bottom-color: #38bdf8; }
  .tab:hover { color: #e2e8f0; }
  .panel { display: none; padding: 24px; }
  .panel.active { display: block; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
  .card { background: #1e293b; border-radius: 12px; padding: 20px; }
  .card-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .card-value { font-size: 28px; font-weight: 700; }
  .card-sub { font-size: 12px; color: #64748b; margin-top: 4px; }
  .card.cloud .card-value { color: #38bdf8; }
  .card.local .card-value { color: #4ade80; }
  .card.proxy .card-value { color: #fb923c; }
  .chart-wrap { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
  .chart-wrap h3 { font-size: 14px; color: #94a3b8; margin-bottom: 12px; }
  .detail-table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
  .detail-table th, .detail-table td { padding: 10px 16px; text-align: right; font-size: 13px; }
  .detail-table th { background: #0f172a; color: #94a3b8; font-weight: 500; }
  .detail-table th:first-child, .detail-table td:first-child { text-align: left; }
  .detail-table td:first-child { color: #e2e8f0; }
  .detail-table tr:not(:last-child) td { border-bottom: 1px solid #0f172a; }

  /* Config panel */
  .config-section { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .config-section h3 { font-size: 14px; color: #94a3b8; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 4px; }
  .field input, .field select { width: 100%; padding: 8px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 13px; outline: none; }
  .field input:focus, .field select:focus { border-color: #38bdf8; }
  .tag-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .tag { background: #334155; color: #e2e8f0; padding: 4px 10px; border-radius: 4px; font-size: 12px; display: flex; align-items: center; gap: 4px; }
  .tag button { background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 14px; line-height: 1; }
  .tag button:hover { color: #f87171; }
  .add-row { display: flex; gap: 8px; margin-top: 8px; }
  .add-row input { flex: 1; }
  .btn { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; }
  .btn-primary { background: #38bdf8; color: #0f172a; }
  .btn-primary:hover { background: #7dd3fc; }
  .btn-sm { padding: 6px 12px; font-size: 12px; }
  .btn-outline { background: transparent; border: 1px solid #334155; color: #e2e8f0; }
  .btn-outline:hover { border-color: #38bdf8; }
  .save-bar { display: flex; justify-content: flex-end; gap: 8px; padding-top: 8px; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: #065f46; color: #d1fae5; padding: 12px 20px; border-radius: 8px; font-size: 13px; display: none; z-index: 100; }
  .toast.error { background: #7f1d1d; color: #fecaca; }
  .badge { display: inline-block; font-size: 10px; padding: 2px 6px; border-radius: 3px; margin-left: 8px; vertical-align: middle; }
  .badge-hot { background: #065f46; color: #6ee7b7; }
  .level-tag { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
  .level-S1 { background: rgba(56,189,248,0.15); color: #38bdf8; }
  .level-S2 { background: rgba(251,146,60,0.15); color: #fb923c; }
  .level-S3 { background: rgba(74,222,128,0.15); color: #4ade80; }
  .session-key { font-family: ui-monospace, monospace; font-size: 12px; color: #94a3b8; }
  .session-table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
  .session-table th, .session-table td { padding: 10px 14px; font-size: 13px; }
  .session-table th { background: #0f172a; color: #94a3b8; font-weight: 500; text-align: left; }
  .session-table td { text-align: right; }
  .session-table td:first-child, .session-table td:nth-child(2) { text-align: left; }
  .session-table tr:not(:last-child) td { border-bottom: 1px solid #0f172a; }
  .session-empty { text-align: center; color: #64748b; padding: 40px 0; font-size: 14px; }
</style>
</head>
<body>
<div class="header">
  <h1>GuardClaw Dashboard</h1>
</div>
<div class="tabs">
  <div class="tab active" data-tab="stats">Token Statistics</div>
  <div class="tab" data-tab="sessions">Sessions</div>
  <div class="tab" data-tab="config">Configuration <span class="badge badge-hot">live</span></div>
</div>

<div id="stats-panel" class="panel active">
  <div class="cards">
    <div class="card cloud">
      <div class="card-label">Cloud</div>
      <div class="card-value" id="cloud-tokens">0</div>
      <div class="card-sub" id="cloud-reqs">0 requests</div>
    </div>
    <div class="card local">
      <div class="card-label">Local</div>
      <div class="card-value" id="local-tokens">0</div>
      <div class="card-sub" id="local-reqs">0 requests</div>
    </div>
    <div class="card proxy">
      <div class="card-label">Proxy</div>
      <div class="card-value" id="proxy-tokens">0</div>
      <div class="card-sub" id="proxy-reqs">0 requests</div>
    </div>
  </div>
  <div class="chart-wrap">
    <h3>Hourly Token Usage</h3>
    <canvas id="hourlyChart" height="80"></canvas>
  </div>
  <table class="detail-table">
    <thead><tr><th>Category</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Total</th><th>Requests</th></tr></thead>
    <tbody id="detail-body"></tbody>
  </table>
</div>

<div id="sessions-panel" class="panel">
  <table class="session-table">
    <thead><tr><th>Session</th><th>Level</th><th>Cloud</th><th>Local</th><th>Proxy</th><th>Total</th><th>Requests</th><th>Last Active</th></tr></thead>
    <tbody id="sessions-body"><tr><td colspan="8" class="session-empty">No session data yet</td></tr></tbody>
  </table>
</div>

<div id="config-panel" class="panel">
  <div class="config-section">
    <h3>Local Model Settings <span class="badge badge-hot">instant</span></h3>
    <div class="field"><label>Endpoint</label><input id="cfg-lm-endpoint" placeholder="https://yeysai.com"></div>
    <div class="field"><label>Model</label><input id="cfg-lm-model" placeholder="qwen3.5-27b"></div>
    <div class="field"><label>API Key</label><input id="cfg-lm-apikey" type="password" placeholder="sk-..."></div>
  </div>
  <div class="config-section">
    <h3>Guard Agent <span class="badge badge-hot">instant</span></h3>
    <div class="field"><label>Model</label><input id="cfg-ga-model" placeholder="openai/qwen3.5-27b"></div>
  </div>
  <div class="config-section">
    <h3>S2 Policy <span class="badge badge-hot">instant</span></h3>
    <div class="field">
      <label>Handling Strategy</label>
      <select id="cfg-s2policy"><option value="proxy">proxy (strip PII via proxy)</option><option value="local">local (route entirely to local model)</option></select>
    </div>
  </div>
  <div class="save-bar">
    <button class="btn btn-primary" onclick="saveConfig()">Save All</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const BASE = '/plugins/guardclaw/stats/api';
let hourlyChart = null;

// Tabs
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(t.dataset.tab + '-panel').classList.add('active');
  });
});

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fillRow(cat, b) {
  return '<tr><td>' + cat + '</td><td>' + fmt(b.inputTokens) + '</td><td>' + fmt(b.outputTokens) +
    '</td><td>' + fmt(b.cacheReadTokens) + '</td><td>' + fmt(b.totalTokens) + '</td><td>' + b.requestCount + '</td></tr>';
}

async function refreshStats() {
  try {
    const [summary, hourly] = await Promise.all([
      fetch(BASE + '/summary').then(r => r.json()),
      fetch(BASE + '/hourly').then(r => r.json()),
    ]);
    const lt = summary.lifetime;
    document.getElementById('cloud-tokens').textContent = fmt(lt.cloud.totalTokens);
    document.getElementById('cloud-reqs').textContent = lt.cloud.requestCount + ' requests';
    document.getElementById('local-tokens').textContent = fmt(lt.local.totalTokens);
    document.getElementById('local-reqs').textContent = lt.local.requestCount + ' requests';
    document.getElementById('proxy-tokens').textContent = fmt(lt.proxy.totalTokens);
    document.getElementById('proxy-reqs').textContent = lt.proxy.requestCount + ' requests';
    document.getElementById('detail-body').innerHTML = fillRow('Cloud', lt.cloud) + fillRow('Local', lt.local) + fillRow('Proxy', lt.proxy);
    updateChart(hourly);
  } catch {}
}

function updateChart(hourly) {
  const labels = hourly.map(h => h.hour.slice(5) + ':00');
  const cloudData = hourly.map(h => h.cloud.totalTokens);
  const localData = hourly.map(h => h.local.totalTokens);
  const proxyData = hourly.map(h => h.proxy.totalTokens);
  if (hourlyChart) {
    hourlyChart.data.labels = labels;
    hourlyChart.data.datasets[0].data = cloudData;
    hourlyChart.data.datasets[1].data = localData;
    hourlyChart.data.datasets[2].data = proxyData;
    hourlyChart.update('none');
  } else {
    hourlyChart = new Chart(document.getElementById('hourlyChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Cloud', data: cloudData, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.1)', fill: true, tension: 0.3 },
          { label: 'Local', data: localData, borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.1)', fill: true, tension: 0.3 },
          { label: 'Proxy', data: proxyData, borderColor: '#fb923c', backgroundColor: 'rgba(251,146,60,0.1)', fill: true, tension: 0.3 },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#94a3b8' } } },
        scales: {
          x: { ticks: { color: '#64748b', maxTicksLimit: 12 }, grid: { color: '#1e293b' } },
          y: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } },
        },
      },
    });
  }
}

// Sessions panel
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function totalForSession(s) {
  return s.cloud.totalTokens + s.local.totalTokens + s.proxy.totalTokens;
}

function totalReqsForSession(s) {
  return s.cloud.requestCount + s.local.requestCount + s.proxy.requestCount;
}

async function refreshSessions() {
  try {
    const sessions = await fetch(BASE + '/sessions').then(r => r.json());
    const tbody = document.getElementById('sessions-body');
    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="session-empty">No session data yet</td></tr>';
      return;
    }
    tbody.innerHTML = sessions.map(s => {
      const shortKey = s.sessionKey.length > 20 ? s.sessionKey.slice(0, 20) + '...' : s.sessionKey;
      return '<tr>' +
        '<td><span class="session-key" title="' + s.sessionKey + '">' + shortKey + '</span></td>' +
        '<td><span class="level-tag level-' + s.highestLevel + '">' + s.highestLevel + '</span></td>' +
        '<td>' + fmt(s.cloud.totalTokens) + '</td>' +
        '<td>' + fmt(s.local.totalTokens) + '</td>' +
        '<td>' + fmt(s.proxy.totalTokens) + '</td>' +
        '<td>' + fmt(totalForSession(s)) + '</td>' +
        '<td>' + totalReqsForSession(s) + '</td>' +
        '<td>' + timeAgo(s.lastActiveAt) + '</td>' +
        '</tr>';
    }).join('');
  } catch {}
}

refreshSessions();
setInterval(refreshSessions, 30000);

// Config panel
async function loadConfig() {
  try {
    const cfg = await fetch(BASE + '/config').then(r => r.json());
    const lm = cfg.privacy?.localModel || {};
    const ga = cfg.privacy?.guardAgent || {};
    document.getElementById('cfg-lm-endpoint').value = lm.endpoint || '';
    document.getElementById('cfg-lm-model').value = lm.model || '';
    document.getElementById('cfg-lm-apikey').value = lm.apiKey || '';
    document.getElementById('cfg-ga-model').value = ga.model || '';
    document.getElementById('cfg-s2policy').value = cfg.privacy?.s2Policy || 'proxy';
  } catch {}
}

async function saveConfig() {
  try {
    const payload = {
      privacy: {
        localModel: {
          endpoint: document.getElementById('cfg-lm-endpoint').value || undefined,
          model: document.getElementById('cfg-lm-model').value || undefined,
          apiKey: document.getElementById('cfg-lm-apikey').value || undefined,
        },
        guardAgent: {
          model: document.getElementById('cfg-ga-model').value || undefined,
        },
        s2Policy: document.getElementById('cfg-s2policy').value,
      },
    };
    const res = await fetch(BASE + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (result.ok) {
      showToast('Saved successfully');
    } else {
      showToast('Save failed: ' + (result.error || 'unknown'), true);
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, true);
  }
}

function showToast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

refreshStats();
loadConfig();
setInterval(refreshStats, 30000);
</script>
</body>
</html>`;
}
