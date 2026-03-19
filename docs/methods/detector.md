# detector.ts — 逐方法文档


 文件定位：GuardClaw 核心敏感度检测引擎
 所属模块：GuardClaw 隐私路由系统

 核心职责：协调规则检测器（ruleDetector）和本地模型检测器
 （localModelDetector）的执行。根据 checkpoint 配置决定启用哪些
 检测器，顺序执行后将多个检测结果合并为一个最终结果（取最高敏感
 等级）。此文件是整个隐私检测管道的入口函数所在。

 敏感等级体系：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理(proxy)或本地模型(local)
   S3 — 高度敏感，强制本地模型处理
函数：detectSensitivityLevel(context, pluginConfig, resolvedConfig?)
                                                  (L27-L67)

### 作用

  核心入口函数。协调所有检测器，对给定的 DetectionContext 进行
  敏感度检测，返回一个聚合后的 DetectionResult（取所有检测器结果
  中的最高敏感等级）。

### 参数

  context: DetectionContext
      — 检测上下文，包含 checkpoint（检查点类型）、message（消息文本）、
        toolName / toolParams / toolResult（工具信息）、sessionKey、
        dryRun（是否为 Dashboard 干跑模式）等字段。

  pluginConfig: Record<string, unknown>
      — 原始插件配置对象（legacy 路径）。当调用方没有预合并配置时，
        函数会从中提取 privacy 子对象并与 defaultPrivacyConfig 合并。

  resolvedConfig?: PrivacyConfig
      — 可选的已合并配置。当调用方（如 router）已经完成了配置合并时
        传入此参数，避免重复合并。

### 返回值

  Promise<DetectionResult>
      — 聚合后的检测结果。包含 level（S1/S2/S3）、levelNumeric（1/2/3）、
        reason（原因）、detectorType（主检测器类型）、confidence（置信度）。
        若隐私检测被禁用或无检测器可用，返回 S1（安全）。

### 逐行逻辑


**L32-L35**:
```typescript
const privacyConfig = resolvedConfig ?? mergeWithDefaults(...)
```
> 如果调用方传入了 resolvedConfig（已合并的配置），直接使用，
> 避免重复合并。否则从 pluginConfig.privacy 中取出配置，
> 用 ?? {} 防御 null/undefined，再与 defaultPrivacyConfig 合并。
> 这种双路径设计让 detector 既能被 legacy 代码直接调用，
> 也能被已做过配置合并的 router 高效调用。


**L38-L46**:
```typescript
if (privacyConfig.enabled === false && !context.dryRun)
```
> 当隐私检测被禁用时直接返回 S1（安全），跳过所有检测逻辑。
> 但如果 context.dryRun 为 true（Dashboard 测试模式），即使
> enabled === false 也继续执行检测——这样 Dashboard 能看到
> 真实的分类结果，便于用户调试规则。
> 返回的 confidence: 1.0 表示"确定无疑地安全"。


**L49**:
```typescript
const detectors = getDetectorsForCheckpoint(context.checkpoint, privacyConfig);
```
> 根据当前 checkpoint（onUserMessage / onToolCallProposed /
> onToolCallExecuted）从配置中获取应该运行的检测器列表。


**L51-L60**:
```typescript
if (detectors.length === 0)
```
> 如果该 checkpoint 没有配置任何检测器，返回 S1。
> 这是一个防御性检查：正常情况下 defaultPrivacyConfig
> 至少配置了 ruleDetector。


**L63**:
```typescript
const results = await runDetectors(detectors, context, privacyConfig);
```
> 按顺序运行所有检测器，收集结果。runDetectors 内部会在
> 遇到 S3 时短路退出（见下方函数说明）。


**L66**:
```typescript
return mergeDetectionResults(results);
```
> 将多个检测器结果合并为一个最终结果：取最高敏感等级，
> 拼接原因字符串，取平均置信度。


