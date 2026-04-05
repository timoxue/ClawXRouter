import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayConfig, UpstreamConfig } from "../types.js";
import { getAllHealth, registerUpstream, unregisterUpstream } from "../load-balancer/health-check.js";
import { getAllSessions, getSessionCount } from "../session/memory-store.js";
import { loadConfig, saveConfig, reloadConfig } from "../config/store.js";
import { updatePrivacyConfig, initPrivacyPipeline } from "../middleware/privacy.js";
import { issueSessionCookie, clearSessionCookie } from "../middleware/admin-auth.js";
import { registerContainer, getAllContainers, removeContainer, isOnline } from "../container-registry.js";

export default async function adminRoute(
  fastify: FastifyInstance,
  _opts: { config: GatewayConfig }
) {
  /** Container self-registration — no auth required */
  fastify.post<{ Body: { username: string; type: string; version: string } }>(
    "/gateway/register",
    async (req: FastifyRequest<{ Body: { username: string; type: string; version: string } }>, reply) => {
      const registration = loadConfig().registration;
      if (registration?.enabled) {
        const token = (req.headers["x-registration-token"] as string | undefined)?.trim();
        if (!token || token !== registration.token) {
          return reply.code(401).send({ error: "Invalid registration token" });
        }
      }

      const { username, type, version } = req.body ?? {};
      if (!username || !type) {
        return reply.code(400).send({ error: "username and type are required" });
      }
      const container = registerContainer(username, type, version ?? "unknown");
      reply.send({
        apiKey: container.apiKey,
      });
    }
  );

  /** Remove a registered container */
  fastify.delete<{ Params: { apiKey: string } }>("/admin/containers/:apiKey", async (req, reply) => {
    const ok = removeContainer(req.params.apiKey);
    ok ? reply.send({ ok: true }) : reply.code(404).send({ error: "Container not found" });
  });

  /** Root → dashboard */
  fastify.get("/", async (_req, reply) => {
    reply.redirect("/admin/dashboard");
  });

  /** Admin login page */
  fastify.get("/admin/login", async (req, reply) => {
    const error = (req.query as Record<string, string>).error;
    const next = (req.query as Record<string, string>).next ?? "/admin/dashboard";
    reply.header("content-type", "text/html").send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClawX 网关 · 登录</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0;
           background: #0f0f0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 40px; width: 340px; }
    h1 { margin: 0 0 6px; font-size: 20px; color: #7eb8f7; }
    .sub { font-size: 12px; color: #555; margin-bottom: 28px; }
    label { display: block; font-size: 12px; color: #888; margin-bottom: 4px; }
    input { width: 100%; background: #111; border: 1px solid #333; color: #e0e0e0;
            padding: 9px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
    input:focus { outline: none; border-color: #7eb8f7; }
    button { width: 100%; background: #1e3a5f; color: #7eb8f7; border: 1px solid #2a5a8f;
             border-radius: 6px; padding: 10px; font-size: 14px; cursor: pointer; margin-top: 4px; }
    button:hover { background: #2a4a6f; }
    .err { color: #bf6f6f; font-size: 13px; margin-bottom: 16px; padding: 8px 12px;
           background: #2a1a1a; border-radius: 6px; border: 1px solid #3a2a2a; }
  </style>
</head>
<body>
  <div class="card">
    <h1>ClawX 网关</h1>
    <div class="sub">管理员登录</div>
    ${error ? `<div class="err">用户名或密码错误</div>` : ""}
    <form method="POST" action="/admin/login">
      <input type="hidden" name="next" value="${next}">
      <label>用户名</label>
      <input type="text" name="username" autofocus autocomplete="username">
      <label>密码</label>
      <input type="password" name="password" autocomplete="current-password">
      <button type="submit">登录</button>
    </form>
  </div>
</body>
</html>`);
  });

  /** Admin login POST */
  fastify.post<{ Body: { username: string; password: string; next?: string } }>(
    "/admin/login",
    { config: { rawBody: false } },
    async (req, reply) => {
      const { username, password, next } = req.body ?? {};
      const cfg = loadConfig();
      const expected = cfg.adminAuth ?? { username: "admin", password: "changeme" };
      if (username === expected.username && password === expected.password) {
        reply
          .header("set-cookie", issueSessionCookie(username, expected.password))
          .redirect(next ?? "/admin/dashboard");
      } else {
        reply.redirect(`/admin/login?error=1&next=${encodeURIComponent(next ?? "/admin/dashboard")}`);
      }
    }
  );

  /** Admin logout */
  fastify.get("/admin/logout", async (_req, reply) => {
    reply.header("set-cookie", clearSessionCookie()).redirect("/admin/login");
  });

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
      registration: cfg.registration
        ? { ...cfg.registration, token: "****" }
        : undefined,
      adminAuth: cfg.adminAuth ? { username: cfg.adminAuth.username, password: "****" } : undefined,
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

  /** Add a new upstream — takes effect immediately, no restart needed */
  fastify.post<{ Body: UpstreamConfig }>("/admin/upstreams", async (req, reply) => {
    const upstream = req.body;
    if (!upstream?.id || !upstream?.baseUrl || !upstream?.provider) {
      return reply.code(400).send({ error: "id, baseUrl, and provider are required" });
    }
    const cfg = loadConfig();
    if (cfg.upstreams.find((u) => u.id === upstream.id)) {
      return reply.code(409).send({ error: `Upstream '${upstream.id}' already exists` });
    }
    cfg.upstreams.push({ weight: 1, enabled: true, models: ["*"], role: "cloud", apiKey: "", ...upstream });
    saveConfig(cfg);
    registerUpstream(upstream);
    reply.send({ ok: true, upstream: cfg.upstreams.at(-1) });
  });

  /** Update an upstream in-place — takes effect immediately */
  fastify.patch<{ Params: { id: string }; Body: Partial<UpstreamConfig> }>(
    "/admin/upstreams/:id",
    async (req, reply) => {
      const cfg = loadConfig();
      const idx = cfg.upstreams.findIndex((u) => u.id === req.params.id);
      if (idx === -1) return reply.code(404).send({ error: "Upstream not found" });
      cfg.upstreams[idx] = { ...cfg.upstreams[idx], ...req.body, id: req.params.id };
      saveConfig(cfg);
      reply.send({ ok: true, upstream: cfg.upstreams[idx] });
    }
  );

  /** Remove an upstream — takes effect immediately */
  fastify.delete<{ Params: { id: string } }>("/admin/upstreams/:id", async (req, reply) => {
    const cfg = loadConfig();
    const before = cfg.upstreams.length;
    cfg.upstreams = cfg.upstreams.filter((u) => u.id !== req.params.id);
    if (cfg.upstreams.length === before) {
      return reply.code(404).send({ error: "Upstream not found" });
    }
    saveConfig(cfg);
    unregisterUpstream(req.params.id);
    reply.send({ ok: true });
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

    const containers = getAllContainers();
    const containersJson = JSON.stringify(
      containers.map((c) => ({ ...c, online: isOnline(c) }))
    );

    const upstreamsJson = JSON.stringify(
      cfg.upstreams.map((u) => ({ ...u, apiKey: u.apiKey ? "****" : "" }))
    );

    const privacy = cfg.privacy as Record<string, unknown>;
    const redaction = (privacy?.redaction ?? {}) as Record<string, boolean>;
    const rules = (privacy?.rules ?? { keywords: { S2: [], S3: [] } }) as {
      keywords: { S2: string[]; S3: string[] };
    };

    const privacyJson = JSON.stringify({
      enabled: privacy?.enabled ?? true,
      s2Policy: privacy?.s2Policy ?? "proxy",
      redaction,
      rules,
      checkpoints: privacy?.checkpoints,
      localModel: privacy?.localModel,
    });

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClawX 网关控制台</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: #0f0f0f; color: #e0e0e0; }
    header { background: #1a1a2e; padding: 16px 32px; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 16px; }
    header h1 { margin: 0; font-size: 20px; color: #7eb8f7; }
    header span { font-size: 12px; color: #888; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 24px 32px 0; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 20px; }
    .card h2 { margin: 0 0 16px; font-size: 13px; text-transform: uppercase; color: #888; letter-spacing: 1px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #666; font-weight: normal; padding: 4px 8px; border-bottom: 1px solid #2a2a2a; }
    td { padding: 6px 8px; border-bottom: 1px solid #1e1e1e; }
    .stat { font-size: 28px; font-weight: bold; color: #7eb8f7; }
    .stat-label { font-size: 12px; color: #666; margin-top: 4px; }
    .stats-row { display: flex; gap: 32px; margin-bottom: 20px; }
    .badge { padding: 2px 10px; border-radius: 12px; font-size: 12px; }
    .badge-blue { background: #1e3a5f; color: #7eb8f7; }
    .badge-local { background: #3a2a1e; color: #f7a85e; }

    /* Privacy card */
    .privacy-grid { display: grid; grid-template-columns: auto 1fr auto; gap: 24px; align-items: start; }
    .sec-label { font-size: 11px; color: #666; letter-spacing: 0.5px; margin-bottom: 8px; }

    /* Toggle */
    .toggle-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-size: 13px; }
    .switch { position: relative; display: inline-block; width: 36px; height: 20px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; inset: 0; background: #333; border-radius: 20px; transition: .2s; }
    .slider:before { content: ""; position: absolute; width: 14px; height: 14px; left: 3px; bottom: 3px; background: #888; border-radius: 50%; transition: .2s; }
    input:checked + .slider { background: #1e5a3f; }
    input:checked + .slider:before { background: #6fbf6f; transform: translateX(16px); }

    /* Select */
    select { background: #222; border: 1px solid #333; color: #e0e0e0; padding: 4px 8px; border-radius: 4px; font-size: 13px; cursor: pointer; }
    select:focus { outline: none; border-color: #7eb8f7; }

    /* Chips */
    .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .chip { background: #222; border: 1px solid #333; border-radius: 14px; padding: 3px 10px; font-size: 12px; display: flex; align-items: center; gap: 5px; }
    .chip .rm { cursor: pointer; color: #666; font-size: 14px; line-height: 1; }
    .chip .rm:hover { color: #bf6f6f; }
    .chip-add { background: none; border: 1px dashed #444; border-radius: 14px; padding: 3px 10px; font-size: 12px; color: #666; cursor: pointer; }
    .chip-add:hover { border-color: #7eb8f7; color: #7eb8f7; }
    .chip-input { background: #222; border: 1px solid #7eb8f7; border-radius: 14px; padding: 3px 10px; font-size: 12px; color: #e0e0e0; width: 120px; outline: none; }

    /* Opt-in */
    .opt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .opt-item { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
    .opt-item input[type=checkbox] { accent-color: #7eb8f7; width: 14px; height: 14px; cursor: pointer; }

    /* Always-on */
    .always-on { display: flex; flex-wrap: wrap; gap: 6px; }
    .always-chip { background: #1a2a1a; border: 1px solid #2a3a2a; border-radius: 14px; padding: 3px 10px; font-size: 11px; color: #6fbf6f; }

    /* Save */
    .btn-save { background: #1e3a5f; color: #7eb8f7; border: 1px solid #2a5a8f; border-radius: 6px; padding: 8px 20px; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .btn-save:hover { background: #2a4a6f; }
    .btn-save:disabled { opacity: 0.5; cursor: default; }
    .save-status { font-size: 12px; margin-top: 6px; min-height: 16px; text-align: right; }

    .divider { border: none; border-top: 1px solid #2a2a2a; margin: 14px 0; }
    .page-pad { padding: 0 32px 32px; }

    /* Upstream table */
    .f-input { background: #222; border: 1px solid #333; color: #e0e0e0; padding: 5px 8px; border-radius: 4px; font-size: 13px; width: 100%; }
    .f-input:focus { outline: none; border-color: #7eb8f7; }
    .btn-cancel { background: #222; color: #888; border: 1px solid #333; border-radius: 6px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
    .btn-cancel:hover { color: #e0e0e0; }
    .btn-del { background: none; border: none; color: #555; font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
    .btn-del:hover { color: #bf6f6f; background: #2a1a1a; }
  </style>
</head>
<body>
  <header>
    <h1>ClawX 网关</h1>
    <span>端口 ${cfg.server.port} &nbsp;·&nbsp; 负载均衡: <span class="badge badge-blue">${cfg.loadBalancer.strategy}</span> &nbsp;·&nbsp; 上游节点: ${cfg.upstreams.filter((u) => u.enabled).length}</span>
    <a href="/admin/logout" style="margin-left:auto;font-size:12px;color:#555;text-decoration:none" onmouseover="this.style.color='#bf6f6f'" onmouseout="this.style.color='#555'">退出登录</a>
  </header>

  <div class="grid">
    <div class="card">
      <div class="stats-row">
        <div>
          <div class="stat">${health.filter((h) => h.healthy).length}/${health.length}</div>
          <div class="stat-label">健康节点</div>
        </div>
        <div>
          <div class="stat">${sessions.length}</div>
          <div class="stat-label">活跃会话</div>
        </div>
        <div>
          <div class="stat">${sessions.reduce((s, x) => s + x.requestCount, 0)}</div>
          <div class="stat-label">总请求数</div>
        </div>
      </div>
      <h2>上游节点健康状态</h2>
      <table>
        <thead><tr><th>节点 ID</th><th>状态</th><th>延迟</th><th>错误次数</th><th>最后检查</th></tr></thead>
        <tbody>${healthRows || "<tr><td colspan='5' style='color:#666'>暂无上游节点</td></tr>"}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>近期会话</h2>
      <table>
        <thead><tr><th>租户</th><th>请求数</th><th>最高安全级别</th><th>最后活跃</th></tr></thead>
        <tbody>${sessionRows || "<tr><td colspan='4' style='color:#666'>暂无会话记录</td></tr>"}</tbody>
      </table>
    </div>
  </div>

  <!-- 已注册容器 -->
  <div class="page-pad">
    <div class="card" style="margin-top:24px">
      <h2>已注册容器</h2>
      <table id="container-table">
        <thead><tr>
          <th>API Key</th><th>用户名</th><th>类型</th><th>版本</th>
          <th>状态</th><th>注册时间</th><th>最后活跃</th><th>操作</th>
        </tr></thead>
        <tbody id="container-tbody"></tbody>
      </table>
    </div>
  </div>

  <!-- 上游节点管理 -->
  <div class="page-pad">
    <div class="card" style="margin-top:24px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2 style="margin:0">上游节点管理</h2>
        <button class="btn-save" onclick="toggleAddForm()">+ 新增节点</button>
      </div>

      <!-- 新增表单 -->
      <div id="add-form" style="display:none;background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:16px;margin-bottom:16px">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
          <div>
            <div class="sec-label">节点 ID *</div>
            <input class="f-input" id="f-id" placeholder="my-upstream">
          </div>
          <div>
            <div class="sec-label">服务商 *</div>
            <select class="f-input" id="f-provider">
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai-compatible">OpenAI Compatible</option>
            </select>
          </div>
          <div>
            <div class="sec-label">角色</div>
            <select class="f-input" id="f-role">
              <option value="cloud">cloud（S1/S2）</option>
              <option value="local">local（S3 专用）</option>
            </select>
          </div>
          <div>
            <div class="sec-label">Base URL *</div>
            <input class="f-input" id="f-baseUrl" placeholder="https://api.openai.com">
          </div>
          <div>
            <div class="sec-label">API Key</div>
            <input class="f-input" id="f-apiKey" type="password" placeholder="sk-...">
          </div>
          <div>
            <div class="sec-label">Models（逗号分隔，* 表示全部）</div>
            <input class="f-input" id="f-models" placeholder="gpt-4o,gpt-4o-mini" value="*">
          </div>
          <div>
            <div class="sec-label">权重</div>
            <input class="f-input" id="f-weight" type="number" value="1" min="1">
          </div>
          <div>
            <div class="sec-label">gw-default 负载均衡别名</div>
            <input class="f-input" id="f-alias" placeholder="留空则不加入 gw-default 池">
            <div style="font-size:11px;color:#555;margin-top:4px">填写该 upstream 实际使用的 model 名，如 deepseek-chat</div>
          </div>
          <div style="display:flex;align-items:flex-end;gap:10px">
            <button class="btn-save" onclick="addUpstream()">确认添加</button>
            <button class="btn-cancel" onclick="toggleAddForm()">取消</button>
          </div>
        </div>
        <div class="save-status" id="add-status" style="text-align:left"></div>
      </div>

      <!-- 节点列表 -->
      <table id="upstream-table" style="font-size:13px">
        <thead><tr>
          <th>ID</th><th>服务商</th><th>Base URL</th><th>Models</th>
          <th>权重</th><th>角色</th><th>启用</th><th>操作</th>
        </tr></thead>
        <tbody id="upstream-tbody"></tbody>
      </table>
    </div>
  </div>

  <!-- 隐私脱敏控制 -->
  <div class="page-pad">
    <div class="card" style="margin-top:24px">
      <h2>隐私与脱敏设置</h2>
      <div class="privacy-grid">

        <!-- 左列：管道开关 -->
        <div>
          <div class="sec-label">管道控制</div>
          <div class="toggle-row">
            <label class="switch">
              <input type="checkbox" id="p-enabled">
              <span class="slider"></span>
            </label>
            <label for="p-enabled">启用隐私检测</label>
          </div>
          <div style="margin-bottom:8px">
            <div class="sec-label" style="margin-bottom:4px">S2 策略</div>
            <select id="p-s2policy">
              <option value="proxy">脱敏后转发</option>
              <option value="block">直接拦截请求</option>
            </select>
          </div>
          <hr class="divider">
          <div class="sec-label">始终生效的脱敏规则</div>
          <div class="always-on">
            <span class="always-chip">私钥文件</span>
            <span class="always-chip">API Key (sk-/key-/token-)</span>
            <span class="always-chip">AWS 密钥</span>
            <span class="always-chip">数据库连接串</span>
          </div>
        </div>

        <!-- 中列：可选脱敏 + 关键词 -->
        <div>
          <div class="sec-label">可选脱敏项</div>
          <div class="opt-grid" style="margin-bottom:16px">
            <label class="opt-item"><input type="checkbox" id="r-ip"> 内网 IP 地址</label>
            <label class="opt-item"><input type="checkbox" id="r-email"> 邮箱地址</label>
            <label class="opt-item"><input type="checkbox" id="r-env"> 环境变量</label>
            <label class="opt-item"><input type="checkbox" id="r-card"> 信用卡号</label>
          </div>

          <div class="sec-label">S2 敏感词 <span style="color:#555;font-size:10px">（触发脱敏后转发）</span></div>
          <div class="chips" id="chips-s2" style="margin-bottom:14px"></div>

          <div class="sec-label">S3 高危词 <span style="color:#555;font-size:10px">（触发本地模型路由）</span></div>
          <div class="chips" id="chips-s3"></div>
        </div>

        <!-- 右列：保存 -->
        <div style="text-align:right">
          <button class="btn-save" id="btn-save" onclick="savePrivacy()">保存设置</button>
          <div class="save-status" id="save-status"></div>
        </div>

      </div>
    </div>
  </div>

  <script>
    // ── Upstream management ──────────────────────────────────────────────
    let upstreams = ${upstreamsJson};

    function renderUpstreams() {
      const tbody = document.getElementById("upstream-tbody");
      if (!upstreams.length) {
        tbody.innerHTML = "<tr><td colspan='8' style='color:#666;text-align:center;padding:16px'>暂无节点</td></tr>";
        return;
      }
      tbody.innerHTML = upstreams.map(u => \`
        <tr id="row-\${u.id}">
          <td><code style="color:#7eb8f7">\${u.id}</code></td>
          <td>\${u.provider}</td>
          <td style="color:#888;font-size:12px">\${u.baseUrl}</td>
          <td style="font-size:12px">\${(u.models||[]).join(", ")}</td>
          <td style="text-align:center">\${u.weight}</td>
          <td><span class="badge \${u.role==="local"?"badge-local":"badge-blue"}">\${u.role||"cloud"}</span></td>
          <td style="text-align:center">
            <label class="switch" style="margin:0 auto">
              <input type="checkbox" \${u.enabled?"checked":""} onchange="toggleEnabled('\${u.id}', this.checked)">
              <span class="slider"></span>
            </label>
          </td>
          <td><button class="btn-del" onclick="deleteUpstream('\${u.id}')" title="删除">✕</button></td>
        </tr>\`).join("");
    }

    function toggleAddForm() {
      const f = document.getElementById("add-form");
      f.style.display = f.style.display === "none" ? "block" : "none";
      document.getElementById("add-status").textContent = "";
    }

    async function toggleEnabled(id, enabled) {
      const res = await fetch(\`/admin/upstreams/\${id}\`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        alert("操作失败：" + (await res.json().catch(()=>({}))).error);
        renderUpstreams(); // revert UI
        return;
      }
      const u = upstreams.find(u => u.id === id);
      if (u) u.enabled = enabled;
    }

    async function deleteUpstream(id) {
      if (!confirm(\`确认删除节点 "\${id}"？\`)) return;
      const res = await fetch(\`/admin/upstreams/\${id}\`, { method: "DELETE" });
      if (res.ok) {
        upstreams = upstreams.filter(u => u.id !== id);
        renderUpstreams();
      } else {
        alert("删除失败：" + (await res.json().catch(()=>({}))).error);
      }
    }

    async function addUpstream() {
      const status = document.getElementById("add-status");
      const alias = document.getElementById("f-alias").value.trim();
      const models = document.getElementById("f-models").value.split(",").map(s=>s.trim()).filter(Boolean);

      // Inject gw-default into models list and build modelAlias if alias is provided
      const modelAlias = {};
      if (alias) {
        if (!models.includes("gw-default")) models.unshift("gw-default");
        modelAlias["gw-default"] = alias;
      }

      const body = {
        id: document.getElementById("f-id").value.trim(),
        provider: document.getElementById("f-provider").value,
        baseUrl: document.getElementById("f-baseUrl").value.trim(),
        apiKey: document.getElementById("f-apiKey").value.trim(),
        models,
        modelAlias: Object.keys(modelAlias).length ? modelAlias : undefined,
        weight: Number(document.getElementById("f-weight").value) || 1,
        role: document.getElementById("f-role").value,
        enabled: true,
      };
      if (!body.id || !body.baseUrl) {
        status.style.color = "#bf6f6f";
        status.textContent = "ID 和 Base URL 必填";
        return;
      }
      status.style.color = "#888";
      status.textContent = "添加中…";
      const res = await fetch("/admin/upstreams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        upstreams.push({ ...data.upstream, apiKey: data.upstream.apiKey ? "****" : "" });
        renderUpstreams();
        toggleAddForm();
        ["f-id","f-baseUrl","f-apiKey","f-alias"].forEach(id => document.getElementById(id).value = "");
        document.getElementById("f-models").value = "*";
        document.getElementById("f-weight").value = "1";
      } else {
        status.style.color = "#bf6f6f";
        status.textContent = data.error || ("添加失败 " + res.status);
      }
    }

    renderUpstreams();

    // ── Containers ───────────────────────────────────────────────────────
    const containers = ${containersJson};

    function renderContainers() {
      const tbody = document.getElementById("container-tbody");
      if (!containers.length) {
        tbody.innerHTML = "<tr><td colspan='8' style='color:#666;text-align:center;padding:16px'>暂无注册容器 — 容器启动时调用 POST /gateway/register 即可自动注册</td></tr>";
        return;
      }
      tbody.innerHTML = containers.map(c => \`
        <tr>
          <td><code style="color:#7eb8f7;font-size:12px">\${c.apiKey}</code></td>
          <td>\${c.username}</td>
          <td><span class="badge badge-blue">\${c.type}</span></td>
          <td style="color:#888;font-size:12px">\${c.version}</td>
          <td><span style="color:\${c.online ? '#6fbf6f' : '#666'};font-size:13px">\${c.online ? '● 在线' : '○ 离线'}</span></td>
          <td style="color:#666;font-size:12px">\${new Date(c.registeredAt).toLocaleString()}</td>
          <td style="color:#666;font-size:12px">\${new Date(c.lastSeenAt).toLocaleString()}</td>
          <td><button class="btn-del" onclick="removeContainer('\${c.apiKey}')" title="移除">✕</button></td>
        </tr>\`).join("");
    }

    async function removeContainer(apiKey) {
      if (!confirm(\`确认移除容器 "\${apiKey}"？其 API Key 将立即失效。\`)) return;
      const res = await fetch(\`/admin/containers/\${apiKey}\`, { method: "DELETE" });
      if (res.ok) location.reload();
      else alert("移除失败");
    }

    renderContainers();

    // ── Privacy ──────────────────────────────────────────────────────────
    const INIT = ${privacyJson};
    let state = JSON.parse(JSON.stringify(INIT));

    function renderChips(elementId, level) {
      const el = document.getElementById(elementId);
      const words = state.rules.keywords[level] || [];
      el.innerHTML = words.map(w =>
        \`<span class="chip">\${w}<span class="rm" onclick="removeKeyword('\${level}','\${w}')">×</span></span>\`
      ).join("") +
      \`<button class="chip-add" onclick="addKeyword(event,'\${level}')">+ 添加</button>\`;
    }

    function removeKeyword(level, word) {
      state.rules.keywords[level] = state.rules.keywords[level].filter(w => w !== word);
      renderChips(level === "S2" ? "chips-s2" : "chips-s3", level);
    }

    function addKeyword(e, level) {
      e.target.replaceWith((() => {
        const inp = document.createElement("input");
        inp.className = "chip-input";
        inp.placeholder = "输入关键词";
        inp.onblur = () => commitKeyword(level, inp.value.trim());
        inp.onkeydown = (ev) => {
          if (ev.key === "Enter") inp.blur();
          if (ev.key === "Escape") renderChips(level === "S2" ? "chips-s2" : "chips-s3", level);
        };
        setTimeout(() => inp.focus(), 0);
        return inp;
      })());
    }

    function commitKeyword(level, word) {
      if (word && !state.rules.keywords[level].includes(word)) {
        state.rules.keywords[level].push(word);
      }
      renderChips(level === "S2" ? "chips-s2" : "chips-s3", level);
    }

    function initControls() {
      document.getElementById("p-enabled").checked = !!state.enabled;
      document.getElementById("p-s2policy").value = state.s2Policy || "proxy";
      document.getElementById("r-ip").checked = !!(state.redaction || {}).internalIp;
      document.getElementById("r-email").checked = !!(state.redaction || {}).email;
      document.getElementById("r-env").checked = !!(state.redaction || {}).envVar;
      document.getElementById("r-card").checked = !!(state.redaction || {}).creditCard;
      renderChips("chips-s2", "S2");
      renderChips("chips-s3", "S3");
    }

    function collectState() {
      state.enabled = document.getElementById("p-enabled").checked;
      state.s2Policy = document.getElementById("p-s2policy").value;
      state.redaction = {
        internalIp: document.getElementById("r-ip").checked,
        email: document.getElementById("r-email").checked,
        envVar: document.getElementById("r-env").checked,
        creditCard: document.getElementById("r-card").checked,
      };
    }

    async function savePrivacy() {
      collectState();
      const btn = document.getElementById("btn-save");
      const status = document.getElementById("save-status");
      btn.disabled = true;
      status.style.color = "#888";
      status.textContent = "保存中…";
      try {
        const res = await fetch("/admin/config/privacy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ privacy: state }),
        });
        if (res.ok) {
          status.style.color = "#6fbf6f";
          status.textContent = "已保存";
        } else {
          const err = await res.json().catch(() => ({}));
          const msg = typeof err.error === "string" ? err.error : (err.error?.message || err.message || ("保存失败 " + res.status));
          status.style.color = "#bf6f6f";
          status.textContent = msg;
        }
      } catch (e) {
        status.style.color = "#bf6f6f";
        status.textContent = "网络错误";
      } finally {
        btn.disabled = false;
        setTimeout(() => { status.textContent = ""; }, 3000);
      }
    }

    initControls();
    setTimeout(() => location.reload(), 30000);
  </script>
</body>
</html>`;

    reply.header("content-type", "text/html").send(html);
  });
}
