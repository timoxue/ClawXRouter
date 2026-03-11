/**
 * GuardClaw Stats Dashboard
 *
 * HTTP handler that serves:
 *   - GET  /plugins/guardclaw/stats              → Dashboard HTML (inline SPA)
 *   - GET  /plugins/guardclaw/stats/api/summary  → JSON summary
 *   - GET  /plugins/guardclaw/stats/api/hourly   → JSON hourly timeline
 *   - GET  /plugins/guardclaw/stats/api/sessions → JSON session stats
 *   - GET  /plugins/guardclaw/stats/api/detections → JSON detection event log
 *   - GET  /plugins/guardclaw/stats/api/config   → current guardclaw config
 *   - POST /plugins/guardclaw/stats/api/config   → update config (hot-reload + persist)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getGlobalCollector } from "./token-stats.js";
import { getLiveConfig, updateLiveConfig } from "./live-config.js";
import { getAllSessionStates } from "./session-state.js";

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
  const reqPath = url.split("?")[0];
  const base = "/plugins/guardclaw/stats";

  if (!reqPath.startsWith(base)) return false;

  const sub = reqPath.slice(base.length) || "/";

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

  if (req.method === "GET" && sub === "/api/detections") {
    const states = getAllSessionStates();
    const events: Array<{
      sessionKey: string;
      level: string;
      checkpoint: string;
      reason?: string;
      timestamp: number;
    }> = [];
    states.forEach((state) => {
      for (const d of state.detectionHistory) {
        events.push({
          sessionKey: state.sessionKey,
          level: d.level,
          checkpoint: d.checkpoint,
          reason: d.reason,
          timestamp: d.timestamp,
        });
      }
    });
    events.sort((a, b) => b.timestamp - a.timestamp);
    json(res, events.slice(0, 500));
    return true;
  }

  if (req.method === "GET" && sub === "/api/config") {
    const liveConfig = getLiveConfig();
    const cfgAny = liveConfig as Record<string, unknown>;
    json(res, {
      privacy: {
        enabled: liveConfig.enabled,
        localModel: liveConfig.localModel,
        guardAgent: liveConfig.guardAgent,
        s2Policy: liveConfig.s2Policy,
        proxyPort: liveConfig.proxyPort,
        checkpoints: liveConfig.checkpoints,
        rules: liveConfig.rules,
        localProviders: liveConfig.localProviders,
        session: liveConfig.session,
        routers: cfgAny.routers,
        pipeline: cfgAny.pipeline,
      },
    });
    return true;
  }

  if (req.method === "POST" && sub === "/api/config") {
    if (!deps) { json(res, { error: "dashboard not initialized" }, 503); return true; }
    try {
      const body = JSON.parse(await readBody(req));

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
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}

  .header{padding:14px 24px;border-bottom:1px solid #1e293b;display:flex;align-items:center;justify-content:space-between}
  .header-left{display:flex;align-items:center;gap:12px}
  .header h1{font-size:18px;font-weight:600}
  .header-right{display:flex;align-items:center;gap:14px;font-size:12px;color:#64748b}
  .status-dot{width:8px;height:8px;border-radius:50%;background:#4ade80;display:inline-block;flex-shrink:0}
  .status-dot.err{background:#f87171}
  .status-dot.warn{background:#fbbf24}

  .tabs{display:flex;gap:0;padding:0 24px;border-bottom:1px solid #1e293b;overflow-x:auto}
  .tab{padding:12px 20px;cursor:pointer;border-bottom:2px solid transparent;color:#94a3b8;font-size:14px;white-space:nowrap;transition:color .15s}
  .tab.active{color:#38bdf8;border-bottom-color:#38bdf8}
  .tab:hover{color:#e2e8f0}

  .panel{display:none;padding:24px;max-width:1200px}
  .panel.active{display:block}

  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
  @media(max-width:860px){.cards{grid-template-columns:repeat(2,1fr)}}
  .card{background:#1e293b;border-radius:12px;padding:20px}
  .card-label{font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
  .card-value{font-size:28px;font-weight:700}
  .card-sub{font-size:12px;color:#64748b;margin-top:4px}
  .card.cloud .card-value{color:#38bdf8}
  .card.local .card-value{color:#4ade80}
  .card.proxy .card-value{color:#fb923c}
  .card.privacy .card-value{color:#a78bfa}

  .chart-wrap{background:#1e293b;border-radius:12px;padding:20px;margin-bottom:24px}
  .chart-wrap h3{font-size:14px;color:#94a3b8;margin-bottom:12px}

  .data-table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
  .data-table th,.data-table td{padding:10px 16px;font-size:13px}
  .data-table th{background:#0f172a;color:#94a3b8;font-weight:500;text-align:left}
  .data-table td{text-align:right}
  .data-table th:first-child,.data-table td:first-child{text-align:left}
  .data-table tr:not(:last-child) td{border-bottom:1px solid #0f172a}

  .info-bar{display:flex;gap:24px;padding:12px 0;font-size:12px;color:#64748b}

  .level-tag{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px}
  .level-S1{background:rgba(56,189,248,.15);color:#38bdf8}
  .level-S2{background:rgba(251,146,60,.15);color:#fb923c}
  .level-S3{background:rgba(74,222,128,.15);color:#4ade80}
  .checkpoint-tag{font-size:11px;padding:2px 6px;border-radius:3px;background:#334155;color:#94a3b8}
  .session-key{font-family:ui-monospace,monospace;font-size:12px;color:#94a3b8}

  .empty-state{text-align:center;color:#64748b;padding:40px 0;font-size:14px}

  .filter-bar{display:flex;gap:8px;margin-bottom:16px}
  .filter-btn{padding:6px 14px;border-radius:6px;border:1px solid #334155;background:transparent;color:#94a3b8;cursor:pointer;font-size:12px;transition:all .15s}
  .filter-btn.active{background:#334155;color:#e2e8f0;border-color:#475569}
  .filter-btn:hover{border-color:#475569;color:#e2e8f0}

  .config-section{background:#1e293b;border-radius:12px;padding:20px;margin-bottom:16px}
  .config-section h3{font-size:14px;color:#94a3b8;margin-bottom:16px;text-transform:uppercase;letter-spacing:.5px}
  .field{margin-bottom:14px}
  .field label{display:block;font-size:13px;color:#94a3b8;margin-bottom:4px}
  .field input,.field select{width:100%;padding:8px 12px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;outline:none}
  .field input:focus,.field select:focus{border-color:#38bdf8}

  .tag-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;min-height:28px}
  .tag{background:#334155;color:#e2e8f0;padding:4px 10px;border-radius:4px;font-size:12px;display:flex;align-items:center;gap:4px}
  .tag button{background:none;border:none;color:#94a3b8;cursor:pointer;font-size:14px;line-height:1}
  .tag button:hover{color:#f87171}
  .add-row{display:flex;gap:8px;margin-top:8px}
  .add-row input{flex:1}

  .btn{padding:8px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:500;transition:all .15s}
  .btn-primary{background:#38bdf8;color:#0f172a}
  .btn-primary:hover{background:#7dd3fc}
  .btn-sm{padding:6px 12px;font-size:12px}
  .btn-outline{background:transparent;border:1px solid #334155;color:#e2e8f0}
  .btn-outline:hover{border-color:#38bdf8;color:#38bdf8}
  .save-bar{display:flex;justify-content:flex-end;gap:8px;padding-top:8px}

  .badge{display:inline-block;font-size:10px;padding:2px 6px;border-radius:3px;margin-left:8px;vertical-align:middle}
  .badge-hot{background:#065f46;color:#6ee7b7}

  .toast{position:fixed;bottom:24px;right:24px;background:#065f46;color:#d1fae5;padding:12px 20px;border-radius:8px;font-size:13px;display:none;z-index:100}
  .toast.error{background:#7f1d1d;color:#fecaca}

  .rules-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:700px){.rules-grid{grid-template-columns:1fr}}
  .rules-col h4{font-size:12px;color:#64748b;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #334155;padding-bottom:6px}

  .toggle-bar{display:flex;align-items:center;justify-content:space-between;background:#1e293b;border-radius:12px;padding:16px 20px;margin-bottom:16px}
  .toggle-bar label{font-size:14px;color:#e2e8f0}
  .toggle{position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0}
  .toggle input{opacity:0;width:0;height:0}
  .toggle .slider{position:absolute;inset:0;background:#334155;border-radius:12px;cursor:pointer;transition:.2s}
  .toggle .slider::before{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;background:#94a3b8;border-radius:50%;transition:.2s}
  .toggle input:checked+.slider{background:#38bdf8}
  .toggle input:checked+.slider::before{transform:translateX(20px);background:#fff}

  .chip-group{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .chip{padding:4px 10px;border-radius:4px;font-size:12px;cursor:pointer;border:1px solid #334155;background:transparent;color:#94a3b8;transition:all .15s}
  .chip.active{background:#334155;color:#e2e8f0;border-color:#475569}
  .chip:hover{border-color:#475569;color:#e2e8f0}

  .router-card{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:14px;margin-bottom:10px}
  .router-card .rc-head{display:flex;align-items:center;gap:8px}
  .router-card .rc-name{font-size:13px;color:#e2e8f0;font-weight:500}
  .router-card .rc-type{font-size:11px;color:#64748b}
  .router-card .rc-del{margin-left:auto;background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;line-height:1}
  .router-card .rc-del:hover{color:#f87171}
  .router-card .rc-module{font-size:11px;color:#64748b;margin-top:4px}

  .field-toggle{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .field-toggle>label{font-size:13px;color:#94a3b8;margin-bottom:0}
  .hint{font-size:11px;color:#64748b;margin-top:4px}
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <h1>GuardClaw Dashboard</h1>
  </div>
  <div class="header-right">
    <span class="status-dot warn" id="status-dot"></span>
    <span id="status-text">Connecting...</span>
    <span id="last-updated"></span>
    <button class="btn btn-sm btn-outline" onclick="refreshAll()">Refresh</button>
  </div>
</div>

<div class="tabs">
  <div class="tab active" data-tab="stats">Overview</div>
  <div class="tab" data-tab="sessions">Sessions</div>
  <div class="tab" data-tab="detections">Detection Log</div>
  <div class="tab" data-tab="config">Configuration <span class="badge badge-hot">live</span></div>
</div>

<!-- Overview -->
<div id="stats-panel" class="panel active">
  <div class="cards">
    <div class="card cloud">
      <div class="card-label">Cloud Tokens</div>
      <div class="card-value" id="cloud-tokens">-</div>
      <div class="card-sub" id="cloud-reqs">0 requests</div>
    </div>
    <div class="card local">
      <div class="card-label">Local Tokens</div>
      <div class="card-value" id="local-tokens">-</div>
      <div class="card-sub" id="local-reqs">0 requests</div>
    </div>
    <div class="card proxy">
      <div class="card-label">Proxy Tokens</div>
      <div class="card-value" id="proxy-tokens">-</div>
      <div class="card-sub" id="proxy-reqs">0 requests</div>
    </div>
    <div class="card privacy">
      <div class="card-label">Privacy Rate</div>
      <div class="card-value" id="privacy-rate">-</div>
      <div class="card-sub" id="privacy-sub">of total tokens protected</div>
    </div>
  </div>
  <div class="chart-wrap">
    <h3>Hourly Token Usage</h3>
    <canvas id="hourlyChart" height="80"></canvas>
  </div>
  <table class="data-table">
    <thead><tr><th>Category</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Total</th><th>Requests</th></tr></thead>
    <tbody id="detail-body"></tbody>
  </table>
  <div class="info-bar" id="info-bar"></div>
</div>

<!-- Sessions -->
<div id="sessions-panel" class="panel">
  <table class="data-table">
    <thead><tr><th>Session</th><th>Level</th><th>Cloud</th><th>Local</th><th>Proxy</th><th>Total</th><th>Requests</th><th>Last Active</th></tr></thead>
    <tbody id="sessions-body"><tr><td colspan="8" class="empty-state">No session data yet</td></tr></tbody>
  </table>
</div>

<!-- Detection Log -->
<div id="detections-panel" class="panel">
  <div class="filter-bar">
    <button class="filter-btn active" onclick="filterDetections('all',this)">All</button>
    <button class="filter-btn" onclick="filterDetections('S1',this)">S1</button>
    <button class="filter-btn" onclick="filterDetections('S2',this)">S2</button>
    <button class="filter-btn" onclick="filterDetections('S3',this)">S3</button>
  </div>
  <table class="data-table">
    <thead><tr><th>Time</th><th>Session</th><th>Level</th><th>Checkpoint</th><th>Reason</th></tr></thead>
    <tbody id="detections-body"><tr><td colspan="5" class="empty-state">No detections yet</td></tr></tbody>
  </table>
</div>

<!-- Configuration -->
<div id="config-panel" class="panel" style="max-width:1200px">

  <div class="toggle-bar">
    <label>GuardClaw Enabled</label>
    <label class="toggle"><input type="checkbox" id="cfg-enabled" checked><span class="slider"></span></label>
  </div>

  <div class="config-section">
    <h3>Local Model <span class="badge badge-hot">instant</span></h3>
    <div class="field-toggle">
      <label>Enabled</label>
      <label class="toggle"><input type="checkbox" id="cfg-lm-enabled" checked><span class="slider"></span></label>
    </div>
    <div class="field">
      <label>API Protocol</label>
      <select id="cfg-lm-type">
        <option value="openai-compatible">openai-compatible (Ollama, vLLM, LMStudio ...)</option>
        <option value="ollama-native">ollama-native (Ollama /api/chat)</option>
        <option value="custom">custom (user module)</option>
      </select>
    </div>
    <div class="field"><label>Provider</label><input id="cfg-lm-provider" placeholder="ollama"></div>
    <div class="field"><label>Endpoint</label><input id="cfg-lm-endpoint" placeholder="http://localhost:11434"></div>
    <div class="field"><label>Model</label><input id="cfg-lm-model" placeholder="openbmb/minicpm4.1"></div>
    <div class="field"><label>API Key</label><input id="cfg-lm-apikey" type="password" placeholder="sk-..."></div>
    <div class="field" id="cfg-lm-module-wrap" style="display:none"><label>Custom Module Path</label><input id="cfg-lm-module" placeholder="./my-provider.js"></div>
  </div>

  <div class="config-section">
    <h3>Guard Agent <span class="badge badge-hot">instant</span></h3>
    <div class="field"><label>Agent ID</label><input id="cfg-ga-id" placeholder="guard"></div>
    <div class="field"><label>Workspace</label><input id="cfg-ga-workspace" placeholder="~/.openclaw/workspace-guard"></div>
    <div class="field"><label>Model (provider/model)</label><input id="cfg-ga-model" placeholder="ollama/qwen3.5-27b"></div>
  </div>

  <div class="config-section">
    <h3>Routing Policy <span class="badge badge-hot">instant</span></h3>
    <div class="field">
      <label>S2 Handling Strategy</label>
      <select id="cfg-s2policy">
        <option value="proxy">proxy (strip PII via privacy proxy)</option>
        <option value="local">local (route entirely to local model)</option>
      </select>
    </div>
    <div class="field">
      <label>Proxy Port</label>
      <input id="cfg-proxyport" type="number" placeholder="8403" style="max-width:160px">
      <div class="hint">Requires restart to take effect</div>
    </div>
  </div>

  <div class="config-section">
    <h3>Session Settings <span class="badge badge-hot">instant</span></h3>
    <div class="field-toggle">
      <label>Isolate Guard History</label>
      <label class="toggle"><input type="checkbox" id="cfg-sess-isolate" checked><span class="slider"></span></label>
    </div>
    <div class="field"><label>Base Directory</label><input id="cfg-sess-basedir" placeholder="~/.openclaw"></div>
  </div>

  <div class="config-section">
    <h3>Checkpoints <span class="badge badge-hot">instant</span></h3>
    <div class="field">
      <label>onUserMessage</label>
      <div class="chip-group" id="ck-um">
        <button class="chip" data-ck="um" data-det="ruleDetector" onclick="toggleChip(this)">ruleDetector</button>
        <button class="chip" data-ck="um" data-det="localModelDetector" onclick="toggleChip(this)">localModelDetector</button>
      </div>
    </div>
    <div class="field">
      <label>onToolCallProposed</label>
      <div class="chip-group" id="ck-tcp">
        <button class="chip" data-ck="tcp" data-det="ruleDetector" onclick="toggleChip(this)">ruleDetector</button>
        <button class="chip" data-ck="tcp" data-det="localModelDetector" onclick="toggleChip(this)">localModelDetector</button>
      </div>
    </div>
    <div class="field">
      <label>onToolCallExecuted</label>
      <div class="chip-group" id="ck-tce">
        <button class="chip" data-ck="tce" data-det="ruleDetector" onclick="toggleChip(this)">ruleDetector</button>
        <button class="chip" data-ck="tce" data-det="localModelDetector" onclick="toggleChip(this)">localModelDetector</button>
      </div>
    </div>
  </div>

  <div class="config-section">
    <h3>Detection Rules <span class="badge badge-hot">instant</span></h3>
    <div class="rules-grid">
      <div class="rules-col">
        <h4>S2 &mdash; Moderate Sensitivity</h4>
        <div class="field">
          <label>Keywords</label>
          <div class="tag-list" id="cfg-tags-kw-s2"></div>
          <div class="add-row">
            <input id="cfg-tags-kw-s2-input" placeholder="e.g. salary, phone number" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('kw-s2')}">
            <button class="btn btn-sm btn-outline" onclick="addTag('kw-s2')">Add</button>
          </div>
        </div>
        <div class="field">
          <label>Regex Patterns</label>
          <div class="tag-list" id="cfg-tags-pat-s2"></div>
          <div class="add-row">
            <input id="cfg-tags-pat-s2-input" placeholder="e.g. \\d{3}-\\d{4}" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('pat-s2')}">
            <button class="btn btn-sm btn-outline" onclick="addTag('pat-s2')">Add</button>
          </div>
        </div>
        <div class="field">
          <label>Tool Names</label>
          <div class="tag-list" id="cfg-tags-tool-s2"></div>
          <div class="add-row">
            <input id="cfg-tags-tool-s2-input" placeholder="e.g. read_file, execute_sql" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('tool-s2')}">
            <button class="btn btn-sm btn-outline" onclick="addTag('tool-s2')">Add</button>
          </div>
        </div>
        <div class="field">
          <label>Tool Paths</label>
          <div class="tag-list" id="cfg-tags-toolpath-s2"></div>
          <div class="add-row">
            <input id="cfg-tags-toolpath-s2-input" placeholder="e.g. /secrets/, *.env" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('toolpath-s2')}">
            <button class="btn btn-sm btn-outline" onclick="addTag('toolpath-s2')">Add</button>
          </div>
        </div>
      </div>
      <div class="rules-col">
        <h4>S3 &mdash; High Sensitivity</h4>
        <div class="field">
          <label>Keywords</label>
          <div class="tag-list" id="cfg-tags-kw-s3"></div>
          <div class="add-row">
            <input id="cfg-tags-kw-s3-input" placeholder="e.g. SSN, bank account" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('kw-s3')}">
            <button class="btn btn-sm btn-outline" onclick="addTag('kw-s3')">Add</button>
          </div>
        </div>
        <div class="field">
          <label>Regex Patterns</label>
          <div class="tag-list" id="cfg-tags-pat-s3"></div>
          <div class="add-row">
            <input id="cfg-tags-pat-s3-input" placeholder="e.g. \\b\\d{3}-\\d{2}-\\d{4}\\b" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('pat-s3')}">
            <button class="btn btn-sm btn-outline" onclick="addTag('pat-s3')">Add</button>
          </div>
        </div>
        <div class="field">
          <label>Tool Names</label>
          <div class="tag-list" id="cfg-tags-tool-s3"></div>
          <div class="add-row">
            <input id="cfg-tags-tool-s3-input" placeholder="e.g. execute_command" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('tool-s3')}">
            <button class="btn btn-sm btn-outline" onclick="addTag('tool-s3')">Add</button>
          </div>
        </div>
        <div class="field">
          <label>Tool Paths</label>
          <div class="tag-list" id="cfg-tags-toolpath-s3"></div>
          <div class="add-row">
            <input id="cfg-tags-toolpath-s3-input" placeholder="e.g. /credentials/" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('toolpath-s3')}">
            <button class="btn btn-sm btn-outline" onclick="addTag('toolpath-s3')">Add</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="config-section">
    <h3>Local Providers <span class="badge badge-hot">instant</span></h3>
    <div class="field">
      <label>Additional providers treated as &quot;local&quot; (safe for S3 routing)</label>
      <div class="tag-list" id="cfg-tags-lp"></div>
      <div class="add-row">
        <input id="cfg-tags-lp-input" placeholder="e.g. my-inference-server" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('lp')}">
        <button class="btn btn-sm btn-outline" onclick="addTag('lp')">Add</button>
      </div>
    </div>
  </div>

  <div class="config-section">
    <h3>Routers</h3>
    <div id="cfg-routers-list"></div>
    <div style="margin-top:12px">
      <div class="add-row">
        <input id="cfg-router-id-input" placeholder="Router ID" style="flex:0.4">
        <select id="cfg-router-type-input" style="flex:0.3;padding:8px 12px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px">
          <option value="builtin">builtin</option>
          <option value="custom">custom</option>
        </select>
        <input id="cfg-router-module-input" placeholder="Module path (custom only)" style="flex:1">
        <button class="btn btn-sm btn-outline" onclick="addRouter()">Add</button>
      </div>
    </div>
  </div>

  <div class="config-section">
    <h3>Pipeline Order <span class="badge badge-hot">instant</span></h3>
    <div class="field">
      <label>onUserMessage</label>
      <div class="tag-list" id="cfg-tags-pipe-um"></div>
      <div class="add-row">
        <input id="cfg-tags-pipe-um-input" placeholder="Router ID, e.g. privacy" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('pipe-um')}">
        <button class="btn btn-sm btn-outline" onclick="addTag('pipe-um')">Add</button>
      </div>
    </div>
    <div class="field">
      <label>onToolCallProposed</label>
      <div class="tag-list" id="cfg-tags-pipe-tcp"></div>
      <div class="add-row">
        <input id="cfg-tags-pipe-tcp-input" placeholder="Router ID" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('pipe-tcp')}">
        <button class="btn btn-sm btn-outline" onclick="addTag('pipe-tcp')">Add</button>
      </div>
    </div>
    <div class="field">
      <label>onToolCallExecuted</label>
      <div class="tag-list" id="cfg-tags-pipe-tce"></div>
      <div class="add-row">
        <input id="cfg-tags-pipe-tce-input" placeholder="Router ID" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('pipe-tce')}">
        <button class="btn btn-sm btn-outline" onclick="addTag('pipe-tce')">Add</button>
      </div>
    </div>
  </div>

  <div class="save-bar">
    <button class="btn btn-primary" onclick="saveConfig()">Save All</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var BASE = '/plugins/guardclaw/stats/api';
var hourlyChart = null;
var _detections = [];
var _detectionFilter = 'all';
// ── Generic tag management ──
var _tags = {
  'kw-s2': [], 'kw-s3': [], 'pat-s2': [], 'pat-s3': [],
  'tool-s2': [], 'tool-s3': [], 'toolpath-s2': [], 'toolpath-s3': [],
  'lp': [],
  'pipe-um': [], 'pipe-tcp': [], 'pipe-tce': []
};

var _checkpoints = { um: [], tcp: [], tce: [] };
var _routers = {};

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderTags(key) {
  var c = document.getElementById('cfg-tags-' + key);
  if (!c) return;
  c.innerHTML = _tags[key].map(function(v, i) {
    return '<span class="tag">' + escHtml(v) +
      ' <button data-key="' + key + '" data-idx="' + i + '" onclick="removeTag(this)">&times;</button></span>';
  }).join('');
}

function addTag(key) {
  var input = document.getElementById('cfg-tags-' + key + '-input');
  if (!input) return;
  var val = input.value.trim();
  if (val && _tags[key].indexOf(val) === -1) {
    _tags[key].push(val);
    renderTags(key);
  }
  input.value = '';
  input.focus();
}

function removeTag(el) {
  var key = el.getAttribute('data-key');
  var idx = parseInt(el.getAttribute('data-idx'));
  if (key && _tags[key]) {
    _tags[key].splice(idx, 1);
    renderTags(key);
  }
}

// ── Checkpoint chips ──
function toggleChip(el) {
  var ck = el.getAttribute('data-ck');
  var det = el.getAttribute('data-det');
  if (!ck || !det || !_checkpoints[ck]) return;
  var arr = _checkpoints[ck];
  var idx = arr.indexOf(det);
  if (idx === -1) { arr.push(det); el.classList.add('active'); }
  else { arr.splice(idx, 1); el.classList.remove('active'); }
}

function syncChips() {
  document.querySelectorAll('.chip[data-ck]').forEach(function(el) {
    var ck = el.getAttribute('data-ck');
    var det = el.getAttribute('data-det');
    if (_checkpoints[ck] && _checkpoints[ck].indexOf(det) !== -1) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });
}

// ── Router management ──
function renderRouters() {
  var c = document.getElementById('cfg-routers-list');
  var ids = Object.keys(_routers);
  if (!ids.length) {
    c.innerHTML = '<div style="color:#64748b;font-size:13px;padding:8px 0">No routers configured</div>';
    return;
  }
  c.innerHTML = ids.map(function(id) {
    var r = _routers[id];
    var checked = r.enabled !== false ? ' checked' : '';
    return '<div class="router-card"><div class="rc-head">' +
      '<label class="toggle"><input type="checkbox"' + checked +
      ' data-rid="' + escHtml(id) + '" onchange="toggleRouter(this)"><span class="slider"></span></label>' +
      '<span class="rc-name">' + escHtml(id) + '</span>' +
      '<span class="rc-type">[' + escHtml(r.type || 'builtin') + ']</span>' +
      '<button class="rc-del" data-rid="' + escHtml(id) + '" onclick="removeRouter(this)">&times;</button>' +
      '</div>' +
      (r.module ? '<div class="rc-module">Module: ' + escHtml(r.module) + '</div>' : '') +
      '</div>';
  }).join('');
}

function toggleRouter(el) {
  var id = el.getAttribute('data-rid');
  if (id && _routers[id]) _routers[id].enabled = el.checked;
}

function removeRouter(el) {
  var id = el.getAttribute('data-rid');
  if (id) { delete _routers[id]; renderRouters(); }
}

function addRouter() {
  var idInput = document.getElementById('cfg-router-id-input');
  var typeInput = document.getElementById('cfg-router-type-input');
  var moduleInput = document.getElementById('cfg-router-module-input');
  var id = idInput.value.trim();
  if (!id) return;
  _routers[id] = {
    enabled: true,
    type: typeInput.value || 'builtin',
    module: typeInput.value === 'custom' ? (moduleInput.value.trim() || undefined) : undefined
  };
  renderRouters();
  idInput.value = '';
  moduleInput.value = '';
}

// ── Tabs ──
document.querySelectorAll('.tab').forEach(function(t) {
  t.addEventListener('click', function() {
    document.querySelectorAll('.tab').forEach(function(x) { x.classList.remove('active'); });
    document.querySelectorAll('.panel').forEach(function(x) { x.classList.remove('active'); });
    t.classList.add('active');
    document.getElementById(t.dataset.tab + '-panel').classList.add('active');
  });
});

// ── Formatters ──
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function timeAgo(ts) {
  var diff = Date.now() - ts;
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function fmtTime(ts) {
  var d = new Date(ts);
  var hh = String(d.getHours()).padStart(2, '0');
  var mm = String(d.getMinutes()).padStart(2, '0');
  var ss = String(d.getSeconds()).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}

function fillRow(cat, b) {
  return '<tr><td>' + cat + '</td><td>' + fmt(b.inputTokens) + '</td><td>' + fmt(b.outputTokens) +
    '</td><td>' + fmt(b.cacheReadTokens) + '</td><td>' + fmt(b.totalTokens) + '</td><td>' + b.requestCount + '</td></tr>';
}

// ── Overview ──
async function refreshStats() {
  try {
    var results = await Promise.all([
      fetch(BASE + '/summary').then(function(r) { return r.json(); }),
      fetch(BASE + '/hourly').then(function(r) { return r.json(); }),
    ]);
    var summary = results[0];
    var hourly = results[1];
    if (summary.error) throw new Error(summary.error);

    var lt = summary.lifetime;
    document.getElementById('cloud-tokens').textContent = fmt(lt.cloud.totalTokens);
    document.getElementById('cloud-reqs').textContent = lt.cloud.requestCount + ' requests';
    document.getElementById('local-tokens').textContent = fmt(lt.local.totalTokens);
    document.getElementById('local-reqs').textContent = lt.local.requestCount + ' requests';
    document.getElementById('proxy-tokens').textContent = fmt(lt.proxy.totalTokens);
    document.getElementById('proxy-reqs').textContent = lt.proxy.requestCount + ' requests';

    var total = lt.cloud.totalTokens + lt.local.totalTokens + lt.proxy.totalTokens;
    var prot = lt.local.totalTokens + lt.proxy.totalTokens;
    var rate = total > 0 ? (prot / total * 100).toFixed(1) + '%' : '--';
    document.getElementById('privacy-rate').textContent = rate;
    document.getElementById('privacy-sub').textContent = total > 0
      ? fmt(prot) + ' of ' + fmt(total) + ' tokens protected'
      : 'No data yet';

    document.getElementById('detail-body').innerHTML =
      fillRow('Cloud', lt.cloud) + fillRow('Local', lt.local) + fillRow('Proxy', lt.proxy);

    var infoHtml = '';
    if (summary.startedAt) infoHtml += 'Uptime: ' + timeAgo(summary.startedAt);
    if (summary.lastUpdatedAt) infoHtml += ' &middot; Last activity: ' + timeAgo(summary.lastUpdatedAt);
    document.getElementById('info-bar').innerHTML = infoHtml;

    document.getElementById('status-dot').className = 'status-dot';
    document.getElementById('status-text').textContent = 'Online';
    document.getElementById('last-updated').textContent = 'Updated ' + fmtTime(Date.now());

    updateChart(hourly);
  } catch (e) {
    document.getElementById('status-dot').className = 'status-dot err';
    document.getElementById('status-text').textContent = 'Error: ' + (e.message || 'unavailable');
  }
}

function updateChart(hourly) {
  var labels = hourly.map(function(h) { return h.hour.slice(5).replace('T', ' ') + ':00'; });
  var cloudData = hourly.map(function(h) { return h.cloud.totalTokens; });
  var localData = hourly.map(function(h) { return h.local.totalTokens; });
  var proxyData = hourly.map(function(h) { return h.proxy.totalTokens; });
  if (hourlyChart) {
    hourlyChart.data.labels = labels;
    hourlyChart.data.datasets[0].data = cloudData;
    hourlyChart.data.datasets[1].data = localData;
    hourlyChart.data.datasets[2].data = proxyData;
    hourlyChart.update('none');
  } else {
    var ctx = document.getElementById('hourlyChart');
    if (!ctx) return;
    hourlyChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
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

// ── Sessions ──
function totalForSession(s) {
  return s.cloud.totalTokens + s.local.totalTokens + s.proxy.totalTokens;
}
function totalReqsForSession(s) {
  return s.cloud.requestCount + s.local.requestCount + s.proxy.requestCount;
}

async function refreshSessions() {
  try {
    var sessions = await fetch(BASE + '/sessions').then(function(r) { return r.json(); });
    var tbody = document.getElementById('sessions-body');
    if (!sessions || !sessions.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No session data yet</td></tr>';
      return;
    }
    tbody.innerHTML = sessions.map(function(s) {
      var shortKey = s.sessionKey.length > 20 ? s.sessionKey.slice(0, 20) + '...' : s.sessionKey;
      return '<tr>' +
        '<td><span class="session-key" title="' + escHtml(s.sessionKey) + '">' + escHtml(shortKey) + '</span></td>' +
        '<td><span class="level-tag level-' + s.highestLevel + '">' + s.highestLevel + '</span></td>' +
        '<td>' + fmt(s.cloud.totalTokens) + '</td>' +
        '<td>' + fmt(s.local.totalTokens) + '</td>' +
        '<td>' + fmt(s.proxy.totalTokens) + '</td>' +
        '<td>' + fmt(totalForSession(s)) + '</td>' +
        '<td>' + totalReqsForSession(s) + '</td>' +
        '<td>' + timeAgo(s.lastActiveAt) + '</td>' +
        '</tr>';
    }).join('');
  } catch (e) { /* non-critical */ }
}