### 设计意图

  作为整个检测系统的唯一公开入口，此函数封装了"配置解析 → 检测器
  选择 → 执行 → 结果聚合"的完整流程。resolvedConfig 参数的引入
  避免了 router 调用链中的配置重复合并，是一个性能和正确性兼顾的
  设计。dryRun 旁路确保 Dashboard 总能获得真实检测结果。
函数：getDetectorsForCheckpoint(checkpoint, config)
                                                  (L72-L88)

### 作用

  根据 checkpoint 类型从 PrivacyConfig 中获取该检查点应运行的
  检测器列表。

### 参数

  checkpoint: Checkpoint
      — "onUserMessage" | "onToolCallProposed" | "onToolCallExecuted"

  config: PrivacyConfig
      — 完整的隐私配置对象

### 返回值

  DetectorType[]
      — 该 checkpoint 对应的检测器类型数组。
        若配置中未指定，则使用硬编码的默认值。

### 逐行逻辑


**L76**:
```typescript
const checkpoints = config.checkpoints ?? {};
```
> 从配置中取 checkpoints 子对象。若为 undefined 则降级为 {}，
> 避免后续取 checkpoints.onUserMessage 时报错。


**L78-L87**:
```typescript
switch (checkpoint) { ... }
```
> 根据 checkpoint 字符串匹配分支。


**L80**:
```typescript
return checkpoints.onUserMessage ?? ["ruleDetector", "localModelDetector"];
```
> onUserMessage 默认启用规则检测 + LLM 检测。
> 与 defaultPrivacyConfig.checkpoints.onUserMessage 一致。
> 规则检测在前（快速、确定性），LLM 检测在后（语义级别）。


**L82**:
```typescript
return checkpoints.onToolCallProposed ?? ["ruleDetector"];
```
> 工具调用提议阶段默认只用规则检测（快速，无 LLM 开销）。


**L84**:
```typescript
return checkpoints.onToolCallExecuted ?? ["ruleDetector"];
```
> 工具调用执行后默认也只用规则检测。


**L86**:
```typescript
return ["ruleDetector"];
```
> default 分支：未知的 checkpoint 类型，兜底只跑规则检测器。
> 这是防御性编码——TypeScript 的 Checkpoint 类型只有三个值，
> 正常不会走到这里。


### 设计意图

  把 checkpoint → 检测器列表的映射逻辑集中在一个函数中，便于维护。
  每个 checkpoint 都有合理的默认值，用户可以通过配置自定义。
  onUserMessage 同时启用规则+LLM 是因为单独的规则无法捕获语义级别的
  敏感内容（如"帮我分析这份工资单"不包含关键词但意图是 S3）。
## 函数：runDetectors(detectors, context, config)    (L98-L130)


### 作用

  按顺序运行给定的检测器数组，收集所有检测结果。
  内置 S3 短路机制：一旦任何检测器返回 S3，立即停止后续检测。

### 参数

  detectors: DetectorType[]
      — 需要运行的检测器类型列表（如 ["ruleDetector", "localModelDetector"]）

  context: DetectionContext
      — 检测上下文

  config: PrivacyConfig
      — 隐私配置

### 返回值

  Promise<DetectionResult[]>
      — 所有成功运行的检测器的结果数组。失败的检测器会被跳过
        （记录错误日志但不抛出异常）。

### 逐行逻辑


**L103**:
```typescript
const results: DetectionResult[] = [];
```
> 初始化结果收集数组。


**L105**:
```typescript
for (const detector of detectors) {
```
> 顺序遍历检测器列表。注意是顺序（非并行）执行，
> 这样才能在 S3 时短路跳过后续的 LLM 检测器。


**L106**:
```typescript
try {
```
> 每个检测器独立捕获异常，单个检测器失败不会影响其他检测器。


**L109-L119**:
```typescript
switch (detector) { ... }
```
> 根据检测器类型分派到不同的检测函数。


