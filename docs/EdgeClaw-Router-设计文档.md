# EdgeClaw Router 设计文档

> **版本**: 2026.3.16  
> **定位**: 端云互联协同路由插件 — 隐私感知 × 成本最优 × 可扩展路由管线  
> **状态**: 已实现并验证

---

## 目录

1. [背景与问题域](#1-背景与问题域)
2. [设计目标与约束](#2-设计目标与约束)
3. [整体架构](#3-整体架构)
4. [核心设计决策与动机](#4-核心设计决策与动机)
   - 4.1 [三级灵敏度模型 (S1/S2/S3)](#41-三级灵敏度模型-s1s2s3)
   - 4.2 [双检测引擎（规则 + LLM）](#42-双检测引擎规则--llm)
   - 4.3 [可组合路由管线](#43-可组合路由管线)
   - 4.4 [两阶段执行与短路优化](#44-两阶段执行与短路优化)
   - 4.5 [加权决策合并策略](#45-加权决策合并策略)
   - 4.6 [LLM-as-Judge 任务分级](#46-llm-as-judge-任务分级)
   - 4.7 [隐私代理 vs 本地路由（S2 双策略）](#47-隐私代理-vs-本地路由s2-双策略)
   - 4.8 [Guard Agent 隔离执行](#48-guard-agent-隔离执行)
   - 4.9 [双轨记忆与会话隔离](#49-双轨记忆与会话隔离)
   - 4.10 [Hook 驱动架构](#410-hook-驱动架构)
5. [模块设计](#5-模块设计)
   - 5.1 [检测层](#51-检测层)
   - 5.2 [路由层](#52-路由层)
   - 5.3 [执行层](#53-执行层)
   - 5.4 [状态管理层](#54-状态管理层)
   - 5.5 [可观测层](#55-可观测层)
6. [数据流](#6-数据流)
7. [安全模型](#7-安全模型)
8. [成本模型](#8-成本模型)
9. [扩展机制](#9-扩展机制)
10. [已验证结果](#10-已验证结果)

---

## 1. 背景与问题域

### 1.1 端云互联协同的三个基本角色

端侧 AI 和云侧 AI 在能力和信任边界上天然互补，但互联协同面临三个核心问题：

| 角色 | 定位 | 能力 | 限制 |
|------|------|------|------|
| **端侧** | 用户的贴身助理 | 了解用户行为，理解用户需求，掌握完整上下文 | 计算资源受限，无法处理所有复杂任务 |
| **云侧** | 提供可靠服务的专业团队 | 强大的推理能力，丰富的知识，高吞吐量 | 必须与用户隐私隔离，按量计费 |
| **路由层** | 协同调度器 | 理解任务特征，评估隐私风险，匹配最优资源 | 自身引入延迟和成本开销 |

### 1.2 协同的两个核心诉求

```
协同 = 安全约束 × 成本最优
```

1. **一条件 — 保障安全**：敏感数据（密码、密钥、PII）永不离开用户控制范围。这是硬约束，不可用成本换取。
2. **一目标 — 最优成本**：在安全约束满足的前提下，结合用户的主观偏好（对质量的容忍度、对延迟的敏感度、对费用的预算），选择成本最低的执行路径。

> **关键洞察**：「最优成本」不是「最低费用」。用户可能接受为复杂推理多花 10 倍费用，但不接受为简单查询浪费 1 美分。最优成本是一个因用户偏好而异的主观支点。

### 1.3 端侧的双重职责

端侧不仅是"理解用户"的一方，还承担两类完全不同的工作：

| 职责 | 场景 | 示例 |
|------|------|------|
| **解决一般性问题** | 任务本身不复杂，端侧即可处理 | 本地文档整理摘要、简单问答、文件检索 |
| **整理任务需求** | 任务超出端侧能力，需要云侧介入 | 将复杂推理任务脱敏后转发、将数据调研需求结构化后发送 |

前者的核心是 **以最小成本完成**，后者的核心是 **以最清晰方式整理**。EdgeClaw Router 在两个场景下的行为完全不同——前者路由到本地小模型，后者构造合适的 prompt 转发给云侧。

### 1.4 为什么需要一个路由插件

如果没有路由层，系统要么：
- **全部走云侧**：隐私泄露 + 成本失控（80% 的交互是简单任务，却全部用最贵模型处理）
- **全部走端侧**：质量崩塌（本地 7B 模型无法完成复杂架构设计或数学证明）
- **靠用户手动选择**：认知负担过重，用户不知道哪个模型适合当前任务

路由插件是 **自动化的决策层**，在每条消息粒度上做出三个判断：
1. 这条消息是否涉及隐私？（安全判断）
2. 这条消息需要多强的推理能力？（能力判断）
3. 应该用哪个模型处理？（资源匹配）

---

## 2. 设计目标与约束

### 2.1 功能设计目标

| # | 目标 | 对应协同诉求 |
|---|------|-------------|
| F1 | 支持任意模型 API 调用时进行具体模型选择 | 资源匹配 |
| F2 | 保障用户隐私安全（账户信息）+ 任务执行安全（如 `rm -rf *`） | 安全约束 |
| F3 | 性能和成本最优支点：完成最优性价比模型选择 | 成本最优 |
| F4 | 降低高成本模型调用次数，降低通信成本 | 成本最优 |
| F5 | 友好的 Dashboard UI 体现能力 | 可观测性 |

### 2.2 非功能约束

| 约束 | 说明 |
|------|------|
| **延迟预算** | 路由决策本身不应超过用户的感知阈值（< 2s），否则路由层成为瓶颈 |
| **安全无退让** | 安全判断优先级绝对高于成本优化；当两者冲突时，安全永远胜出 |
| **渐进式采纳** | 用户可以只启用隐私路由或只启用成本路由，不必全量使用 |
| **端侧可运行** | 核心检测逻辑必须能在端侧完成（规则引擎 + 本地小模型），不依赖云侧 |
| **可扩展** | 支持用户添加自定义路由器（内容过滤、合规检查等），不修改核心代码 |

### 2.3 用户偏好建模

「最优成本」中的「最优」因用户偏好而异。系统通过分级模型映射 (tier → model) 来表达偏好：

```json
{
  "SIMPLE":    { "model": "gemini-2.5-flash" },
  "MEDIUM":    { "model": "gemini-2.5-pro" },
  "COMPLEX":   { "model": "gemini-3.1-pro" },
  "REASONING": { "model": "claude-sonnet-4.5" }
}
```

用户可以根据自己的偏好调整映射：
- **成本敏感型**：SIMPLE 和 MEDIUM 都用小模型，只有 REASONING 上大模型
- **质量敏感型**：MEDIUM 就开始用大模型
- **极端节省型**：全部用小模型，禁用 token-saver（等价于只用端侧）

这个配置就是用户对「性能-成本支点」的显式声明。

---

## 3. 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        用户消息 / 工具调用                         │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     OpenClaw Agent (宿主)                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                   Hook 系统 (13 个拦截点)                    │  │
│  │  before_model_resolve / before_tool_call / after_tool_call  │  │
│  │  tool_result_persist / before_message_write / session_end   │  │
│  │  ...                                                        │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │               Router Pipeline (可组合管线)                   │  │
│  │                                                            │  │
│  │   Phase 1: Fast Routers (weight ≥ 50, 并行执行)            │  │
│  │   ┌─────────────┐                                          │  │
│  │   │  Privacy     │ ← 规则检测 + LLM 检测 → S1/S2/S3       │  │
│  │   │  Router (90) │                                          │  │
│  │   └──────┬───────┘                                          │  │
│  │          │  S2/S3? ──→ 短路，跳过 Phase 2                   │  │
│  │          │  S1?   ──→ 继续 Phase 2                          │  │
│  │          ▼                                                  │  │
│  │   Phase 2: Slow Routers (weight < 50, 按需执行)            │  │
│  │   ┌──────────────┐                                          │  │
│  │   │ Token-Saver   │ ← LLM-as-Judge → SIMPLE/.../REASONING │  │
│  │   │ Router (30)   │                                          │  │
│  │   └──────┬────────┘                                          │  │
│  │          │                                                  │  │
│  │          ▼                                                  │  │
│  │   ┌──────────────┐                                          │  │
│  │   │ 决策合并      │ ← 安全级别优先 → 加权 → 行为优先级       │  │
│  │   └──────┬────────┘                                          │  │
│  └──────────┼─────────────────────────────────────────────────┘  │
│             │                                                    │
│    ┌────────┼────────┬────────────┐                              │
│    ▼        ▼        ▼            ▼                              │
│  ┌────┐  ┌──────┐  ┌──────┐  ┌───────┐                          │
│  │ S1 │  │  S2  │  │  S2  │  │  S3   │                          │
│  │Cloud│  │Proxy │  │Local │  │Guard  │                          │
│  │(tier│  │(脱敏 │  │(端侧 │  │Agent  │                          │
│  │路由)│  │转发) │  │处理) │  │(隔离) │                          │
│  └────┘  └──────┘  └──────┘  └───────┘                          │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                 双轨状态管理                                  │  │
│  │  Session: full (含 guard) / clean (排除 guard)              │  │
│  │  Memory:  MEMORY-FULL.md / MEMORY.md                       │  │
│  │  Stats:   per-tier token 统计 → Dashboard                   │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 3.1 分层设计

| 层 | 职责 | 核心模块 |
|----|------|----------|
| **检测层** | 判断消息的安全等级和任务复杂度 | `detector.ts`, `rules.ts`, `local-model.ts` |
| **路由层** | 将检测结果映射为路由决策，合并多路由器的意见 | `router-pipeline.ts`, `privacy.ts`, `token-saver.ts` |
| **执行层** | 执行路由决策——转发、代理、本地处理 | `privacy-proxy.ts`, `guard-agent.ts`, `provider.ts` |
| **状态管理层** | 维护会话、记忆、配置的隔离状态 | `session-state.ts`, `session-manager.ts`, `memory-isolation.ts` |
| **可观测层** | 统计、仪表盘、日志 | `token-stats.ts`, `stats-dashboard.ts` |
| **集成层** | 与宿主 Agent 的 hook 对接 | `hooks.ts`, `index.ts` |

**动机**：分层是为了让每层可独立测试、独立演化。例如检测层可以在不改变路由层的情况下增加新的检测器，路由层可以在不改变执行层的情况下增加新的路由策略。这在插件生态中尤为重要——用户可能只想替换检测规则而不碰路由逻辑。

---

## 4. 核心设计决策与动机

### 4.1 三级灵敏度模型 (S1/S2/S3)

#### 设计

| 等级 | 语义 | 路由策略 | 示例 |
|------|------|----------|------|
| **S1** — 安全 | 不含任何敏感信息 | 直接转发云端，按复杂度选模型 | "HTTP 403 和 401 的区别？" |
| **S2** — 敏感 | 含 PII（可脱敏） | 脱敏后转发 / 路由到本地模型 | SOC 告警含内网 IP |
| **S3** — 私密 | 含不可脱敏的秘密 | 仅本地处理，永不上云 | SSH 私钥、硬编码密码 |

#### 动机：为什么是三级而不是二级或连续值？

**备选方案 A：二级（安全/不安全）**
- 过于粗糙。一封含收件人地址的快递信息和一个 SSH 私钥的风险等级完全不同——前者脱敏后可安全转发（利用云侧的强推理能力），后者必须完全隔离。二级分类会把所有含敏感信息的任务都限制在本地，浪费云侧能力。

**备选方案 B：连续值（0.0 ~ 1.0 的风险评分）**
- 概念上更精细，但会导致路由策略的 if-else 激增——每个路由策略都需要定义自己的阈值，阈值之间的交互行为难以预测。而且用户难以理解 "0.6 的风险" 意味着什么行为。

**选择三级的理由**：
- 三级对应三种完全不同的 **物理执行路径**：S1 走云端、S2 走代理脱敏、S3 走本地 Agent。每个级别有且仅有一种执行路径，策略清晰、行为可预测。
- 三级是用户可直觉理解的最小分类——"安全"、"小心处理"、"完全保密"。
- 在路由合并时，三级之间的优先级关系简单明确：S3 > S2 > S1，没有模糊地带。

### 4.2 双检测引擎（规则 + LLM）

#### 设计

```
输入消息 ──→ ruleDetector (正则 + 关键词)  ──→ S1/S2/S3
         └─→ localModelDetector (本地 LLM) ──→ S1/S2/S3
                                                  │
                                                  ▼
                                            max(两者) = 最终等级
```

- **规则检测器**：零成本，零延迟。通过关键词匹配（`password`, `api_key`, `ssh`）和正则表达式（内网 IP、AWS Key 格式）判定。
- **LLM 检测器**：调用本地小模型（如 Qwen 7B / MiniCPM），理解语义上下文，处理规则无法覆盖的模糊场景。

#### 动机：为什么同时用两个引擎而不选其一？

**只用规则的问题**：
- 规则是基于模式匹配的，无法理解上下文。例如 "帮我分析这份工资单"——没有出现任何关键词或模式，但内容本身是高度私密的。
- 规则难以覆盖所有自然语言表达，每种语言的敏感词库需要独立维护。
- 规则容易被绕过——用变量名、编码、拼音等方式。

**只用 LLM 的问题**：
- 即使是本地小模型，每次调用也有 200ms-2s 的延迟。如果每条消息都过 LLM，路由层本身就成了延迟瓶颈。
- LLM 是概率模型，可能漏判——"AKIA" 开头的 AWS Key 有明确的模式特征，用正则 100% 能抓住，但 LLM 可能忽略。
- 对已知模式（IP、API Key、SSH 密钥格式），规则检测器的准确率 > 99%，没必要动用 LLM。

**双引擎组合的优势**：
- 规则引擎负责"确定性高、模式明确"的场景（零成本、零延迟）。
- LLM 引擎负责"语义模糊、需要上下文理解"的场景（更高的召回率）。
- 两者取 max，确保不遗漏：规则引擎是下限保障，LLM 引擎是上限提升。
- 如果规则引擎已经判定 S3（例如匹配到 AWS Key），可以跳过 LLM 调用——节省端侧计算资源。

### 4.3 可组合路由管线

#### 设计

```typescript
interface GuardClawRouter {
  id: string;
  detect(context: DetectionContext, config: Record<string, unknown>): Promise<RouterDecision>;
}
```

路由管线是一个容器，内部包含多个路由器（router），每个路由器独立运行、独立产出决策，最后由管线合并所有决策。

内置两个路由器：
- **Privacy Router** (weight: 90)：安全判断
- **Token-Saver Router** (weight: 30)：成本优化

用户可添加自定义路由器（内容过滤、合规检查、A/B 测试等）。

#### 动机：为什么是「管线 + 多路由器」而不是「单一路由器」？

**备选方案 A：单一路由器，所有逻辑写在一个 detect() 里**
- 初期简单，但违反单一职责原则。安全检测和成本优化是两个完全不同的关注点——安全检测需要高优先级和短路行为（检测到隐私就立即本地处理），成本优化需要 LLM 判断（较慢）且只在安全通过后才有意义。
- 混在一起后，添加新能力（如内容过滤）需要修改核心逻辑，违反开闭原则。

**备选方案 B：责任链模式（前一个路由器的输出是后一个的输入）**
- 路由器之间是串行的，顺序依赖强。但安全路由器和成本路由器本质上是并行关注——它们各自独立做出判断，然后综合考虑。
- 串行链的延迟等于所有路由器延迟之和；并行管线的延迟等于最慢路由器的延迟。

**选择可组合管线的理由**：
- 每个路由器是独立的、可测试的单元，只关注自己的判断维度。
- 管线在 Phase 1 中并行运行多个 fast router，延迟不累加。
- 合并逻辑集中在管线中（而非分散在各路由器里），策略清晰。
- 支持运行时动态注册/注销路由器（通过配置 + Dashboard）。

### 4.4 两阶段执行与短路优化

#### 设计

```
Phase 1: Fast Routers (weight ≥ 50)
  ├─ 并行执行（rule 检测 + LLM 检测通常 < 500ms）
  ├─ 如果任一返回 S2/S3 且 action ≠ passthrough → 短路
  └─ 跳过 Phase 2

Phase 2: Slow Routers (weight < 50)
  ├─ 仅在 Phase 1 全部 S1 时执行
  └─ Token-Saver 调用 LLM Judge（~1-2s）
```

#### 动机：为什么不是所有路由器都并行执行？

**核心观察**：当消息含有隐私信息（S2/S3）时，token-saver 的分级结果毫无意义——无论任务是 SIMPLE 还是 REASONING，都必须走隐私路径。此时 LLM Judge 的调用纯属浪费。

**量化影响**：
- 假设 20% 的消息含隐私信息
- LLM Judge 每次调用成本约 $0.001，延迟约 1.5s
- 短路优化避免了 20% 的无效 Judge 调用：**节省 20% 的 Judge 成本，且这 20% 的消息延迟减少 1.5s**

**更深层的动机**：
- 两阶段模型自然映射了「安全优先」的哲学——安全判断（Phase 1）永远先于成本优化（Phase 2）。
- 这不是性能优化的附属品，而是架构上的显式声明：**安全是前提，成本优化是在安全通过后的第二级关注**。

### 4.5 加权决策合并策略

#### 设计

当多个路由器产出决策后，管线按以下规则合并：

```
1. 安全级别最高的决策胜出 (S3 > S2 > S1)         — 安全永远最高优先级
2. 同级别下，权重高的路由器胜出                     — privacy(90) > token-saver(30)
3. 同权重下，行为严格的胜出                          — block > redirect > transform > passthrough
4. 特例：S1 + passthrough 意味着「无意见」           — 让其他路由器的 redirect 生效
```

第 4 条规则是关键：当 Privacy Router 返回 S1 + passthrough（"没有隐私问题，我没意见"），而 Token-Saver Router 返回 S1 + redirect（"请用 gemini-2.5-flash"）时，redirect 生效。

#### 动机：passthrough ≠ "我坚持用默认"

这是一个重要的语义区分。在早期实现中，我们遇到过一个 bug：Privacy Router 的 S1/passthrough 会覆盖 Token-Saver 的 redirect，因为 privacy 的 weight 更高。这导致 Token-Saver 永远不生效——违反了设计初衷。

**修复后的语义**：
- `passthrough` = "我对这条消息没有意见，交给其他路由器决定"
- `redirect` = "我建议用这个模型处理"
- 只有当路由器显式返回 redirect（有明确目标）时才算"有意见"
- passthrough 在合并中让步，redirect 在合并中主张

这个语义让 privacy 和 token-saver 能自然协作：privacy 只在检测到隐私问题时发声（S2/S3），其余时间默默让步（S1/passthrough），给 token-saver 空间来优化成本。

### 4.6 LLM-as-Judge 任务分级

#### 设计

Token-Saver Router 使用一个小模型（Judge Model）对每条消息进行复杂度分级：

| Tier | 对应能力需求 | 默认模型 | 成本量级 |
|------|-------------|---------|---------|
| **SIMPLE** | 查找、翻译、格式化、yes/no | gemini-2.5-flash | ~$0.15/M tokens |
| **MEDIUM** | 代码生成、数据分析、摘要 | gemini-2.5-pro | ~$1.25/M tokens |
| **COMPLEX** | 系统设计、大规模重构、架构决策 | gemini-3.1-pro | ~$2.50/M tokens |
| **REASONING** | 数学证明、形式化推理、算法正确性论证 | claude-sonnet-4.5 | ~$3.00/M tokens |

附加机制：
- **Prompt Hash 缓存**（TTL 5 分钟）：相同消息不重复分类
- **Subagent 豁免**：子代理会话跳过分级，避免每条子消息都调 Judge
- **降级兜底**：Judge 调用失败时，passthrough 到默认模型

#### 动机：为什么用 LLM-as-Judge 而不是规则分级？

**备选方案 A：基于关键词/启发式规则的分级**
- "包含代码 → MEDIUM" 这类规则过于粗糙。一个 10 行的 bug fix 是 MEDIUM，但一个涉及 50 个文件的重构是 COMPLEX——规则很难区分。
- 不同语言的提示词风格差异大，中文、英文、日文的"系统设计"表达完全不同。
- 规则库维护成本高，新的任务类型不断出现。

**备选方案 B：用被路由的大模型自判**
- "让 claude-sonnet-4.5 自己判断这个任务是 SIMPLE 还是 REASONING" → 先调用一次大模型做判断，再调用一次做任务。成本翻倍。
- 违反了 Token-Saver 的核心目标：减少大模型调用。

**选择 LLM-as-Judge 的理由**：
- 用小模型（flash 级别）做 Judge，成本约为大模型的 1/20。即使 Judge 本身有成本，只要它能将 50%+ 的消息下调到 SIMPLE tier，净节省依然显著。
- LLM 能理解语义——"写首诗" 是 SIMPLE，"设计百万 QPS 推送系统" 是 COMPLEX，不需要穷举关键词。
- Judge 的 system prompt 是可编辑的（通过 Dashboard 或文件），用户可以根据自己的使用模式调整分级标准。

#### 为什么是四级而不是更多或更少？

**四级对应四种显著不同的能力需求**：
- SIMPLE：纯检索/模式匹配，任何模型都能做
- MEDIUM：需要一定生成能力，但不需要深度推理
- COMPLEX：需要跨上下文的综合推理
- REASONING：需要多步逻辑链条、形式化推导

更少（如二级）会导致大量 MEDIUM 任务被迫使用最贵模型；更多（如六级）会增加 Judge 的判断难度，分级边界模糊，错误率上升。四级是「分级收益」和「判断准确率」的平衡点。

### 4.7 隐私代理 vs 本地路由（S2 双策略）

#### 设计

S2（敏感但可脱敏）提供两种策略，用户通过 `s2Policy` 配置选择：

| 策略 | 数据流 | 适用场景 |
|------|--------|---------|
| **proxy** | 消息 → 本地 LLM 脱敏 → 标记 `<guardclaw-s2>` → 代理服务器剥离标记 → 云端模型 | 需要云侧推理能力，但消息含 PII |
| **local** | 消息 → 本地模型直接处理 | 端侧模型即可完成，无需云侧 |

代理模式的标记协议：
```
原始消息：我的地址是北京市朝阳区建国路88号
脱敏后：  我的地址是<guardclaw-s2>[某城市某区某路某号]</guardclaw-s2>
代理剥离：我的地址是[某城市某区某路某号]
```

#### 动机：为什么提供两种策略？

S2 是一个"灰色地带"——敏感但可处理。不同用户对 S2 数据的风险容忍度不同：

- **风险厌恶型用户**：即使脱敏了也不想让数据离开本地 → 选 `local`
- **功能优先型用户**：脱敏后的数据可以接受发送到云端，以获得更好的推理质量 → 选 `proxy`

提供双策略的核心动机是 **尊重用户的主观偏好**——这正是"最优成本"定义中"结合用户偏好"的体现。系统不替用户做风险决策，而是提供两种物理隔离程度不同的执行路径，让用户选择。

#### 代理标记协议的设计动机

为什么用 `<guardclaw-s2>` XML 标记包裹脱敏内容，而不是直接替换？

- **可逆性**：标记保留了"这里曾经有敏感信息"的元信息，使云端模型能更好地理解上下文（例如知道"某个地址"被替换了，而不是以为原文就没有地址）。
- **多层剥离**：代理服务器负责去除标记，云端模型看到的是干净的脱敏文本。这分离了"标记"和"清洗"两个关注点。
- **审计可追溯**：在本地日志中保留完整标记，方便事后审计脱敏行为。

### 4.8 Guard Agent 隔离执行

#### 设计

S3 级别的任务由一个独立的 Guard Agent 处理：
- 专用的 workspace 目录
- 专用的 session key（`:guard` 后缀）
- 仅使用本地模型（Ollama/vLLM 等）
- 白名单校验：只允许被标记为 "local" 的 provider

```typescript
const KNOWN_LOCAL_PROVIDERS = new Set([
  "ollama", "llama.cpp", "localai", "llamafile",
  "lmstudio", "vllm", "mlx", "sglang", "tgi"
]);
```

#### 动机：为什么不直接用主 Agent 切换到本地模型？

**物理隔离 vs 逻辑隔离**：

如果只是将主 Agent 的模型切换到本地，主 Agent 的上下文窗口仍然包含所有历史消息（含 S1 时发送给云端的内容）。当会话后续切回云端模型时，S3 内容可能因为上下文残留而泄露。

Guard Agent 是 **物理隔离**：独立的 session、独立的历史、独立的 workspace。S3 内容永远只存在于 Guard Agent 的上下文中。主 Agent 的 clean session 中不包含任何 Guard Agent 的交互记录。

**类比**：主 Agent 是开放式办公室（云端模型可见），Guard Agent 是密室（仅本地可见）。密室里的对话记录不会出现在办公室的会议纪要中。

**对会话状态的影响**：S3 的设计原则是始终交由 Guard Agent 处理（用户消息路由到隔离子 agent、工具调用被 block、工具结果被占位符替换）。因此无论 S3 出现在哪个 checkpoint，主会话的上下文窗口始终是干净的，`isPrivate` 不被标记。后续 S1 消息可安全使用云端模型。系统仅通过 `trackSessionLevel()` 记录 `highestLevel=S3` 用于统计和审计。

### 4.9 双轨记忆与会话隔离

#### 设计

系统维护两套平行的状态：

| 维度 | Full（本地视角） | Clean（云端视角） |
|------|-----------------|-----------------|
| **会话历史** | 包含所有交互（含 Guard Agent） | 排除 Guard Agent 交互 |
| **长期记忆** | `MEMORY-FULL.md` — 完整内容 | `MEMORY.md` — PII 已脱敏 |
| **日常记忆** | `memory-full/2026-03-16.md` | `memory/2026-03-16.md` |

同步方向：
```
MEMORY-FULL.md ──(过滤 guard + PII 脱敏)──→ MEMORY.md
MEMORY.md ──(合并新增内容)──→ MEMORY-FULL.md (确保 FULL 是超集)
```

#### 动机：为什么需要双轨而不是单一记忆？

**如果只有一套记忆**：
- 如果保存完整内容 → 云端模型读取记忆时会看到 S3 数据 → 安全违规
- 如果只保存脱敏内容 → 本地模型也只能看到脱敏版 → 后续本地任务丢失上下文

**双轨的核心价值**：本地模型始终拥有完整上下文（FULL），云端模型只看到脱敏后的内容（Clean）。当用户的 S3 任务产生了有价值的结论（如"工资单分析发现某项扣款异常"），这个结论会以脱敏形式同步到 Clean 记忆，使云端模型能知道"发现了异常"但不知道具体数字。

**双向同步的必要性**：
- Full → Clean：脱敏后同步，确保云端模型了解全貌
- Clean → Full：云端模型可能在 MEMORY.md 中写入新内容（如从网络搜索获得的公开信息），这些内容需要合并回 FULL，否则本地模型看不到

### 4.10 Hook 驱动架构

#### 设计

系统通过 13 个 Hook 点与宿主 Agent 集成：

| Hook | 触发时机 | 核心行为 |
|------|---------|---------|
| `before_model_resolve` | 模型选择前 | 执行路由管线，决定用哪个模型 |
| `before_prompt_build` | 构建 prompt 前 | 注入脱敏标记、Guard Agent 系统提示 |
| `before_tool_call` | 工具调用前 | 检测工具参数安全性、重定向记忆路径 |
| `after_tool_call` | 工具调用后 | 检测工具返回内容、同步记忆 |
| `tool_result_persist` | 工具结果持久化时 | PII 脱敏、过滤记忆搜索结果 |
| `before_message_write` | 消息写入前 | 根据隐私状态清洗消息内容 |
| `session_end` | 会话结束 | 同步所有记忆、输出统计 |
| `after_compaction` | 会话压缩后 | 全量记忆同步 |
| `before_reset` | 会话重置前 | 确保记忆已同步 |
| `message_sending` | 消息发送时 | 拦截并记录 |
| `before_agent_start` | Agent 启动时 | 初始化路由状态 |
| `message_received` | 消息接收时 | Token 统计 |
| `llm_output` | LLM 输出时 | Token 统计 |

#### 动机：为什么用 Hook 而不是 Middleware 或 Wrapper？

**备选方案 A：Middleware 模式**
- 请求 → middleware1 → middleware2 → ... → 模型。每个 middleware 只能在请求流上插入逻辑，无法拦截工具调用返回值、记忆持久化等非请求流事件。

**备选方案 B：Wrapper / Decorator 模式**
- 包装整个 Agent 对象，拦截所有方法调用。侵入性强，与宿主 Agent 的具体实现耦合紧密。不同版本的 Agent SDK 可能破坏 Wrapper。

**选择 Hook 的理由**：
- Hook 是宿主 Agent（OpenClaw）提供的标准扩展机制，插件不需要了解 Agent 内部实现。
- 13 个 Hook 覆盖了消息生命周期的每个关键节点，从"接收消息"到"写入记忆"。
- Hook 之间通过 stash/consume 模式传递状态（如检测结果），避免全局状态污染。
- 如果宿主 Agent 更新，只要 Hook 接口不变，插件不需要修改。

---

## 5. 模块设计

### 5.1 检测层

#### 规则检测器 (rules.ts)

```
输入 → 关键词匹配 → S2/S3?
     → 正则匹配   → S2/S3?
     → 工具名匹配 → S2/S3?
     → 工具参数路径匹配 → S2/S3?
     → max(所有命中) = 最终等级
```

支持四种检测维度：
1. **关键词**：如 `password`, `api_key`, `ssh`（S2/S3 分级）
2. **正则模式**：如内网 IP `10.x.x.x`、AWS Key `AKIA...`
3. **工具名**：如 `execute_command`（高危工具 → S3）
4. **工具参数路径**：如 `~/.ssh/`、`/etc/passwd`

**设计动机**：四个维度的检测覆盖了消息的不同层面——内容（关键词 + 正则）和行为（工具 + 路径）。安全检测不仅关心"说了什么"，还关心"要做什么"。一条看似无害的消息可能触发的工具调用包含 `rm -rf /`，仅检测内容无法发现这个风险。

#### LLM 检测器 (local-model.ts)

```
输入 → 构建 detection prompt → 调用本地 LLM → 解析 JSON 响应 → S1/S2/S3
                                    │
                                    └─→ 如果 S2: 同时返回脱敏版本
```

特性：
- 支持多种 API 协议：`openai-compatible`（Ollama/vLLM/LMStudio）、`ollama-native`、`custom`
- 检测和脱敏在同一次 LLM 调用中完成（减少调用次数）
- 检测 prompt 可通过 `prompts/detection-system.md` 自定义

#### 协调器 (detector.ts)

- 按 checkpoint 配置决定启用哪些检测器
- 顺序执行（规则先行，命中 S3 可跳过 LLM）
- 结果合并取 max

### 5.2 路由层

#### 路由管线 (router-pipeline.ts)

核心类 `RouterPipeline`：
- `register(router, registration)` — 注册路由器
- `configure(config)` — 配置管线和路由器参数
- `run(checkpoint, context, config)` — 执行两阶段路由
- `runSingle(id, context, config)` — 单路由器测试（Dashboard 用）

关键设计点：

**路由器注册与配置分离**：路由器实例（代码逻辑）和路由器配置（权重、启用状态、选项）是分开管理的。这允许同一个路由器在不同配置下表现不同，也允许通过 Dashboard 动态调整配置而不重启。

**决策合并函数 `mergeDecisionsWeighted()`**：
- 输入：`Array<{ decision: RouterDecision, weight: number }>`
- 输出：合并后的单一 `RouterDecision`
- 合并逻辑的四层优先级见 [4.5 节](#45-加权决策合并策略)

#### Privacy Router (routers/privacy.ts)

桥接 detector.ts 的检测结果到路由管线的 RouterDecision：
- S1 → `{ level: "S1", action: "passthrough" }`
- S2 + proxy 策略 → `{ level: "S2", action: "redirect", target: "guardclaw-privacy" }`
- S2 + local 策略 → `{ level: "S2", action: "redirect", target: 本地模型 }`
- S3 → `{ level: "S3", action: "redirect", target: Guard Agent 本地模型 }`

#### Token-Saver Router (routers/token-saver.ts)

核心流程：
```
消息 → subagent? → 跳过
     → 缓存命中? → 返回缓存的 tier 决策
     → 调用 Judge LLM → 解析 tier → 缓存 → 构建 redirect 决策
```

**缓存设计**：
- Key: SHA-256(prompt) 的前 16 位
- TTL: 5 分钟（可配置）
- 定期清理（60s 间隔）
- 动机：同一用户可能在短时间内重复发送类似消息（例如修改后重试），缓存避免重复 Judge 调用

**Subagent 豁免**：
- 检测 session key 中的 `:subagent:` 标记
- 动机：Subagent 是主 Agent 拆分的子任务，一次主任务可能产生 10-50 条 subagent 消息。如果每条都调 Judge，开销巨大且无意义（subagent 使用自己的默认模型）

### 5.3 执行层

#### 隐私代理 (privacy-proxy.ts)

本地 HTTP 反向代理（默认端口 8403），处理 S2 消息的脱敏转发：

```
OpenClaw Agent
  → guardclaw-privacy provider
    → localhost:8403 (代理)
      → stripPiiMarkers() (去除 <guardclaw-s2> 标记)
      → cleanToolSchemas() (修复不兼容的 JSON Schema)
      → buildUpstreamUrl() (构建目标 API URL)
      → resolveAuthHeaders() (添加认证头)
      → fetch() → 转发到云端
      → 流式/非流式响应返回
```

支持的上游提供商：
- OpenAI 及兼容 API（messages + tools 格式）
- Google/Gemini（contents + functionDeclarations 格式）
- Anthropic（messages + x-api-key 认证）

**设计动机——为什么用本地代理而不是在请求构建时直接替换？**

在请求构建时替换（例如在 hook 中直接修改 messages 数组）有两个问题：
1. **格式耦合**：不同提供商的 API 格式不同（OpenAI 的 messages vs Google 的 contents），在 hook 中处理所有格式会导致 hook 变成一个巨大的适配器。
2. **流式响应**：hook 无法方便地拦截和转发流式响应。本地代理天然支持 SSE 透传。

代理模式将"消息清洗"和"API 适配"封装在一个独立的 HTTP 服务中，与 hook 系统解耦。

#### Guard Agent (guard-agent.ts)

S3 级别的专用本地代理：
- 从配置中解析 `provider/model` 格式（如 `ollama/qwen2.5:7b`）
- 验证 provider 是否在本地白名单中
- 生成带 `:guard` 后缀的隔离 session key

#### Provider 镜像 (provider.ts)

注册 `guardclaw-privacy` 虚拟 provider，镜像其他 provider 的模型列表。使得路由决策可以通过切换 provider 来改变模型，而不需要改变调用接口。

### 5.4 状态管理层

#### 会话状态 (session-state.ts)

每个 session 维护：
- `isPrivate`: 是否被标记为私密会话（仅 S2 及工具级 S3 触发；Guard Agent 路由的 S3 不标记）
- `highestLevel`: 会话中出现过的最高安全等级（始终跟踪，用于统计/审计）
- `detectionHistory`: 所有检测事件的时间线

**S3 会话状态的区别处理**：

S3 的设计原则是**始终交由 Guard Agent（子 agent）处理**，无论出现在哪个 checkpoint，S3 数据都不会残留在主 Agent 的上下文窗口中：
- 用户消息级别：路由到 Guard Agent（物理隔离的独立 session/workspace）
- 工具调用级别：工具被 block，S3 内容不进入执行结果
- 工具结果级别：S3 内容被 `before_message_write` 替换为占位符

因此 S3 **从不标记 `isPrivate`**——后续 S1 消息可安全使用云端模型。系统通过 `trackSessionLevel()` 仅更新 `highestLevel` 用于统计和审计。

**Stash/Consume 机制**：
- Hook A（如 `before_model_resolve`）产生检测结果 → stash
- Hook B（如 `before_prompt_build`）消费检测结果 → consume
- 避免全局状态或在 hook 之间传递参数

#### 会话管理器 (session-manager.ts)

双轨会话历史：
- **full track**：记录所有消息（含 Guard Agent 交互）— 用于本地审计
- **clean track**：排除 Guard Agent 消息 — 用于云端模型上下文

#### 记忆隔离管理器 (memory-isolation.ts)

负责 `MEMORY-FULL.md` / `MEMORY.md` 和 `memory-full/` / `memory/` 的双向同步。

同步流程：
```
1. mergeCleanIntoFull() — 将 MEMORY.md 中的新增行合并到 MEMORY-FULL.md
2. filterGuardContent() — 从 FULL 内容中过滤 Guard Agent 相关段落
3. redactContent() — PII 脱敏（优先用本地 LLM，降级用正则）
4. 写入 MEMORY.md
```

**设计动机——为什么需要 mergeCleanIntoFull？**

云端模型可能在 `MEMORY.md` 中写入有价值的公开信息（如从网络获取的技术方案、公开的 API 文档摘要）。如果不合并回 FULL，本地模型会丢失这些信息。FULL 必须始终是超集。

### 5.5 可观测层

#### Token 统计 (token-stats.ts)

按 tier (SIMPLE/MEDIUM/COMPLEX/REASONING) 分别统计：
- 请求次数
- 输入/输出 token 数
- 估算费用

支持按小时、按会话维度聚合。

#### Dashboard (stats-dashboard.ts)

Web UI，提供：
- 统计概览（总费用、各 tier 占比、节省金额）
- 小时级时间线图
- 会话级明细
- 检测事件日志
- 配置热更新（GET/POST `/api/config`）
- Prompt 编辑（GET/POST `/api/prompts`）
- 干运行测试（POST `/api/test-classify`）

**设计动机**：Dashboard 不是"锦上添花"，而是解决路由系统的 **可信度问题**。用户需要验证：路由决策是否正确？成本确实降低了吗？哪些消息被标记为敏感？没有 Dashboard，用户只能看日志，无法形成全局认知。

---

## 6. 数据流

### 6.1 S1 路径（安全消息 + 成本路由）

```
用户消息: "JSON 和 YAML 有什么区别？"
  │
  ├─ [Hook: before_model_resolve]
  │   ├─ Phase 1: Privacy Router → ruleDetector: S1, localModelDetector: S1
  │   │   结果: S1/passthrough (无隐私问题)
  │   ├─ Phase 2: Token-Saver Router → Judge LLM: {"tier":"SIMPLE"}
  │   │   结果: S1/redirect → gemini-2.5-flash
  │   └─ 合并: S1/redirect → gemini-2.5-flash (passthrough 让步给 redirect)
  │
  ├─ [Hook: before_prompt_build]
  │   └─ 无特殊处理
  │
  ├─ 消息发送给 gemini-2.5-flash (云端)
  │
  ├─ [Hook: llm_output]
  │   └─ 记录 token 统计 (SIMPLE tier)
  │
  └─ 响应返回用户
```

### 6.2 S2 路径（含 PII + Proxy 策略）

```
用户消息: "分析这条 SOC 告警: src_ip=10.4.8.15 dst_ip=192.168.1.1 ..."
  │
  ├─ [Hook: before_model_resolve]
  │   ├─ Phase 1: Privacy Router
  │   │   ├─ ruleDetector: 匹配内网 IP 正则 → S2
  │   │   └─ localModelDetector: 检测到 IP 地址 → S2
  │   │   结果: S2/redirect → guardclaw-privacy (代理模式)
  │   ├─ Short-circuit: 跳过 Token-Saver (节省 Judge 调用)
  │   └─ 最终: S2/redirect → guardclaw-privacy
  │
  ├─ [Hook: before_prompt_build]
  │   ├─ 调用本地 LLM 脱敏: 10.4.8.15 → [内部IP-1], 192.168.1.1 → [内部IP-2]
  │   └─ 包裹标记: <guardclaw-s2>[脱敏后内容]</guardclaw-s2>
  │
  ├─ 消息发送给 guardclaw-privacy provider
  │   → localhost:8403 (代理)
  │   → stripPiiMarkers() 去除标记
  │   → 转发到实际云端 API
  │
  ├─ 会话标记为 private (highestLevel = S2)
  │
  └─ 云端模型响应返回用户
```

### 6.3 S3 路径（高敏感 + Guard Agent）

```
用户消息: "检查这段代码: const key = 'AKIAIOSFODNN7EXAMPLE'"
  │
  ├─ [Hook: before_model_resolve]
  │   ├─ Phase 1: Privacy Router
  │   │   ├─ ruleDetector: 匹配 AWS Key 正则 → S3
  │   │   └─ 结果: S3/redirect → ollama/qwen2.5:7b (Guard Agent)
  │   ├─ Short-circuit: 跳过 Token-Saver
  │   └─ 最终: S3/redirect → Guard Agent
  │
  ├─ [Hook: before_prompt_build]
  │   └─ 注入 Guard Agent 系统提示（含隐私保护规则）
  │
  ├─ 消息发送给 Guard Agent (本地 Ollama)
  │   Session: "xxx:guard" (隔离 session)
  │   Workspace: ~/.openclaw/workspace-guard/
  │
  ├─ [Session Manager]
  │   ├─ full track: 记录完整交互
  │   └─ clean track: 不记录 Guard Agent 交互
  │
  ├─ 会话标记为 private (highestLevel = S3)
  │
  └─ Guard Agent 响应返回用户 (永不离开本地)
```

---

## 7. 安全模型

### 7.1 威胁矩阵

| 威胁 | 防御机制 | 层 |
|------|---------|---|
| PII 发送到云端 | S2 proxy 脱敏 / S3 本地隔离 | 路由层 + 执行层 |
| 密码/密钥泄露 | 规则检测器（正则） + LLM 检测器 | 检测层 |
| 危险工具调用（rm -rf） | 工具名/路径白名单检测 | 检测层 |
| 记忆中残留 PII | 双轨记忆 + PII 脱敏同步 | 状态管理层 |
| 会话上下文泄露 | Guard Agent 物理隔离 + 双轨会话 | 执行层 + 状态管理层 |
| 云端模型访问敏感路径 | `isProtectedMemoryPath()` 路径拦截 | 集成层 (hooks) |
| 本地模型被伪装为云端 | Provider 白名单校验 | 执行层 |

### 7.2 安全保证

| 保证 | 机制 |
|------|------|
| S3 数据永不离开本地 | Guard Agent + 本地 provider 白名单 + 物理隔离 |
| S2 数据到达云端前已脱敏 | 本地 LLM 脱敏 + 代理剥离标记 |
| 云端模型无法读取完整记忆 | 路径保护 (`MEMORY-FULL.md`, `memory-full/`, `sessions/full` 被拦截) |
| 检测层失败不导致数据泄露 | 检测器异常时 fallback 到 S1/passthrough（安全的默认值），且规则检测器无外部依赖 |

### 7.3 安全-可用性权衡

| 场景 | 安全措施 | 可用性影响 | 权衡决策 |
|------|---------|-----------|---------|
| LLM 检测器不可用 | 仅用规则检测器 | 可能漏判语义级敏感信息 | 接受：规则检测器覆盖高危模式，语义漏判的影响有限 |
| 脱敏可能过度 | 宁可多脱不可少脱 | 云端模型收到的上下文信息量减少 | 接受：安全优先 |
| Guard Agent 能力有限 | 本地 7B 模型 | 复杂 S3 任务的响应质量受限 | 接受：用质量换安全，这是用户的显式选择 |

---

## 8. 成本模型

### 8.1 路由层自身成本

| 组件 | 成本来源 | 量级 |
|------|---------|------|
| 规则检测器 | CPU 正则匹配 | 可忽略（< 1ms） |
| LLM 检测器 | 本地模型推理 | 端侧算力，$0（电费忽略） |
| Token-Saver Judge | 小模型 API 调用 | ~$0.001/次 |
| 隐私代理 | 本地 HTTP 转发 | 可忽略 |

### 8.2 节省模型

设 80% 的消息为 SIMPLE/MEDIUM，20% 为 COMPLEX/REASONING：

| 无路由 | 有路由 | 节省 |
|--------|--------|------|
| 100% 消息 × $3/M tokens | 60% × $0.15 + 20% × $1.25 + 10% × $2.50 + 10% × $3.00 | ~75-85% |

加上 20% 的消息因隐私短路跳过 Judge 调用，实际节省进一步增加。

### 8.3 实测成本节省（Use Cases）

| 场景 | 全量大模型 | Token-Saver 分级 | 节省比例 |
|------|-----------|-----------------|---------|
| 专利地图分析 (1,000 件) | ~$350-600 | ~$45-80 | **~87%** |
| 系统文献综述 (14 步) | — | 43% SIMPLE | **~80%** |
| 研究助理 (11 步) | — | 45% SIMPLE | **~75%** |
| 合规审计 | — | 隐私 + 成本联合 | **~80-85%** |

---

## 9. 扩展机制

### 9.1 自定义路由器

实现 `GuardClawRouter` 接口，通过配置注册：

```typescript
const contentFilter: GuardClawRouter = {
  id: "content-filter",
  async detect(context, config) {
    if (containsHarmfulContent(context.message)) {
      return { level: "S3", action: "block", reason: "harmful content" };
    }
    return { level: "S1", action: "passthrough" };
  },
};
```

```json
{
  "routers": {
    "content-filter": {
      "enabled": true,
      "type": "custom",
      "module": "./my-content-filter.js",
      "weight": 95
    }
  }
}
```

### 9.2 自定义检测规则

通过配置文件扩展关键词、正则、工具白名单：

```json
{
  "privacy": {
    "rules": {
      "keywords": { "S2": ["客户编号", "订单号"], "S3": ["社保号", "银行卡"] },
      "patterns": { "S2": ["\\b\\d{11}\\b"] },
      "tools": { "S3": { "tools": ["execute_command"], "paths": ["/etc/shadow"] } }
    }
  }
}
```

### 9.3 自定义 Prompt

通过 `prompts/` 目录或 Dashboard 编辑：
- `detection-system.md` — 隐私检测 prompt
- `guard-agent-system.md` — Guard Agent 系统提示
- `token-saver-judge.md` — 任务复杂度分级 prompt

### 9.4 自定义边缘推理后端

支持三种接入方式：
- `openai-compatible`：任何提供 `/v1/chat/completions` 端点的服务
- `ollama-native`：Ollama 原生 `/api/chat` 端点
- `custom`：用户自行实现 `callChat()` 函数的自定义模块

### 9.5 Dashboard 可配置路由器

通过 Dashboard 创建的路由器（`type: "configurable"`），无需编写代码，支持热更新。

---

## 10. 已验证结果

### 10.1 Token-Saver 路由验证

所有分级均通过 Gateway `model overridden` 日志确认：

| 输入 | Judge 判定 | 路由模型 | 延迟 | 响应 |
|------|-----------|---------|------|------|
| "JSON vs YAML?" | SIMPLE | gemini-2.5-flash | 6.4s | 122 字 |
| "找出这个函数的 bug" | MEDIUM | gemini-2.5-pro | 19.7s | 1,252 字 |
| "设计百万 QPS 推送系统" | COMPLEX | gemini-3.1-pro-preview | 72.2s | 4,213 字 |
| "证明梅森素数定理" | REASONING | claude-sonnet-4-5 | 11.7s | 1,132 字 |

### 10.2 隐私路由验证

| 输入 | 检测 | 路由 | 模型 |
|------|------|------|------|
| 5 个硬编码凭据 | S3 (正则 + LLM) | Guard Agent | 本地模型 |
| 含银行卡、身份证的聊天记录 | S3 (LLM) | Guard Agent | 本地模型 |
| 含内网 IP 的 SOC 告警 | S2 (正则) | Privacy Proxy | 云端 via 代理 |
| "HTTP 403 vs 401?" | S1 | Cloud (SIMPLE) | gemini-2.5-flash |

### 10.3 优先级解析验证

| 输入 | Privacy | Token-Saver | 胜出 |
|------|---------|-------------|------|
| 身份证号 + 简单问题 | S2 | SIMPLE | **Privacy**（PII 被检测到） |
| 架构对比，无 PII | S1 | REASONING | **Token-Saver** → claude-sonnet-4.5 |

---

## 附录 A：配置完整参考

```jsonc
{
  "privacy": {
    "enabled": true,                          // 是否启用隐私检测
    "s2Policy": "proxy",                      // S2 策略: "proxy" | "local"
    "proxyPort": 8403,                        // 代理端口
    "checkpoints": {
      "onUserMessage": ["ruleDetector", "localModelDetector"],
      "onToolCallProposed": ["ruleDetector"],
      "onToolCallExecuted": ["ruleDetector", "localModelDetector"]
    },
    "rules": {
      "keywords": { "S2": [...], "S3": [...] },
      "patterns": { "S2": [...], "S3": [...] },
      "tools": {
        "S2": { "tools": [...], "paths": [...] },
        "S3": { "tools": [...], "paths": [...] }
      }
    },
    "localModel": {
      "enabled": true,
      "type": "openai-compatible",            // API 协议
      "provider": "ollama",
      "model": "qwen2.5:7b",
      "endpoint": "http://localhost:11434"
    },
    "guardAgent": {
      "id": "guard",
      "workspace": "~/.openclaw/workspace-guard",
      "model": "ollama/qwen2.5:7b"
    },
    "localProviders": []                      // 额外的本地 provider 名称
  },
  "routers": {
    "privacy": { "enabled": true, "type": "builtin", "weight": 90 },
    "token-saver": {
      "enabled": true,
      "type": "builtin",
      "weight": 30,
      "options": {
        "judgeModel": "gemini-2.5-flash",
        "tiers": {
          "SIMPLE":    { "provider": "...", "model": "gemini-2.5-flash" },
          "MEDIUM":    { "provider": "...", "model": "gemini-2.5-pro" },
          "COMPLEX":   { "provider": "...", "model": "gemini-3.1-pro" },
          "REASONING": { "provider": "...", "model": "claude-sonnet-4.5" }
        },
        "cacheTtlMs": 300000
      }
    }
  },
  "pipeline": {
    "onUserMessage": ["privacy", "token-saver"],
    "onToolCallProposed": ["privacy"],
    "onToolCallExecuted": ["privacy"]
  }
}
```

## 附录 B：术语表

| 术语 | 定义 |
|------|------|
| **Checkpoint** | 路由管线的触发时机（onUserMessage / onToolCallProposed / onToolCallExecuted） |
| **Detector** | 检测器，判断消息的灵敏度等级 |
| **Router** | 路由器，将检测结果映射为路由决策 |
| **Pipeline** | 路由管线，组合多个路由器并合并决策 |
| **Guard Agent** | S3 专用本地代理 |
| **Privacy Proxy** | S2 脱敏转发代理 |
| **Tier** | Token-Saver 的任务复杂度分级（SIMPLE/MEDIUM/COMPLEX/REASONING） |
| **Stash/Consume** | Hook 间传递临时状态的机制 |
| **Dual-track** | 双轨（full/clean）状态管理模式 |