// ── Detection Log ──
async function refreshDetections() {
  try {
    _detections = await fetch(BASE + '/detections').then(function(r) { return r.json(); });
    renderDetections();
  } catch (e) { /* non-critical */ }
}

function filterDetections(level, el) {
  _detectionFilter = level;
  document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
  if (el) el.classList.add('active');
  renderDetections();
}

function renderDetections() {
  var tbody = document.getElementById('detections-body');
  var filtered = _detectionFilter === 'all'
    ? _detections
    : _detections.filter(function(d) { return d.level === _detectionFilter; });
  if (!filtered || !filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No detections' +
      (_detectionFilter !== 'all' ? ' for ' + _detectionFilter : '') + '</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.slice(0, 100).map(function(d) {
    var shortKey = d.sessionKey.length > 16 ? d.sessionKey.slice(0, 16) + '...' : d.sessionKey;
    return '<tr>' +
      '<td>' + fmtTime(d.timestamp) + '</td>' +
      '<td><span class="session-key" title="' + escHtml(d.sessionKey) + '">' + escHtml(shortKey) + '</span></td>' +
      '<td><span class="level-tag level-' + d.level + '">' + d.level + '</span></td>' +
      '<td><span class="checkpoint-tag">' + escHtml(d.checkpoint || '--') + '</span></td>' +
      '<td>' + escHtml(d.reason || '--') + '</td>' +
      '</tr>';
  }).join('');
}

