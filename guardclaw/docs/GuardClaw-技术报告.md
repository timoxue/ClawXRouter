# GuardClaw 技术报告

> 版本: 2026.3.0 | 生成日期: 2026-03-09

---

## 目录

1. [项目概览](#1-项目概览)
2. [系统架构](#2-系统架构)
3. [设计模式分析](#3-设计模式分析)
4. [核心模块详解](#4-核心模块详解)
5. [数据流与处理链路](#5-数据流与处理链路)
6. [配置体系](#6-配置体系)
7. [开发指南](#7-开发指南)
8. [测试策略](#8-测试策略)
9. [现有不足与改进建议](#9-现有不足与改进建议)
10. [路线图建议](#10-路线图建议)

---

## 1. 项目概览

### 1.1 定位

GuardClaw 是 OpenClaw AI 编程代理平台的**隐私保护扩展插件**。它作为一个安全层嵌入在 Agent 与 LLM 之间，在不影响用户体验的前提下，实时检测、分级、路由和脱敏敏感数据，确保私密信息不会泄露至云端模型。

### 1.2 核心能力

| 能力 | 描述 |
|------|------|
| **三级敏感度分类** | S1（安全）、S2（敏感，需脱敏）、S3（私密，仅本地处理） |
| **双引擎检测** | 规则引擎 + 本地 LLM 判别器，可组合配置 |
| **可组合路由管道** | Pipeline 架构支持内置路由器 + 用户自定义路由器 |
| **隐私代理** | 本地 HTTP 代理，拦截 S2 请求并剥离 PII 标记后转发 |
| **Guard Agent** | S3 内容全部路由至本地模型的守护子代理 |
| **双轨会话管理** | full（完整历史）+ clean（脱敏历史）双轨持久化 |
| **记忆隔离** | MEMORY-FULL.md 与 MEMORY.md 分离，云模型永远只看到干净版本 |
| **Token 节省路由** | LLM-as-Judge 任务复杂度分级，自动路由到最经济的模型 |

### 1.3 技术栈

- **语言**: TypeScript (ESM)
- **运行时**: Node.js
- **LLM 后端**: OpenAI-compatible API（Ollama、vLLM、LiteLLM 等）
- **配置校验**: @sinclair/typebox
- **测试框架**: Vitest
- **代理服务**: Node.js `http` 模块

### 1.4 文件结构

```
guardclaw/
├── index.ts                    # 插件入口，五步注册流程
├── package.json
├── openclaw.plugin.json        # 插件元数据 + 配置 JSON Schema
├── config.example.json         # 示例配置
├── tsconfig.json
├── prompts/                    # 可编辑的 prompt 模板
│   ├── guard-agent-system.md
│   └── token-saver-judge.md
├── src/
│   ├── types.ts                # 核心类型定义
│   ├── config-schema.ts        # TypeBox 配置 schema + 默认值
│   ├── detector.ts             # 检测引擎协调器
│   ├── rules.ts                # 规则检测器（关键词、正则、工具、路径）
│   ├── local-model.ts          # 本地 LLM 检测器 + 脱敏器
│   ├── hooks.ts                # 10 个 OpenClaw 钩子注册
│   ├── router-pipeline.ts      # 可组合路由管道
│   ├── routers/
│   │   ├── privacy.ts          # 内置隐私路由器
│   │   └── token-saver.ts      # 内置 Token 节省路由器
│   ├── privacy-proxy.ts        # HTTP 隐私代理
│   ├── provider.ts             # guardclaw-privacy 提供者注册
│   ├── guard-agent.ts          # Guard Agent 配置管理
│   ├── session-manager.ts      # 双轨会话管理器
│   ├── session-state.ts        # 运行时会话状态（内存态）
│   ├── memory-isolation.ts     # 记忆文件隔离管理
│   ├── prompt-loader.ts        # Prompt 模板加载器
│   └── utils.ts                # 工具函数（路径匹配、PII 规则脱敏）
└── test/
    ├── detector.test.ts
    ├── rules.test.ts
    ├── privacy-proxy.test.ts
    ├── session-manager.test.ts
    ├── token-saver.test.ts
    ├── integration.test.ts
    └── router-pipeline.test.ts
```

---

## 2. 系统架构

### 2.1 高层架构图

```
                    ┌──────────────────────────────────────────────┐
                    │              OpenClaw Agent Runtime           │
                    │                                              │
  User Message ──►  │  ┌─── Hook 1: before_model_resolve ───────┐  │
                    │  │                                         │  │
                    │  │   RouterPipeline.run("onUserMessage")   │  │
                    │  │         ┌──────────┐ ┌──────────┐       │  │
                    │  │         │ Privacy  │ │ Token    │ ...   │  │
                    │  │         │ Router   │ │ Saver    │       │  │
                    │  │         └────┬─────┘ └────┬─────┘       │  │
                    │  │              │             │             │  │
                    │  │         mergeDecisions()                 │  │
                    │  │              │                           │  │
                    │  │    ┌────────┼────────┬───────────┐      │  │
                    │  │    ▼        ▼        ▼           ▼      │  │
                    │  │   S1      S2/proxy  S2/local    S3      │  │
                    │  │ (pass)  (privacy   (local     (guard    │  │
                    │  │          proxy)     model)     agent)   │  │
                    │  └─────────────────────────────────────────┘  │
                    │                                              │
                    │  ┌─── Hook 2: before_prompt_build ─────────┐  │
                    │  │  Inject guard prompt / S2 markers       │  │
                    │  └─────────────────────────────────────────┘  │
                    │                                              │
                    │  ┌─── Hook 3-4: tool call guards ──────────┐  │
                    │  │  Pipeline check → block / desensitize   │  │
                    │  └─────────────────────────────────────────┘  │
                    │                                              │
                    │  ┌─── Hook 5-6: persistence ───────────────┐  │
                    │  │  Dual history write + transcript sanitize│  │
                    │  └─────────────────────────────────────────┘  │
                    │                                              │
                    │  ┌─── Hook 7: session_end ─────────────────┐  │
                    │  │  Memory sync: FULL → CLEAN (redact PII) │  │
                    │  └─────────────────────────────────────────┘  │
                    └──────────────────────────────────────────────┘
```

### 2.2 S2 隐私代理流程

```
Agent ──► guardclaw-privacy provider ──► localhost:8403 (Privacy Proxy)
                                              │
                                         Strip <guardclaw-s2> markers
                                              │
                                         Forward clean request ──► Cloud LLM (OpenAI / Anthropic)
                                              │
                                         Stream/buffer response ◄── Cloud LLM
                                              │
                                         Return to Agent ◄──
```

### 2.3 双轨历史模型

```
┌─────────────────────────┐     ┌──────────────────────────┐
│      MEMORY-FULL.md     │     │       MEMORY.md          │
│   (本地模型可见)          │     │   (云模型可见)             │
│                         │     │                          │
│ - 所有消息              │ ──► │ - 过滤 Guard Agent 内容    │
│ - Guard Agent 交互      │sync │ - PII 已脱敏              │
│ - 完整 PII 数据         │     │ - [REDACTED:xxx] 标记     │
└─────────────────────────┘     └──────────────────────────┘

sessions/full/*.jsonl  ←→  sessions/clean/*.jsonl
memory-full/*.md       ←→  memory/*.md
```

---

## 3. 设计模式分析

### 3.1 管道与过滤器模式 (Pipeline & Filters)

**应用位置**: `RouterPipeline` 类

这是 GuardClaw 最核心的架构模式。`RouterPipeline` 实现了一个可组合的路由管道，每个路由器（Router）作为一个独立的过滤器：

```typescript
// 多个路由器按序执行，决策合并
const decision = await pipeline.run("onUserMessage", context, config);
```

**特点**:
- 每个路由器实现 `GuardClawRouter` 接口，仅需提供 `id` 和 `detect()` 方法
- 管道按配置顺序依次执行所有路由器
- 决策合并策略：最高敏感度级别胜出；同级别下 block > redirect > transform > passthrough
- 单个路由器异常不影响其他路由器（容错隔离）

**优势**: 高度可扩展，用户可通过配置注册自定义路由器（如成本优化、内容过滤等），无需修改核心代码。

### 3.2 策略模式 (Strategy Pattern)

**应用位置**: 检测器分发 (`detector.ts`)

检测引擎支持两种可替换的检测策略——`ruleDetector` 和 `localModelDetector`——通过配置在不同 checkpoint 自由组合：

```typescript
// 配置驱动的策略选择
checkpoints: {
  onUserMessage: ["ruleDetector", "localModelDetector"],
  onToolCallProposed: ["ruleDetector"],
}
```

每个检测器实现独立的检测逻辑，但共享相同的输入/输出接口 (`DetectionContext` → `DetectionResult`)。`runDetectors()` 函数依次执行配置的检测器并合并结果。

### 3.3 代理模式 (Proxy Pattern)

**应用位置**: `privacy-proxy.ts` + `provider.ts`

隐私代理是经典代理模式的应用：

1. **`guardclaw-privacy` Provider** 注册为虚拟提供者，镜像所有已配置模型
2. **本地 HTTP 代理** 拦截请求，剥离 `<guardclaw-s2>` 标记后转发至真实 Provider
3. 对调用者完全透明——Agent 以为在与 "guardclaw-privacy" 通信，实际数据已被清洗

```
Agent → guardclaw-privacy → Privacy Proxy → 剥离 PII → OpenAI/Anthropic
```

### 3.4 观察者模式 (Observer / Hook Pattern)

**应用位置**: `hooks.ts`

通过 OpenClaw 的 `api.on(event, handler)` 钩子机制，GuardClaw 注册了 10 个事件监听器：

| 钩子 | 触发时机 | 职责 |
|------|---------|------|
| `before_model_resolve` | 模型选择前 | 管道检测 + 模型路由 |
| `before_prompt_build` | Prompt 构建前 | 注入守护 prompt / S2 标记 |
| `before_tool_call` | 工具调用前 | 管道检测 + 阻断/脱敏 |
| `after_tool_call` | 工具调用后 | 结果检测 + 会话标记 |
| `tool_result_persist` | 工具结果持久化 | 双轨历史写入 |
| `before_message_write` | 消息写入前 | 会话转录脱敏 |
| `session_end` | 会话结束 | 记忆同步 |
| `message_sending` | 消息外发 | 出站消息守卫 |
| `before_agent_start` | 子代理启动前 | 子代理内容守卫 |
| `message_received` | 消息接收 | 观测日志 |

这实现了**面向切面 (AOP)** 的安全增强——业务逻辑不受影响，安全检测作为横切关注点植入。

### 3.5 单例模式 (Singleton)

**应用位置**: 多个管理器

以下组件使用了模块级单例：

- `RouterPipeline` — `globalPipeline` (via `setGlobalPipeline` / `getGlobalPipeline`)
- `DualSessionManager` — `defaultManager` (via `getDefaultSessionManager`)
- `MemoryIsolationManager` — `defaultMemoryManager` (via `getDefaultMemoryManager`)
- Prompt 缓存 — `cache` Map in `prompt-loader.ts`

单例确保全局状态一致性，避免多实例间的状态竞争。

### 3.6 模板方法模式 (Template Method)

**应用位置**: `GuardClawRouter` 接口

路由器接口定义了检测的骨架结构（`detect(context, config) → RouterDecision`），具体策略由各实现填充：

- `privacyRouter`: 封装 S1/S2/S3 敏感度检测
- `tokenSaverRouter`: 封装 LLM-as-Judge 任务复杂度分级

新路由器只需实现 `detect()` 方法，管道负责编排和合并。

### 3.7 装饰器模式 (Decorator)

**应用位置**: `before_prompt_build` 钩子

在不修改原始 prompt 的情况下，GuardClaw 以装饰方式添加额外内容：

- S3: `prependSystemContext` 注入守护 Agent 系统提示
- S2-proxy: `prependContext` 注入 `<guardclaw-s2>` 包裹的脱敏内容 + `appendSystemContext` 注入隐私指令

### 3.8 暂存器模式 (Stash Pattern)

**应用位置**: `session-state.ts` 中的 `PendingDetection`

由于 OpenClaw 钩子是独立注册的（`before_model_resolve` 和 `before_prompt_build` 分开触发），需要在钩子间传递检测结果：

```typescript
stashDetection(sessionKey, { level, reason, desensitized, ... });
// ... 下一个钩子中 ...
const pending = getPendingDetection(sessionKey);
consumeDetection(sessionKey); // 一次性消费
```

这是一种受控的共享状态模式，通过 `consume` 语义防止过期数据误用。

### 3.9 配置优先模式 (Configuration-Driven)

整个插件的行为高度可配置化：

- 检测器组合由 `checkpoints` 配置驱动
- 路由管道顺序由 `pipeline` 配置驱动
- 关键词/正则/工具规则由 `rules` 配置驱动
- 自定义路由器通过 `routers[id].module` 动态加载
- Prompt 通过 `prompts/*.md` 文件可编辑

零代码修改即可调整系统行为。

---

## 4. 核心模块详解

### 4.1 检测引擎 (`detector.ts`)

**职责**: 协调多个检测器，合并结果。

**流程**:
1. 根据 checkpoint 类型从配置获取检测器列表
2. 依次运行每个检测器
3. 取最高敏感度级别作为最终结果
4. 合并所有非 S1 结果的原因和置信度

**关键设计**:
- 检测器失败不中断流程（catch + continue）
- 空检测器列表回退到 `localModelDetector`
- 配置使用深度合并（用户配置覆盖默认值）

### 4.2 规则检测器 (`rules.ts`)

**职责**: 基于静态规则的快速检测。

**五层检测**:
1. **关键词匹配** — S2/S3 关键词在消息中的大小写无关匹配
2. **正则模式** — 编译缓存的 RegExp 匹配（内网 IP、数据库连接串、API Key 等）
3. **工具类型** — 工具名称与 S2/S3 工具列表匹配
4. **工具参数路径** — 参数中的文件路径与保护路径匹配 + 敏感扩展名检测
5. **工具结果扫描** — 对工具返回内容执行关键词 + 正则检查

**性能优化**: 正则编译结果缓存在 `patternCache` Map 中，避免重复编译。

### 4.3 本地 LLM 检测器 (`local-model.ts`)

**职责**: 基于语义的智能检测 + PII 脱敏。

**检测流程**:
1. 使用系统级分类 prompt 发送至本地模型
2. 解析 JSON 响应 `{"level":"S1|S2|S3","reason":"..."}`
3. 对文件内容执行 `quickPiiScan` 安全网检查（防止 LLM 漏判）

**脱敏流程**（两步法）:
1. **PII 提取**: 请求本地模型输出 PII 项的 JSON 数组 `[{"type":"NAME","value":"张三"}, ...]`
2. **程序化替换**: 按值长度降序替换，映射为 `[REDACTED:xxx]` 标记

**兼容性处理**:
- 剥离 `<think>...</think>` 推理标签（MiniCPM、Qwen3 等模型）
- Qwen3 自动添加 `/no_think` 前缀
- 修复 Python 风格单引号 JSON
- 支持不完整 JSON 修复（缺少 `]`、尾逗号等）

### 4.4 路由管道 (`router-pipeline.ts`)

**职责**: 可组合的多路由器编排引擎。

**核心 API**:
- `register(router, registration)` — 注册路由器
- `configure({ routers, pipeline })` — 配置管道顺序
- `loadCustomRouters()` — 异步动态加载自定义路由器模块
- `run(checkpoint, context, config)` — 执行管道并合并决策

**决策合并算法** (`mergeDecisions`):
1. 所有路由器的决策按级别排序
2. 最高 `SensitivityLevel` 胜出（S3 > S2 > S1）
3. 同级别按 action 优先级排序：block(4) > redirect(3) > transform(2) > passthrough(1)
4. 原因字符串从所有非 S1 决策拼接
5. 置信度取平均值

### 4.5 隐私代理 (`privacy-proxy.ts`)

**职责**: 本地 HTTP 代理，在 S2 流程中剥离 PII 标记。

**标记协议**:
```
<guardclaw-s2>
  脱敏后的内容（含 [REDACTED:xxx] 标记）
</guardclaw-s2>
原始敏感内容（不会发送至云端）
```

**代理处理流程**:
1. 读取请求体 JSON
2. 扫描 `messages[]` 中的 `<guardclaw-s2>` 标记
3. 提取标记内的脱敏内容，丢弃标记外的原始内容
4. 解析 `x-guardclaw-session` header 获取原始 Provider 目标
5. 转发清洗后的请求至真实 LLM API
6. 流式或缓冲透传响应

### 4.6 Guard Agent (`guard-agent.ts`)

**职责**: S3 内容的本地守护代理配置管理。

**关键功能**:
- 从 `"ollama/openbmb/minicpm4.1"` 格式解析 `provider` + `modelName`
- 生成守护子会话 Key：`{parentSessionKey}:guard`
- 验证 provider 是否为本地类型（`ollama`、`llama.cpp`、`localai`、`llamafile`、`lmstudio`）
- 生成主会话占位符消息：`🔒 [Private content — processed locally]`

### 4.7 会话管理 (`session-manager.ts` + `session-state.ts`)

**双轨持久化** (`DualSessionManager`):
- 普通消息 → 写入 `full/` + `clean/` 两个目录
- Guard Agent 消息 → 仅写入 `full/`
- 云模型加载 → 读取 `clean/`；本地模型加载 → 读取 `full/`
- 存储格式：JSONL（每行一条消息）

**运行时状态** (`session-state.ts`):
- `sessionStates` Map: 跟踪每个会话的隐私状态（一旦标记为 private，不可降级）
- `preReadFiles` Map: 跟踪已预读的文件路径（防止云模型二次读取原始文件）
- `pendingDetections` Map: 钩子间传递检测结果的暂存器
- 检测历史上限 50 条，防止内存膨胀

### 4.8 记忆隔离 (`memory-isolation.ts`)

**职责**: 管理 MEMORY-FULL.md 与 MEMORY.md 的同步。

**同步流程**:
1. **Merge**: 将 MEMORY.md（云模型写入）的新行合并至 MEMORY-FULL.md
2. **Filter**: 从 MEMORY-FULL.md 中过滤 Guard Agent 相关段落
3. **Redact**: PII 脱敏（优先本地模型，降级至规则脱敏）
4. **Write**: 写入清洗后的 MEMORY.md

支持长期记忆（MEMORY.md / MEMORY-FULL.md）和每日记忆（`memory/YYYY-MM-DD.md`）两种模式。

### 4.9 Token 节省路由器 (`routers/token-saver.ts`)

**职责**: LLM-as-Judge 任务复杂度分级，路由到最经济的模型。

**四级分类**:
| 级别 | 描述 | 默认模型 |
|------|------|---------|
| SIMPLE | 查询、翻译、格式化 | gpt-4o-mini |
| MEDIUM | 代码生成、数据分析 | gpt-4o |
| COMPLEX | 架构设计、多文件重构 | claude-sonnet-4.6 |
| REASONING | 数学证明、形式逻辑 | o4-mini |

**优化设计**:
- Prompt 哈希缓存（SHA-256 前 16 位，TTL 5 分钟）
- 子代理会话直接跳过（避免每条消息都调用 Judge）
- 完整 Prompt 转发给 Judge（不截断，确保分类准确性）
- Judge 失败时 passthrough（不阻塞请求）
- 定时清理过期缓存（每 60 秒，`unref()` 避免阻止进程退出）

### 4.10 Prompt 加载器 (`prompt-loader.ts`)

**职责**: 运行时加载可编辑的 Prompt 模板。

用户可以编辑 `prompts/*.md` 文件来自定义：
- 检测标准 (`detection-system.md`)
- Guard Agent 行为 (`guard-agent-system.md`)
- PII 提取规则 (`pii-extraction.md`)
- Token Saver Judge (`token-saver-judge.md`)

**特点**:
- 内存缓存（每个进程生命周期只读一次）
- 找不到文件时回退到硬编码默认值
- 支持 `{{PLACEHOLDER}}` 变量替换
- 自动适配 `src/` 和 `dist/src/` 两种目录结构

---

## 5. 数据流与处理链路

### 5.1 用户消息处理 (S2 Proxy 路径)

```
1. 用户发送消息: "分析我的工资单 payslip.xlsx"
   │
2. Hook: before_model_resolve
   │  ├─ 预读文件内容 (tryReadReferencedFile)
   │  ├─ RouterPipeline.run("onUserMessage")
   │  │   └─ privacyRouter.detect()
   │  │       └─ detectSensitivityLevel() → S2 (salary data)
   │  ├─ desensitizeWithLocalModel(fileContent)
   │  │   └─ extractPiiWithModel() → [{type:"NAME",value:"张三"}, {type:"SALARY",value:"50000"}]
   │  │   └─ 替换: "张三" → [REDACTED:NAME], "50000" → [REDACTED:SALARY]
   │  ├─ stashDetection(sessionKey, { level:"S2", desensitized, preReadFileContent })
   │  ├─ stashOriginalProvider(sessionKey, { baseUrl, apiKey })
   │  └─ return { providerOverride: "guardclaw-privacy" }
   │
3. Hook: before_prompt_build
   │  ├─ getPendingDetection(sessionKey)
   │  └─ return {
   │      prependContext: "<guardclaw-s2>\n脱敏内容\n</guardclaw-s2>",
   │      appendSystemContext: PRIVACY_S2_SYSTEM_INSTRUCTION
   │    }
   │
4. Agent → guardclaw-privacy provider → localhost:8403
   │  ├─ stripPiiMarkers(messages) → 提取脱敏内容，丢弃原始内容
   │  ├─ resolveTarget(sessionKey) → 获取原始 Provider (OpenAI)
   │  └─ Forward clean request → OpenAI API → Stream response back
   │
5. Hook: before_message_write
   │  └─ 将用户消息替换为脱敏版本（写入会话历史）
   │
6. Agent 返回分析结果给用户
```

### 5.2 用户消息处理 (S3 Guard Agent 路径)

```
1. 用户发送消息: "检查我的密码强度: abc123"
   │
2. Hook: before_model_resolve
   │  ├─ RouterPipeline.run("onUserMessage") → S3
   │  ├─ markSessionAsPrivate(sessionKey, "S3")
   │  └─ return { providerOverride: "ollama", modelOverride: "openbmb/minicpm4.1" }
   │
3. Hook: before_prompt_build
   │  └─ return { prependSystemContext: guardAgentSystemPrompt }
   │
4. 本地模型直接处理 → 响应不经过任何云端
   │
5. Hook: before_message_write
   │  └─ 用户消息替换为: "🔒 [Private content — processed locally]"
   │
6. 用户看到分析结果，会话历史中不含原始密码
```

### 5.3 工具调用守卫流程

```
1. LLM 提议调用工具: read_file(path="~/.ssh/id_rsa")
   │
2. Hook: before_tool_call
   │  ├─ 检查保护路径: isProtectedMemoryPath() → false
   │  ├─ 检查预读文件: isFilePreRead() → false
   │  ├─ RouterPipeline.run("onToolCallProposed")
   │  │   └─ S3 detected (path matches ~/.ssh)
   │  ├─ markSessionAsPrivate(sessionKey, "S3")
   │  └─ return { block: true, blockReason: "..." }
   │
3. 工具调用被阻断，Agent 收到阻断原因
```

---

## 6. 配置体系

### 6.1 配置层级

```
默认值 (defaultPrivacyConfig)
  ↓ 深度合并
用户配置 (config.json → privacy)
  ↓ 深度合并
运行时覆盖 (hooks 中的动态调整)
```

### 6.2 关键配置项

| 配置路径 | 类型 | 默认值 | 说明 |
|---------|------|--------|------|
| `privacy.enabled` | boolean | `true` | 启用/禁用整个插件 |
| `privacy.s2Policy` | `"proxy" \| "local"` | `"proxy"` | S2 处理策略 |
| `privacy.proxyPort` | number | `8403` | 代理端口 |
| `privacy.checkpoints.*` | string[] | `["localModelDetector"]` | 各 checkpoint 的检测器列表 |
| `privacy.rules.keywords.S2/S3` | string[] | `[]` | 敏感关键词 |
| `privacy.rules.patterns.S2/S3` | string[] | `[]` | 敏感正则 |
| `privacy.rules.tools.S2/S3` | object | `{}` | 敏感工具和路径 |
| `privacy.localModel.enabled` | boolean | `true` | 启用本地模型检测 |
| `privacy.localModel.model` | string | `"openbmb/minicpm4.1"` | 本地模型名称 |
| `privacy.localModel.endpoint` | string | `"http://localhost:11434"` | 模型端点 |
| `privacy.guardAgent.id` | string | `"guard"` | Guard Agent ID |
| `privacy.guardAgent.model` | string | `"ollama/openbmb/minicpm4.1"` | Guard Agent 模型 |
| `privacy.session.isolateGuardHistory` | boolean | `true` | 隔离 Guard 历史 |
| `privacy.routers.*` | object | — | 路由器注册和配置 |
| `privacy.pipeline.*` | string[] | `["privacy"]` | 各 checkpoint 的路由器执行顺序 |

### 6.3 配置校验

使用 `@sinclair/typebox` 进行类型安全的 schema 校验，同时在 `openclaw.plugin.json` 中提供 JSON Schema 供编辑器验证。两者同步定义。

---

## 7. 开发指南

### 7.1 添加新的检测规则

**方式 1: 通过配置添加**

编辑 `config.json` 的 `privacy.rules`:

```json
{
  "privacy": {
    "rules": {
      "keywords": {
        "S2": ["employee_id", "工号"],
        "S3": ["master_password", "root_password"]
      },
      "patterns": {
        "S2": ["\\b\\d{3}-\\d{2}-\\d{4}\\b"]
      },
      "tools": {
        "S3": {
          "tools": ["dangerous_tool"],
          "paths": ["/sensitive/data"]
        }
      }
    }
  }
}
```

**方式 2: 修改规则引擎**

编辑 `src/rules.ts`，在 `checkToolParams()` 等函数中添加新的检测逻辑。

### 7.2 开发自定义路由器

1. 创建路由器模块文件:

```typescript
// my-custom-router.ts
import type { GuardClawRouter, DetectionContext, RouterDecision } from "../types.js";

export default {
  id: "my-router",
  async detect(context: DetectionContext, config: Record<string, unknown>): Promise<RouterDecision> {
    // 自定义检测逻辑
    if (someCondition(context)) {
      return {
        level: "S2",
        action: "redirect",
        target: { provider: "openai", model: "gpt-4o-mini" },
        reason: "Custom routing logic",
      };
    }
    return { level: "S1", action: "passthrough" };
  },
} satisfies GuardClawRouter;
```

2. 在配置中注册:

```json
{
  "privacy": {
    "routers": {
      "my-router": {
        "enabled": true,
        "type": "custom",
        "module": "./path/to/my-custom-router.js",
        "options": { "customOption": "value" }
      }
    },
    "pipeline": {
      "onUserMessage": ["privacy", "my-router"]
    }
  }
}
```

### 7.3 自定义 Prompt 模板

在 `prompts/` 目录下创建或编辑 `.md` 文件：

- `prompts/detection-system.md` — 覆盖默认的敏感度分类 prompt
- `prompts/guard-agent-system.md` — 自定义 Guard Agent 行为
- `prompts/pii-extraction.md` — 自定义 PII 提取 prompt
- `prompts/token-saver-judge.md` — 自定义任务复杂度分类 prompt

支持 `{{PLACEHOLDER}}` 变量替换。文件不存在时自动回退至代码内硬编码默认值。

### 7.4 添加新的 Hook

在 `src/hooks.ts` 的 `registerHooks()` 函数中添加:

```typescript
api.on("new_event_name", async (event, ctx) => {
  try {
    const pipeline = getGlobalPipeline();
    if (!pipeline) return;
    
    const decision = await pipeline.run(
      "onUserMessage",
      { checkpoint: "onUserMessage", message: event.content, sessionKey: ctx.sessionKey },
      api.pluginConfig ?? {},
    );
    
    // 根据 decision 执行操作
  } catch (err) {
    api.logger.error(`[GuardClaw] Error in new_event hook: ${String(err)}`);
  }
});
```

### 7.5 本地开发环境搭建

```bash
# 1. 确保 Ollama 运行并拉取模型
ollama pull openbmb/minicpm4.1

# 2. 安装依赖（workspace 模式）
pnpm install

# 3. 运行测试
pnpm vitest run --filter guardclaw

# 4. 监听模式开发
pnpm vitest watch --filter guardclaw
```

### 7.6 模块依赖关系

```
index.ts (入口)
  ├── config-schema.ts
  ├── hooks.ts ──────────── ★ 最核心，连接所有模块
  │     ├── detector.ts
  │     │     ├── rules.ts ──── utils.ts
  │     │     └── local-model.ts ──── prompt-loader.ts
  │     ├── router-pipeline.ts
  │     │     └── types.ts
  │     ├── guard-agent.ts
  │     ├── session-manager.ts
  │     ├── session-state.ts
  │     ├── memory-isolation.ts ──── local-model.ts, utils.ts
  │     └── privacy-proxy.ts
  ├── provider.ts
  ├── routers/
  │     ├── privacy.ts ──── detector.ts, guard-agent.ts
  │     └── token-saver.ts ──── local-model.ts, prompt-loader.ts
  └── types.ts (被所有模块引用)
```

---

## 8. 测试策略

### 8.1 测试覆盖范围

| 测试文件 | 测试目标 | 用例数 | 类型 |
|---------|---------|--------|------|
| `detector.test.ts` | 检测引擎协调 | 5 | 单元 |
| `rules.test.ts` | 规则检测器 | 10 | 单元 |
| `privacy-proxy.test.ts` | PII 标记剥离 | 8 | 单元 |
| `session-manager.test.ts` | 双轨会话管理 | 6 | 单元（含 I/O） |
| `token-saver.test.ts` | Token 节省路由器 | 12 | 单元 + Mock |
| `integration.test.ts` | 端到端流程 | 9 | 集成 |
| `router-pipeline.test.ts` | 路由管道 | 9 | 单元 |

### 8.2 测试设计特点

**规则测试** (`rules.test.ts`):
- 覆盖五层检测的所有路径（关键词、工具、路径、扩展名、结果合并）
- 大小写无关性验证
- 多规则触发时的优先级合并

**代理测试** (`privacy-proxy.test.ts`):
- 标记剥离的正确性
- 仅处理 user 角色消息
- 多消息批量处理
- 畸形标记的容错
- 非字符串 content 的处理
- 文件内容在标记内的保留

**管道测试** (`router-pipeline.test.ts`):
- 空管道的默认行为
- 单路由器直通
- 多路由器合并（级别、action 优先级）
- 管道配置（checkpoint 关联、enabled 标志）
- 路由器异常的容错

**Token Saver 测试** (`token-saver.test.ts`):
- LLM 调用 Mock（`vi.mock`）
- 缓存命中/未命中
- 子代理跳过
- 完整 Prompt 转发
- 降级处理（LLM 失败、非法 JSON）

**集成测试** (`integration.test.ts`):
- 检测 → 会话标记 → 历史记录的完整流程
- 多次检测的级别升级（不降级）
- 三个 checkpoint 的链式处理
- 配置禁用/空配置的边界情况
- 暂存器（stash/consume）的生命周期

### 8.3 Mock 策略

- `callChatCompletion` 通过 Vitest `vi.mock` 替换，避免真实 LLM 调用
- `DualSessionManager` 使用临时目录（`.test-guardclaw`），测试后清理
- 集成测试仅使用 `ruleDetector`，不依赖本地模型

---

## 9. 现有不足与改进建议

### 9.1 架构层面

| 问题 | 影响 | 建议 |
|------|------|------|
| **全局单例状态** | `globalPipeline`、`sessionStates`、`preReadFiles` 等全局 Map 在多租户场景下会产生状态污染 | 引入 Scope 化的上下文对象（类似 DI Container），将状态绑定到插件实例而非全局 |
| **同步配置合并** | `mergeWithDefaults()` 在 `detector.ts`、`hooks.ts`、`routers/privacy.ts` 三处重复实现 | 抽取为共享的 `resolvePrivacyConfig(api)` 工具函数 |
| **Hook 耦合度高** | `hooks.ts` 承载了 10 个钩子 ~600 行代码，职责过于集中 | 按功能域拆分为 `hooks/model-resolve.ts`、`hooks/tool-guard.ts`、`hooks/persistence.ts` 等 |
| **缺少依赖注入** | 模块间直接 import 单例，难以替换（如测试中替换 MemoryIsolationManager） | 引入简单的 DI 或 Context 对象，在 `register()` 时注入依赖 |

### 9.2 安全层面

| 问题 | 影响 | 建议 |
|------|------|------|
| **LLM 检测的绕过风险** | 精心构造的 prompt 可能绕过本地 LLM 的分类（如 Base64 编码、拆分敏感词） | 增加对编码内容的预处理解码；引入对抗样本测试集 |
| **quickPiiScan 粒度不足** | 仅需 2 个 S2 模式匹配才触发，单个 PII 会被遗漏 | 降低阈值至 1，或为高置信度模式（如完整地址）直接触发 |
| **规则引擎的 S2/S3 边界模糊** | `password` 被配置为 S2 关键词，但密码类数据应为 S3 | 审计默认关键词分级；提供分级建议文档 |
| **Proxy API Key 透传** | `apiKey: "guardclaw-proxy-handles-auth"` 硬编码在 Provider 配置中 | 虽然仅本地使用，但考虑使用随机 token 增加安全性 |
| **execSync 用于文件读取** | `tryReadReferencedFile` 中使用 `execSync` 执行 Python 脚本，存在命令注入风险 | 使用 Node.js 原生库处理 xlsx/docx（如 `xlsx` 或 `exceljs` 包） |

### 9.3 性能层面

| 问题 | 影响 | 建议 |
|------|------|------|
| **每条消息调用本地 LLM** | `localModelDetector` 作为默认检测器，每条消息都需 LLM 推理（~100-500ms） | 引入规则预筛：规则检测器先过滤明显的 S1 消息，仅对"可能敏感"的消息调用 LLM |
| **脱敏的双次 LLM 调用** | S2 流程: 检测(1次) + PII 提取(1次) = 2 次 LLM 调用 | 合并为单次调用：检测 prompt 中同时要求输出 PII 列表 |
| **Prompt 缓存无失效** | `prompt-loader.ts` 的缓存永不失效，热重载时需重启 | 增加 mtime 检查或 `--watch` 模式下禁用缓存 |
| **patternCache 无大小限制** | 正则编译缓存 Map 无上限 | 引入 LRU 策略或定期清理 |
| **会话状态内存泄漏** | `sessionStates`、`preReadFiles`、`pendingDetections` 无 TTL | 在 `session_end` 中清理对应 key；或增加定时扫描清理过期条目 |

### 9.4 可用性层面

| 问题 | 影响 | 建议 |
|------|------|------|
| **缺少管理界面** | 无法直观查看当前会话的隐私状态、检测历史 | 提供 CLI 命令或 Web UI dashboard |
| **缺少日志结构化** | 全部使用 `console.log/error/warn`，不便于过滤和分析 | 统一使用 `api.logger` 并增加结构化字段 |
| **错误处理过于静默** | 多处 `catch { /* ignore */ }` 或仅 console.error | 关键路径的错误应上报至 OpenClaw 的错误追踪系统 |
| **缺少 dry-run 模式** | 用户无法在不影响路由的情况下测试检测效果 | 增加 `dryRun: true` 配置，仅记录检测结果不执行路由 |

### 9.5 测试层面

| 问题 | 影响 | 建议 |
|------|------|------|
| **无 LLM 集成测试** | `localModelDetector` 在所有测试中被禁用或 Mock | 增加可选的端到端测试（需本地 Ollama），标记为 `@slow` |
| **hooks.ts 无直接测试** | 最核心的模块没有单独的测试文件 | 创建 `test/hooks.test.ts`，mock OpenClawPluginApi |
| **memory-isolation.ts 无测试** | 记忆同步逻辑未测试 | 创建 `test/memory-isolation.test.ts` |
| **utils.ts 无测试** | `redactSensitiveInfo`、`isProtectedMemoryPath` 等关键函数未测试 | 创建 `test/utils.test.ts` |

---

## 10. 路线图建议

### Phase 1: 稳定性与质量 (短期，1-2 周)

- [ ] 补全 `hooks.ts`、`memory-isolation.ts`、`utils.ts` 的测试
- [ ] 重构配置合并逻辑，消除三处重复的 `getPrivacyConfig`
- [ ] 为 `session-state.ts` 增加 TTL 清理机制
- [ ] 将 `hooks.ts` 拆分为多个文件
- [ ] 修复 `console.log/error` → 统一使用 `api.logger`
- [ ] 替换 `execSync` 文件读取为安全的 Node.js 实现

### Phase 2: 性能优化 (中期，3-4 周)

- [ ] 实现规则预筛 + LLM 后验的两阶段检测
- [ ] 合并检测与 PII 提取为单次 LLM 调用
- [ ] 引入消息级别缓存（类似 token-saver 的 hash 缓存）
- [ ] 为 `patternCache` 和 Prompt 缓存增加大小限制 / 失效策略
- [ ] 基准测试：测量每条消息的处理延迟，设定 P99 目标

### Phase 3: 功能增强 (中期，4-6 周)

- [ ] **Dry-run 模式**: 仅检测记录，不路由，用于调试和调优
- [ ] **审计日志**: 结构化记录所有检测决策，支持导出分析
- [ ] **用户反馈回路**: 允许用户标记误判（False Positive / False Negative），用于规则调优
- [ ] **多 LLM Provider 支持**: 检测和脱敏使用不同的本地模型（如小模型分类 + 大模型脱敏）
- [ ] **流式脱敏**: 对 S2 流式响应中的 PII 进行实时检测和脱敏
- [ ] **PII 类型扩展**: 支持更多地区的 PII 格式（日本、韩国、欧洲 GDPR 相关）

### Phase 4: 生态集成 (长期，6+ 周)

- [ ] **Web Dashboard**: 实时查看会话隐私状态、检测统计、配置管理
- [ ] **多租户支持**: Scope 化状态管理，支持多用户/多工作区
- [ ] **合规报告生成**: 自动生成 GDPR/CCPA/PIPL 合规审计报告
- [ ] **联邦学习**: 多实例间共享脱敏的检测模式（不共享数据）
- [ ] **A2A (Agent-to-Agent) 深度集成**: 跨代理调用的隐私链路追踪
- [ ] **IDE 集成**: VS Code / Cursor 侧边栏显示当前会话隐私等级

---

## 附录 A: 类型系统一览

```typescript
// 核心枚举
type SensitivityLevel = "S1" | "S2" | "S3";
type DetectorType = "ruleDetector" | "localModelDetector";
type Checkpoint = "onUserMessage" | "onToolCallProposed" | "onToolCallExecuted";
type RouterAction = "passthrough" | "redirect" | "transform" | "block";

// 检测输入
type DetectionContext = {
  checkpoint, message?, toolName?, toolParams?, toolResult?,
  sessionKey?, agentId?, recentContext?, fileContentSnippet?
};

// 检测输出
type DetectionResult = { level, levelNumeric, reason?, detectorType, confidence? };

// 路由决策
type RouterDecision = {
  level, action?, target?: { provider, model },
  transformedContent?, reason?, confidence?, routerId?
};

// 路由器接口
interface GuardClawRouter {
  id: string;
  detect(context: DetectionContext, config: Record<string, unknown>): Promise<RouterDecision>;
}

// 会话状态
type SessionPrivacyState = {
  sessionKey, isPrivate, highestLevel,
  detectionHistory: Array<{ timestamp, level, checkpoint, reason? }>
};
```

## 附录 B: S2 标记协议

```
用户消息:
  <guardclaw-s2>
  [脱敏后的安全内容，含 [REDACTED:xxx] 标记]
  </guardclaw-s2>
  [原始敏感内容 — 标记外的部分永远不会到达云端]

Privacy Proxy 处理:
  1. 找到 <guardclaw-s2>...</guardclaw-s2> 范围
  2. 提取范围内内容作为新的 message.content
  3. 丢弃范围外的所有内容
  4. 转发清洗后的请求至目标 Provider
```

## 附录 C: 外部依赖

| 依赖 | 用途 | 类型 |
|------|------|------|
| `openclaw` | 宿主平台 Plugin SDK | workspace devDependency |
| `@sinclair/typebox` | 配置 schema 校验 | 间接依赖（来自 openclaw） |
| `vitest` | 测试框架 | 间接依赖（来自 openclaw） |
| 本地 LLM 后端 | 检测 + 脱敏 + Guard Agent | 运行时外部服务（Ollama 等） |

---

*本报告基于 GuardClaw v2026.3.0 源代码分析生成。*
