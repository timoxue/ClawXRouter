# GuardClaw 技术文档

> **版本**: 2026.3.9  
> **定位**: OpenClaw 隐私感知插件 — 集成灵敏度检测、可组合路由管线、隐私代理与 Guard Agent  
> **协议**: OpenClaw Plugin SDK

---

## 目录

1. [项目概览](#1-项目概览)
2. [架构设计](#2-架构设计)
3. [代码结构](#3-代码结构)
4. [核心类型定义](#4-核心类型定义)
5. [模块详解与 API 参考](#5-模块详解与-api-参考)
   - 5.1 [入口 — index.ts](#51-入口--indexts)
   - 5.2 [类型系统 — types.ts](#52-类型系统--typests)
   - 5.3 [配置 Schema — config-schema.ts](#53-配置-schema--config-schemats)
   - 5.4 [检测引擎 — detector.ts](#54-检测引擎--detectorts)
   - 5.5 [规则检测器 — rules.ts](#55-规则检测器--rulests)
   - 5.6 [本地模型检测器 — local-model.ts](#56-本地模型检测器--local-modelts)
   - 5.7 [路由管线 — router-pipeline.ts](#57-路由管线--router-pipelinets)
   - 5.8 [隐私路由器 — routers/privacy.ts](#58-隐私路由器--routersprivacyts)
   - 5.9 [Token-Saver 路由器 — routers/token-saver.ts](#59-token-saver-路由器--routerstoken-saverts)
   - 5.10 [Hook 系统 — hooks.ts](#510-hook-系统--hooksts)
   - 5.11 [隐私代理 — privacy-proxy.ts](#511-隐私代理--privacy-proxyts)
   - 5.12 [Provider — provider.ts](#512-provider--providerts)
   - 5.13 [Guard Agent — guard-agent.ts](#513-guard-agent--guard-agentts)
   - 5.14 [会话状态 — session-state.ts](#514-会话状态--session-statest)
   - 5.15 [会话管理器 — session-manager.ts](#515-会话管理器--session-managerts)
   - 5.16 [记忆隔离 — memory-isolation.ts](#516-记忆隔离--memory-isolationts)
   - 5.17 [Prompt 加载器 — prompt-loader.ts](#517-prompt-加载器--prompt-loaderts)
   - 5.18 [工具函数 — utils.ts](#518-工具函数--utilsts)
6. [配置指南](#6-配置指南)
7. [开发指南](#7-开发指南)
8. [自定义指南](#8-自定义指南)
   - 8.1 [自定义路由器](#81-自定义路由器)
   - 8.2 [自定义边缘推理 Provider](#82-自定义边缘推理-provider)
   - 8.3 [自定义 Prompt 模板](#83-自定义-prompt-模板)
   - 8.4 [自定义检测规则](#84-自定义检测规则)
9. [测试](#9-测试)
10. [安全模型与威胁分析](#10-安全模型与威胁分析)

---

## 1. 项目概览

GuardClaw 是 OpenClaw 平台的隐私感知插件，核心目标是**在 AI Agent 与用户交互过程中自动检测敏感数据，并根据敏感等级做出适当的路由决策**——确保高敏感数据永远不会离开本地环境。

### 核心能力

| 能力 | 说明 |
|------|------|
| **三级灵敏度分类** | S1（安全）→ 云端处理；S2（敏感）→ 脱敏后云端 / 本地处理；S3（私密）→ 仅本地处理 |
| **双检测引擎** | 基于规则的检测器 + 基于本地 LLM 的检测器，可组合使用 |
| **可扩展路由管线** | 内置 privacy 路由器 + token-saver 路由器，支持用户自定义路由器 |
| **隐私代理** | 本地 HTTP 代理服务器，拦截 S2 请求并在转发前剥离 PII 标记 |
| **Guard Agent** | 专用本地子代理，处理 S3 级别的私密任务 |
| **双轨记忆** | MEMORY-FULL.md（本地完整记忆）+ MEMORY.md（脱敏后的云端记忆） |
| **双轨会话历史** | full 历史（含 guard agent 交互）+ clean 历史（排除 guard agent 内容） |
| **多推理后端** | 支持 Ollama、vLLM、LMStudio、SGLang、TGI 等 OpenAI 兼容 API 以及自定义 Provider |

### 灵敏度等级定义

| 等级 | 含义 | 路由策略 | 示例 |
|------|------|----------|------|
| **S1** | 安全 | 直接通过，云端模型处理 | "写一首关于春天的诗" |
| **S2** | 敏感（含 PII） | 脱敏后转发云端（proxy 策略）或路由到本地模型（local 策略） | 地址、电话、邮箱、快递单号 |
| **S3** | 私密 | 仅本地模型处理，永不上云 | 工资单、病历、密码、API Key、SSH 密钥 |

---

## 2. 架构设计

### 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                        OpenClaw Agent                        │
│                                                              │
│  User Message → [Hook: before_model_resolve]                 │
│                       │                                      │
│                 ┌─────▼──────┐                               │
│                 │  RouterPipeline  │                          │
│                 │  ┌──────────────┐│                          │
│                 │  │ privacy      ││ ← 内置: S1/S2/S3 检测   │
│                 │  │ token-saver  ││ ← 内置: 任务复杂度路由   │
│                 │  │ custom-*     ││ ← 用户自定义路由器       │
│                 │  └──────────────┘│                          │
│                 └─────┬──────┘                               │
│                       │ RouterDecision                       │
│              ┌────────┼────────┐                             │
│              │        │        │                             │
│          S1: 通过  S2: 代理   S3: 本地                       │
│              │        │        │                             │
│              ▼        ▼        ▼                             │
│          Cloud   Privacy    Guard Agent                      │
│          Model    Proxy    (Local Model)                     │
│                    │                                         │
│            ┌───────▼────────┐                                │
│            │ Strip PII Markers│                               │
│            │ Forward to Cloud │                               │
│            └─────────────────┘                               │
└──────────────────────────────────────────────────────────────┘
```

### 插件注册五步流程

1. **registerProvider** — 注册 `guardclaw-privacy` 代理 Provider
2. **config injection** — 将 Provider 指向本地隐私代理
3. **registerService** — 管理代理服务器生命周期
4. **init pipeline** — 创建路由管线 + 注册内置与自定义路由器
5. **registerHooks** — 注册全部 10 个 Hook 点

### 检测流程

```
Checkpoint (onUserMessage / onToolCallProposed / onToolCallExecuted)
    │
    ▼
RouterPipeline.run()
    │
    ├── Phase 1: 高权重路由器 (weight ≥ 50) 并行执行
    │       └── privacy router → detectSensitivityLevel()
    │                                ├── ruleDetector: 关键词 + 正则 + 工具类型
    │                                └── localModelDetector: 本地 LLM 分类
    │
    ├── 短路判断: 若 Phase 1 发现非 S1 → 跳过 Phase 2
    │
    └── Phase 2: 低权重路由器 (weight < 50) 
            └── token-saver → LLM Judge 任务复杂度分类
```

### S2 数据流（proxy 策略）

```
User Message (含 PII)
    │
    ▼
detectByLocalModel() → S2
    │
    ▼
desensitizeWithLocalModel()
    ├── Step 1: LLM 提取 PII 为 JSON 数组
    └── Step 2: 编程替换 PII → [REDACTED:TYPE] 标记
    │
    ▼
Wrap in <guardclaw-s2>...</guardclaw-s2> markers
    │
    ▼
Route to guardclaw-privacy provider
    │
    ▼
Privacy Proxy (localhost:8403)
    ├── Strip markers, keep only desensitized content
    ├── Forward to original cloud provider
    └── Passthrough response (including SSE streaming)
```

---

## 3. 代码结构

```
guardclaw/
├── index.ts                    # 插件入口，五步注册流程
├── package.json                # 包定义与依赖
├── openclaw.plugin.json        # OpenClaw 插件元数据 + configSchema
├── config.example.json         # 示例配置（含所有 Edge Provider 示例）
│
├── src/
│   ├── types.ts                # 核心类型定义
│   ├── config-schema.ts        # TypeBox 配置 Schema + 默认值
│   ├── detector.ts             # 检测引擎核心（协调双检测器）
│   ├── rules.ts                # 规则检测器（关键词、正则、工具类型、路径）
│   ├── local-model.ts          # 本地 LLM 检测器 + 脱敏 + 多协议支持
│   ├── router-pipeline.ts      # 路由管线（注册、配置、两阶段执行、加权合并）
│   ├── hooks.ts                # 10 个 Hook 注册与实现
│   ├── privacy-proxy.ts        # HTTP 隐私代理服务器
│   ├── provider.ts             # guardclaw-privacy Provider 定义
│   ├── guard-agent.ts          # Guard Agent 配置与会话管理
│   ├── session-state.ts        # 会话隐私状态（内存存储）
│   ├── session-manager.ts      # 双轨会话历史持久化
│   ├── memory-isolation.ts     # 双轨记忆管理（MEMORY.md / MEMORY-FULL.md）
│   ├── prompt-loader.ts        # Prompt 模板加载器（支持用户自定义）
│   ├── utils.ts                # 工具函数（路径匹配、PII 规则脱敏等）
│   └── routers/
│       ├── privacy.ts          # 内置 privacy 路由器
│       └── token-saver.ts      # 内置 token-saver 路由器
│
├── prompts/
│   ├── guard-agent-system.md   # Guard Agent 系统 Prompt（可自定义）
│   └── token-saver-judge.md    # Token-Saver 复杂度分类 Prompt（可自定义）
│
├── test/
│   ├── rules.test.ts           # 规则检测器测试
│   ├── session-manager.test.ts # 会话管理器测试
│   ├── detector.test.ts        # 检测引擎测试
│   ├── token-saver.test.ts     # Token-Saver 路由器测试
│   ├── guardclaw-plugin-e2e.test.ts  # 端到端插件测试
│   ├── privacy-proxy.test.ts   # 隐私代理测试
│   ├── integration.test.ts     # 集成测试
│   └── router-pipeline.test.ts # 路由管线测试
│
└── docs/
    └── GuardClaw-技术报告.md   # 本文档
```

---

## 4. 核心类型定义

### 灵敏度等级

```typescript
type SensitivityLevel = "S1" | "S2" | "S3";
type SensitivityLevelNumeric = 1 | 2 | 3;
```

### 检测器类型

```typescript
type DetectorType = "ruleDetector" | "localModelDetector";
```

### 检测点（Checkpoint）

```typescript
type Checkpoint = "onUserMessage" | "onToolCallProposed" | "onToolCallExecuted";
```

### 边缘推理 Provider 协议

```typescript
type EdgeProviderType = "openai-compatible" | "ollama-native" | "custom";
```

- **openai-compatible**: `POST /v1/chat/completions` — 兼容 Ollama、vLLM、LiteLLM、LocalAI、LMStudio、SGLang、TGI
- **ollama-native**: `POST /api/chat` — Ollama 原生 API
- **custom**: 用户提供的模块，需导出 `callChat()` 函数

### 检测上下文

```typescript
type DetectionContext = {
  checkpoint: Checkpoint;
  message?: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  toolResult?: unknown;
  sessionKey?: string;
  agentId?: string;
  recentContext?: string[];
  fileContentSnippet?: string;   // 预读文件内容片段
};
```

### 检测结果

```typescript
type DetectionResult = {
  level: SensitivityLevel;
  levelNumeric: SensitivityLevelNumeric;
  reason?: string;
  detectorType: DetectorType;
  confidence?: number;
};
```

### 路由器决策

```typescript
type RouterAction = "passthrough" | "redirect" | "transform" | "block";

type RouterDecision = {
  level: SensitivityLevel;
  action?: RouterAction;
  target?: { provider: string; model: string };
  transformedContent?: string;
  reason?: string;
  confidence?: number;
  routerId?: string;
};
```

### 路由器接口

```typescript
interface GuardClawRouter {
  id: string;
  detect(
    context: DetectionContext,
    config: Record<string, unknown>,
  ): Promise<RouterDecision>;
}
```

### 路由器注册

```typescript
type RouterRegistration = {
  enabled?: boolean;
  type?: "builtin" | "custom";
  module?: string;                    // 自定义路由器模块路径
  options?: Record<string, unknown>;  // 传递给 router.detect() 的配置
  weight?: number;                    // 合并权重 (0–100, 默认 50)
};
```

### 管线配置

```typescript
type PipelineConfig = {
  onUserMessage?: string[];           // 路由器 ID 执行顺序
  onToolCallProposed?: string[];
  onToolCallExecuted?: string[];
};
```

### 会话隐私状态

```typescript
type SessionPrivacyState = {
  sessionKey: string;
  isPrivate: boolean;
  highestLevel: SensitivityLevel;
  detectionHistory: Array<{
    timestamp: number;
    level: SensitivityLevel;
    checkpoint: Checkpoint;
    reason?: string;
  }>;
};
```

---

## 5. 模块详解与 API 参考

### 5.1 入口 — `index.ts`

插件的主入口文件，实现 OpenClaw 插件接口。

**导出**: `default plugin` 对象

**注册流程** (`register(api)`):

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | `api.registerProvider()` | 注册 `guardclaw-privacy` Provider |
| 2 | Config injection | 将 Provider 的 `baseUrl` 指向 `http://127.0.0.1:{proxyPort}/v1` |
| 3 | `api.registerService()` | 注册代理服务 `guardclaw-proxy`，管理启停 |
| 4 | `new RouterPipeline()` | 创建路由管线，注册 privacy + token-saver 路由器 |
| 5 | `registerHooks(api)` | 注册全部 10 个检测与路由 Hook |

**关键内部函数**:

- `getPrivacyConfig(pluginConfig)` — 合并用户配置与默认配置

---

### 5.2 类型系统 — `types.ts`

集中定义所有核心类型与辅助函数。

**导出的辅助函数**:

| 函数 | 签名 | 说明 |
|------|------|------|
| `levelToNumeric` | `(level: SensitivityLevel) => SensitivityLevelNumeric` | 等级转数字 |
| `numericToLevel` | `(numeric: SensitivityLevelNumeric) => SensitivityLevel` | 数字转等级 |
| `maxLevel` | `(...levels: SensitivityLevel[]) => SensitivityLevel` | 取最高等级 |

---

### 5.3 配置 Schema — `config-schema.ts`

使用 `@sinclair/typebox` 定义配置 Schema，提供运行时类型验证。

**导出**:

| 名称 | 说明 |
|------|------|
| `guardClawConfigSchema` | TypeBox Schema 对象 |
| `defaultPrivacyConfig` | 默认配置值 |

**默认配置要点**:

- 检测默认使用 `localModelDetector`（非规则检测器）
- S2 策略默认为 `"proxy"`
- 代理端口默认 `8403`
- 默认本地模型: `openbmb/minicpm4.1` via `openai-compatible`
- privacy 路由器默认启用，token-saver 默认禁用

---

### 5.4 检测引擎 — `detector.ts`

检测的核心协调器，负责根据配置调度多个检测器并合并结果。

**导出函数**:

#### `detectSensitivityLevel(context, pluginConfig)`

- **参数**: `DetectionContext` + 插件配置
- **返回**: `Promise<DetectionResult>`
- **逻辑**:
  1. 合并配置（用户 + 默认）
  2. 根据 checkpoint 获取配置的检测器列表
  3. 顺序执行所有检测器
  4. 合并结果：取最高等级，合并原因，加权平均置信度

**内部函数**:

| 函数 | 说明 |
|------|------|
| `getDetectorsForCheckpoint()` | 获取指定 checkpoint 的检测器列表，默认 `["localModelDetector"]` |
| `runDetectors()` | 顺序执行检测器，单个失败不阻塞其它 |
| `mergeDetectionResults()` | 合并多个检测结果，最高等级优先 |
| `mergeWithDefaults()` | 深度合并用户配置与默认值 |

---

### 5.5 规则检测器 — `rules.ts`

基于规则的灵敏度检测，支持关键词匹配、正则表达式、工具类型和路径检测。

**导出函数**:

#### `detectByRules(context, config)`

- **返回**: `DetectionResult`（同步，confidence 固定为 1.0）

**检测维度** (按顺序):

| 序号 | 检测项 | 说明 |
|------|--------|------|
| 1 | 关键词匹配 | 消息文本中匹配 `rules.keywords.S2/S3` |
| 2 | 正则匹配 | 消息文本中匹配 `rules.patterns.S2/S3`（带编译缓存） |
| 3 | 工具类型 | 工具名匹配 `rules.tools.S2/S3.tools` |
| 4 | 工具参数路径 | 参数中提取路径，匹配 `rules.tools.S2/S3.paths` |
| 5 | 工具结果内容 | 对工具执行结果重复关键词 + 正则检查 |

**内部实现细节**:

- 正则编译结果缓存在 `patternCache` Map 中，避免重复编译
- 所有检查 S3 优先于 S2（高优先级先检测）
- 路径匹配支持精确匹配、前缀匹配和后缀匹配（`*` 通配）
- 额外检测敏感文件扩展名：`.pem`, `.key`, `.p12`, `.pfx`, `id_rsa` 等

---

### 5.6 本地模型检测器 — `local-model.ts`

基于本地 LLM 的灵敏度检测与 PII 脱敏引擎，支持多种 API 协议。

**导出函数**:

#### `callChatCompletion(endpoint, model, messages, options?)`

统一的 Chat Completion 调用入口，根据 `providerType` 分发到不同 API。

| 协议 | API 路径 | 兼容后端 |
|------|----------|----------|
| `openai-compatible` | `POST {endpoint}/v1/chat/completions` | Ollama, vLLM, LiteLLM, LocalAI, LMStudio, SGLang, TGI |
| `ollama-native` | `POST {endpoint}/api/chat` | Ollama 原生 |
| `custom` | 用户模块的 `callChat()` | 自定义 |

#### `detectByLocalModel(context, config)`

- 构建检测 Prompt（system + user）
- 调用本地模型获取 JSON 分类结果
- 解析响应提取 `{level, reason, confidence}`
- 安全网: 若 LLM 返回 S1 但文件内容有明显 PII，自动升级到 S2

#### `desensitizeWithLocalModel(content, config)`

两步脱敏流程：
1. **Step 1**: LLM 提取 PII 为 JSON 数组 `[{type, value}, ...]`
2. **Step 2**: 编程替换 — 按 value 长度降序排序，逐个替换为 `[REDACTED:TYPE]` 标记

PII 类型映射覆盖：ADDRESS, PHONE, NAME, EMAIL, ID, CARD, SECRET, PASSWORD, LICENSE_PLATE, DELIVERY, ACCESS_CODE 等 30+ 种类型。

#### `callLocalModelDirect(systemPrompt, userMessage, config)`

直接调用边缘模型执行 S3 分析任务，绕过完整 Agent 管线。配置了 `frequencyPenalty: 0.5` 抑制重复。

**内部实现细节**:

- `stripThinkingTags()` — 清理推理模型（MiniCPM、Qwen3）的 `<think>...</think>` 输出
- `quickPiiScan()` — 基于正则的 PII 快速扫描，用于安全网判断（非主要检测手段）
- `parsePiiJson()` — 健壮的 JSON 解析器，处理 markdown 代码块、单引号 JSON、尾部逗号等模型输出异常
- Qwen 模型自动添加 `/no_think` 前缀抑制思维链输出

**自定义 Provider 接口**:

```typescript
interface CustomEdgeProvider {
  callChat(
    endpoint: string,
    model: string,
    messages: ChatMessage[],
    options?: ChatCompletionOptions,
  ): Promise<string>;
}
```

---

### 5.7 路由管线 — `router-pipeline.ts`

通用路由管线，支持多个路由器在每个 checkpoint 组合执行。

**导出类**: `RouterPipeline`

#### 构造函数

```typescript
new RouterPipeline(logger?)
```

#### 方法

| 方法 | 说明 |
|------|------|
| `register(router, registration?)` | 注册路由器实例 |
| `loadCustomRouter(id, modulePath, registration?)` | 从模块路径动态加载自定义路由器 |
| `configure(config)` | 从插件配置初始化管线 |
| `loadCustomRouters()` | 加载所有在配置中声明的自定义路由器 |
| `getRoutersForCheckpoint(checkpoint)` | 获取指定 checkpoint 的路由器列表 |
| `getRouterWeight(id)` | 获取路由器权重（默认 50） |
| `run(checkpoint, context, pluginConfig)` | 执行路由管线 |
| `listRouters()` | 列出所有已注册路由器 ID |
| `hasRouter(id)` | 检查路由器是否已注册 |

#### 两阶段执行策略

`run()` 方法实现两阶段短路执行：

| 阶段 | 条件 | 行为 |
|------|------|------|
| **Phase 1** | weight ≥ 50（快速路由器） | 并行执行，如有非 S1/非 passthrough 结果则短路 |
| **Phase 2** | weight < 50（慢速路由器） | 仅当 Phase 1 全部 S1 时执行 |

这避免了在规则检测已确定敏感时还调用昂贵的 LLM Judge。

#### 加权决策合并策略

```
1. 安全优先: 最高灵敏度等级始终获胜 (S3 > S2 > S1)
2. 同等级下，权重决定: 高权重路由器的 action/target 获胜
3. 权重相同时，action 严重性决定: block > redirect > transform > passthrough
4. 最终 confidence: 加权平均
```

**导出的全局函数**:

| 函数 | 说明 |
|------|------|
| `setGlobalPipeline(pipeline)` | 设置全局单例管线（插件初始化时调用） |
| `getGlobalPipeline()` | 获取全局管线实例 |

---

### 5.8 隐私路由器 — `routers/privacy.ts`

内置隐私路由器，封装现有的检测引擎 (`detector.ts`) 作为 `GuardClawRouter` 接口。

**导出**: `privacyRouter: GuardClawRouter`

- **id**: `"privacy"`
- **默认权重**: 50（归类为快速路由器，Phase 1 执行）

**路由逻辑**:

| 检测结果 | 路由动作 | 目标 |
|----------|----------|------|
| S1 | `passthrough` | 直接通过 |
| S2 (proxy 策略) | `redirect` | `guardclaw-privacy` 代理 Provider |
| S2 (local 策略) | `redirect` | 本地 Guard Agent |
| S3 | `redirect` | 本地 Guard Agent |

---

### 5.9 Token-Saver 路由器 — `routers/token-saver.ts`

基于 LLM-as-Judge 的任务复杂度路由器，将简单任务路由到更便宜的模型。

**导出**: `tokenSaverRouter: GuardClawRouter`

- **id**: `"token-saver"`
- **默认启用**: `false`（需用户主动开启）
- **建议权重**: < 50（归类为慢速路由器，仅在 privacy 通过后执行）

**任务复杂度分级**:

| 级别 | 说明 | 默认模型 |
|------|------|----------|
| SIMPLE | 查询、翻译、格式化、是/否 | `gpt-4o-mini` |
| MEDIUM | 代码生成、数据分析、单文件编辑 | `gpt-4o` |
| COMPLEX | 系统设计、多文件重构、架构决策 | `claude-sonnet-4.6` |
| REASONING | 数学证明、形式逻辑、深度分析 | `o4-mini` |

**特性**:

- 子代理会话自动跳过（避免逐消息 Judge 开销）
- Prompt 哈希缓存（SHA-256，TTL 5 分钟）
- 定期缓存清理（每 60 秒，最大存活 10 分钟）
- Judge 调用失败时 fallback 为 passthrough（不阻塞请求）
- 复用 GuardClaw 的 `callChatCompletion()` 基础设施

**配置项** (`routers.token-saver.options`):

| 键 | 类型 | 默认 | 说明 |
|----|------|------|------|
| `judgeEndpoint` | string | 继承 localModel.endpoint | Judge 模型端点 |
| `judgeModel` | string | 继承 localModel.model | Judge 模型名称 |
| `judgeProviderType` | EdgeProviderType | 继承 localModel.type | Judge API 协议 |
| `tiers` | Record<Tier, {provider, model}> | 见上表 | 每级对应的模型 |
| `cacheTtlMs` | number | 300000 | 缓存 TTL（毫秒） |

---

### 5.10 Hook 系统 — `hooks.ts`

注册全部 10 个插件 Hook，串联检测、路由、脱敏、Guard Agent、记忆同步等功能。

**Hook 列表**:

| 序号 | Hook 名称 | 触发时机 | 核心职责 |
|------|-----------|----------|----------|
| 1 | `before_model_resolve` | 模型选择前 | 运行管线 → 决定路由（本地/代理/云端） |
| 2 | `before_prompt_build` | Prompt 构建前 | 注入 Guard Prompt / S2 标记 / 文件内容 |
| 3 | `before_tool_call` | 工具调用前 | 管线检测 + 文件访问守卫 + 子代理守卫 |
| 4 | `after_tool_call` | 工具调用后 | 对工具结果运行管线检测 |
| 5 | `tool_result_persist` | 工具结果持久化时 | 写入双轨会话历史 |
| 6 | `before_message_write` | 消息写入前 | 根据检测结果清理会话记录（S3 → 占位符，S2 → 脱敏版） |
| 7 | `session_end` | 会话结束时 | 记忆同步（MEMORY-FULL → MEMORY） |
| 8 | `message_sending` | 出站消息时 | 对外发消息运行管线，S3 取消 / S2 脱敏 |
| 9 | `before_agent_start` | 子代理启动前 | 对子代理任务运行管线守卫 |
| 10 | `message_received` | 收到消息时 | 观察性日志 |

**Hook 1 详细流程** (`before_model_resolve`):

```
1. 检查是否为 Guard 子会话 → 是则直接返回本地模型
2. 过滤系统消息、已脱敏内容
3. 尝试预读消息中引用的文件 (.xlsx/.csv/.txt/.docx/.json/.md)
4. 执行 RouterPipeline.run("onUserMessage")
5. 记录检测结果到会话状态
6. 根据 RouterDecision:
   - S1 passthrough → 无操作
   - S3 / redirect → 路由到本地模型
   - S2 proxy → 脱敏 + 路由到 guardclaw-privacy
   - S2 local → 脱敏 + 路由到本地模型
   - block → 路由到边缘模型作为安全保障
7. Stash 检测结果供后续 Hook 使用
```

**Hook 3 特殊守卫**:

- **文件访问守卫**: 阻止云端模型访问 `sessions/full/`、`MEMORY-FULL.md` 等受保护路径
- **预读文件守卫**: 若文件已在 S2 流程中预读并脱敏，阻止重复读取原始文件
- **子代理守卫**: 拦截 `sessions_spawn` / `sessions_send`，对任务内容运行管线检测

---

### 5.11 隐私代理 — `privacy-proxy.ts`

轻量级 HTTP 代理服务器，拦截 S2 请求并在转发到云端前剥离 PII 标记。

**导出函数/类型**:

| 名称 | 说明 |
|------|------|
| `startPrivacyProxy(port, logger?)` | 启动代理服务器，返回 `ProxyHandle` |
| `stripPiiMarkers(messages)` | 从消息数组中剥离 `<guardclaw-s2>` 标记 |
| `stashOriginalProvider(key, target)` | 暂存原始 Provider 信息（按会话 key） |
| `getStashedProvider(key)` | 查询暂存的 Provider 信息（TTL 缓存，不删除） |
| `setDefaultProviderTarget(target)` | 设置默认 Provider 目标（fallback） |

**标记协议**:

```
<guardclaw-s2>
  [脱敏后的内容]
</guardclaw-s2>
```

**代理处理流程**:

1. 读取请求体
2. 剥离 `<guardclaw-s2>...</guardclaw-s2>` 标记
3. 通过 `x-guardclaw-session` 头解析会话 key
4. 查找原始 Provider 目标
5. 转发清理后的请求到上游 Provider
6. 透传响应（支持 SSE streaming）

**ProxyHandle 接口**:

```typescript
type ProxyHandle = {
  baseUrl: string;     // "http://127.0.0.1:{port}"
  port: number;
  close: () => Promise<void>;
};
```

---

### 5.12 Provider — `provider.ts`

注册 `guardclaw-privacy` 作为 OpenClaw Provider。

**导出**:

| 名称 | 说明 |
|------|------|
| `guardClawPrivacyProvider` | Provider 定义对象 |
| `setActiveProxy(proxy)` | 设置活跃的代理实例 |
| `getActiveProxy()` | 获取活跃的代理实例 |
| `mirrorAllProviderModels(config)` | 从所有已配置 Provider 镜像模型列表 |

`mirrorAllProviderModels()` 确保 `guardclaw-privacy` Provider 包含所有用户配置的模型，使得 `providerOverride: "guardclaw-privacy"` 可以与任意模型配合工作。

---

### 5.13 Guard Agent — `guard-agent.ts`

管理 Guard Agent 配置与 S3 会话路由。

**导出函数**:

| 函数 | 说明 |
|------|------|
| `isGuardAgentConfigured(config)` | 检查 Guard Agent 是否完整配置 |
| `getGuardAgentConfig(config)` | 解析 Guard Agent 配置，分离 provider/model |
| `generateGuardSessionKey(parentKey)` | 生成 guard 子会话 key（`{parent}:guard`） |
| `isGuardSessionKey(key)` | 检测是否为 guard 子会话 |
| `getParentSessionKey(guardKey)` | 提取父会话 key |
| `buildMainSessionPlaceholder(level, reason?)` | 构建主会话占位消息 |
| `isLocalProvider(provider, extraProviders?)` | 验证 Provider 是否为本地（非云端） |

**内置本地 Provider 列表**:

`ollama`, `llama.cpp`, `localai`, `llamafile`, `lmstudio`, `vllm`, `mlx`, `sglang`, `tgi`, `koboldcpp`, `tabbyapi`, `nitro`

**模型引用格式**: `"provider/model"` — 如 `"ollama/llama3.2:3b"`, `"vllm/qwen2.5:7b"`

---

### 5.14 会话状态 — `session-state.ts`

基于内存的会话隐私状态管理。

**导出函数**:

| 函数 | 说明 |
|------|------|
| `markSessionAsPrivate(key, level)` | 标记会话为私密（一旦标记不降级） |
| `isSessionMarkedPrivate(key)` | 检查会话是否私密 |
| `getSessionHighestLevel(key)` | 获取最高检测等级 |
| `getSessionSensitivity(key)` | 获取会话灵敏度信息 |
| `recordDetection(key, level, checkpoint, reason?)` | 记录检测事件（最多保留 50 条） |
| `getSessionState(key)` | 获取完整会话状态 |
| `clearSessionState(key)` | 清除会话状态 |
| `resetSessionPrivacy(key)` | 重置隐私状态（允许切回云端模型） |
| `getAllSessionStates()` | 获取所有活跃会话状态（调试用） |
| `markPreReadFiles(key, message)` | 标记已预读的文件路径 |
| `isFilePreRead(key, filePath)` | 检查文件是否已预读 |
| `stashDetection(key, detection)` | 暂存检测结果（跨 Hook 传递） |
| `getPendingDetection(key)` | 获取待处理的检测结果 |
| `consumeDetection(key)` | 消费并返回待处理的检测结果 |

**PendingDetection 类型**:

```typescript
type PendingDetection = {
  level: SensitivityLevel;
  reason?: string;
  desensitized?: string;        // S2 脱敏后的内容
  preReadFileContent?: string;  // 预读的文件内容
  originalPrompt?: string;      // 原始消息
  timestamp: number;
};
```

---

### 5.15 会话管理器 — `session-manager.ts`

双轨会话历史持久化（JSONL 格式）。

**导出类**: `DualSessionManager`

#### 方法

| 方法 | 说明 |
|------|------|
| `persistMessage(sessionKey, message, agentId?)` | 持久化消息到双轨历史 |
| `loadHistory(sessionKey, isCloudModel, agentId?, limit?)` | 根据模型类型加载历史 |
| `clearHistory(sessionKey, agentId?, historyType?)` | 清除历史 |
| `getHistoryStats(sessionKey, agentId?)` | 获取历史统计 |

**双轨策略**:

- **full 历史**: 所有消息（含 Guard Agent 交互），供本地模型使用
- **clean 历史**: 排除 Guard Agent 消息，供云端模型使用

**存储路径**:

```
~/.openclaw/agents/{agentId}/sessions/{full|clean}/{sessionKey}.jsonl
```

**导出的单例**:

```typescript
getDefaultSessionManager(): DualSessionManager
```

---

### 5.16 记忆隔离 — `memory-isolation.ts`

管理双轨记忆目录，确保云端模型永远看不到完整的隐私记忆。

**导出类**: `MemoryIsolationManager`

#### 方法

| 方法 | 说明 |
|------|------|
| `getMemoryDir(isCloudModel)` | 获取记忆目录路径 |
| `getMemoryFilePath(isCloudModel)` | 获取 MEMORY.md / MEMORY-FULL.md 路径 |
| `getDailyMemoryPath(isCloudModel, date?)` | 获取日记忆文件路径 |
| `writeMemory(content, isCloudModel, options?)` | 写入记忆 |
| `readMemory(isCloudModel, options?)` | 读取记忆 |
| `mergeCleanIntoFull(options?)` | 将云端记忆的新增内容合并到完整记忆 |
| `syncMemoryToClean(privacyConfig?)` | 同步 MEMORY-FULL → MEMORY（过滤 + 脱敏） |
| `syncDailyMemoryToClean(privacyConfig?)` | 同步所有日记忆文件 |
| `syncAllMemoryToClean(privacyConfig?)` | 全量同步（长期 + 日记忆） |
| `initializeDirectories()` | 初始化目录结构 |
| `getMemoryStats()` | 获取记忆统计 |

**同步流程**:

```
1. Merge MEMORY.md → MEMORY-FULL.md    (捕获云端模型的新增)
2. Filter guard agent sections           (移除 [Guard Agent] 等标记段)
3. Redact PII                            (优先 LLM 脱敏，fallback 规则脱敏)
4. Write → MEMORY.md                     (清理后的版本)
```

**文件结构**:

```
~/.openclaw/workspace/
├── MEMORY.md           # 云端模型看到的（脱敏后）
├── MEMORY-FULL.md      # 本地模型看到的（完整）
├── memory/             # 日记忆（脱敏后）
│   └── 2026-03-11.md
└── memory-full/        # 日记忆（完整）
    └── 2026-03-11.md
```

---

### 5.17 Prompt 加载器 — `prompt-loader.ts`

从 `prompts/` 目录加载 Prompt 模板，支持用户自定义。

**导出函数**:

| 函数 | 说明 |
|------|------|
| `loadPrompt(name, fallback)` | 加载 `prompts/{name}.md`，不存在则用 fallback |
| `loadPromptWithVars(name, fallback, vars)` | 加载并替换 `{{PLACEHOLDER}}` 变量 |

**特性**:

- 结果缓存在内存中，每个名称只读取一次
- 自动搜索 `src/../prompts` 和 `dist/src/../../prompts`
- 文件不存在或读取失败时静默回退到硬编码默认值

---

### 5.18 工具函数 — `utils.ts`

通用辅助函数集。

**导出函数**:

| 函数 | 说明 |
|------|------|
| `getPrivacyConfig(pluginConfig)` | 从插件配置提取隐私配置 |
| `isPrivacyEnabled(config)` | 检查隐私功能是否启用 |
| `normalizePath(path)` | 路径标准化（展开 `~`） |
| `matchesPathPattern(path, patterns)` | 路径模式匹配 |
| `extractPathsFromParams(params)` | 从工具参数递归提取路径 |
| `redactSensitiveInfo(text)` | 综合规则脱敏（两阶段） |
| `isProtectedMemoryPath(filePath, baseDir?)` | 检查路径是否为受保护的记忆路径 |

**`redactSensitiveInfo()` 两阶段脱敏**:

| 阶段 | 策略 | 覆盖模式 |
|------|------|----------|
| Phase 1 | 模式匹配 | SSH 私钥、API Key、AWS Key、数据库连接串、内网 IP、邮箱、.env 变量、信用卡号、中文手机号、身份证号、快递单号、门禁码、中文地址 |
| Phase 2 | 上下文匹配 | `keyword + connecting_word + value` — password/api_key/token/secret/ssn/pin/credit_card + is/are/=/:/ + 实际值 |

Phase 2 使用两种连接模式:
- **STRICT** — 需要动词 (is/are/was) 或分隔符 (=/:)，用于宽泛关键词如 "credit card"
- **LOOSE** — 也接受空格，用于凭证关键词如 "password"

---

## 6. 配置指南

### 最小配置

```json
{
  "plugins": { "enabled": ["guardclaw"] },
  "privacy": {
    "enabled": true
  }
}
```

使用默认值：localModelDetector + proxy 策略 + 端口 8403。

### 完整配置参考

```json
{
  "privacy": {
    "enabled": true,
    "s2Policy": "proxy",
    "proxyPort": 8403,

    "checkpoints": {
      "onUserMessage": ["localModelDetector"],
      "onToolCallProposed": ["localModelDetector"],
      "onToolCallExecuted": ["localModelDetector"]
    },

    "rules": {
      "keywords": {
        "S2": ["password", "api_key", "secret", "token"],
        "S3": ["ssh", "id_rsa", "private_key", ".pem", ".env"]
      },
      "patterns": {
        "S2": [
          "\\b(?:10|172\\.(?:1[6-9]|2\\d|3[01])|192\\.168)\\.\\d{1,3}\\.\\d{1,3}\\b",
          "(?:mysql|postgres|mongodb|redis)://[^\\s]+"
        ],
        "S3": [
          "-----BEGIN (?:RSA |EC )?PRIVATE KEY-----",
          "AKIA[0-9A-Z]{16}"
        ]
      },
      "tools": {
        "S2": { "tools": ["exec", "shell"], "paths": ["~/secrets"] },
        "S3": { "tools": ["sudo"], "paths": ["~/.ssh", "/etc", "~/.aws"] }
      }
    },

    "localModel": {
      "enabled": true,
      "type": "openai-compatible",
      "provider": "ollama",
      "model": "openbmb/minicpm4.1",
      "endpoint": "http://localhost:11434"
    },

    "guardAgent": {
      "id": "guard",
      "workspace": "~/.openclaw/workspace-guard",
      "model": "ollama/openbmb/minicpm4.1"
    },

    "localProviders": ["my-custom-inference"],

    "session": {
      "isolateGuardHistory": true,
      "baseDir": "~/.openclaw"
    },

    "routers": {
      "privacy": { "enabled": true, "type": "builtin", "weight": 80 },
      "token-saver": {
        "enabled": true,
        "type": "builtin",
        "weight": 30,
        "options": {
          "tiers": {
            "SIMPLE": { "provider": "openai", "model": "gpt-4o-mini" },
            "MEDIUM": { "provider": "openai", "model": "gpt-4o" },
            "COMPLEX": { "provider": "anthropic", "model": "claude-sonnet-4.6" },
            "REASONING": { "provider": "openai", "model": "o4-mini" }
          }
        }
      },
      "my-filter": {
        "enabled": true,
        "type": "custom",
        "module": "./my-routers/content-filter.js",
        "weight": 60,
        "options": { "maxLength": 5000 }
      }
    },

    "pipeline": {
      "onUserMessage": ["privacy", "token-saver", "my-filter"],
      "onToolCallProposed": ["privacy"],
      "onToolCallExecuted": ["privacy"]
    }
  }
}
```

### Edge Provider 配置示例

#### Ollama (OpenAI 兼容)

```json
{
  "localModel": {
    "enabled": true,
    "type": "openai-compatible",
    "provider": "ollama",
    "model": "llama3.2:3b",
    "endpoint": "http://localhost:11434"
  }
}
```

#### Ollama (原生 API)

```json
{
  "localModel": {
    "enabled": true,
    "type": "ollama-native",
    "provider": "ollama",
    "model": "qwen2.5:7b",
    "endpoint": "http://localhost:11434"
  }
}
```

#### vLLM

```json
{
  "localModel": {
    "enabled": true,
    "type": "openai-compatible",
    "provider": "vllm",
    "model": "Qwen/Qwen2.5-7B-Instruct",
    "endpoint": "http://localhost:8000"
  }
}
```

#### LMStudio

```json
{
  "localModel": {
    "enabled": true,
    "type": "openai-compatible",
    "provider": "lmstudio",
    "model": "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF",
    "endpoint": "http://localhost:1234"
  }
}
```

#### SGLang

```json
{
  "localModel": {
    "enabled": true,
    "type": "openai-compatible",
    "provider": "sglang",
    "model": "meta-llama/Meta-Llama-3.1-8B-Instruct",
    "endpoint": "http://localhost:30000"
  }
}
```

#### 自定义 Provider

```json
{
  "localModel": {
    "enabled": true,
    "type": "custom",
    "provider": "my-inference",
    "model": "my-model",
    "endpoint": "http://localhost:9999",
    "module": "./my-edge-provider.js"
  },
  "localProviders": ["my-inference"]
}
```

---

## 7. 开发指南

### 环境要求

- **Node.js**: >= 18（需要 `fetch` API 支持）
- **TypeScript**: ES module 项目（`"type": "module"`）
- **依赖**: `@sinclair/typebox` 0.34.x
- **本地推理**: 至少一个 Edge 推理后端（推荐 Ollama）

### 项目设置

```bash
# 安装依赖
cd guardclaw
npm install

# 运行测试
npx vitest run

# 单独运行特定测试
npx vitest run test/rules.test.ts
npx vitest run test/router-pipeline.test.ts
```

### 开发工作流

1. **修改源码** — 所有源码在 `src/` 目录
2. **运行测试** — `npx vitest run` 验证改动
3. **测试 Prompt** — 修改 `prompts/*.md` 文件无需改代码
4. **集成测试** — `test/integration.test.ts` 和 `test/guardclaw-plugin-e2e.test.ts`

### 添加新的检测维度

1. 在 `types.ts` 中扩展 `DetectorType` 联合类型
2. 在对应模块中实现检测函数（返回 `DetectionResult`）
3. 在 `detector.ts` 的 `runDetectors()` switch 中注册
4. 在 `config-schema.ts` 的 checkpoint 枚举中添加新类型

### 添加新的 Hook

1. 在 `hooks.ts` 的 `registerHooks()` 函数中添加 `api.on("hook_name", ...)` 
2. 遵循现有 Hook 的错误处理模式（try/catch + logger.error）
3. 需要跨 Hook 传递数据时使用 `session-state.ts` 的 stash/consume 机制

### 模块依赖关系

```
index.ts
  ├── config-schema.ts     (配置 Schema + 默认值)
  ├── hooks.ts             (10 个 Hook)
  │     ├── detector.ts    (检测引擎)
  │     │     ├── rules.ts        (规则检测器)
  │     │     └── local-model.ts  (LLM 检测器)
  │     ├── router-pipeline.ts    (路由管线)
  │     ├── guard-agent.ts        (Guard Agent)
  │     ├── session-state.ts      (会话状态)
  │     ├── session-manager.ts    (双轨历史)
  │     ├── memory-isolation.ts   (双轨记忆)
  │     ├── prompt-loader.ts      (Prompt 加载)
  │     └── privacy-proxy.ts      (标记常量)
  ├── provider.ts          (Provider 定义)
  ├── privacy-proxy.ts     (代理服务器)
  ├── router-pipeline.ts   (管线单例)
  └── routers/
        ├── privacy.ts     (隐私路由器)
        └── token-saver.ts (Token-Saver 路由器)
```

---

## 8. 自定义指南

### 8.1 自定义路由器

自定义路由器允许在 GuardClaw 管线中注入自定义逻辑（内容过滤、成本优化、A/B 测试等）。

#### 步骤 1: 实现 `GuardClawRouter` 接口

创建 `my-routers/content-filter.js`:

```typescript
import type { GuardClawRouter, DetectionContext, RouterDecision } from "@openclaw/guardclaw/src/types.js";

const contentFilterRouter: GuardClawRouter = {
  id: "content-filter",

  async detect(
    context: DetectionContext,
    pluginConfig: Record<string, unknown>,
  ): Promise<RouterDecision> {
    const message = context.message ?? "";
    
    // 获取路由器自身的配置 (来自 routers.content-filter.options)
    const privacy = pluginConfig?.privacy as Record<string, unknown>;
    const routers = privacy?.routers as Record<string, { options?: Record<string, unknown> }>;
    const options = routers?.["content-filter"]?.options ?? {};
    const maxLength = (options.maxLength as number) ?? 10000;
    
    // 自定义逻辑: 超长消息路由到更大上下文的模型
    if (message.length > maxLength) {
      return {
        level: "S1",
        action: "redirect",
        target: { provider: "anthropic", model: "claude-sonnet-4.6" },
        reason: `Message too long (${message.length} chars), using larger context model`,
        confidence: 0.9,
      };
    }

    return { level: "S1", action: "passthrough" };
  },
};

export default contentFilterRouter;
```

#### 步骤 2: 在配置中注册

```json
{
  "privacy": {
    "routers": {
      "content-filter": {
        "enabled": true,
        "type": "custom",
        "module": "./my-routers/content-filter.js",
        "weight": 40,
        "options": { "maxLength": 5000 }
      }
    },
    "pipeline": {
      "onUserMessage": ["privacy", "content-filter"]
    }
  }
}
```

#### 路由器设计原则

| 原则 | 说明 |
|------|------|
| **权重语义** | 安全类路由器（privacy）使用高权重 (60-100)；优化类路由器使用低权重 (10-40) |
| **快慢分类** | weight ≥ 50 为快速路由器（Phase 1 并行），< 50 为慢速路由器（Phase 2 按需） |
| **Action 语义** | `passthrough` = 不干预; `redirect` = 转向其他模型; `transform` = 修改内容; `block` = 阻止 |
| **Level 语义** | 在非安全路由器中通常返回 `S1`，除非有独立的安全理由需要升级等级 |
| **错误处理** | 路由器异常不会阻塞管线，仅记录错误日志并跳过 |

---

### 8.2 自定义边缘推理 Provider

当内置的 `openai-compatible` 和 `ollama-native` 协议无法满足需求时，可实现自定义 Provider。

#### 步骤 1: 实现 `CustomEdgeProvider` 接口

创建 `my-edge-provider.js`:

```typescript
import type { ChatMessage, ChatCompletionOptions } from "@openclaw/guardclaw/src/local-model.js";

export async function callChat(
  endpoint: string,
  model: string,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<string> {
  // 自定义 API 调用逻辑
  const response = await fetch(`${endpoint}/my-api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options?.apiKey ? { "X-API-Key": options.apiKey } : {}),
    },
    body: JSON.stringify({
      model,
      prompt: messages.map(m => `${m.role}: ${m.content}`).join("\n"),
      max_tokens: options?.maxTokens ?? 800,
      temperature: options?.temperature ?? 0.1,
    }),
  });

  if (!response.ok) {
    throw new Error(`Custom provider error: ${response.status}`);
  }

  const data = await response.json() as { output: string };
  return data.output;
}
```

#### 步骤 2: 配置使用

```json
{
  "privacy": {
    "localModel": {
      "enabled": true,
      "type": "custom",
      "provider": "my-inference",
      "model": "my-model",
      "endpoint": "http://localhost:9999",
      "module": "./my-edge-provider.js"
    },
    "localProviders": ["my-inference"]
  }
}
```

> **注意**: `localProviders` 数组用于声明哪些 Provider 名称是本地的（安全的），允许 Guard Agent 使用。

---

### 8.3 自定义 Prompt 模板

GuardClaw 的 Prompt 模板可以通过编辑 `prompts/` 目录下的 Markdown 文件进行自定义，无需修改代码。

#### 可自定义的 Prompt

| 文件 | 用途 | 变量 |
|------|------|------|
| `prompts/guard-agent-system.md` | Guard Agent 系统 Prompt | 无 |
| `prompts/token-saver-judge.md` | Token-Saver 复杂度分类 Prompt | 无 |
| `prompts/detection-system.md` | 灵敏度检测系统 Prompt | 无 |
| `prompts/pii-extraction.md` | PII 提取 Prompt | `{{CONTENT}}` |

#### 示例: 自定义检测 Prompt

创建 `prompts/detection-system.md`:

```markdown
[SYSTEM] You are a strict privacy classifier for our enterprise system.
Output ONLY a single JSON object.

Our classification criteria:
S3 = PRIVATE: financial records, medical data, HR data, all credentials
S2 = SENSITIVE: personal contact info, addresses, tracking numbers
S1 = SAFE: everything else

Industry-specific rules:
- Any mention of HIPAA-covered data → S3
- Customer support ticket content → S2
- Internal API documentation → S1

Output: {"level":"S1|S2|S3","reason":"brief explanation"}
```

#### 示例: 自定义 PII 提取 Prompt

创建 `prompts/pii-extraction.md`:

```markdown
Extract ALL personally identifiable information from the following text.

Text: {{CONTENT}}

Output a JSON array of objects with "type" and "value" fields.
Supported types: NAME, PHONE, ADDRESS, EMAIL, ID, CARD, SECRET, 
EMPLOYEE_ID, DEPARTMENT, SALARY_GRADE

Output ONLY the JSON array.
```

---

### 8.4 自定义检测规则

#### 添加关键词

```json
{
  "rules": {
    "keywords": {
      "S2": ["employee_id", "department", "内部编号"],
      "S3": ["salary_grade", "performance_review", "绩效评分"]
    }
  }
}
```

#### 添加正则模式

```json
{
  "rules": {
    "patterns": {
      "S2": [
        "EMP-\\d{6}",
        "\\b[A-Z]{2}-\\d{4}-\\d{4}\\b"
      ],
      "S3": [
        "GRADE-[A-E]\\d{2}",
        "PERF-\\d{4}-[A-Z]+"
      ]
    }
  }
}
```

#### 添加工具规则

```json
{
  "rules": {
    "tools": {
      "S2": {
        "tools": ["database_query", "crm_lookup"],
        "paths": ["~/company-data/employees"]
      },
      "S3": {
        "tools": ["hr_system", "payroll_api"],
        "paths": ["~/company-data/hr", "~/company-data/payroll"]
      }
    }
  }
}
```

#### 组合双检测器

默认仅使用 `localModelDetector`。若需要叠加规则检测器作为额外安全层:

```json
{
  "checkpoints": {
    "onUserMessage": ["ruleDetector", "localModelDetector"],
    "onToolCallProposed": ["ruleDetector"],
    "onToolCallExecuted": ["ruleDetector"]
  }
}
```

两个检测器的结果会自动合并（取最高等级）。

---

## 9. 测试

### 测试文件

| 文件 | 覆盖范围 |
|------|----------|
| `test/rules.test.ts` | 规则检测器 — 关键词、正则、工具类型、路径 |
| `test/detector.test.ts` | 检测引擎 — 检测器协调与结果合并 |
| `test/session-manager.test.ts` | 双轨会话历史 — 持久化、加载、过滤 |
| `test/token-saver.test.ts` | Token-Saver — 复杂度分类、缓存、配置解析 |
| `test/privacy-proxy.test.ts` | 隐私代理 — PII 标记剥离、请求转发 |
| `test/router-pipeline.test.ts` | 路由管线 — 注册、执行、加权合并、短路 |
| `test/integration.test.ts` | 集成测试 — 端到端检测流程 |
| `test/guardclaw-plugin-e2e.test.ts` | 插件 E2E — 完整注册与 Hook 触发 |

### 运行测试

```bash
# 全部测试
npx vitest run

# 单文件
npx vitest run test/rules.test.ts

# 监视模式
npx vitest --watch

# 覆盖率
npx vitest run --coverage
```

---

## 10. 安全模型与威胁分析

### 信任边界

```
┌─────────────────────────────────┐
│         信任边界: 本地           │
│                                 │
│  ● Edge Model (Ollama/vLLM)    │
│  ● Guard Agent                 │
│  ● MEMORY-FULL.md              │
│  ● sessions/full/              │
│  ● Privacy Proxy               │
│                                 │
├─────────────────────────────────┤
│         信任边界: 云端           │
│                                 │
│  ● Cloud Model (GPT-4/Claude)  │
│  ● MEMORY.md (脱敏后)          │
│  ● sessions/clean/             │
│                                 │
└─────────────────────────────────┘
```

### 防护机制

| 威胁 | 防护 |
|------|------|
| 云端模型读取私密文件 | `before_tool_call` Hook 阻止访问 `sessions/full/`、`MEMORY-FULL.md` |
| S2 数据泄露到云端 | Privacy Proxy 在转发前剥离 PII 标记 |
| S3 数据意外上云 | 路由到本地模型 + `before_message_write` 写入占位符 |
| 子代理传递敏感数据 | `before_tool_call` 拦截 `sessions_spawn/send` |
| 出站消息泄露 PII | `message_sending` Hook 检测并脱敏/取消 |
| 文件重复读取绕过脱敏 | `isFilePreRead()` 阻止对已脱敏文件的重复读取 |
| Guard 历史污染云端记忆 | 双轨记忆 + 会话结束时同步过滤 |
| 会话隐私降级 | 一旦标记为 private 不自动降级（需显式调用 `resetSessionPrivacy`） |

### 已知限制

1. **LLM 检测器准确性**: 依赖本地模型的分类能力，小模型在复杂场景可能误判
2. **脱敏完整性**: PII 提取依赖 LLM 输出，可能遗漏非标准格式的 PII
3. **内存存储**: 会话状态存储在进程内存中，重启后丢失
4. **单节点**: 隐私代理运行在单节点上，不支持分布式部署
5. **文件预读**: 仅支持 `.xlsx/.xls/.csv/.txt/.docx/.json/.md` 格式
