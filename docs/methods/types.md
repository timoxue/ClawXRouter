# types.ts — 逐方法文档


 文件定位：GuardClaw 插件的核心类型定义文件
 所属模块：GuardClaw 隐私路由系统

 核心职责：定义 GuardClaw 系统所有模块共享的类型别名、接口和工具函数。
 包括敏感等级体系（S1/S2/S3）、检测上下文、路由决策、管线配置、
 会话状态，以及等级之间的相互转换辅助函数。本文件是整个 GuardClaw
 插件的"类型契约"，所有其他模块（routers、rules、hooks、pipeline 等）
 均依赖此文件中导出的类型来保证接口一致性。

 敏感等级体系：
   S1 — 无敏感内容，直接放行（passthrough）
   S2 — 中度敏感，走代理（proxy）脱敏转发或本地模型（local）处理
   S3 — 高度敏感，强制本地模型处理，数据不出设备
## 类型别名：SensitivityLevel                       (L7)


敏感等级的字符串字面量联合类型。

  "S1" — 无敏感内容
  "S2" — 中度敏感
  "S3" — 高度敏感

整个系统围绕这三个等级运作：rules.ts 检测等级，routers 根据等级
做路由决策，hooks.ts 按等级对消息进行脱敏/拦截/本地路由。
## 类型别名：SensitivityLevelNumeric                 (L9)


敏感等级的数值表示：1 | 2 | 3。

用于 maxLevel() 等函数中需要数值比较的场景。
与 SensitivityLevel 通过 levelToNumeric() / numericToLevel() 互转。
DetectionResult 同时携带 level 和 levelNumeric 两种表示，
方便下游模块按需使用。
## 类型别名：DetectorType                            (L11)


检测器类型的字面量联合：

  "ruleDetector"       — 基于关键词/正则/工具名的确定性规则检测
  "localModelDetector" — 基于本地 LLM 的语义检测

用于 PrivacyConfig.checkpoints 中配置各检查点启用哪些检测器，
以及 DetectionResult.detectorType 标识结果来源。
默认配置（config-schema.ts defaultPrivacyConfig）中：
  onUserMessage 同时启用两者，onToolCallProposed/Executed 只启用 ruleDetector。
## 类型别名：Checkpoint                              (L13)


检查点标识，标记检测发生在请求生命周期的哪个阶段：

  "onUserMessage"      — 用户消息到达时（before_model_resolve hook）
  "onToolCallProposed" — 模型提议调用工具时（before_tool_call hook）
  "onToolCallExecuted" — 工具执行完毕后（tool_result_persist hook）

PipelineConfig 使用 Checkpoint 作为键名，决定每个检查点运行哪些路由器。
RouterPipeline.run() 的第一个参数就是 Checkpoint。
## 类型别名：EdgeProviderType                        (L21)


边缘（本地）模型的 API 协议类型：

  "openai-compatible" — POST /v1/chat/completions
      兼容 Ollama, vLLM, LiteLLM, LocalAI, LMStudio, SGLang 等

  "ollama-native"     — POST /api/chat
      Ollama 原生 API，原生支持流式输出

  "custom"            — 用户自定义模块
      需导出 callChat 函数，配合 localModel.module 路径使用

被 PrivacyConfig.localModel.type 和 token-saver.ts 的 judgeProviderType 使用，
传入 callChatCompletion() 决定如何构造 HTTP 请求。
## 类型：PrivacyConfig                               (L23-L112)


GuardClaw 隐私功能的顶层配置类型。所有字段均可选（用户只需覆盖
需要定制的部分），运行时由 privacy.ts 等路由器与 defaultPrivacyConfig
合并形成完整配置。