**L110-L111**:
```typescript
case "ruleDetector": result = detectByRules(context, config);
```
> 调用 rules.ts 的 detectByRules()，这是同步函数，
> 通过关键词匹配、正则匹配、工具名和路径匹配来检测。
> 返回 DetectionResult，confidence 固定为 1.0。


**L113-L114**:
```typescript
case "localModelDetector": result = await detectByLocalModel(context, config);
```
> 调用 local-model.ts 的 detectByLocalModel()，这是异步函数，
> 向本地 LLM（如 MiniCPM、Ollama）发送消息进行语义分类。
> 若 localModel.enabled 为 false，返回 S1（confidence: 0）。
> 若 LLM 调用失败，也返回 S1（降级，不阻断流程）。


**L116-L118**:
```typescript
default: console.warn(...); continue;
```
> 未知检测器类型：打印警告日志并 continue 跳过，
> 不推入结果数组。这是防御性编码。


**L121**:
```typescript
results.push(result);
```
> 将成功的检测结果推入收集数组。


**L123**:
```typescript
if (result.level === "S3") break;
```
> S3 短路：S3 是最高敏感等级，后续检测器无法提升等级，
> 继续运行 LLM 检测既浪费计算资源，又会把敏感内容暴露给
> LLM（即使是本地 LLM，也是不必要的传输）。


**L124-L126**:
```typescript
catch (err) { console.error(...); }
```
> 检测器异常被静默捕获——单个检测器失败不应阻断整个
> 检测流程。该检测器的结果不会被推入数组。


**L129**:
```typescript
return results;
```
> 返回所有成功检测器的结果（可能为空数组）。


### 设计意图

  顺序执行而非并行执行是有意为之的核心设计：
  1) 规则检测器（同步、微秒级）先运行，若直接命中 S3 则短路，
     完全跳过 LLM 检测器（异步、百毫秒~秒级），显著降低延迟。
  2) S3 短路也避免了将高度敏感内容发送给 LLM 进行分类——即使
     LLM 是本地的，减少数据暴露面仍是安全最佳实践。
  3) try-catch 确保单检测器故障时系统降级而非崩溃。
## 函数：mergeDetectionResults(results)              (L136-L175)


### 作用

  将多个检测器的结果合并为单一的 DetectionResult。
  策略：取最高敏感等级、拼接原因、取平均置信度。

### 参数

  results: DetectionResult[]
      — 来自各检测器的结果数组

### 返回值

  DetectionResult
      — 合并后的最终检测结果。空数组返回 S1（confidence: 0）。
        单元素直接返回（无计算开销）。

### 逐行逻辑


**L137-L145**:
```typescript
if (results.length === 0) return { level: "S1", ... confidence: 0 };
```
> 空数组防御：无结果视为安全。confidence: 0 表示"无检测依据，
> 默认放行"。detectorType 降级为 "ruleDetector"。


**L147-L149**:
```typescript
if (results.length === 1) return results[0];
```
> 单结果快速路径：无需合并，直接返回。避免不必要的
> maxLevel / filter / reduce 运算。


**L152**:
```typescript
const levels = results.map((r) => r.level);
```
> 提取所有结果的 level 字段为字符串数组。


**L153**:
```typescript
const finalLevel = maxLevel(...levels);
```
> 调用 types.ts 的 maxLevel()，将 S1/S2/S3 转为数值比较
> 后取最大值再转回字符串。保证最终等级是所有检测器中最高的。


**L156**:
```typescript
const relevantResults = results.filter((r) => r.level === finalLevel);
```
> 过滤出与最终等级相同的结果。这些是"贡献了最终决定的"
> 检测器，用于拼接原因字符串。


**L157-L159**:
```typescript
const reasons = relevantResults.map(r => r.reason).filter(...)
```
> 从相关结果中提取非空的 reason 字符串。
> filter 的类型守卫 (r): r is string => Boolean(r) 同时
> 过滤 undefined 和空字符串。


**L162**:
```typescript
const confidences = results.map((r) => r.confidence ?? 0.5);
```
> 提取所有结果的 confidence，缺失值默认 0.5（中等置信度）。
> 注意：是对所有结果取平均，而非只对 relevantResults。


