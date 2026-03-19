# privacy.ts — 逐方法文档


 文件定位：GuardClaw 内置隐私路由器（Built-in Privacy Router）
 所属模块：GuardClaw 隐私路由系统

 核心职责：
   将已有的 detector.ts（ruleDetector + localModelDetector）检测引擎
   封装为 GuardClawRouter 接口，作为路由管线（RouterPipeline）中的
   默认 "privacy" 路由器。负责接收 DetectionContext，执行敏感度检测，
   并将检测结果（S1/S2/S3）映射为 RouterDecision（包含 action、target
   等路由指令），供 hooks.ts 编排层执行实际的模型切换与脱敏处理。

 术语表：
   S1 — 无敏感内容，直接放行（passthrough）
   S2 — 中度敏感，走代理脱敏后转发（proxy）或本地模型处理（local）
   S3 — 高度敏感，强制本地模型处理（redirect → edge model）
   s2Policy — "proxy"（脱敏后通过隐私代理转发云端）或 "local"（本地处理）
   Guard Agent — 专门处理敏感请求的本地 AI Agent
   RouterDecision — 路由决策对象，包含 level / action / target / reason
## 导入说明                                     (L14-L24)


DetectionContext   — 检测上下文，含 checkpoint / message / toolName /
                     toolParams / toolResult / dryRun 等字段
GuardClawRouter    — 路由器接口，要求实现 id: string + detect() 方法
PrivacyConfig      — 隐私配置顶层类型，含 enabled / s2Policy / rules /
                     localModel / guardAgent / session 等嵌套配置
RouterDecision     — 路由决策：level + action + target + reason + confidence
SensitivityLevel   — "S1" | "S2" | "S3"

detectSensitivityLevel — detector.ts 的主入口，协调 ruleDetector 和
                         localModelDetector 执行检测，返回 DetectionResult
desensitizeWithLocalModel — ⚠️ 已导入但未使用（dead import），脱敏逻辑
                             实际由 hooks.ts 调用
getGuardAgentConfig — guard-agent.ts，解析 guardAgent 配置，返回
                      { id, model, workspace, provider, modelName } | null
defaultPrivacyConfig — config-schema.ts 中的全量默认配置对象
函数：detectionToDecision(level, reason, privacyConfig)
                                              (L30-L76)

### 作用

  将 detector.ts 返回的 DetectionResult（旧版检测 API）桥接为
  RouterDecision（新版路由管线 API）。根据敏感等级（S1/S2/S3）和
  s2Policy 配置，决定路由动作（passthrough / redirect）及目标模型。

### 参数

  level:         SensitivityLevel — 检测出的敏感等级
  reason:        string | undefined — 检测原因描述
  privacyConfig: PrivacyConfig — 已合并默认值的完整隐私配置

### 返回值

  RouterDecision — 包含 level / action / target / reason 的路由决策。
    S1 → action="passthrough"，无 target
    S3 → action="redirect"，target 指向 Guard Agent 或本地模型
    S2+local → action="redirect"，target 同 S3
    S2+proxy → action="redirect"，target 指向 guardclaw-privacy 代理

### 逐行逻辑


**L35**:
```typescript
if (level === "S1")
```
> S1 无敏感内容 —— 最常见的快速路径


**L36**:
```typescript
return { level: "S1", action: "passthrough", reason }
```
> 直接放行，不设 target，让原始 provider 处理请求


**L39**:
```typescript
if (level === "S3")
```
> S3 高敏：数据绝对不能离开本地


**L40**:
```typescript
const guardCfg = getGuardAgentConfig(privacyConfig)
```
> 尝试解析 Guard Agent 配置。若 guardAgent.id / model / workspace
> 齐全则返回 { provider, modelName, ... }，否则返回 null


**L41**:
```typescript
const defaultProvider = privacyConfig.localModel?.provider ?? "ollama"
```
> Guard Agent 未配置时的兜底 provider，默认 "ollama"