字段说明：

  enabled?: boolean
      总开关。false 时 hooks.ts 跳过所有检测；
      各路由器（privacy.ts, configurable.ts）在 detect() 中
      也会检查此字段（dryRun 时忽略）。
      默认值（config-schema.ts）：true

  s2Policy?: "proxy" | "local"
      S2 处理策略：
        "proxy" — 脱敏后通过本地 HTTP 代理转发至云端（默认）
        "local" — 整条消息由本地模型处理
      privacy.ts 的 detectionToDecision() 根据此字段决定
      S2 的 RouterDecision.target 是 "guardclaw-privacy"（proxy）
      还是本地模型端点（local）。

  proxyPort?: number
      隐私代理服务器端口。默认 8403。

  checkpoints?: { onUserMessage/onToolCallProposed/onToolCallExecuted?: DetectorType[] }
      每个检查点启用的检测器列表。hooks.ts 读取此配置决定
      是仅运行规则检测还是同时启用 LLM 检测器。
      默认值：onUserMessage 同时启用两者，其余仅 ruleDetector。

  rules?: { keywords, patterns, tools }
      规则检测器配置。rules.ts 的 detectByRules() 直接读取：
        keywords.S2/S3: 关键词列表
        patterns.S2/S3: 正则表达式字符串列表
        tools.S2/S3: { tools: 工具名列表, paths: 路径模式列表 }

  localModel?: { enabled, type, provider, model, endpoint, apiKey, module }
      本地 LLM 配置。localModel.enabled 控制 LLM 检测器是否启用，
      endpoint/model/type 等传入 callChatCompletion()。
      token-saver.ts 在没有独立配置时也 fallback 读取此字段。

  guardAgent?: { id, workspace, model }
      Guard Agent 配置。model 为 "provider/model" 格式（如 "ollama/llama3.2:3b"），
      guard-agent.ts 的 getGuardAgentConfig() 解析此字段得到
      provider 和 modelName。

  session?: { isolateGuardHistory, baseDir, injectDualHistory, historyLimit }
      会话/历史记录配置：
        isolateGuardHistory: 是否隔离 Guard 会话历史（默认 true）
        baseDir: 会话历史文件根目录（默认 ~/.openclaw）
        injectDualHistory: S3/S2-local 时是否注入完整对话历史（默认 true）
        historyLimit: 注入历史的最大消息数（默认 20）

  localProviders?: string[]
      额外的本地提供商名称列表。系统内置识别 ollama、vllm 等，
      用户可通过此字段添加自定义的本地推理后端名称。

  toolAllowlist?: string[]
      免检工具白名单。白名单中的工具跳过隐私检测和 PII 脱敏。
      默认空（不豁免任何工具）。hooks.ts isToolAllowlisted() 读取。

  modelPricing?: Record<string, { inputPer1M?, outputPer1M? }>
      各模型的云端 API 定价（USD/百万 token）。
      token-stats.ts 用于成本估算。查找策略：先精确匹配模型名，再子串匹配。

  redaction?: RedactionOptions
      PII 脱敏规则的开关。各规则默认关闭以避免过度脱敏。
      utils.ts 的 redactSensitiveInfo() 读取此配置。
## 类型：RedactionOptions                            (L114-L131)


控制各类 PII 脱敏规则的开关集合。
所有字段默认为 false（关闭），避免对正常内容的误伤（false positive）。
用户可在配置中按需开启特定规则。

字段说明：

  internalIp?: boolean
      内网 IP 地址（10.x, 172.16-31.x, 192.168.x）。默认 false。

  email?: boolean
      电子邮件地址。默认 false。

  envVar?: boolean
      .env 文件内容（KEY=VALUE 格式行）。默认 false。

  creditCard?: boolean
      信用卡号码模式（13-19 位数字）。默认 false。

  chinesePhone?: boolean
      中国手机号（1[3-9]x 11 位）。默认 false。

  chineseId?: boolean
      中国身份证号（18 位 / 17 位 + X）。默认 false。

  chineseAddress?: boolean
      中国地址模式（省/市/区/路/号等）。默认 false。

  pin?: boolean
      PIN / pin code 上下文规则。默认 false。
## 类型：DetectionContext                             (L133-L144)


传入检测器 / 路由器的检测上下文。
每次检测调用时由 hooks.ts 或 router-pipeline.ts 构造。

