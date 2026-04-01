import type { FastifyInstance } from "fastify";
import type { GatewayConfig } from "../types.js";
import { getAllHealth } from "../load-balancer/health-check.js";
import { getAllSessions, getSessionCount } from "../session/memory-store.js";
import { loadConfig, saveConfig, reloadConfig } from "../config/store.js";
import { updatePrivacyConfig, initPrivacyPipeline } from "../middleware/privacy.js";

export default async function adminRoute(
  fastify: FastifyInstance,
  opts: { config: GatewayConfig }
) {
  const { config } = opts;

  /** Health probe — used by load balancers in front of the gateway */
  fastify.get("/health", async (_req, reply) => {
    reply.send({ status: "ok", upstreams: getAllHealth() });
  });

  /** Upstream health status */
  fastify.get("/admin/upstreams", async (_req, reply) => {
    reply.send({ upstreams: getAllHealth() });
  });

  /** Session summary */
  fastify.get("/admin/sessions", async (_req, reply) => {
    reply.send({ count: getSessionCount(), sessions: getAllSessions() });
  });

  /** Get current config (redacts API keys) */
  fastify.get("/admin/config", async (_req, reply) => {
    const cfg = loadConfig();
    const safe = {
      ...cfg,
      auth: {
        ...cfg.auth,
        apiKeys: Object.fromEntries(
          Object.entries(cfg.auth.apiKeys).map(([k, v]) => [
            k.slice(0, 6) + "****",
            v,
          ])
        ),
      },
      upstreams: cfg.upstreams.map((u) => ({ ...u, apiKey: "****" })),
    };
    reply.send(safe);
  });

  /** Update privacy config live — no restart needed */
  fastify.post<{ Body: { privacy: Record<string, unknown> } }>(
    "/admin/config/privacy",
    async (req, reply) => {
      const { privacy } = req.body;
      if (!privacy || typeof privacy !== "object") {
        reply.code(400).send({ error: "Body must be { privacy: {...} }" });
        return;
      }
      const cfg = loadConfig();
      cfg.privacy = privacy;
      saveConfig(cfg);
      updatePrivacyConfig(privacy);
      reply.send({ ok: true, message: "Privacy config updated" });
    }
  );

  /** Reload full config from disk */
  fastify.post("/admin/config/reload", async (_req, reply) => {
    const cfg = reloadConfig();
    initPrivacyPipeline(cfg);
    reply.send({ ok: true, message: "Config reloaded from disk" });
  });

  /** Simple dashboard HTML */
  fastify.get("/admin/dashboard", async (_req, reply) => {
    const health = getAllHealth();
    const sessions = getAllSessions();
    const cfg = loadConfig();

    const healthRows = health
      .map(
        (h) =>
          `<tr>
            <td>${h.id}</td>
            <td style="color:${h.healthy ? "green" : "red"}">${h.healthy ? "✓ healthy" : "✗ down"}</td>
            <td>${h.latencyMs != null ? h.latencyMs + "ms" : "—"}</td>
            <td>${h.errorCount}</td>
            <td>${new Date(h.lastCheckAt).toLocaleTimeString()}</td>
          </tr>`
      )
      .join("");

    const sessionRows = sessions
      .slice(0, 50)
      .map(
        (s) =>
          `<tr>
            <td>${s.tenantId}</td>
            <td>${s.requestCount}</td>
            <td style="color:${s.highestLevel === "S3" ? "red" : s.highestLevel === "S2" ? "orange" : "green"}">${s.highestLevel}</td>
            <td>${new Date(s.lastActiveAt).toLocaleTimeString()}</td>
          </tr>`
      )
      .join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClawX Gateway Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #0f0f0f; color: #e0e0e0; }
    header { background: #1a1a2e; padding: 16px 32px; border-bottom: 1px solid #333; }
    header h1 { margin: 0; font-size: 20px; color: #7eb8f7; }
    header span { font-size: 12px; color: #888; margin-left: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 24px 32px; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 20px; }
    .card h2 { margin: 0 0 16px; font-size: 14px; text-transform: uppercase; color: #888; letter-spacing: 1px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #666; font-weight: normal; padding: 4px 8px; border-bottom: 1px solid #2a2a2a; }
    td { padding: 6px 8px; border-bottom: 1px solid #1e1e1e; }
    .stat { font-size: 28px; font-weight: bold; color: #7eb8f7; }
    .stat-label { font-size: 12px; color: #666; margin-top: 4px; }
    .stats-row { display: flex; gap: 32px; margin-bottom: 20px; }
    .strategy-badge { background: #1e3a5f; color: #7eb8f7; padding: 2px 10px; border-radius: 12px; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <h1>ClawX Gateway</h1>
    <span>Port ${cfg.server.port} &nbsp;·&nbsp; LB: <span class="strategy-badge">${cfg.loadBalancer.strategy}</span> &nbsp;·&nbsp; Upstreams: ${cfg.upstreams.filter((u) => u.enabled).length}</span>
  </header>
  <div class="grid">
    <div class="card">
      <div class="stats-row">
        <div>
          <div class="stat">${health.filter((h) => h.healthy).length}/${health.length}</div>
          <div class="stat-label">Healthy Upstreams</div>
        </div>
        <div>
          <div class="stat">${sessions.length}</div>
          <div class="stat-label">Active Sessions</div>
        </div>
        <div>
          <div class="stat">${sessions.reduce((s, x) => s + x.requestCount, 0)}</div>
          <div class="stat-label">Total Requests</div>
        </div>
      </div>
      <h2>Upstream Health</h2>
      <table>
        <thead><tr><th>ID</th><th>Status</th><th>Latency</th><th>Errors</th><th>Last Check</th></tr></thead>
        <tbody>${healthRows || "<tr><td colspan='5' style='color:#666'>No upstreams configured</td></tr>"}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Recent Sessions</h2>
      <table>
        <thead><tr><th>Tenant</th><th>Requests</th><th>Highest Level</th><th>Last Active</th></tr></thead>
        <tbody>${sessionRows || "<tr><td colspan='4' style='color:#666'>No sessions yet</td></tr>"}</tbody>
      </table>
    </div>
  </div>
  <script>setTimeout(() => location.reload(), 10000)</script>
</body>
</html>`;

    reply.header("content-type", "text/html").send(html);
  });
}
