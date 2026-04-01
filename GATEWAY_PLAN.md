# ClawX Gateway — 开发计划

将 ClawXRouter 从 OpenClaw 插件演进为独立 AI 网关，支持 100+ OpenClaw 容器接入、集中隐私管理与负载均衡。

---

## 目标架构

```
OpenClaw Container 1 ──┐
OpenClaw Container 2 ──┤
OpenClaw Container N ──┴──→  ClawX Gateway :7080  ──→  Claude / GPT / Gemini / Ollama
                              ├─ 隐私检测 + 脱敏             ├─ Provider A (weight 3)
                              ├─ 负载均衡 (WRR/RR/LC)        ├─ Provider B (weight 2)
                              ├─ 多租户 API Key              └─ Local Ollama (S3)
                              ├─ 集中配置
                              └─ 统一 Dashboard
```

**客户端改动：** OpenClaw 容器只需将 `baseUrl` 指向网关，无需安装任何插件。

---

## 代码复用策略

| 模块 | 文件 | 复用方式 |
|------|------|---------|
| 路由管道 | `clawxrouter/src/router-pipeline.ts` | 直接 import，零改动 |
| 隐私路由器 | `clawxrouter/src/routers/privacy.ts` | 直接 import，零改动 |
| 成本路由器 | `clawxrouter/src/routers/token-saver.ts` | 直接 import，零改动 |
| 规则检测 | `clawxrouter/src/rules.ts` | 直接 import，零改动 |
| 双引擎检测 | `clawxrouter/src/detector.ts` | 直接 import，零改动 |
| 本地模型 | `clawxrouter/src/local-model.ts` | 直接 import，零改动 |
| PII 脱敏 | `clawxrouter/src/utils.ts` | 直接 import，零改动 |
| 配置模式 | `clawxrouter/src/config-schema.ts` | 直接 import，零改动 |
| Hook 系统 | `clawxrouter/src/hooks.ts` | **不用** — 被 HTTP 中间件替代 |
| 插件入口 | `clawxrouter/index.ts` | **不用** — 被 `gateway/src/server.ts` 替代 |

---

## Phase 1 — 核心网关 MVP

**目标：** 能收请求、做隐私检测、负载均衡转发、流式响应。

### 新增文件结构

```
gateway/
├── package.json
├── tsconfig.json
├── gateway.config.example.json        # 配置示例
└── src/
    ├── server.ts                      # Fastify 服务器入口
    ├── types.ts                       # 网关专属类型
    ├── config/
    │   └── store.ts                   # 配置加载（JSON 文件）
    ├── session/
    │   └── memory-store.ts            # 内存 session 状态（Phase 2 换 Redis）
    ├── load-balancer/
    │   ├── strategies.ts              # RoundRobin / WeightedRR / LeastConn
    │   └── health-check.ts            # 上游健康探测
    ├── middleware/
    │   ├── auth.ts                    # API Key 认证 → tenantId
    │   └── privacy.ts                 # 隐私检测中间件（wraps RouterPipeline）
    └── routes/
        ├── completions.ts             # POST /v1/chat/completions
        ├── models.ts                  # GET  /v1/models
        └── admin.ts                   # GET/POST /admin/*
```

### 请求流程

```
POST /v1/chat/completions
  │
  ├─ [auth] API Key → tenant
  ├─ [privacy] 提取最后一条 user message → RouterPipeline → S1/S2/S3
  │
  ├─ S1: LoadBalancer 选上游 → 直接转发
  ├─ S2: PII 脱敏 → LoadBalancer 选上游 → 转发脱敏后的内容
  └─ S3: 转发到本地模型 (Ollama/vLLM)
  │
  └─ 流式 SSE 响应透传回客户端
```

### 配置结构

```json
{
  "server": { "port": 7080, "host": "0.0.0.0" },
  "auth": {
    "enabled": true,
    "apiKeys": {
      "gw-team-a-xxxx": { "tenantId": "team-a", "name": "Team A" }
    }
  },
  "upstreams": [
    {
      "id": "anthropic-primary",
      "provider": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-...",
      "models": ["claude-sonnet-4-6", "claude-opus-4-6"],
      "weight": 3,
      "enabled": true
    },
    {
      "id": "openai-backup",
      "provider": "openai",
      "baseUrl": "https://api.openai.com",
      "apiKey": "sk-...",
      "models": ["gpt-4o", "gpt-4o-mini"],
      "weight": 2,
      "enabled": true
    },
    {
      "id": "local-ollama",
      "provider": "openai-compatible",
      "baseUrl": "http://ollama:11434",
      "apiKey": "",
      "models": ["*"],
      "weight": 1,
      "enabled": true
    }
  ],
  "loadBalancer": {
    "strategy": "weighted-round-robin",
    "healthCheck": { "enabled": true, "intervalSec": 30, "timeoutSec": 5 }
  },
  "privacy": {
    "enabled": true,
    "s2Policy": "proxy",
    "rules": { "keywords": { "S2": [], "S3": [] } }
  }
}
```

### OpenClaw 容器侧配置（仅需改这一处）

```json
{
  "providers": [{
    "name": "clawx-gateway",
    "type": "openai-compatible",
    "baseUrl": "http://clawx-gateway:7080/v1",
    "apiKey": "gw-team-a-xxxx"
  }],
  "defaultProvider": "clawx-gateway"
}
```

---

## Phase 2 — 生产就绪

| 功能 | 实现 |
|------|------|
| Redis session store | 替换 `memory-store.ts` |
| 多租户隔离 | 每个租户独立隐私规则 + 配额 |
| 熔断器 | `load-balancer/circuit-breaker.ts` |
| Prometheus 指标 | `/metrics` 端点 |
| Docker 部署 | `docker/docker-compose.yml` |

---

## Phase 3 — 高级特性

- 基于延迟/错误率的动态权重调整
- 每请求完整审计日志（含脱敏 diff）
- 配置热下发到 OpenClaw 容器（WebSocket）
- A/B 测试路由（流量百分比拆分）

---

## 启动方式

```bash
cd gateway
npm install
cp ../gateway.config.example.json gateway.config.json
# 编辑 gateway.config.json 填入 API Keys
npm start
```

访问 Dashboard: `http://localhost:7080/admin/dashboard`

---

*当前进度: Phase 1 实施中*