**L42-L50**:
```typescript
return { level: "S3", action: "redirect", target: {...}, reason }
```
> 重定向到本地模型：
> provider: guardCfg 优先 → defaultProvider 兜底
> model:    guardCfg.modelName 优先 → localModel.model 兜底
> → 硬编码 "openbmb/minicpm4.1" 最终兜底


**L54**:
```typescript
const s2Policy = privacyConfig.s2Policy ?? "proxy"
```
> S2 策略：默认 "proxy"（脱敏后转发云端）


**L55**:
```typescript
if (s2Policy === "local")
```
> S2+local 模式：数据留在本地，处理方式与 S3 相同


**L56-L66**:
```typescript
return { level: "S2", action: "redirect", target: {...}, reason }
```
> 目标模型解析逻辑与 S3 完全一致（Guard Agent → localModel → 硬编码）


**L70-L75**:
```typescript
return { level: "S2", action: "redirect", target: { provider: "guardclaw-privacy", model: "" }, reason }
```
> S2+proxy 模式：target.provider 设为 "guardclaw-privacy" 特殊标记，
> hooks.ts 会据此启动隐私代理服务器
> model 设为空字符串 "" —— 故意留空，供管线合并逻辑
> （router-pipeline.ts mergeDecisionsWeighted）从 token-saver 等
> 低权重路由器获取最优模型选择


### 设计意图

  这是一个纯粹的"映射"函数，将检测结果（what level）翻译为路由指令
  （where to go）。S3/S2-local 复用同一套 Guard Agent 解析逻辑；
  S2-proxy 使用特殊 provider 标记，与 hooks.ts 的 before_model_resolve
  钩子约定协作。model 留空是有意设计：让 token-saver 等成本优化路由器
  有机会在管线合并阶段注入最适合的模型。
## 函数：getPrivacyConfig(pluginConfig)          (L78-L96)


### 作用

  从插件配置的 `privacy` 字段提取用户配置，与 defaultPrivacyConfig
  进行深度合并（deep merge），返回完整的 PrivacyConfig 对象。
  确保每个嵌套字段都有有效值，即使用户只配置了部分选项。

### 参数

  pluginConfig: Record<string, unknown> — 插件的顶层配置对象，
                其中 pluginConfig.privacy 是用户的隐私配置

### 返回值

  PrivacyConfig — 完全合并后的配置对象，所有字段都有值

### 逐行逻辑


**L79**:
```typescript
const userConfig = (pluginConfig?.privacy as PrivacyConfig) ?? {}
```
> 从 pluginConfig 中提取 privacy 子对象，不存在则用空对象
> 使用 `as PrivacyConfig` 类型断言（无运行时校验）


**L80-L95**:
```typescript
return { ...defaultPrivacyConfig, ...userConfig, ... }
```
> 第一层：顶层字段 spread merge（enabled, s2Policy 等）


**L83**:
```typescript
checkpoints: { ...defaultPrivacyConfig.checkpoints, ...userConfig.checkpoints }
```
> 第二层 merge：checkpoint 配置（onUserMessage 等检测器列表）


**L84-L91**:
```typescript
rules: { keywords: {...}, patterns: {...}, tools: {...} }
```
> 第三层 merge：规则配置，每个子字段（S2/S3）都独立 merge
> 注意 tools 有两层嵌套（S2.tools / S2.paths），需要三层 spread


**L92**:
```typescript
localModel: { ...defaultPrivacyConfig.localModel, ...userConfig.localModel }
```
> 本地模型配置 merge


**L93**:
```typescript
guardAgent: { ...defaultPrivacyConfig.guardAgent, ...userConfig.guardAgent }
```
> Guard Agent 配置 merge


**L94**:
```typescript
session: { ...defaultPrivacyConfig.session, ...userConfig.session }
```
> 会话配置 merge（isolateGuardHistory, baseDir 等）