字段说明：

  checkpoint: Checkpoint
      当前检查点，标识检测发生在哪个生命周期阶段。必填。

  message?: string
      用户消息文本。onUserMessage 检查点时填充。
      rules.ts 的 checkKeywords/checkPatterns 扫描此字段。

  toolName?: string
      工具名称。onToolCallProposed/Executed 时填充。
      rules.ts 的 checkToolType() 匹配此字段。

  toolParams?: Record<string, unknown>
      工具调用参数。onToolCallProposed 时填充。
      rules.ts 的 checkToolParams() 提取路径并匹配。

  toolResult?: unknown
      工具执行结果。onToolCallExecuted 时填充。
      rules.ts 将其序列化后执行关键词+正则检查。

  sessionKey?: string
      会话标识。用于跟踪会话级隐私状态（session-state.ts）。

  agentId?: string
      Agent 标识。用于 dual-track 历史加载等场景。

  recentContext?: string[]
      最近的对话上下文（预留字段，当前未被使用）。

  dryRun?: boolean
      当为 true 时，路由器应跳过 `enabled` 检查。
      用于 Dashboard 的"干跑测试"功能：即使路由器被禁用也能
      测试其检测行为。router-pipeline.ts 的 runSingle() 会
      自动设置 dryRun: true。
## 类型：DetectionResult                             (L146-L152)


检测器（ruleDetector / localModelDetector）的返回结果。
这是检测器层面的内部类型，与路由器层面的 RouterDecision 不同：
  DetectionResult = "是否敏感 + 为什么"
  RouterDecision  = "如何路由 + 去哪里"

字段说明：

  level: SensitivityLevel
      检测到的敏感等级（S1/S2/S3）。

  levelNumeric: SensitivityLevelNumeric
      等级的数值表示（1/2/3），方便数值比较。
      hooks.ts 的 tool_result_persist hook 中
      用 llmResult.levelNumeric > ruleCheck.levelNumeric
      判断 LLM 是否提升了等级。

  reason?: string
      检测原因（如 "S3 keyword detected: password"）。
      传递给 RouterDecision.reason，最终出现在日志中。

  detectorType: DetectorType
      结果来源标识（"ruleDetector" 或 "localModelDetector"）。
      rules.ts 固定返回 "ruleDetector"。

  confidence?: number
      置信度（0-1）。rules.ts 固定返回 1.0（确定性匹配），
      LLM 检测器返回模型自报的置信度或默认值。
      mergeDecisionsWeighted() 用权重加权平均计算最终置信度。
## 类型别名：RouterAction                            (L156)


路由动作的字面量联合：

  "passthrough" — 放行，不做任何路由变更
  "redirect"    — 重定向到指定 provider/model
  "transform"   — 改写消息内容（如脱敏后转发）
  "block"       — 阻断请求

router-pipeline.ts 的 ACTION_PRIORITY 为这四种动作定义了优先级：
  block(4) > redirect(3) > transform(2) > passthrough(1)
同等级同权重时，高优先级动作胜出。
## 类型：RouterDecision                              (L158-L167)


路由器的决策结果。每个 GuardClawRouter.detect() 返回此类型，
RouterPipeline 收集所有路由器的决策后通过 mergeDecisionsWeighted()
合并为最终决策。

字段说明：

  level: SensitivityLevel
      决定的敏感等级。pipeline 合并时取所有路由器中的最高等级
      （通过 maxLevel()）。

  action?: RouterAction
      路由动作。可选，默认视为 "passthrough"。
      hooks.ts 根据 action 决定：
        passthrough → 不干预
        redirect    → providerOverride/modelOverride
        transform   → 改写 prompt 内容
        block       → 拦截或降级到本地模型

  target?: { provider: string; model: string }
      重定向目标。action 为 "redirect" 时指定目标 provider 和 model。
      privacy.ts S2-proxy 时设为 { provider: "guardclaw-privacy", model: "" }，
      S3 时设为本地模型端点。
      token-saver.ts 按复杂度 tier 设为不同的云端模型。

  transformedContent?: string
      改写后的 prompt 内容。action 为 "transform" 时使用。
      hooks.ts 在 S2+transform 时用此内容替代原始 prompt。

  reason?: string
      决策原因。pipeline 合并时拼接所有非 S1 路由器的 reason，
      格式如 "[privacy:w80] S3 keyword detected: password"。

  confidence?: number
      置信度。pipeline 合并时计算加权平均值。

  routerId?: string
      产生此决策的路由器 ID。pipeline.runGroup() 在 detect()
      返回后自动设置此字段（d.routerId = id）。
      hooks.ts 日志中用于追踪是哪个路由器做出了决策。