**L163**:
```typescript
const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
```
> 简单算术平均。这种方式在只有两个检测器时合理，
> 但如果检测器数量增加，可能需要加权平均。


**L166**:
```typescript
const primaryDetector = relevantResults[0]?.detectorType ?? "ruleDetector";
```
> 选择第一个到达最终等级的检测器作为"主检测器"。
> 由于 detectors 数组中 ruleDetector 在前，如果规则和 LLM
> 同时检测到 S3，primaryDetector 会是 ruleDetector。


**L168-L175**:
```typescript
return { level, levelNumeric, reason, detectorType, confidence }
```
> 组装最终结果。levelNumeric 通过 find() 从原始结果中取，
> 避免再次调用 levelToNumeric()。reasons 用 "; " 拼接。


### 设计意图

  "取最高等级"策略是安全系统的标准做法——宁可误报（高估敏感度）
  也不漏报。confidence 取平均值提供了一个大致的可信度指标，
  但并非加权平均（不考虑检测器自身的可靠性差异）。
## 函数：mergeWithDefaults(userConfig, defaults)     (L180-L236)


### 作用

  将用户提供的 PrivacyConfig 与 defaultPrivacyConfig 进行
  逐字段合并。每个字段使用 ?? 操作符：用户值优先，缺失时回退到默认值。

### 参数

  userConfig: PrivacyConfig
      — 用户配置（可能只设置了部分字段）

  defaults: PrivacyConfig
      — 默认配置（来自 config-schema.ts 的 defaultPrivacyConfig）

### 返回值

  PrivacyConfig
      — 完整的合并后配置对象，所有字段都有值。

### 逐行逻辑


**L184**:
```typescript
return { ... }
```
> 返回一个新对象，结构与 PrivacyConfig 类型完全一致。


**L185**:
```typescript
enabled: userConfig.enabled ?? defaults.enabled,
```
> 布尔字段用 ?? 合并。用户显式设为 false 时会保留（!= null），
> 只有 undefined 时才回退到默认值 true。


**L186-L192**:
```typescript
checkpoints: { onUserMessage: ..., onToolCallProposed: ..., ... }
```
> 逐个 checkpoint 合并，用户可以单独覆盖某个 checkpoint
> 的检测器列表而不影响其他。


**L193-L211**:
```typescript
rules: { keywords: {...}, patterns: {...}, tools: {...} }
```
> 三级嵌套合并：rules → keywords/patterns/tools → S2/S3。
> 用户可以只设置 rules.keywords.S3 而保持 S2 使用默认值。
> tools 子结构更深一层：每个等级包含 tools 和 paths 两个数组。


**L212-L221**:
```typescript
localModel: { enabled, type, provider, model, endpoint, apiKey, module }
```
> 本地模型配置的逐字段合并。


**L222-L226**:
```typescript
guardAgent: { id, workspace, model }
```
> Guard Agent 配置的逐字段合并。


**L227-L234**:
```typescript
session: { isolateGuardHistory, baseDir, injectDualHistory, historyLimit }
```
> 会话配置的逐字段合并。


### 设计意图

  采用手动逐字段 ?? 合并而非深度合并（deep merge）是有意为之：
  1) 完全可控——能精确控制每个字段的合并行为；
  2) TypeScript 类型安全——编译器能检查字段是否遗漏；
  3) 避免深度合并库的不可预测行为（如数组合并策略差异）。
  代价是代码冗长，且新增字段时必须手动添加。
---

## Code Review — 代码审查

## Part A — Code 层面改动建议