### 设计意图

  使用 spread 操作符实现"浅层深度合并"：每个嵌套对象单独展开合并，
  确保用户只覆盖他们设置的字段，其余字段保持默认值。
  与 detector.ts 的 mergeWithDefaults() 功能相同但实现不同——
  detector.ts 使用 `??` 逐字段合并，privacy.ts 使用 spread 合并。
  privacy.ts 将合并后的 config 传给 detectSensitivityLevel() 的
  resolvedConfig 参数，避免 detector.ts 再次合并（double-merge）。

  ⚠️ 注意：此函数未合并 localProviders / toolAllowlist / modelPricing /
  redaction 等顶层字段。这些字段在 defaultPrivacyConfig 中有默认值，
  但 spread 合并只会被 userConfig 中存在的同名字段覆盖——不会丢失，
  因为第一层 ...defaultPrivacyConfig 已经包含它们。
## 导出对象：privacyRouter (GuardClawRouter)     (L98-L115)


实现 GuardClawRouter 接口的单例对象，作为内置 "privacy" 路由器
注册到 RouterPipeline 中。

  id:     "privacy"
  detect: async (context, pluginConfig) => RouterDecision
方法：privacyRouter.detect(context, pluginConfig)
                                              (L101-L114)

### 作用

  GuardClawRouter 接口的核心方法。接收检测上下文和插件配置，
  执行完整的隐私敏感度检测流程，返回路由决策。
  这是 RouterPipeline 调用的入口点。

### 参数

  context:      DetectionContext — 检测上下文
    .checkpoint: "onUserMessage" | "onToolCallProposed" | "onToolCallExecuted"
    .message:    用户消息文本（可选）
    .toolName:   工具名称（可选）
    .toolParams: 工具参数（可选）
    .toolResult: 工具执行结果（可选）
    .dryRun:     是否为 Dashboard 干运行模式（跳过 enabled 检查）
  pluginConfig: Record<string, unknown> — 插件顶层配置对象

### 返回值

  Promise<RouterDecision> —
    disabled 时返回 S1/passthrough；
    正常时通过 detectionToDecision() 将检测结果映射为路由决策。

### 逐行逻辑


**L105**:
```typescript
const privacyConfig = getPrivacyConfig(pluginConfig)
```
> 深度合并用户配置与默认配置，得到完整 PrivacyConfig


**L107**:
```typescript
if (privacyConfig.enabled === false && !context.dryRun)
```
> 隐私检测被禁用时直接放行
> 严格检查 === false（非 undefined/null）
> dryRun 模式下跳过此检查 —— Dashboard 测试需要真实分类结果


**L108**:
```typescript
return { level: "S1", action: "passthrough", reason: "Privacy detection disabled" }
```
> 禁用时的快速返回，附带明确的 reason 供调试


**L111**:
```typescript
const result = await detectSensitivityLevel(context, pluginConfig, privacyConfig)
```
> 核心调用：把完整 context 传给 detector.ts 的主检测函数
> 第三参数 privacyConfig 是已合并的配置（resolvedConfig），
> detector.ts 会直接使用它，跳过内部的 mergeWithDefaults()
> 检测流程：getDetectorsForCheckpoint() → runDetectors()
> → [ruleDetector, localModelDetector] → mergeDetectionResults()
> 返回 DetectionResult { level, levelNumeric, reason, detectorType, confidence }


**L113**:
```typescript
return detectionToDecision(result.level, result.reason, privacyConfig)
```
> 将 DetectionResult 桥接为 RouterDecision
> 只传递 level 和 reason —— DetectionResult 中的 confidence 和
> detectorType 信息在此处被丢弃（RouterDecision 无对应字段）


### 设计意图

  作为"适配器"角色：privacy router 不实现自己的检测逻辑，而是将
  现有的 detector.ts 检测引擎包装为 GuardClawRouter 接口。
  这使得旧版检测流程（ruleDetector + localModelDetector 的 checkpoint
  组合模型）可以无缝接入新版路由管线，与 configurable / token-saver
  等路由器并行运行并通过权重合并决策。

  隐私路由器在管线中通常拥有最高权重（默认 50，与其他路由器持平），
  确保安全决策（S2/S3）优先于成本优化决策。
---

## Code Review — 代码审查


### Part A — Code 层面改动建议