## 接口：GuardClawRouter                             (L175-L181)


可插拔路由器的统一接口。所有路由器（内置和自定义）必须实现此接口。

字段说明：

  id: string
      路由器唯一标识。用于 pipeline 注册、日志、配置引用等。
      内置路由器："privacy"、"token-saver"。
      自定义路由器由用户在 config 中定义 ID。
      pipeline.loadCustomRouter() 中会覆写 router.id = id。

  detect(context, config): Promise<RouterDecision>
      核心检测方法。接收 DetectionContext 和全局插件配置，
      返回 RouterDecision。

      context: DetectionContext — 当前检测上下文
      config: Record<string, unknown> — 全局插件配置
          各路由器从 config 中提取自己需要的部分：
            privacy.ts:      config.privacy as PrivacyConfig
            token-saver.ts:  config.privacy.routers["token-saver"].options
            configurable.ts: config.privacy.routers[routerId].options

设计意图：
  提供统一的路由器插拔接口，使 RouterPipeline 能够以相同方式调用
  内置路由器（privacy, token-saver）和用户自定义路由器。
  pipeline 通过 Promise.allSettled 并行运行同组路由器，
  单个路由器异常不会影响其他路由器。
## 类型：RouterRegistration                          (L183-L199)


路由器注册信息。在 config 的 routers 字段中为每个路由器 ID
定义其注册元数据。

字段说明：

  enabled?: boolean
      是否启用此路由器。默认 true（undefined 视为启用）。
      RouterPipeline.isRouterEnabled() 检查此字段：
      `reg?.enabled !== false` — 只有显式 false 才禁用。

  type?: "builtin" | "custom" | "configurable"
      路由器类型：
        "builtin"      — 内置路由器（privacy, token-saver），代码中直接注册
        "custom"       — 用户自定义模块，通过 module 路径动态加载
        "configurable" — Dashboard UI 创建的可配置路由器
      pipeline.loadCustomRouters() 只加载 type === "custom" 的路由器。

  module?: string
      自定义路由器模块路径（仅 type="custom" 时使用）。
      pipeline.loadCustomRouter() 通过 import(modulePath) 加载。

  options?: Record<string, unknown>
      传给路由器 detect() 的任意配置。
      token-saver.ts 从 options 中读取 judgeEndpoint/tiers 等。
      configurable.ts 从 options 中读取 keywords/patterns/prompt 等。

  weight?: number
      合并权重（0-100，默认 50）。权重越高，在同等级决策合并时
      越优先。安全类路由器（privacy）应使用高权重；
      优化类路由器（token-saver）应使用低权重，确保安全路由器
      放行后才生效。
      defaultPrivacyConfig 中 privacy 路由器未显式设置 weight，
      因此使用 pipeline 的默认值 50。
## 类型：PipelineConfig                              (L201-L205)


管线配置，定义每个检查点运行哪些路由器（按顺序排列的路由器 ID 列表）。

字段说明：

  onUserMessage?: string[]
      用户消息检查点的路由器列表。
      默认值（config-schema.ts）：["privacy"]

  onToolCallProposed?: string[]
      工具调用提议检查点的路由器列表。
      默认值：["privacy"]

  onToolCallExecuted?: string[]
      工具执行完毕检查点的路由器列表。
      默认值：["privacy"]

设计意图：
  RouterPipeline.getRoutersForCheckpoint() 读取此配置。
  如果某检查点未配置或为空数组，fallback 为所有已注册路由器。
  这允许用户精确控制每个检查点的路由器组合——例如只在
  onUserMessage 启用 token-saver 而 onToolCallProposed 不启用。
## 类型：SessionPrivacyState                         (L209-L222)


会话级隐私状态，跟踪一个会话在生命周期内的敏感检测历史。
session-state.ts 维护此状态（内存中的 Map<string, SessionPrivacyState>）。