// ── Config ──
function toggleModuleField() {
  var wrap = document.getElementById('cfg-lm-module-wrap');
  wrap.style.display = document.getElementById('cfg-lm-type').value === 'custom' ? 'block' : 'none';
}

async function loadConfig() {
  try {
    var cfg = await fetch(BASE + '/config').then(function(r) { return r.json(); });
    var p = cfg.privacy || {};
    var lm = p.localModel || {};
    var ga = p.guardAgent || {};
    var rules = p.rules || {};
    var sess = p.session || {};
    var ck = p.checkpoints || {};
    var routers = p.routers || {};
    var pipeline = p.pipeline || {};

    document.getElementById('cfg-enabled').checked = p.enabled !== false;
    document.getElementById('cfg-lm-enabled').checked = lm.enabled !== false;
    document.getElementById('cfg-lm-type').value = lm.type || 'openai-compatible';
    document.getElementById('cfg-lm-provider').value = lm.provider || '';
    document.getElementById('cfg-lm-endpoint').value = lm.endpoint || '';
    document.getElementById('cfg-lm-model').value = lm.model || '';
    document.getElementById('cfg-lm-apikey').value = lm.apiKey || '';
    document.getElementById('cfg-lm-module').value = lm.module || '';

    document.getElementById('cfg-ga-id').value = ga.id || '';
    document.getElementById('cfg-ga-workspace').value = ga.workspace || '';
    document.getElementById('cfg-ga-model').value = ga.model || '';

    document.getElementById('cfg-s2policy').value = p.s2Policy || 'proxy';
    document.getElementById('cfg-proxyport').value = p.proxyPort || '';

    document.getElementById('cfg-sess-isolate').checked = sess.isolateGuardHistory !== false;
    document.getElementById('cfg-sess-basedir').value = sess.baseDir || '';

    _checkpoints.um = Array.isArray(ck.onUserMessage) ? ck.onUserMessage.slice() : [];
    _checkpoints.tcp = Array.isArray(ck.onToolCallProposed) ? ck.onToolCallProposed.slice() : [];
    _checkpoints.tce = Array.isArray(ck.onToolCallExecuted) ? ck.onToolCallExecuted.slice() : [];
    syncChips();

    _tags['kw-s2'] = (rules.keywords && rules.keywords.S2) ? rules.keywords.S2.slice() : [];
    _tags['kw-s3'] = (rules.keywords && rules.keywords.S3) ? rules.keywords.S3.slice() : [];
    _tags['pat-s2'] = (rules.patterns && rules.patterns.S2) ? rules.patterns.S2.slice() : [];
    _tags['pat-s3'] = (rules.patterns && rules.patterns.S3) ? rules.patterns.S3.slice() : [];
    var toolRules = rules.tools || {};
    _tags['tool-s2'] = (toolRules.S2 && toolRules.S2.tools) ? toolRules.S2.tools.slice() : [];
    _tags['tool-s3'] = (toolRules.S3 && toolRules.S3.tools) ? toolRules.S3.tools.slice() : [];
    _tags['toolpath-s2'] = (toolRules.S2 && toolRules.S2.paths) ? toolRules.S2.paths.slice() : [];
    _tags['toolpath-s3'] = (toolRules.S3 && toolRules.S3.paths) ? toolRules.S3.paths.slice() : [];
    _tags['lp'] = Array.isArray(p.localProviders) ? p.localProviders.slice() : [];

    _tags['pipe-um'] = Array.isArray(pipeline.onUserMessage) ? pipeline.onUserMessage.slice() : [];
    _tags['pipe-tcp'] = Array.isArray(pipeline.onToolCallProposed) ? pipeline.onToolCallProposed.slice() : [];
    _tags['pipe-tce'] = Array.isArray(pipeline.onToolCallExecuted) ? pipeline.onToolCallExecuted.slice() : [];

    _routers = {};
    if (routers && typeof routers === 'object') {
      Object.keys(routers).forEach(function(k) { _routers[k] = Object.assign({}, routers[k]); });
    }
    renderRouters();

    Object.keys(_tags).forEach(function(k) { renderTags(k); });
    toggleModuleField();
  } catch (e) { /* non-critical, fields stay at defaults */ }
}