#### 🟡 Dead Import: desensitizeWithLocalModel 未使用


 现状（L22）：import { desensitizeWithLocalModel } from "../local-model.js";
 问题：该导入在 privacy.ts 中从未被调用。脱敏逻辑实际由 hooks.ts
       在 before_model_resolve 钩子中执行（hooks.ts L238）。
       死导入增加了认知负担，且可能导致 tree-shaking 失效。
 建议：删除此导入行。


#### 🟡 confidence 字段未设置


 现状（L36, L42-L50, L59-L66, L70-L75）：
   detectionToDecision() 返回的 RouterDecision 从不设置 confidence 字段。
 问题：router-pipeline.ts mergeDecisionsWeighted() 在计算加权平均
       confidence 时使用 `i.decision.confidence ?? 0.5` 作为默认值
       （router-pipeline.ts L367）。而兄弟路由器 configurable.ts
       （L219）和 token-saver.ts（L119）都显式设置 confidence: 0.8。
       这意味着 privacy router 的 confidence 默认是 0.5，低于其他
       路由器，这在加权合并时可能产生不符预期的结果。
 建议：在 detectionToDecision() 的每个 return 中加入 confidence 字段：
       S1 → confidence: 1.0（来自 ruleDetector 默认值）
       S2/S3 → confidence: result.confidence ?? 0.8
       或将 DetectionResult.confidence 透传到 RouterDecision。


#### 🟢 S3 和 S2-local 的 target 解析逻辑重复


 现状（L40-L50 与 L56-L66）：
   S3 和 S2-local 分支中的 target 构建逻辑（getGuardAgentConfig →
   defaultProvider → model 回退链）完全相同。
 问题：违反 DRY，未来修改一处容易忘记另一处。
       configurable.ts 已经用 resolveTargetForLevel() 提取了这段逻辑
       （configurable.ts L132-L156），但 privacy.ts 没有复用。
 建议：提取为 resolveLocalTarget(privacyConfig) 辅助函数，或直接
       复用 configurable.ts 的 resolveTargetForLevel()。
       例如：
       ```
       function resolveLocalTarget(cfg: PrivacyConfig) {
         const guardCfg = getGuardAgentConfig(cfg);
         const defaultProvider = cfg.localModel?.provider ?? "ollama";
         return {
           provider: guardCfg?.provider ?? defaultProvider,
           model: guardCfg?.modelName ?? cfg.localModel?.model ?? "openbmb/minicpm4.1",
         };
       }
       ```


#### 🟢 硬编码兜底模型名 "openbmb/minicpm4.1"


 现状（L47, L63）：硬编码 "openbmb/minicpm4.1" 作为最终兜底模型。
 问题：此值也出现在 config-schema.ts defaultPrivacyConfig.localModel.model
       （L183）、guard-agent.ts（L45）、configurable.ts（L142, L153）
       以及 hooks.ts 的多处。散布的魔法字符串容易不一致。
 建议：提取为常量 DEFAULT_EDGE_MODEL = "openbmb/minicpm4.1"，从
       config-schema.ts 导出并在各文件中引用。


### Part B — 逻辑/设计层面改动建议


#### 🔴 与 configurable.ts 的配置合并行为不一致


 现状：privacy.ts getPrivacyConfig()（L78-L96）执行深度 spread merge，
       确保所有默认值生效。
       configurable.ts getPrivacyConfig()（configurable.ts L47-L49）
       仅执行 `(pluginConfig?.privacy ?? {}) as PrivacyConfig`——
       没有任何默认值合并。
 问题：configurable.ts 的 resolveTargetForLevel() 读取 pCfg.s2Policy、
       pCfg.localModel?.provider 等字段。如果用户未配置这些字段，
       configurable.ts 会得到 undefined 并依赖 `??` 运算符做逐字段兜底。
       这种行为与 privacy.ts 一致（因为两者最终兜底值相同），但
       如果 defaultPrivacyConfig 新增字段，configurable.ts 不会自动获取。
       这是一个潜在的逻辑一致性风险。
 建议：将 privacy.ts 的 getPrivacyConfig() 提取为共享工具函数
       （如 config-utils.ts），让 configurable.ts 也使用它。