字段说明：

  sessionKey: string
      会话唯一标识。与 DetectionContext.sessionKey 对应。

  isPrivate: boolean
      @deprecated — 已被 currentTurnLevel 替代，保留用于向后兼容。
      表示会话是否包含敏感内容。markSessionAsPrivate() 设置为 true。

  highestLevel: SensitivityLevel
      会话生命周期内检测到的最高敏感等级。
      trackSessionLevel() 使用 maxLevel() 更新此字段。
      只升不降——一旦检测到 S3，整个会话标记为 S3。

  currentTurnLevel: SensitivityLevel
      当前轮次的最高敏感等级。每轮重置（resetTurnLevel()），
      用于细粒度的轮次级隐私控制。hooks.ts 的
      before_model_resolve 开始时调用 resetTurnLevel()。

  detectionHistory: Array<{ timestamp, level, checkpoint, reason? }>
      检测历史记录数组。recordDetection() 追加记录。
      用于审计和 Dashboard 可视化。
## 函数：levelToNumeric(level)                       (L224-L233)


### 作用

  将字符串形式的敏感等级转换为数值形式，便于数值比较运算。

### 参数

  level: SensitivityLevel — 字符串等级 "S1" | "S2" | "S3"

### 返回值

  SensitivityLevelNumeric (1 | 2 | 3)
  由于 SensitivityLevel 是穷举联合类型，switch 覆盖了所有分支，
  TypeScript 推断此函数永远有返回值（无需 default 分支）。

### 逐行逻辑


**L225**:
```typescript
switch (level) {
```
> 使用 switch 而非 if-else 或 Map 查找。
> 编译器可验证穷举性（exhaustive check），若新增等级会报错。


**L226-L227**:
```typescript
case "S1": return 1;
```
> S1 → 1（最低敏感度）


**L228-L229**:
```typescript
case "S2": return 2;
```
> S2 → 2（中度敏感）


**L230-L231**:
```typescript
case "S3": return 3;
```
> S3 → 3（最高敏感度）


### 设计意图

  提供类型安全的等级转换。下游模块（rules.ts, hooks.ts）用
  levelNumeric 做 > / < 比较（如判断 LLM 是否提升了等级），
  比字符串比较更直观且不易出错。穷举 switch 确保未来新增等级时
  编译器会强制更新此函数。
## 函数：numericToLevel(numeric)                     (L235-L246)


### 作用

  将数值形式的敏感等级转回字符串形式。是 levelToNumeric 的逆操作。

### 参数

  numeric: SensitivityLevelNumeric — 数值等级 1 | 2 | 3

### 返回值

  SensitivityLevel ("S1" | "S2" | "S3")
  default 分支返回 "S1"，作为安全降级（defensive fallback）。

### 逐行逻辑


**L236**:
```typescript
switch (numeric) {
```
> 与 levelToNumeric 对称的 switch 结构。


**L237-L238**:
```typescript
case 1: return "S1";
```
> 1 → "S1"


**L239-L240**:
```typescript
case 2: return "S2";
```
> 2 → "S2"


**L241-L242**:
```typescript
case 3: return "S3";
```
> 3 → "S3"


**L243-L244**:
```typescript
default: return "S1";
```
> 防御性兜底。虽然 TypeScript 类型系统限制了入参只能是
> 1|2|3，但运行时可能收到意外值（如 JSON 反序列化的数字）。
> 返回 "S1"（最低等级）确保不会误升级敏感度。
> 注意：levelToNumeric() 没有 default 分支（依赖穷举），
> 而 numericToLevel() 有。这是因为 number 类型的运行时
> 可信度低于 string 字面量联合——Math.max() 返回 number，
> 需要 `as SensitivityLevelNumeric` 强制转换，可能引入
> 非法值。


### 设计意图

  主要被 maxLevel() 使用。maxLevel() 对一组等级取 Math.max() 后
  需要将数值结果转回字符串。default→"S1" 的安全降级策略与
  GuardClaw 的"宁可误放不可误拦"原则一致——在不确定的情况下
  默认最低等级，由上层逻辑做进一步判断。
## 函数：maxLevel(...levels)                         (L248-L253)