document.getElementById('cfg-lm-type').addEventListener('change', toggleModuleField);

async function saveConfig() {
  try {
    var typeVal = document.getElementById('cfg-lm-type').value;
    var portVal = document.getElementById('cfg-proxyport').value;

    var payload = {
      privacy: {
        enabled: document.getElementById('cfg-enabled').checked,
        localModel: {
          enabled: document.getElementById('cfg-lm-enabled').checked,
          type: typeVal || undefined,
          provider: document.getElementById('cfg-lm-provider').value || undefined,
          endpoint: document.getElementById('cfg-lm-endpoint').value || undefined,
          model: document.getElementById('cfg-lm-model').value || undefined,
          apiKey: document.getElementById('cfg-lm-apikey').value || undefined,
          module: typeVal === 'custom' ? (document.getElementById('cfg-lm-module').value || undefined) : undefined,
        },
        guardAgent: {
          id: document.getElementById('cfg-ga-id').value || undefined,
          workspace: document.getElementById('cfg-ga-workspace').value || undefined,
          model: document.getElementById('cfg-ga-model').value || undefined,
        },
        s2Policy: document.getElementById('cfg-s2policy').value,
        proxyPort: portVal ? parseInt(portVal) : undefined,
        checkpoints: {
          onUserMessage: _checkpoints.um.length ? _checkpoints.um : undefined,
          onToolCallProposed: _checkpoints.tcp.length ? _checkpoints.tcp : undefined,
          onToolCallExecuted: _checkpoints.tce.length ? _checkpoints.tce : undefined,
        },
        rules: {
          keywords: { S2: _tags['kw-s2'], S3: _tags['kw-s3'] },
          patterns: { S2: _tags['pat-s2'], S3: _tags['pat-s3'] },
          tools: {
            S2: { tools: _tags['tool-s2'], paths: _tags['toolpath-s2'] },
            S3: { tools: _tags['tool-s3'], paths: _tags['toolpath-s3'] },
          },
        },
        localProviders: _tags['lp'].length > 0 ? _tags['lp'] : [],
        session: {
          isolateGuardHistory: document.getElementById('cfg-sess-isolate').checked,
          baseDir: document.getElementById('cfg-sess-basedir').value || undefined,
        },
        routers: Object.keys(_routers).length > 0 ? _routers : undefined,
        pipeline: {
          onUserMessage: _tags['pipe-um'].length ? _tags['pipe-um'] : undefined,
          onToolCallProposed: _tags['pipe-tcp'].length ? _tags['pipe-tcp'] : undefined,
          onToolCallExecuted: _tags['pipe-tce'].length ? _tags['pipe-tce'] : undefined,
        },
      },
    };
    var res = await fetch(BASE + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var result = await res.json();
    if (result.ok) {
      showToast('Configuration saved');
    } else {
      showToast('Save failed: ' + (result.error || 'unknown'), true);
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, true);
  }
}

function showToast(msg, isError) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 3000);
}

function refreshAll() {
  refreshStats();
  refreshSessions();
  refreshDetections();
}

// ── Init ──
refreshAll();
loadConfig();
setInterval(refreshAll, 30000);
</script>
</body>
</html>`;
}
