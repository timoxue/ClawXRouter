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
 *   - GET  /plugins/guardclaw/stats/api/prompts  → all editable prompts
 *   - POST /plugins/guardclaw/stats/api/prompts  → save a prompt (hot-reload)
 *   - POST /plugins/guardclaw/stats/api/test-classify → dry-run pipeline classification
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getGlobalCollector } from "./token-stats.js";
import { getLiveConfig, updateLiveConfig } from "./live-config.js";
import { getAllSessionStates } from "./session-state.js";
import { loadPrompt, readPromptFromDisk, writePrompt } from "./prompt-loader.js";
import { DEFAULT_JUDGE_PROMPT } from "./routers/token-saver.js";
import { DEFAULT_DETECTION_SYSTEM_PROMPT, DEFAULT_PII_EXTRACTION_PROMPT } from "./local-model.js";
import type { RouterPipeline } from "./router-pipeline.js";
import { createConfigurableRouter } from "./routers/configurable.js";

const DASHBOARD_CONFIG_PATH = join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "guardclaw-dashboard.json",
);

export function loadDashboardOverrides(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(DASHBOARD_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function saveDashboardOverrides(privacy: Record<string, unknown>): void {
  try {
    mkdirSync(join(process.env.HOME ?? "/tmp", ".openclaw"), { recursive: true });
    writeFileSync(DASHBOARD_CONFIG_PATH, JSON.stringify(privacy, null, 2), "utf-8");
  } catch {
    // best-effort persistence
  }
}

export type DashboardDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadConfig: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeConfigFile: (...args: any[]) => Promise<void>;
  pluginId: string;
  pluginConfig: Record<string, unknown>;
  pipeline: RouterPipeline | null;
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

        const existingPrivacy = ((deps.pluginConfig as Record<string, unknown>).privacy ?? {}) as Record<string, unknown>;
        const mergedPrivacy = { ...existingPrivacy, ...body.privacy } as Record<string, unknown>;

        // Persist to guardclaw-local file (does NOT touch openclaw.json → no restart)
        saveDashboardOverrides(mergedPrivacy);

        // Dynamically register/update configurable routers in the pipeline
        if (body.privacy.routers && deps.pipeline) {
          const routers = body.privacy.routers as Record<string, { type?: string; enabled?: boolean }>;
          for (const [id, reg] of Object.entries(routers)) {
            if (reg.type === "configurable" && !deps.pipeline.hasRouter(id)) {
              deps.pipeline.register(
                createConfigurableRouter(id),
                reg as Parameters<typeof deps.pipeline.register>[1],
              );
            }
          }
          deps.pipeline.configure({
            routers: mergedPrivacy.routers as Record<string, Parameters<typeof deps.pipeline.register>[1]>,
            pipeline: mergedPrivacy.pipeline as Record<string, string[]>,
          });
        }
        // Update deps.pluginConfig so test-classify picks up new options
        (deps.pluginConfig as Record<string, unknown>).privacy = mergedPrivacy;
      }

      json(res, { ok: true });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
    return true;
  }

  // ── Prompts API ──

  const EDITABLE_PROMPTS: Record<string, { label: string; defaultContent: string }> = {
    "detection-system": { label: "Sensitivity Classifier Prompt", defaultContent: DEFAULT_DETECTION_SYSTEM_PROMPT },
    "token-saver-judge": { label: "Cost-Optimizer (Task Complexity Classifier)", defaultContent: DEFAULT_JUDGE_PROMPT },
    "pii-extraction": { label: "Personal Info Redaction Prompt", defaultContent: DEFAULT_PII_EXTRACTION_PROMPT },
  };

  if (req.method === "GET" && sub === "/api/prompts") {
    const result: Record<string, { label: string; content: string; isCustom: boolean; defaultContent: string }> = {};
    for (const [name, meta] of Object.entries(EDITABLE_PROMPTS)) {
      const fromDisk = readPromptFromDisk(name);
      result[name] = {
        label: meta.label,
        content: fromDisk ?? meta.defaultContent,
        isCustom: fromDisk !== null,
        defaultContent: meta.defaultContent,
      };
    }
    json(res, result);
    return true;
  }

  if (req.method === "POST" && sub === "/api/prompts") {
    try {
      const body = JSON.parse(await readBody(req)) as { name: string; content: string };
      if (!body.name || typeof body.content !== "string") {
        json(res, { error: "name and content required" }, 400);
        return true;
      }
      // Allow both built-in prompts and custom router prompts (custom-*)
      if (!EDITABLE_PROMPTS[body.name] && !body.name.startsWith("custom-")) {
        json(res, { error: `Unknown prompt: ${body.name}` }, 400);
        return true;
      }
      writePrompt(body.name, body.content);
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
    return true;
  }

  // ── Test Classify API ──

  if (req.method === "POST" && sub === "/api/test-classify") {
    if (!deps?.pipeline) { json(res, { error: "pipeline not initialized" }, 503); return true; }
    try {
      const body = JSON.parse(await readBody(req)) as { message: string; checkpoint?: string; router?: string };
      if (!body.message?.trim()) {
        json(res, { error: "message required" }, 400);
        return true;
      }
      const checkpoint = (body.checkpoint ?? "onUserMessage") as "onUserMessage" | "onToolCallProposed" | "onToolCallExecuted";

      if (body.router) {
        const decision = await deps.pipeline.runSingle(
          body.router,
          { checkpoint, message: body.message, sessionKey: "__test__" },
          deps.pluginConfig,
        );
        if (!decision) {
          json(res, { error: `Router not found: ${body.router}` }, 404);
          return true;
        }
        json(res, {
          level: decision.level,
          action: decision.action,
          target: decision.target,
          reason: decision.reason,
          confidence: decision.confidence,
          routerId: decision.routerId,
        });
      } else {
        // Full pipeline test — return merged result + individual router results
        const [merged, individual] = await Promise.all([
          deps.pipeline.run(
            checkpoint,
            { checkpoint, message: body.message, sessionKey: "__test__" },
            deps.pluginConfig,
          ),
          deps.pipeline.runEach(
            checkpoint,
            { checkpoint, message: body.message, sessionKey: "__test__" },
            deps.pluginConfig,
          ),
        ]);
        json(res, {
          level: merged.level,
          action: merged.action,
          target: merged.target,
          reason: merged.reason,
          confidence: merged.confidence,
          routerId: merged.routerId,
          routers: individual.map((d) => ({
            routerId: d.routerId,
            level: d.level,
            action: d.action,
            target: d.target,
            reason: d.reason,
            confidence: d.confidence,
          })),
        });
      }
    } catch (err) {
      json(res, { error: String(err) }, 500);
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

  .panel{display:none;padding:24px}
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

  .config-section{background:#1e293b;border-radius:12px;padding:24px;margin-bottom:16px}
  .config-section h3{font-size:14px;color:#94a3b8;margin-bottom:16px;text-transform:uppercase;letter-spacing:.5px}
  .field{margin-bottom:14px}
  .field label{display:block;font-size:13px;color:#94a3b8;margin-bottom:6px}
  .field input,.field select{width:100%;padding:9px 14px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;outline:none}
  .field select{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;padding-right:36px}
  .field input:focus,.field select:focus{border-color:#38bdf8}

  .tag-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;min-height:32px}
  .tag{background:#334155;color:#e2e8f0;padding:4px 10px;border-radius:4px;font-size:12px;display:flex;align-items:center;gap:4px}
  .tag button{background:none;border:none;color:#94a3b8;cursor:pointer;font-size:14px;line-height:1}
  .tag button:hover{color:#f87171}
  .add-row{display:flex;gap:10px;margin-top:8px;align-items:center}
  .add-row input{flex:1;min-width:0}

  .btn{padding:9px 18px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:500;transition:all .15s;white-space:nowrap;flex-shrink:0}
  .btn-primary{background:#38bdf8;color:#0f172a}
  .btn-primary:hover{background:#7dd3fc}
  .btn-sm{padding:7px 14px;font-size:12px}
  .btn-outline{background:transparent;border:1px solid #334155;color:#e2e8f0}
  .btn-outline:hover{border-color:#38bdf8;color:#38bdf8}
  .save-bar{display:flex;justify-content:flex-end;gap:10px;padding-top:12px;margin-top:8px}

  .badge{display:inline-block;font-size:10px;padding:2px 6px;border-radius:3px;margin-left:8px;vertical-align:middle}
  .badge-hot{background:#065f46;color:#6ee7b7}

  .toast{position:fixed;bottom:24px;right:24px;background:#065f46;color:#d1fae5;padding:12px 20px;border-radius:8px;font-size:13px;display:none;z-index:100}
  .toast.error{background:#7f1d1d;color:#fecaca}

  .rules-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media(max-width:700px){.rules-grid{grid-template-columns:1fr}}
  .rules-col{background:#0f172a;border-radius:8px;padding:16px}
  .rules-col h4{font-size:12px;color:#64748b;margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #334155;padding-bottom:8px}

  .toggle-bar{display:flex;align-items:center;justify-content:space-between;background:#1e293b;border-radius:12px;padding:18px 24px;margin-bottom:16px}
  .toggle-bar label{font-size:14px;color:#e2e8f0}
  .toggle{position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0}
  .toggle input{opacity:0;width:0;height:0}
  .toggle .slider{position:absolute;inset:0;background:#334155;border-radius:12px;cursor:pointer;transition:.2s}
  .toggle .slider::before{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;background:#94a3b8;border-radius:50%;transition:.2s}
  .toggle input:checked+.slider{background:#38bdf8}
  .toggle input:checked+.slider::before{transform:translateX(20px);background:#fff}

  .chip-group{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
  .chip{padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid #334155;background:transparent;color:#94a3b8;transition:all .15s}
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

  .prompt-editor{width:100%;min-height:200px;padding:14px 16px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-family:ui-monospace,monospace;font-size:12px;line-height:1.5;resize:vertical;outline:none;tab-size:2}
  .prompt-editor:focus{border-color:#38bdf8}
  .prompt-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .prompt-header h4{font-size:13px;color:#e2e8f0;font-weight:500}
  .prompt-actions{display:flex;gap:6px}
  .custom-badge{font-size:10px;padding:2px 6px;border-radius:3px;background:#1e40af;color:#93c5fd;margin-left:8px}

  .test-panel{background:#1e293b;border-radius:12px;padding:24px;margin-bottom:16px}
  .test-input{width:100%;min-height:80px;padding:12px 14px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;resize:vertical;outline:none}
  .test-input:focus{border-color:#38bdf8}
  .test-result{margin-top:16px;padding:16px 18px;background:#0f172a;border-radius:8px;border:1px solid #334155;display:none}
  .test-result.visible{display:block}
  .test-result-row{display:flex;justify-content:space-between;padding:8px 0;font-size:13px;border-bottom:1px solid #1e293b}
  .test-result-row:last-child{border-bottom:none}
  .test-result-label{color:#94a3b8}
  .test-result-value{color:#e2e8f0;font-weight:500}
  .test-loading{color:#94a3b8;font-size:13px;padding:12px 0}

  .tier-grid{display:grid;grid-template-columns:120px 1fr 1fr;gap:10px;align-items:center}
  .tier-grid .tier-label{font-size:12px;color:#94a3b8;font-weight:600}
  .tier-grid input{padding:8px 12px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:12px;outline:none}
  .tier-grid input:focus{border-color:#38bdf8}
  .tier-grid-header{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;padding-bottom:6px}

  .section-collapse{cursor:pointer;user-select:none}
  .section-collapse::before{content:'\\25BC';display:inline-block;margin-right:8px;font-size:10px;transition:transform .2s}
  .section-collapse.collapsed::before{transform:rotate(-90deg)}
  .section-body{overflow:hidden;transition:max-height .3s ease}
  .section-body.collapsed{max-height:0 !important;padding:0;overflow:hidden}

  .router-section{background:#1e293b;border-radius:12px;margin-bottom:16px;border:1px solid #334155;overflow:hidden}
  .router-section-header{display:flex;align-items:center;gap:12px;padding:18px 24px;cursor:pointer;user-select:none;transition:background .15s}
  .router-section-header:hover{background:#243044}
  .router-section-header h3{font-size:15px;color:#e2e8f0;font-weight:600;margin:0}
  .router-section-header .section-arrow{font-size:10px;color:#64748b;transition:transform .2s;display:inline-block}
  .router-section-header.collapsed .section-arrow{transform:rotate(-90deg)}
  .router-id-badge{font-size:11px;padding:2px 8px;border-radius:4px;background:#0f172a;color:#64748b;font-family:ui-monospace,monospace}
  .router-section-body{padding:0 24px 24px}
  .router-section-body.collapsed{display:none}
  .subsection{margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid #334155}
  .subsection:last-of-type{border-bottom:none;margin-bottom:0;padding-bottom:0}
  .subsection>h4{font-size:13px;color:#94a3b8;margin-bottom:14px;text-transform:uppercase;letter-spacing:.5px}
  .add-custom-router{background:#1e293b;border:2px dashed #334155;border-radius:12px;padding:24px;margin-bottom:16px;transition:border-color .15s}
  .add-custom-router:hover{border-color:#475569}
  .btn-danger{background:#7f1d1d;color:#fecaca;border:none}
  .btn-danger:hover{background:#991b1b}
  .pipe-picker{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .pipe-pick-btn{padding:5px 12px;border-radius:5px;font-size:12px;cursor:pointer;border:1px dashed #475569;background:transparent;color:#64748b;transition:all .15s;font-family:ui-monospace,monospace}
  .pipe-pick-btn:hover{border-color:#38bdf8;color:#38bdf8}
  .pipe-pick-btn.in-use{opacity:.35;cursor:default;border-style:solid}
  .pipe-pick-btn.in-use:hover{border-color:#475569;color:#64748b}
  .tag.pipe-tag{cursor:grab;user-select:none}
  .tag.pipe-tag.dragging{opacity:.4}
  .adv-toggle{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-size:12px;color:#64748b;margin:16px 0 8px;padding:6px 0}
  .adv-toggle:hover{color:#94a3b8}
  .adv-toggle .adv-arrow{font-size:10px;transition:transform .2s;display:inline-block}
  .adv-toggle.open .adv-arrow{transform:rotate(90deg)}
  .adv-body{display:none}
  .adv-body.open{display:block}
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
  <div class="tab" data-tab="rules">Router Rules <span class="badge badge-hot">live</span></div>
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
      <div class="card-label">Redacted Tokens</div>
      <div class="card-value" id="proxy-tokens">-</div>
      <div class="card-sub" id="proxy-reqs">0 requests</div>
    </div>
    <div class="card privacy">
      <div class="card-label">Data Protection Rate</div>
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
    <thead><tr><th>Session</th><th>Level</th><th>Cloud</th><th>Local</th><th>Redacted</th><th>Total</th><th>Requests</th><th>Last Active</th></tr></thead>
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

<!-- Router Rules -->
<div id="rules-panel" class="panel">

  <!-- Pipeline Test (full pipeline) -->
  <div class="test-panel">
    <h3 style="font-size:14px;color:#94a3b8;margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px">Test Classification</h3>
    <div class="hint" style="margin-bottom:10px">Test how the router pipeline would classify a message (no changes applied).</div>
    <textarea class="test-input" id="test-message" placeholder="e.g. &quot;帮我分析一下这个月的工资单&quot; or &quot;write a poem about spring&quot;"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
      <select id="test-checkpoint" style="padding:9px 36px 9px 14px;background:#0f172a url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M2 4l4 4 4-4'/%3E%3C/svg%3E&quot;) no-repeat right 14px center;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:12px;appearance:none;-webkit-appearance:none">
        <option value="onUserMessage">User Message</option>
        <option value="onToolCallProposed">Before Tool Runs</option>
        <option value="onToolCallExecuted">After Tool Runs</option>
      </select>
      <button class="btn btn-primary btn-sm" onclick="runTestClassify()">Run Test</button>
    </div>
    <div class="test-result" id="test-result">
      <div style="font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:.5px;margin-bottom:8px">Merged Result</div>
      <div class="test-result-row"><span class="test-result-label">Level</span><span class="test-result-value" id="tr-level">-</span></div>
      <div class="test-result-row"><span class="test-result-label">Action</span><span class="test-result-value" id="tr-action">-</span></div>
      <div class="test-result-row"><span class="test-result-label">Target</span><span class="test-result-value" id="tr-target">-</span></div>
      <div class="test-result-row"><span class="test-result-label">Deciding Router</span><span class="test-result-value" id="tr-router">-</span></div>
      <div class="test-result-row"><span class="test-result-label">Reason</span><span class="test-result-value" id="tr-reason">-</span></div>
      <div class="test-result-row"><span class="test-result-label">Confidence</span><span class="test-result-value" id="tr-confidence">-</span></div>
      <div id="tr-per-router"></div>
    </div>
    <div class="test-loading" id="test-loading" style="display:none">Classifying...</div>
  </div>

  <!-- Pipeline Order (Advanced) -->
  <div class="adv-toggle" onclick="toggleAdv(this)">
    <span class="adv-arrow">&#9654;</span> Router Execution Order (Advanced)
  </div>
  <div class="adv-body">
    <div class="config-section">
      <div class="hint" style="margin-bottom:12px">Click a router to add it to a stage. Drag tags to reorder. Click &times; to remove.</div>
      <div class="field">
        <label>User Message</label>
        <div class="tag-list" id="cfg-tags-pipe-um"></div>
        <div class="pipe-picker" id="pipe-picker-um"></div>
      </div>
      <div class="field">
        <label>Before Tool Runs</label>
        <div class="tag-list" id="cfg-tags-pipe-tcp"></div>
        <div class="pipe-picker" id="pipe-picker-tcp"></div>
      </div>
      <div class="field">
        <label>After Tool Runs</label>
        <div class="tag-list" id="cfg-tags-pipe-tce"></div>
        <div class="pipe-picker" id="pipe-picker-tce"></div>
      </div>
      <div class="save-bar"><button class="btn btn-primary btn-sm" onclick="savePipelineOrder()">Save Execution Order</button></div>
    </div>
  </div>

  <!-- ═══ Privacy Router Card ═══ -->
  <div class="router-section">
    <div class="router-section-header" onclick="toggleSection(this)">
      <span class="section-arrow">&#9660;</span>
      <h3>Privacy Router</h3>
      <span class="router-id-badge">privacy</span>
    </div>
    <div class="router-section-body">

      <div class="field-toggle" style="margin-bottom:18px">
        <label>Enabled</label>
        <label class="toggle"><input type="checkbox" id="cfg-privacy-enabled" checked><span class="slider"></span></label>
      </div>

      <!-- Keywords (always visible) -->
      <div class="subsection">
        <h4>Keywords</h4>
        <div class="rules-grid">
          <div class="rules-col">
            <h4>S2 &mdash; Sensitive (Redact &rarr; Cloud)</h4>
            <div class="field">
              <label>Keywords</label>
              <div class="tag-list" id="cfg-tags-kw-s2"></div>
              <div class="add-row">
                <input id="cfg-tags-kw-s2-input" placeholder="e.g. salary, phone number" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('kw-s2')}">
                <button class="btn btn-sm btn-outline" onclick="addTag('kw-s2')">Add</button>
              </div>
            </div>
          </div>
          <div class="rules-col">
            <h4>S3 &mdash; Confidential (Local Model Only)</h4>
            <div class="field">
              <label>Keywords</label>
              <div class="tag-list" id="cfg-tags-kw-s3"></div>
              <div class="add-row">
                <input id="cfg-tags-kw-s3-input" placeholder="e.g. SSN, bank account" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('kw-s3')}">
                <button class="btn btn-sm btn-outline" onclick="addTag('kw-s3')">Add</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- LLM Prompt: Privacy Detection only (always visible) -->
      <div class="subsection">
        <h4>LLM Prompt</h4>
        <div class="hint" style="margin-bottom:12px">Prompt used by the local LLM to classify data sensitivity (S1/S2/S3).</div>
        <div id="privacy-prompt-main"></div>
      </div>

      <!-- Per-router Test -->
      <div class="subsection">
        <h4>Test (Privacy Router Only)</h4>
        <textarea class="test-input" id="test-privacy-message" placeholder="Enter a message to test the privacy router alone..."></textarea>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
          <button class="btn btn-primary btn-sm" onclick="runRouterTest('privacy')">Test Privacy Router</button>
        </div>
        <div class="test-result" id="test-privacy-result">
          <div class="test-result-row"><span class="test-result-label">Level</span><span class="test-result-value" id="tr-privacy-level">-</span></div>
          <div class="test-result-row"><span class="test-result-label">Action</span><span class="test-result-value" id="tr-privacy-action">-</span></div>
          <div class="test-result-row"><span class="test-result-label">Target</span><span class="test-result-value" id="tr-privacy-target">-</span></div>
          <div class="test-result-row"><span class="test-result-label">Reason</span><span class="test-result-value" id="tr-privacy-reason">-</span></div>
          <div class="test-result-row"><span class="test-result-label">Confidence</span><span class="test-result-value" id="tr-privacy-confidence">-</span></div>
        </div>
        <div class="test-loading" id="test-privacy-loading" style="display:none">Testing...</div>
      </div>

      <!-- Advanced Configuration -->
      <div class="adv-toggle" onclick="toggleAdv(this)">
        <span class="adv-arrow">&#9654;</span> Advanced Configuration
      </div>
      <div class="adv-body">

        <!-- When to Run -->
        <div class="subsection">
          <h4>When to Run</h4>
          <div class="hint" style="margin-bottom:10px">Select which detectors run at each stage for the privacy router.</div>
          <div class="field">
            <label>User Message</label>
            <div class="chip-group" id="ck-um">
              <button class="chip" data-ck="um" data-det="ruleDetector" onclick="toggleChip(this)">Keyword &amp; Regex</button>
              <button class="chip" data-ck="um" data-det="localModelDetector" onclick="toggleChip(this)">LLM Classifier</button>
            </div>
          </div>
          <div class="field">
            <label>Before Tool Runs</label>
            <div class="chip-group" id="ck-tcp">
              <button class="chip" data-ck="tcp" data-det="ruleDetector" onclick="toggleChip(this)">Keyword &amp; Regex</button>
              <button class="chip" data-ck="tcp" data-det="localModelDetector" onclick="toggleChip(this)">LLM Classifier</button>
            </div>
          </div>
          <div class="field">
            <label>After Tool Runs</label>
            <div class="chip-group" id="ck-tce">
              <button class="chip" data-ck="tce" data-det="ruleDetector" onclick="toggleChip(this)">Keyword &amp; Regex</button>
              <button class="chip" data-ck="tce" data-det="localModelDetector" onclick="toggleChip(this)">LLM Classifier</button>
            </div>
          </div>
        </div>

        <!-- Regex Patterns, Sensitive Tool Names, Sensitive File Paths -->
        <div class="subsection">
          <h4>Detection Rules (Regex &amp; Tool Filters)</h4>
          <div class="rules-grid">
            <div class="rules-col">
              <h4>S2 &mdash; Sensitive (Redact &rarr; Cloud)</h4>
              <div class="field">
                <label>Regex Patterns</label>
                <div class="tag-list" id="cfg-tags-pat-s2"></div>
                <div class="add-row">
                  <input id="cfg-tags-pat-s2-input" placeholder="e.g. \\d{3}-\\d{4}" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('pat-s2')}">
                  <button class="btn btn-sm btn-outline" onclick="addTag('pat-s2')">Add</button>
                </div>
              </div>
              <div class="field">
                <label>Sensitive Tool Names</label>
                <div class="tag-list" id="cfg-tags-tool-s2"></div>
                <div class="add-row">
                  <input id="cfg-tags-tool-s2-input" placeholder="e.g. read_file, execute_sql" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('tool-s2')}">
                  <button class="btn btn-sm btn-outline" onclick="addTag('tool-s2')">Add</button>
                </div>
              </div>
              <div class="field">
                <label>Sensitive File Paths</label>
                <div class="tag-list" id="cfg-tags-toolpath-s2"></div>
                <div class="add-row">
                  <input id="cfg-tags-toolpath-s2-input" placeholder="e.g. /secrets/, *.env" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('toolpath-s2')}">
                  <button class="btn btn-sm btn-outline" onclick="addTag('toolpath-s2')">Add</button>
                </div>
              </div>
            </div>
            <div class="rules-col">
              <h4>S3 &mdash; Confidential (Local Model Only)</h4>
              <div class="field">
                <label>Regex Patterns</label>
                <div class="tag-list" id="cfg-tags-pat-s3"></div>
                <div class="add-row">
                  <input id="cfg-tags-pat-s3-input" placeholder="e.g. \\b\\d{3}-\\d{2}-\\d{4}\\b" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('pat-s3')}">
                  <button class="btn btn-sm btn-outline" onclick="addTag('pat-s3')">Add</button>
                </div>
              </div>
              <div class="field">
                <label>Sensitive Tool Names</label>
                <div class="tag-list" id="cfg-tags-tool-s3"></div>
                <div class="add-row">
                  <input id="cfg-tags-tool-s3-input" placeholder="e.g. execute_command" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('tool-s3')}">
                  <button class="btn btn-sm btn-outline" onclick="addTag('tool-s3')">Add</button>
                </div>
              </div>
              <div class="field">
                <label>Sensitive File Paths</label>
                <div class="tag-list" id="cfg-tags-toolpath-s3"></div>
                <div class="add-row">
                  <input id="cfg-tags-toolpath-s3-input" placeholder="e.g. /credentials/" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('toolpath-s3')}">
                  <button class="btn btn-sm btn-outline" onclick="addTag('toolpath-s3')">Add</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Personal Info Redaction Prompt -->
        <div class="subsection">
          <h4>Personal Info Redaction Prompt</h4>
          <div class="hint" style="margin-bottom:12px">Prompt used by the local LLM to extract and redact personal info.</div>
          <div id="privacy-prompt-adv"></div>
        </div>

      </div>

      <div class="save-bar"><button class="btn btn-primary" onclick="savePrivacyRouter()">Save Privacy Router</button></div>
    </div>
  </div>

  <!-- ═══ Cost-Optimizer Router Card ═══ -->
  <div class="router-section">
    <div class="router-section-header" onclick="toggleSection(this)">
      <span class="section-arrow">&#9660;</span>
      <h3>Cost-Optimizer Router</h3>
      <span class="router-id-badge">token-saver</span>
    </div>
    <div class="router-section-body">

      <div class="field-toggle" style="margin-bottom:18px">
        <label>Enabled</label>
        <label class="toggle"><input type="checkbox" id="cfg-ts-enabled"><span class="slider"></span></label>
      </div>

      <!-- Tier-to-Model (always visible) -->
      <div class="subsection">
        <h4>Complexity Level &rarr; Model</h4>
        <div class="tier-grid">
          <div class="tier-grid-header">Complexity</div>
          <div class="tier-grid-header">Provider</div>
          <div class="tier-grid-header">Model</div>
          <div class="tier-label">SIMPLE</div><input id="cfg-ts-tier-SIMPLE-provider" placeholder="openai"><input id="cfg-ts-tier-SIMPLE-model" placeholder="gpt-4o-mini">
          <div class="tier-label">MEDIUM</div><input id="cfg-ts-tier-MEDIUM-provider" placeholder="openai"><input id="cfg-ts-tier-MEDIUM-model" placeholder="gpt-4o">
          <div class="tier-label">COMPLEX</div><input id="cfg-ts-tier-COMPLEX-provider" placeholder="anthropic"><input id="cfg-ts-tier-COMPLEX-model" placeholder="claude-sonnet-4.6">
          <div class="tier-label">REASONING</div><input id="cfg-ts-tier-REASONING-provider" placeholder="openai"><input id="cfg-ts-tier-REASONING-model" placeholder="o4-mini">
        </div>
      </div>

      <!-- LLM Prompt (always visible) -->
      <div class="subsection">
        <h4>LLM Prompt</h4>
        <div class="hint" style="margin-bottom:12px">Prompt used by the classifier LLM to determine task complexity.</div>
        <div id="tokensaver-prompt-editors"></div>
      </div>

      <!-- Per-router Test (always visible) -->
      <div class="subsection">
        <h4>Test (Cost-Optimizer Only)</h4>
        <textarea class="test-input" id="test-token-saver-message" placeholder="Enter a message to test the cost-optimizer router alone..."></textarea>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
          <button class="btn btn-primary btn-sm" onclick="runRouterTest('token-saver')">Test Cost-Optimizer</button>
        </div>
        <div class="test-result" id="test-token-saver-result">
          <div class="test-result-row"><span class="test-result-label">Level</span><span class="test-result-value" id="tr-token-saver-level">-</span></div>
          <div class="test-result-row"><span class="test-result-label">Action</span><span class="test-result-value" id="tr-token-saver-action">-</span></div>
          <div class="test-result-row"><span class="test-result-label">Target</span><span class="test-result-value" id="tr-token-saver-target">-</span></div>
          <div class="test-result-row"><span class="test-result-label">Reason</span><span class="test-result-value" id="tr-token-saver-reason">-</span></div>
          <div class="test-result-row"><span class="test-result-label">Confidence</span><span class="test-result-value" id="tr-token-saver-confidence">-</span></div>
        </div>
        <div class="test-loading" id="test-token-saver-loading" style="display:none">Testing...</div>
      </div>

      <!-- Advanced Configuration -->
      <div class="adv-toggle" onclick="toggleAdv(this)">
        <span class="adv-arrow">&#9654;</span> Advanced Configuration
      </div>
      <div class="adv-body">

        <!-- Cache Duration -->
        <div class="subsection">
          <h4>Cache</h4>
          <div class="field">
            <label>Cache Duration (ms)</label>
            <input id="cfg-ts-cachettl" type="number" placeholder="300000" style="max-width:180px">
          </div>
        </div>

      </div>

      <div class="save-bar"><button class="btn btn-primary" onclick="saveTokenSaverConfig()">Save Cost-Optimizer</button></div>
    </div>
  </div>

  <!-- ═══ Custom Router Cards (rendered dynamically) ═══ -->
  <div id="custom-router-cards"></div>

  <!-- Add Custom Router -->
  <div class="add-custom-router">
    <div style="display:flex;gap:10px;align-items:center">
      <input id="new-router-id" placeholder="Router ID (e.g. content-filter)" style="flex:1;padding:10px 14px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:13px;outline:none">
      <button class="btn btn-primary" onclick="addCustomRouter()">+ Add Custom Router</button>
    </div>
    <div class="hint" style="margin-top:8px">Create a new router with keyword rules and an optional LLM classification prompt. Added routers appear above and can be included in Router Execution Order.</div>
  </div>

</div>

<!-- Configuration -->
<div id="config-panel" class="panel">

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
    <h3>Cost-Optimizer Classifier <span class="badge badge-hot">instant</span></h3>
    <div class="hint" style="margin-bottom:14px">LLM used by the Cost-Optimizer to determine task complexity. Falls back to the Local Model settings above if empty.</div>
    <div class="field"><label>Endpoint</label><input id="cfg-ts-endpoint" placeholder="(inherits from Local Model)"></div>
    <div class="field"><label>Model</label><input id="cfg-ts-model" placeholder="(inherits from Local Model)"></div>
    <div class="field">
      <label>API Protocol</label>
      <select id="cfg-ts-providertype">
        <option value="openai-compatible">openai-compatible</option>
        <option value="ollama-native">ollama-native</option>
        <option value="custom">custom</option>
      </select>
    </div>
  </div>

  <div class="config-section">
    <h3>Privacy Guard Agent <span class="badge badge-hot">instant</span></h3>
    <div class="field"><label>Agent ID</label><input id="cfg-ga-id" placeholder="guard"></div>
    <div class="field"><label>Workspace</label><input id="cfg-ga-workspace" placeholder="~/.openclaw/workspace-guard"></div>
    <div class="field"><label>Model (provider/model)</label><input id="cfg-ga-model" placeholder="ollama/qwen3.5-27b"></div>
  </div>

  <div class="config-section">
    <h3>Routing Policy <span class="badge badge-hot">instant</span></h3>
    <div class="field">
      <label>Sensitive Data Routing</label>
      <select id="cfg-s2policy">
        <option value="proxy">Proxy (redact personal info before sending)</option>
        <option value="local">Local only (process on-device, no cloud)</option>
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
      <label>Separate Guard Chat History</label>
      <label class="toggle"><input type="checkbox" id="cfg-sess-isolate" checked><span class="slider"></span></label>
    </div>
    <div class="field"><label>Base Directory</label><input id="cfg-sess-basedir" placeholder="~/.openclaw"></div>
  </div>

  <div class="config-section">
    <h3>Local Providers <span class="badge badge-hot">instant</span></h3>
    <div class="field">
      <label>Additional providers treated as &quot;local&quot; (safe for confidential data routing)</label>
      <div class="tag-list" id="cfg-tags-lp"></div>
      <div class="add-row">
        <input id="cfg-tags-lp-input" placeholder="e.g. my-inference-server" onkeydown="if(event.key==='Enter'){event.preventDefault();addTag('lp')}">
        <button class="btn btn-sm btn-outline" onclick="addTag('lp')">Add</button>
      </div>
    </div>
  </div>

  <div class="save-bar">
    <button class="btn btn-primary" onclick="saveConfig()">Save Configuration</button>
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
  if (!c) return;
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
      fillRow('Cloud', lt.cloud) + fillRow('Local', lt.local) + fillRow('Redacted', lt.proxy);

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
          { label: 'Redacted', data: proxyData, borderColor: '#fb923c', backgroundColor: 'rgba(251,146,60,0.1)', fill: true, tension: 0.3 },
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

    // Privacy router enable toggle
    var privacyReg = _routers['privacy'] || {};
    var privacyEl = document.getElementById('cfg-privacy-enabled');
    if (privacyEl) privacyEl.checked = privacyReg.enabled !== false;

    Object.keys(_tags).forEach(function(k) {
      if (k.indexOf('pipe-') === 0) return;
      renderTags(k);
    });
    toggleModuleField();
    loadTokenSaverConfig();
    renderCustomRouterCards();
    updateAvailableRouters();
  } catch (e) { /* non-critical, fields stay at defaults */ }
}

document.getElementById('cfg-lm-type').addEventListener('change', toggleModuleField);

async function saveConfig() {
  try {
    var typeVal = document.getElementById('cfg-lm-type').value;
    var portVal = document.getElementById('cfg-proxyport').value;

    // Collect Cost-Optimizer classifier model fields (displayed in this tab)
    var tsEp = document.getElementById('cfg-ts-endpoint').value.trim();
    var tsMd = document.getElementById('cfg-ts-model').value.trim();
    var tsPt = document.getElementById('cfg-ts-providertype').value;
    var tsOpts = {};
    if (tsEp) tsOpts.judgeEndpoint = tsEp;
    if (tsMd) tsOpts.judgeModel = tsMd;
    if (tsPt) tsOpts.judgeProviderType = tsPt;
    var existingTs = _routers['token-saver'] || {};
    var mergedTsOpts = Object.assign({}, existingTs.options || {}, tsOpts);

    var currentRouters = Object.assign({}, _routers);
    currentRouters['token-saver'] = Object.assign({}, existingTs, { options: mergedTsOpts });

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
        localProviders: _tags['lp'].length > 0 ? _tags['lp'] : [],
        session: {
          isolateGuardHistory: document.getElementById('cfg-sess-isolate').checked,
          baseDir: document.getElementById('cfg-sess-basedir').value || undefined,
        },
        routers: currentRouters,
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

// ── Prompt Editors ──

var _prompts = {};

async function loadPrompts() {
  try {
    _prompts = await fetch(BASE + '/prompts').then(function(r) { return r.json(); });
    renderRouterPrompts('privacy-prompt-main', PRIVACY_PROMPTS_MAIN);
    renderRouterPrompts('privacy-prompt-adv', PRIVACY_PROMPTS_ADV);
    renderRouterPrompts('tokensaver-prompt-editors', TOKENSAVER_PROMPTS);
  } catch (e) { /* non-critical */ }
}

async function savePrompt(name) {
  var el = document.getElementById('prompt-' + name);
  if (!el) return;
  try {
    var res = await fetch(BASE + '/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, content: el.value }),
    });
    var result = await res.json();
    if (result.ok) {
      showToast('Prompt "' + name + '" saved & applied');
      loadPrompts();
    } else {
      showToast('Save failed: ' + (result.error || 'unknown'), true);
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, true);
  }
}

function resetPrompt(name) {
  if (!_prompts[name]) return;
  var el = document.getElementById('prompt-' + name);
  if (el) el.value = _prompts[name].defaultContent;
}

// ── Test Classify ──

async function runTestClassify() {
  var msg = document.getElementById('test-message').value.trim();
  if (!msg) { showToast('Enter a test message', true); return; }
  var checkpoint = document.getElementById('test-checkpoint').value;
  var resultEl = document.getElementById('test-result');
  var loadingEl = document.getElementById('test-loading');
  resultEl.classList.remove('visible');
  loadingEl.style.display = 'block';
  try {
    var res = await fetch(BASE + '/test-classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, checkpoint: checkpoint }),
    });
    var data = await res.json();
    loadingEl.style.display = 'none';
    if (data.error) {
      showToast('Test failed: ' + data.error, true);
      return;
    }
    document.getElementById('tr-level').innerHTML = '<span class="level-tag level-' + data.level + '">' + data.level + '</span>';
    document.getElementById('tr-action').textContent = data.action || 'passthrough';
    document.getElementById('tr-target').textContent = data.target ? (data.target.provider + '/' + data.target.model) : '(none)';
    document.getElementById('tr-router').textContent = data.routerId || '(none)';
    document.getElementById('tr-reason').textContent = data.reason || '(none)';
    document.getElementById('tr-confidence').textContent = data.confidence != null ? (data.confidence * 100).toFixed(0) + '%' : '-';
    var perEl = document.getElementById('tr-per-router');
    if (data.routers && data.routers.length > 0) {
      var html = '<div style="margin-top:14px;padding-top:12px;border-top:1px solid #1e293b">' +
        '<div style="font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:.5px;margin-bottom:8px">Individual Router Results</div>';
      data.routers.forEach(function(r) {
        html += '<div style="background:#1e293b;border-radius:6px;padding:10px 14px;margin-bottom:6px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<span style="font-weight:600;color:#e2e8f0;font-size:13px">' + (r.routerId || '?') + '</span>' +
          '<span class="level-tag level-' + r.level + '">' + r.level + '</span></div>' +
          '<div style="font-size:12px;color:#94a3b8;margin-top:4px">' +
          (r.action || 'passthrough') +
          (r.target ? ' → ' + r.target.provider + '/' + r.target.model : '') +
          '</div>' +
          '<div style="font-size:12px;color:#64748b;margin-top:2px">' + (r.reason || '-') + '</div>' +
          '</div>';
      });
      html += '</div>';
      perEl.innerHTML = html;
    } else {
      perEl.innerHTML = '';
    }
    resultEl.classList.add('visible');
  } catch (e) {
    loadingEl.style.display = 'none';
    showToast('Test failed: ' + e.message, true);
  }
}

// ── Token-Saver Config ──

function loadTokenSaverConfig() {
  try {
    var cfg = _prompts; // reuse config load
    var routers = _routers || {};
    var ts = routers['token-saver'] || {};
    var opts = ts.options || {};
    document.getElementById('cfg-ts-enabled').checked = ts.enabled === true;
    document.getElementById('cfg-ts-endpoint').value = opts.judgeEndpoint || '';
    document.getElementById('cfg-ts-model').value = opts.judgeModel || '';
    document.getElementById('cfg-ts-providertype').value = opts.judgeProviderType || 'openai-compatible';
    document.getElementById('cfg-ts-cachettl').value = opts.cacheTtlMs || '';
    var tiers = opts.tiers || {};
    ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'].forEach(function(t) {
      var tier = tiers[t] || {};
      var pEl = document.getElementById('cfg-ts-tier-' + t + '-provider');
      var mEl = document.getElementById('cfg-ts-tier-' + t + '-model');
      if (pEl) pEl.value = tier.provider || '';
      if (mEl) mEl.value = tier.model || '';
    });
  } catch (e) { /* non-critical */ }
}

async function saveTokenSaverConfig() {
  try {
    var tiers = {};
    ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'].forEach(function(t) {
      var pVal = document.getElementById('cfg-ts-tier-' + t + '-provider').value.trim();
      var mVal = document.getElementById('cfg-ts-tier-' + t + '-model').value.trim();
      if (pVal || mVal) tiers[t] = { provider: pVal, model: mVal };
    });
    var options = {};
    var ep = document.getElementById('cfg-ts-endpoint').value.trim();
    var md = document.getElementById('cfg-ts-model').value.trim();
    var pt = document.getElementById('cfg-ts-providertype').value;
    var ct = document.getElementById('cfg-ts-cachettl').value;
    if (ep) options.judgeEndpoint = ep;
    if (md) options.judgeModel = md;
    if (pt) options.judgeProviderType = pt;
    if (ct) options.cacheTtlMs = parseInt(ct);
    if (Object.keys(tiers).length) options.tiers = tiers;

    var currentRouters = Object.assign({}, _routers);
    currentRouters['token-saver'] = {
      enabled: document.getElementById('cfg-ts-enabled').checked,
      type: 'builtin',
      options: options,
    };

    var payload = { privacy: { routers: currentRouters } };
    var res = await fetch(BASE + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var result = await res.json();
    if (result.ok) {
      showToast('Cost-Optimizer config saved');
      loadConfig();
    } else {
      showToast('Save failed: ' + (result.error || 'unknown'), true);
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, true);
  }
}

// ── Section Collapse ──

function toggleSection(el) {
  el.classList.toggle('collapsed');
  var body = el.nextElementSibling;
  if (body) body.classList.toggle('collapsed');
}

function toggleAdv(el) {
  el.classList.toggle('open');
  var body = el.nextElementSibling;
  if (body) body.classList.toggle('open');
}

// ── Per-Router Prompt Rendering ──

var PRIVACY_PROMPTS_MAIN = ['detection-system'];
var PRIVACY_PROMPTS_ADV = ['pii-extraction'];
var TOKENSAVER_PROMPTS = ['token-saver-judge'];

function renderRouterPrompts(containerId, promptNames) {
  var c = document.getElementById(containerId);
  if (!c) return;
  var html = '';
  promptNames.forEach(function(name) {
    var p = _prompts[name];
    if (!p) return;
    var customBadge = p.isCustom ? '<span class="custom-badge">customized</span>' : '';
    html += '<div style="margin-bottom:16px">' +
      '<div class="prompt-header">' +
        '<h4>' + escHtml(p.label) + customBadge + '</h4>' +
        '<div class="prompt-actions">' +
          '<button class="btn btn-sm btn-outline" onclick="resetPrompt(\\'' + escHtml(name) + '\\')">Reset Default</button>' +
          '<button class="btn btn-sm btn-primary" onclick="savePrompt(\\'' + escHtml(name) + '\\')">Save</button>' +
        '</div>' +
      '</div>' +
      '<textarea class="prompt-editor" id="prompt-' + escHtml(name) + '">' + escHtml(p.content) + '</textarea>' +
    '</div>';
  });
  c.innerHTML = html || '<div style="color:#64748b;font-size:13px">Loading prompts...</div>';
}

// ── Per-Router Test ──

async function runRouterTest(routerId) {
  var msgEl = document.getElementById('test-' + routerId + '-message');
  var msg = msgEl ? msgEl.value.trim() : '';
  if (!msg) { showToast('Enter a test message', true); return; }
  var resultEl = document.getElementById('test-' + routerId + '-result');
  var loadingEl = document.getElementById('test-' + routerId + '-loading');
  resultEl.classList.remove('visible');
  loadingEl.style.display = 'block';
  try {
    var res = await fetch(BASE + '/test-classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, router: routerId }),
    });
    var data = await res.json();
    loadingEl.style.display = 'none';
    if (data.error) {
      showToast('Test failed: ' + data.error, true);
      return;
    }
    document.getElementById('tr-' + routerId + '-level').innerHTML = '<span class="level-tag level-' + data.level + '">' + data.level + '</span>';
    document.getElementById('tr-' + routerId + '-action').textContent = data.action || 'passthrough';
    document.getElementById('tr-' + routerId + '-target').textContent = data.target ? (data.target.provider + '/' + data.target.model) : '(none)';
    document.getElementById('tr-' + routerId + '-reason').textContent = data.reason || '(none)';
    document.getElementById('tr-' + routerId + '-confidence').textContent = data.confidence != null ? (data.confidence * 100).toFixed(0) + '%' : '-';
    resultEl.classList.add('visible');
  } catch (e) {
    loadingEl.style.display = 'none';
    showToast('Test failed: ' + e.message, true);
  }
}

// ── Save Privacy Router ──

async function savePrivacyRouter() {
  try {
    var payload = {
      privacy: {
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
      },
    };
    var res = await fetch(BASE + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var result = await res.json();
    if (result.ok) {
      showToast('Privacy Router saved');
    } else {
      showToast('Save failed: ' + (result.error || 'unknown'), true);
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, true);
  }
}

// ── Save Pipeline Order ──

async function savePipelineOrder() {
  try {
    var payload = {
      privacy: {
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
      showToast('Execution order saved');
    } else {
      showToast('Save failed: ' + (result.error || 'unknown'), true);
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, true);
  }
}

// ── Custom Routers ──

var BUILTIN_ROUTERS = ['privacy', 'token-saver'];
var _customRouterData = {};

function getCustomRouterIds() {
  return Object.keys(_routers).filter(function(id) {
    return BUILTIN_ROUTERS.indexOf(id) === -1 && _routers[id].type === 'configurable';
  });
}

function renderCustomRouterCards() {
  var container = document.getElementById('custom-router-cards');
  if (!container) return;
  var ids = getCustomRouterIds();
  if (!ids.length) { container.innerHTML = ''; return; }

  container.innerHTML = ids.map(function(id) {
    var r = _routers[id] || {};
    var opts = r.options || {};
    var checked = r.enabled !== false ? ' checked' : '';
    var kwS2 = (opts.keywords && opts.keywords.S2) ? opts.keywords.S2 : [];
    var kwS3 = (opts.keywords && opts.keywords.S3) ? opts.keywords.S3 : [];
    var patS2 = (opts.patterns && opts.patterns.S2) ? opts.patterns.S2 : [];
    var patS3 = (opts.patterns && opts.patterns.S3) ? opts.patterns.S3 : [];
    var prompt = opts.prompt || '';

    // init tag arrays for this custom router
    _tags['cr-kw-s2-' + id] = kwS2.slice();
    _tags['cr-kw-s3-' + id] = kwS3.slice();
    _tags['cr-pat-s2-' + id] = patS2.slice();
    _tags['cr-pat-s3-' + id] = patS3.slice();

    return '<div class="router-section" id="cr-card-' + escHtml(id) + '">' +
      '<div class="router-section-header" onclick="toggleSection(this)">' +
        '<span class="section-arrow">&#9660;</span>' +
        '<h3>' + escHtml(id) + '</h3>' +
        '<span class="router-id-badge">configurable</span>' +
        '<button class="btn btn-sm btn-danger" style="margin-left:auto" onclick="event.stopPropagation();removeCustomRouter(\\'' + escHtml(id) + '\\')">Delete</button>' +
      '</div>' +
      '<div class="router-section-body">' +
        '<div class="field-toggle" style="margin-bottom:18px">' +
          '<label>Enabled</label>' +
          '<label class="toggle"><input type="checkbox" id="cfg-cr-enabled-' + escHtml(id) + '"' + checked + '><span class="slider"></span></label>' +
        '</div>' +

        '<div class="subsection">' +
          '<h4>Keyword Rules</h4>' +
          '<div class="rules-grid">' +
            '<div class="rules-col">' +
              '<h4>S2 &mdash; Sensitive Keywords</h4>' +
              '<div class="tag-list" id="cfg-tags-cr-kw-s2-' + escHtml(id) + '"></div>' +
              '<div class="add-row">' +
                '<input id="cfg-tags-cr-kw-s2-' + escHtml(id) + '-input" placeholder="Add S2 keyword" onkeydown="if(event.key===\\'Enter\\'){event.preventDefault();addTag(\\'cr-kw-s2-' + escHtml(id) + '\\')}"><button class="btn btn-sm btn-outline" onclick="addTag(\\'cr-kw-s2-' + escHtml(id) + '\\')">Add</button>' +
              '</div>' +
              '<div style="margin-top:12px"><h4 style="font-size:12px;color:#64748b;margin-bottom:6px">S2 &mdash; Sensitive Patterns (regex)</h4></div>' +
              '<div class="tag-list" id="cfg-tags-cr-pat-s2-' + escHtml(id) + '"></div>' +
              '<div class="add-row">' +
                '<input id="cfg-tags-cr-pat-s2-' + escHtml(id) + '-input" placeholder="Add S2 pattern" onkeydown="if(event.key===\\'Enter\\'){event.preventDefault();addTag(\\'cr-pat-s2-' + escHtml(id) + '\\')}"><button class="btn btn-sm btn-outline" onclick="addTag(\\'cr-pat-s2-' + escHtml(id) + '\\')">Add</button>' +
              '</div>' +
            '</div>' +
            '<div class="rules-col">' +
              '<h4>S3 &mdash; Confidential Keywords</h4>' +
              '<div class="tag-list" id="cfg-tags-cr-kw-s3-' + escHtml(id) + '"></div>' +
              '<div class="add-row">' +
                '<input id="cfg-tags-cr-kw-s3-' + escHtml(id) + '-input" placeholder="Add S3 keyword" onkeydown="if(event.key===\\'Enter\\'){event.preventDefault();addTag(\\'cr-kw-s3-' + escHtml(id) + '\\')}"><button class="btn btn-sm btn-outline" onclick="addTag(\\'cr-kw-s3-' + escHtml(id) + '\\')">Add</button>' +
              '</div>' +
              '<div style="margin-top:12px"><h4 style="font-size:12px;color:#64748b;margin-bottom:6px">S3 &mdash; Confidential Patterns (regex)</h4></div>' +
              '<div class="tag-list" id="cfg-tags-cr-pat-s3-' + escHtml(id) + '"></div>' +
              '<div class="add-row">' +
                '<input id="cfg-tags-cr-pat-s3-' + escHtml(id) + '-input" placeholder="Add S3 pattern" onkeydown="if(event.key===\\'Enter\\'){event.preventDefault();addTag(\\'cr-pat-s3-' + escHtml(id) + '\\')}"><button class="btn btn-sm btn-outline" onclick="addTag(\\'cr-pat-s3-' + escHtml(id) + '\\')">Add</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="subsection">' +
          '<h4>Classification Prompt <span style="font-size:11px;color:#64748b;text-transform:none;letter-spacing:0">(optional)</span></h4>' +
          '<div class="hint" style="margin-bottom:10px">If set, the local LLM will classify messages using this prompt. Should output JSON with {level, reason}.</div>' +
          '<textarea class="prompt-editor" id="cr-prompt-' + escHtml(id) + '">' + escHtml(prompt) + '</textarea>' +
        '</div>' +

        '<div class="subsection">' +
          '<h4>Test (' + escHtml(id) + ' Only)</h4>' +
          '<textarea class="test-input" id="test-' + escHtml(id) + '-message" placeholder="Enter a message to test this router..."></textarea>' +
          '<div style="display:flex;gap:8px;margin-top:10px;align-items:center">' +
            '<button class="btn btn-primary btn-sm" onclick="runRouterTest(\\'' + escHtml(id) + '\\')">Test</button>' +
          '</div>' +
          '<div class="test-result" id="test-' + escHtml(id) + '-result">' +
            '<div class="test-result-row"><span class="test-result-label">Level</span><span class="test-result-value" id="tr-' + escHtml(id) + '-level">-</span></div>' +
            '<div class="test-result-row"><span class="test-result-label">Action</span><span class="test-result-value" id="tr-' + escHtml(id) + '-action">-</span></div>' +
            '<div class="test-result-row"><span class="test-result-label">Target</span><span class="test-result-value" id="tr-' + escHtml(id) + '-target">-</span></div>' +
            '<div class="test-result-row"><span class="test-result-label">Reason</span><span class="test-result-value" id="tr-' + escHtml(id) + '-reason">-</span></div>' +
            '<div class="test-result-row"><span class="test-result-label">Confidence</span><span class="test-result-value" id="tr-' + escHtml(id) + '-confidence">-</span></div>' +
          '</div>' +
          '<div class="test-loading" id="test-' + escHtml(id) + '-loading" style="display:none">Testing...</div>' +
        '</div>' +

        '<div class="save-bar"><button class="btn btn-primary" onclick="saveCustomRouter(\\'' + escHtml(id) + '\\')">Save ' + escHtml(id) + '</button></div>' +
      '</div>' +
    '</div>';
  }).join('');

  // render tags for custom routers after DOM is built
  ids.forEach(function(id) {
    renderTags('cr-kw-s2-' + id);
    renderTags('cr-kw-s3-' + id);
    renderTags('cr-pat-s2-' + id);
    renderTags('cr-pat-s3-' + id);
  });
}

function getAllRouterIds() {
  var allIds = Object.keys(_routers);
  if (!allIds.length) allIds = BUILTIN_ROUTERS.slice();
  BUILTIN_ROUTERS.forEach(function(b) {
    if (allIds.indexOf(b) === -1) allIds.unshift(b);
  });
  return allIds;
}

function renderPipePicker(pipeKey) {
  var suffix = pipeKey.replace('pipe-', '');
  var container = document.getElementById('pipe-picker-' + suffix);
  if (!container) return;
  var current = _tags[pipeKey] || [];
  var allIds = getAllRouterIds();
  container.innerHTML = allIds.map(function(id) {
    var inUse = current.indexOf(id) !== -1;
    return '<button class="pipe-pick-btn' + (inUse ? ' in-use' : '') + '" onclick="togglePipeRouter(\\'' + escHtml(pipeKey) + '\\',\\'' + escHtml(id) + '\\')">' +
      '+ ' + escHtml(id) + '</button>';
  }).join('');
}

function renderPipeTags(pipeKey) {
  var c = document.getElementById('cfg-tags-' + pipeKey);
  if (!c) return;
  c.innerHTML = _tags[pipeKey].map(function(v, i) {
    return '<span class="tag pipe-tag" draggable="true" data-pipe="' + pipeKey + '" data-idx="' + i + '">' +
      '<span style="color:#64748b;font-size:10px;margin-right:4px">' + (i + 1) + '</span>' +
      escHtml(v) +
      ' <button data-key="' + pipeKey + '" data-idx="' + i + '" onclick="removePipeTag(this)">&times;</button></span>';
  }).join('');
  initPipeDrag(pipeKey);
  renderPipePicker(pipeKey);
}

function togglePipeRouter(pipeKey, routerId) {
  var arr = _tags[pipeKey];
  var idx = arr.indexOf(routerId);
  if (idx !== -1) return;
  arr.push(routerId);
  renderPipeTags(pipeKey);
}

function removePipeTag(el) {
  var key = el.getAttribute('data-key');
  var idx = parseInt(el.getAttribute('data-idx'));
  if (key && _tags[key]) {
    _tags[key].splice(idx, 1);
    renderPipeTags(key);
  }
}

function initPipeDrag(pipeKey) {
  var container = document.getElementById('cfg-tags-' + pipeKey);
  if (!container) return;
  var tags = container.querySelectorAll('.pipe-tag');
  tags.forEach(function(tag) {
    tag.addEventListener('dragstart', function(e) {
      e.dataTransfer.setData('text/plain', tag.getAttribute('data-idx'));
      e.dataTransfer.effectAllowed = 'move';
      tag.classList.add('dragging');
    });
    tag.addEventListener('dragend', function() {
      tag.classList.remove('dragging');
    });
    tag.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    tag.addEventListener('drop', function(e) {
      e.preventDefault();
      var fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
      var toIdx = parseInt(tag.getAttribute('data-idx'));
      if (isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx) return;
      var arr = _tags[pipeKey];
      var item = arr.splice(fromIdx, 1)[0];
      arr.splice(toIdx, 0, item);
      renderPipeTags(pipeKey);
    });
  });
}

function updateAvailableRouters() {
  renderPipeTags('pipe-um');
  renderPipeTags('pipe-tcp');
  renderPipeTags('pipe-tce');
}

function addCustomRouter() {
  var idInput = document.getElementById('new-router-id');
  var id = idInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!id) { showToast('Enter a router ID', true); return; }
  if (_routers[id]) { showToast('Router "' + id + '" already exists', true); return; }
  _routers[id] = {
    enabled: true,
    type: 'configurable',
    options: { keywords: { S2: [], S3: [] }, patterns: { S2: [], S3: [] }, prompt: '' }
  };
  idInput.value = '';
  renderCustomRouterCards();
  updateAvailableRouters();
  showToast('Router "' + id + '" created — configure and save it below');
}

function removeCustomRouter(id) {
  if (!confirm('Delete router "' + id + '"? This cannot be undone.')) return;
  delete _routers[id];
  // Clean up tag arrays
  delete _tags['cr-kw-s2-' + id];
  delete _tags['cr-kw-s3-' + id];
  delete _tags['cr-pat-s2-' + id];
  delete _tags['cr-pat-s3-' + id];

  // Save the removal to config
  var currentRouters = Object.assign({}, _routers);
  var payload = { privacy: { routers: currentRouters } };
  fetch(BASE + '/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(function(r) { return r.json(); }).then(function(result) {
    if (result.ok) {
      showToast('Router "' + id + '" deleted');
      renderCustomRouterCards();
    } else {
      showToast('Delete failed: ' + (result.error || 'unknown'), true);
    }
  }).catch(function(e) {
    showToast('Delete failed: ' + e.message, true);
  });
}

async function saveCustomRouter(id) {
  try {
    var kwS2 = _tags['cr-kw-s2-' + id] || [];
    var kwS3 = _tags['cr-kw-s3-' + id] || [];
    var patS2 = _tags['cr-pat-s2-' + id] || [];
    var patS3 = _tags['cr-pat-s3-' + id] || [];
    var promptEl = document.getElementById('cr-prompt-' + id);
    var prompt = promptEl ? promptEl.value.trim() : '';
    var enabledEl = document.getElementById('cfg-cr-enabled-' + id);
    var enabled = enabledEl ? enabledEl.checked : true;

    var options = {
      keywords: { S2: kwS2, S3: kwS3 },
      patterns: { S2: patS2, S3: patS3 },
    };
    if (prompt) options.prompt = prompt;

    var currentRouters = Object.assign({}, _routers);
    currentRouters[id] = {
      enabled: enabled,
      type: 'configurable',
      options: options,
    };
    _routers[id] = currentRouters[id];

    var payload = { privacy: { routers: currentRouters } };
    var res = await fetch(BASE + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var result = await res.json();
    if (result.ok) {
      showToast('Router "' + id + '" saved');
    } else {
      showToast('Save failed: ' + (result.error || 'unknown'), true);
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, true);
  }
}

// ── Init ──
refreshAll();
loadConfig();
loadPrompts();
setInterval(refreshAll, 30000);
</script>
</body>
</html>`;
}