### 作用

  在一组敏感等级中取最高值。安全优先原则的核心实现——
  多个路由器/检测器的结果取"最严格"的等级。

### 参数

  ...levels: SensitivityLevel[] — 零个或多个敏感等级

### 返回值

  SensitivityLevel — 输入中的最高等级。空输入返回 "S1"。

### 逐行逻辑


**L249**:
```typescript
if (levels.length === 0) return "S1";
```
> 边界处理：无输入时返回最低等级 "S1"。
> 这在 rules.ts 的 detectByRules() 中发生——当所有检查
> 都未触发时 levels 数组为空，最终返回 "S1"。


**L250**:
```typescript
const numeric = levels.map(levelToNumeric);
```
> 将所有字符串等级映射为数值数组 [1, 2, 3, ...]。
> 利用 levelToNumeric 进行类型安全转换。


**L251**:
```typescript
const max = Math.max(...numeric) as SensitivityLevelNumeric;
```
> 用 Math.max 取最大值。
> `as SensitivityLevelNumeric` 强制类型断言——Math.max
> 返回 number，但由于输入已被约束为 1|2|3，结果一定是
> 有效的 SensitivityLevelNumeric。
> 风险：如果 levels 中混入非法字符串，levelToNumeric 的
> switch 会因穷举而不返回值（TypeScript 不报错但运行时
> 返回 undefined），Math.max 会得到 NaN。
> numericToLevel 的 default→"S1" 可以兜底此极端情况。


**L252**:
```typescript
return numericToLevel(max);
```
> 将数值最高等级转回字符串形式返回。


### 设计意图

  这是 GuardClaw "安全优先"（safety-first）原则的基石函数。
  被以下关键路径调用：
    - rules.ts detectByRules()：合并 keywords + patterns + tools 的检测结果
    - router-pipeline.ts mergeDecisionsWeighted()：合并多个路由器决策的等级
  确保只要任何一个检测维度/路由器判定为高敏感，最终结果就是高敏感。
---

## Code Review — 代码审查


### Part A — Code 层面改动建议


#### 🟢 levelToNumeric 缺少 default 分支，存在运行时隐患


 现状（L224-L233）：levelToNumeric() 使用穷举 switch，无 default。
 问题：TypeScript 编译时保证穷举，但运行时（JS）若传入非法字符串
       （如从 JSON.parse 解析的配置值），函数返回 undefined。
       调用方 maxLevel() 的 Math.max() 会产生 NaN，虽然
       numericToLevel 的 default→"S1" 能兜底，但中间过程不透明。
 建议：添加 default 分支抛出或返回 1：
       ```
       default: return 1; // defensive: treat unknown as S1
       ```

       或者使用 `satisfies never` 在编译时捕获遗漏同时保留运行时安全：
       ```
       default: {
         const _exhaustive: never = level;
         return 1;
       }
       ```


#### 🟢 DetectionContext.recentContext 字段未被使用


 现状（L141）：recentContext?: string[] 定义在 DetectionContext 中。
 问题：搜索整个 guardclaw/src/ 目录，没有任何模块读取此字段。
       hooks.ts 构造 DetectionContext 时也从未填充此字段。
       这是一个死字段，增加了类型的认知负担。
 建议：如果计划在未来版本中使用（如提供多轮上下文给 LLM 检测器），
       添加 JSDoc 注明 "@planned" 或 "@reserved"。
       如果无计划使用，移除该字段以保持类型简洁。


#### 🟢 maxLevel 对空数组的 Math.max 行为依赖隐式约定


 现状（L249-L252）：先检查空数组返回 "S1"，然后对非空数组
       执行 Math.max(...numeric)。
 问题：当前代码是正确的（空数组已被提前返回），但 `as SensitivityLevelNumeric`
       类型断言掩盖了可能的 NaN（见第 1 点）。若 levels 中包含
       undefined（极端情况），Math.max 返回 NaN，numericToLevel
       的 default 兜底虽然安全，但丢失了错误信息。
 建议：可使用 reduce 代替 Math.max(...spread) 以避免对大数组的
       栈溢出风险（虽然实际不太可能超过几十个），并在中间步骤
       增加 NaN 检查。当前代码规模下影响极小，仅作为健壮性建议。