#### 🟡 mergeWithDefaults 遗漏了多个 PrivacyConfig 字段


 现状（L180-L236）：mergeWithDefaults 手动合并了 enabled /
 checkpoints / rules / localModel / guardAgent / session 六组字段。

 问题：PrivacyConfig（types.ts L23-L112）还包括以下字段，
 但 mergeWithDefaults 完全没有合并它们：
   - s2Policy（"proxy" | "local"，default: "proxy"）
   - proxyPort（default: 8403）
   - localProviders（string[]）
   - toolAllowlist（string[]）
   - modelPricing（Record<string, ...>）
   - redaction（RedactionOptions）

 当 detector.ts 通过 legacy 路径（pluginConfig → mergeWithDefaults）
 被调用时，这些字段不会从 defaultPrivacyConfig 中获得默认值，
 导致下游代码（如 hooks.ts 的 s2Policy、redaction 读取）可能
 拿到 undefined。

 不过，在当前架构中，hooks.ts 使用 getLiveConfig() 获取配置
 而不经过 detector.ts 的 mergeWithDefaults，所以实际影响有限。
 但如果 detectSensitivityLevel 被第三方直接调用（legacy 用法），
 则会出现字段缺失。

 建议：补全所有遗漏字段：
   return {
     ...
     s2Policy: userConfig.s2Policy ?? defaults.s2Policy,
     proxyPort: userConfig.proxyPort ?? defaults.proxyPort,
     localProviders: userConfig.localProviders ?? defaults.localProviders,
     toolAllowlist: userConfig.toolAllowlist ?? defaults.toolAllowlist,
     modelPricing: userConfig.modelPricing ?? defaults.modelPricing,
     redaction: { ... },
   };


#### 🟢 mergeDetectionResults 中 confidence 使用简单算术平均


 现状（L162-L163）：对所有检测器结果取简单算术平均。

 问题：ruleDetector 的 confidence 固定为 1.0（确定性匹配），
 localModelDetector 默认为 0.8（local-model.ts L318）。当两者都
 返回相同等级时，平均值 0.9 可能略低于预期；当一个返回 S1
 （confidence 0.5 默认）时，会不合理地拉低整体置信度。

 建议：考虑只对 relevantResults（达到最终等级的结果）计算
 置信度平均，或使用加权平均（按检测器可靠性加权）。


#### 🟢 getDetectorsForCheckpoint 的默认值与 defaultPrivacyConfig 重复


 现状（L80-L86）：每个 case 分支都硬编码了默认检测器列表，
 如 ["ruleDetector", "localModelDetector"]。

 问题：config-schema.ts 的 defaultPrivacyConfig（L162-L164）
 已经定义了完全相同的默认值。两处重复意味着修改默认值时
 必须同步更新两个地方，容易遗漏。

 建议：直接引用 defaultPrivacyConfig 的值：
   return checkpoints.onUserMessage
     ?? defaultPrivacyConfig.checkpoints.onUserMessage;


#### 🟢 runDetectors 中 console.warn/error 缺少结构化日志


 现状（L117, L125）：使用 console.warn / console.error 输出日志。

 问题：hooks.ts 和 router-pipeline.ts 使用 api.logger 进行
 结构化日志输出，而 detector.ts 直接用 console，风格不一致。
 在生产环境中 console 输出可能无法被日志收集系统捕获。

 建议：为 runDetectors / detectSensitivityLevel 添加可选的
 logger 参数，或使用与 router-pipeline.ts 相同的 logger 模式。
## Part B — 逻辑/设计层面改动建议


#### 🔴 mergeWithDefaults 与 privacy.ts router 中合并行为不一致


 现状（L180-L236）：detector.ts 的 mergeWithDefaults 只合并
 六组字段（enabled / checkpoints / rules / localModel / guardAgent / session）。

 对比：hooks.ts 完全不调用 detector.ts 的 mergeWithDefaults，
 而是通过 getLiveConfig()（live-config.ts）获取配置。
 router-pipeline.ts 中的 privacy router 调用 detectSensitivityLevel
 时传入 resolvedConfig，也绕过了 mergeWithDefaults。

 问题：mergeWithDefaults 实际上只在 legacy 直调路径生效。
 如果有外部代码通过 detectSensitivityLevel(ctx, pluginConfig)
 方式调用（不传 resolvedConfig），得到的配置会缺少
 s2Policy / proxyPort / localProviders / toolAllowlist / modelPricing / redaction
 等字段。这不会直接导致 detector.ts 内部出错（因为 detector.ts
 只读取 enabled / checkpoints / rules / localModel），但合并后的
 配置如果被传给下游函数，可能导致意外行为。

 建议：
 方案 A：补全 mergeWithDefaults 中所有字段（最安全）。
 方案 B：在 JSDoc 中明确标注 legacy 路径的限制，
        引导调用方使用 resolvedConfig 参数。