#### 🟡 DetectionResult.confidence 在桥接时被丢弃


 现状（L113）：detectionToDecision(result.level, result.reason, privacyConfig)
   只传递 level 和 reason。detector.ts 返回的 DetectionResult 还包含
   confidence（ruleDetector 为 1.0，localModelDetector 为 0.8 等）和
   detectorType 字段。
 问题：RouterDecision 有 confidence 字段（types.ts L165），但
       detectionToDecision() 从不设置它。这导致了上面 #2 描述的问题：
       管线合并时 privacy 路由器的 confidence 默认 0.5，低于实际值。
       调用方期望（pipeline reads decision.confidence）vs 实际输出不匹配。
 建议：修改 detectionToDecision() 签名，增加 confidence 参数：
       `detectionToDecision(level, reason, confidence, privacyConfig)`
       并在 detect() 中传入 result.confidence。


#### 🟡 configurable.ts 缺少 enabled 检查


 现状：privacy.ts（L107）和 token-saver.ts（L172）都在 detect() 入口
       检查 `enabled === false && !context.dryRun`。
       configurable.ts 的 detect()（configurable.ts L166-L221）没有
       任何 enabled 检查。
 问题：RouterPipeline.isRouterEnabled()（router-pipeline.ts L113-L116）
       在管线层面检查 `reg.enabled !== false`，所以 configurable router
       会在管线层面被跳过。但如果直接调用 createConfigurableRouter().detect()
       （如 pipeline.runSingle() 的 dryRun 测试），则不会经过管线检查。
 建议：在 configurable.ts detect() 入口也添加 enabled 检查，与
       privacy.ts / token-saver.ts 保持一致的自我保护模式。


#### 🟡 configurable.ts 不处理 toolName / toolParams / toolResult


 现状：privacy.ts 通过 detectSensitivityLevel() → detectByRules() 的
       完整检测链，会检查 context.toolName / toolParams / toolResult。
       configurable.ts（configurable.ts L171-L199）只读取 context.message，
       完全忽略工具相关字段。
 问题：当管线在 onToolCallProposed / onToolCallExecuted 检查点运行时，
       context.message 通常为空（只有 toolName/toolParams），
       configurable router 会直接返回 S1/passthrough，等同于无效。
       如果用户在 Dashboard 创建了 configurable router 并期望它能
       检测工具调用中的敏感内容，则不会生效。
 建议：configurable.ts 的 checkKeywords / checkPatterns 也应检查
       toolName 和 JSON.stringify(toolParams) 组成的文本。


#### 🟢 routerId 未在 detect() 内部设置


 现状：privacy.ts detect() 返回的 RouterDecision 不含 routerId 字段。
 问题：RouterDecision 类型定义有 routerId? 字段（types.ts L166）。
       router-pipeline.ts runGroup() 在调用后补设 `d.routerId = id`
       （router-pipeline.ts L218），所以管线正常运行时没问题。
       但如果独立调用 privacyRouter.detect()（不经过管线），routerId
       将为 undefined，hooks.ts 中的日志打印会显示 `[undefined]`。
 建议：在 detect() 返回时设置 routerId: "privacy"，或在
       detectionToDecision() 中统一添加。成本极低，增强独立可用性。


### 优先级总览


| 编号 | 优先 | 标题 |
| --- | --- | --- |
| 5 | 🔴 | configurable.ts 配置合并行为不一致 |
| 1 | 🟡 | Dead Import: desensitizeWithLocalModel |
| 2 | 🟡 | confidence 字段未设置 |
| 6 | 🟡 | DetectionResult.confidence 桥接时被丢弃 |
| 7 | 🟡 | configurable.ts 缺少 enabled 检查 |
| 8 | 🟡 | configurable.ts 不处理 tool* 字段 |
| 3 | 🟢 | S3/S2-local target 解析逻辑重复 |
| 4 | 🟢 | 硬编码兜底模型名散布多处 |
| 9 | 🟢 | routerId 未在 detect() 内部设置 |