### Part B — 逻辑/设计层面改动建议


#### 🔴 PrivacyConfig 缺少 routers 和 pipeline 字段定义


 现状（L23-L112）：PrivacyConfig 类型未包含 `routers` 和 `pipeline` 字段。
 问题：config-schema.ts 的 guardClawConfigSchema（L111-L129）定义了
       privacy.routers（Record<string, RouterRegistration>）和
       privacy.pipeline（PipelineConfig），defaultPrivacyConfig（L219-L226）
       也设置了这两个字段的默认值。但 PrivacyConfig 类型中没有它们。

       这导致：
         a) 需要使用 PrivacyConfig 的模块无法类型安全地访问 routers/pipeline
         b) hooks.ts 通过 `as Record<string, unknown>` 强制转换来读取
         c) token-saver.ts resolveConfig() 中 `(pluginConfig?.privacy as Record<string, unknown>)?.routers`
            的链式断言正是因为类型中缺少此字段

       config-schema.ts（L219-L226）：
         routers: { privacy: { enabled: true, type: "builtin" } }
         pipeline: { onUserMessage: ["privacy"], ... }
       types.ts（L23-L112）：PrivacyConfig 中无 routers/pipeline

 建议：在 PrivacyConfig 中添加：
       ```
       routers?: Record<string, RouterRegistration>;
       pipeline?: PipelineConfig;
       ```

       这将消除多处 `as Record<string, unknown>` 断言，
       提升全局类型安全性。


#### 🟡 RouterDecision.routerId 语义歧义：声明时可选，运行时必填


 现状（L166）：routerId?: string — 在类型中标记为可选。
 问题：router-pipeline.ts runGroup()（L218-L219）总是在 detect() 返回后
       立即设置 d.routerId = id，因此 pipeline 输出的所有决策实际上
       都有 routerId。hooks.ts 多处使用 decision.routerId 记录日志
       （L202, L218, L272 等），mergeDecisionsWeighted() 也读取
       routerId 构造合并 reason。

       但对于直接调用路由器（不经过 pipeline）的场景，routerId
       可能确实缺失——例如测试代码或未来的直接调用。

 建议：保持 `routerId?: string` 的可选定义是合理的（路由器自身
       不需要知道自己的 ID），但建议在 JSDoc 中明确标注：
       "Set by RouterPipeline after detect() returns. Always present
       in pipeline output."


#### 🟡 SessionPrivacyState 类型在 types.ts 中定义但仅 session-state.ts 使用


 现状（L209-L222）：SessionPrivacyState 定义在 types.ts 中，exported。
 问题：此类型主要被 session-state.ts 内部使用，Dashboard API 可能也读取。
       放在 types.ts 中不是错误，但随着类型文件增长，可考虑将
       session 相关类型拆分到 session-types.ts 以保持文件聚焦。
 建议：低优先级重构。当前文件 254 行尚在可管理范围内。


#### 🟡 PrivacyConfig.session 缺少与 config-schema 一致的 redaction 嵌套


 现状：PrivacyConfig 的 redaction 是顶层字段（L111），
       config-schema.ts（L130-L141）也将其放在 privacy 下的顶层。
       两者一致，无问题。

       但 config-schema.ts defaultPrivacyConfig 中 session 字段（L213-L218）
       包含 historyLimit: 20，而 PrivacyConfig.session 类型（L86）
       也有 historyLimit?: number。两者一致。

 （此条经复核无实际问题，保留记录以说明已验证 config drift。）


### 优先级总览


| 优先 | 描述 |
| --- | --- |
| 🔴 | #4 PrivacyConfig 缺少 routers/pipeline 字段 |
| 🟡 | #5 RouterDecision.routerId 语义歧义 |
| 🟡 | #6 SessionPrivacyState 放置位置可优化 |
| 🟡 | #7 config drift 验证（已确认无问题） |
| 🟢 | #1 levelToNumeric 缺少 default 分支 |
| 🟢 | #2 recentContext 未使用的死字段 |
| 🟢 | #3 maxLevel 中 Math.max 的 NaN 隐患 |