#### 🟡 detector.ts 的 detectSensitivityLevel 在 hooks.ts 中未直接被调用


 现状：hooks.ts 的 before_model_resolve 中先调用 detectByRules()
 做 S3 快速路径（L159-L161），然后调用 pipeline.run()（L190-L199）。
 pipeline 内部由 privacy router 调用 detectSensitivityLevel。

 问题：hooks.ts 的 S3 快速路径直接调用了 detectByRules（rules.ts）
 而不经过 detectSensitivityLevel。这意味着 detector.ts 的
 "enabled 检查" 和 "dryRun 旁路" 逻辑在快速路径中被跳过了。
 不过 hooks.ts 在调用 detectByRules 之前已经做了
 `if (!privacyConfig.enabled) return;`（hooks.ts L139），
 所以 enabled 检查不会遗漏。但 dryRun 场景下快速路径
 仍然生效（hooks.ts 没有在快速路径前检查 dryRun），可能导致
 Dashboard 干跑测试时 S3 规则命中被快速路径直接路由到本地模型，
 而非走完整 pipeline 产生纯检测结果。

 建议：hooks.ts 的 S3 快速路径前增加 dryRun 检查：
   if (rulePreCheck.level === "S3" && !context.dryRun) { ... }
 （注：这是 hooks.ts 的问题，不是 detector.ts 的问题。）


#### 🟡 mergeDetectionResults 的 levelNumeric 取值方式脆弱


 现状（L170）：
   levelNumeric: results.find((r) => r.level === finalLevel)?.levelNumeric ?? 1

 问题：已经有 types.ts 的 levelToNumeric() 函数可以直接从
 finalLevel 转换，无需在 results 数组中搜索。当前的 find()
 方式虽然能工作，但逻辑上是间接的——依赖 results 中某个元素
 的 levelNumeric 与 finalLevel 一致，而非直接计算。

 建议：直接使用 levelToNumeric(finalLevel)：
   levelNumeric: levelToNumeric(finalLevel),


#### 🟢 detectSensitivityLevel 未设置 routerId 相关标记


 现状：detectSensitivityLevel 返回 DetectionResult，
 不包含 routerId 字段。

 问题：DetectionResult 类型本身没有 routerId（只有 RouterDecision
 有），所以从类型角度没有错误。但 router-pipeline.ts 的
 runGroup()（L217-L219）在拿到 RouterDecision 后手动设置
 d.routerId = id。这意味着 routerId 的设置职责在 pipeline
 层，detector 层无需关心，设计是一致的。此条仅作为观察，
 无需改动。
## 优先级总览


| 优先 | 编号 + 标题 |
| --- | --- |
| 🔴 | 5. mergeWithDefaults 与系统其他配置合并路径不一致 |
| 🟡 | 1. mergeWithDefaults 遗漏多个 PrivacyConfig 字段 |
| 🟡 | 6. hooks.ts S3 快速路径跳过 dryRun 检查 |
| 🟡 | 7. levelNumeric 取值方式脆弱（应直接计算） |
| 🟢 | 2. confidence 简单算术平均可能不合理 |
| 🟢 | 3. 默认检测器列表与 defaultPrivacyConfig 重复 |
| 🟢 | 4. console.warn/error 与结构化日志风格不一致 |
| 🟢 | 8. routerId 设置职责观察（无需改动） |
