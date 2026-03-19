# config-schema.ts — 逐方法文档


 文件定位：GuardClaw 插件的配置 Schema 定义与默认值
 所属模块：GuardClaw 隐私路由系统

 核心职责：
   1. 使用 TypeBox（@sinclair/typebox）声明 guardClawConfigSchema，
      为 OpenClaw 插件框架提供 JSON-Schema 级别的配置校验。
   2. 导出 defaultPrivacyConfig 对象，作为运行时所有模块合并用户
      配置时的基础默认值。该对象是 GuardClaw 系统的"单一事实来源"。

 敏感等级体系：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理(proxy)或本地模型(local)
   S3 — 高度敏感，强制本地模型处理
## 导入：Type                                     (L7)


从 @sinclair/typebox 导入 Type 构建器。
TypeBox 是一个在运行时生成 JSON Schema 的库，同时提供
TypeScript 静态类型推断。这里仅用于声明 schema 结构，
并不会在运行时做校验——校验由 OpenClaw 插件框架在加载
配置时完成。
## 常量：guardClawConfigSchema                    (L9-L144)


### 作用

  声明 GuardClaw 插件的完整配置 JSON Schema。
  OpenClaw 插件框架读取此 schema，在插件初始化时对用户
  提供的 JSON 配置进行结构校验。

### 类型

  TObject — TypeBox 构建的对象类型（编译后等价于 JSON Schema）

### 逐段逻辑


**L9**:
```typescript
Type.Object({ ... })
```
> 顶层 schema 为一个对象，包含唯一的可选字段 `privacy`。
> 所有 GuardClaw 配置均嵌套在 privacy 下，避免与其他插件的配置冲突。


**L10-L11**:
```typescript
privacy: Type.Optional(Type.Object({ ... }))
```
> privacy 本身是可选的——若用户完全不配置，系统走 defaultPrivacyConfig。


**L12**:
```typescript
enabled: Type.Optional(Type.Boolean())
```
> 全局开关。false 时隐私检测直接返回 S1（放行）。
> 默认值在 defaultPrivacyConfig 中设为 true。


**L13-L15**:
```typescript
s2Policy: Type.Optional(Type.Union([Type.Literal("proxy"), Type.Literal("local")]))
```
> S2 策略枚举：proxy 表示通过隐私代理脱敏后转发给云模型；
> local 表示直接路由到本地模型处理。
> 使用 Union + Literal 而非 Type.String() 实现枚举级校验。


**L16**:
```typescript
proxyPort: Type.Optional(Type.Number())
```
> 隐私代理服务器端口。live-config.ts 注释明确指出此值
> 无法热重载（端口已绑定），需重启插件生效。


**L17-L35**:
```typescript
checkpoints: Type.Optional(Type.Object({ ... }))
```
> 检查点配置。三个检查点各持有一个检测器数组：
> onUserMessage      — 用户消息到达时触发
> onToolCallProposed — 工具调用请求提出时触发
> onToolCallExecuted — 工具调用执行完成后触发
> 数组元素为 "ruleDetector" | "localModelDetector" 的枚举。
> 这决定了每个检查点运行哪些检测器以及顺序。


**L36-L66**:
```typescript
rules: Type.Optional(Type.Object({ ... }))
```
> 规则引擎配置，包含三种规则类型：
> L38-L43: keywords — 关键词规则
> S2/S3 各持有一个 string[] 关键词列表。
> rules.ts 使用 getKeywordRegex() 将关键词编译为
> 带 word-boundary 的正则进行匹配。
> L44-L49: patterns — 正则表达式规则
> S2/S3 各持有一个 string[] 正则字符串列表。
> 运行时由 rules.ts 编译为 RegExp 对象。
> L50-L65: tools — 工具敏感规则
> S2/S3 各有 tools（工具名）和 paths（文件路径前缀）两个列表。
> 用于在 onToolCallProposed/onToolCallExecuted 检查点
> 判断特定工具或特定路径操作的敏感等级。


**L68-L84**:
```typescript
localModel: Type.Optional(Type.Object({ ... }))
```
> 本地模型（边缘推理）配置：
> enabled  — 是否启用本地模型检测
> type     — API 协议：openai-compatible / ollama-native / custom
> provider — 提供商名（用于 OpenClaw 路由分发）
> model    — 模型标识符
> endpoint — 推理端点 URL
> apiKey   — 可选的 API 密钥
> module   — 自定义提供商模块路径（type="custom" 时使用）


**L85-L91**:
```typescript
guardAgent: Type.Optional(Type.Object({ ... }))
```
> Guard Agent 配置——专门处理 S3/S2-local 敏感请求的本地 AI Agent：
> id        — Agent 标识符（默认 "guard"）
> workspace — Agent 工作目录
> model     — 完整的 "provider/model" 格式引用


**L92**:
```typescript
localProviders: Type.Optional(Type.Array(Type.String()))
```
> 额外标记为"本地安全"的 provider 名称列表。
> 内置白名单（ollama, llamafile, vllm 等）写在运行时代码中，
> 此处仅收集用户自定义的追加条目。


**L93**:
```typescript
toolAllowlist: Type.Optional(Type.Array(Type.String()))
```
> 工具白名单——在此列表中的工具名将跳过隐私检测和 PII 脱敏。


**L94-L102**:
```typescript
modelPricing: Type.Optional(Type.Record(...))
```
> 云模型定价表。Key 为模型名，Value 为 { inputPer1M, outputPer1M }。
> 用于 token-stats.ts 的成本估算功能。
> 使用 Type.Record 允许任意模型名作为键。


**L103-L110**:
```typescript
session: Type.Optional(Type.Object({ ... }))
```
> 会话管理配置：
> isolateGuardHistory — 是否隔离 Guard Agent 的会话历史
> baseDir             — 会话历史存储基础目录
> injectDualHistory   — 是否向本地模型注入完整双轨历史
> historyLimit        — 注入历史的最大消息数


**L111-L122**:
```typescript
routers: Type.Optional(Type.Record(...))
```
> 路由器注册表。Key 为路由器 ID，Value 为注册信息：
> enabled  — 启用/禁用
> type     — "builtin" | "custom" | "configurable"
> module   — 自定义路由器模块路径
> weight   — 合并权重（0-100，默认50，权重高的优先）
> options  — 任意附加配置（传给路由器的 detect()）
> router-pipeline.ts 读取此表来注册和运行路由器。


**L123-L129**:
```typescript
pipeline: Type.Optional(Type.Object({ ... }))
```
> 路由管线配置，定义每个检查点按什么顺序执行哪些路由器。
> 三个检查点各持有一个 string[] 路由器 ID 列表。
> 若未配置，router-pipeline.ts 回退到运行所有已注册路由器。


**L130-L141**:
```typescript
redaction: Type.Optional(Type.Object({ ... }))
```
> PII 脱敏规则开关集合。每个字段对应一种脱敏规则：
> internalIp    — 内网 IP 地址
> email         — 电子邮箱
> envVar        — .env 环境变量
> creditCard    — 信用卡号
> chinesePhone  — 中国手机号
> chineseId     — 中国身份证号
> chineseAddress — 中国地址
> pin           — PIN 码
> 所有规则默认关闭（false），因为某些规则误报率较高，
> 由用户按需开启。


### 设计意图

  使用 TypeBox 而非手写 JSON Schema 有两个好处：
  1. TypeScript 类型推断——Static<typeof guardClawConfigSchema> 可自动
     得到配置的 TS 类型，虽然本项目实际用手写的 PrivacyConfig 类型。
  2. 代码即文档——schema 结构在 .ts 文件中清晰可见。
  所有字段均为 Optional，实现"零配置可用"——
  用户不提供任何配置时，系统使用 defaultPrivacyConfig 的全部默认值。
## 常量：defaultPrivacyConfig                     (L157-L227)


### 作用

  提供 GuardClaw 运行时的完整默认配置对象。
  所有消费方（live-config.ts, detector.ts, privacy.ts 等）
  均以此对象为基础，通过 spread 合并用户配置。

### 类型

  对象字面量（类型由推断得出，等价于 PrivacyConfig 的完整版本）

### 逐行逻辑


**L157**:
```typescript
export const defaultPrivacyConfig = {
```
> 模块级导出，确保所有消费方引用同一份默认值。


**L158**:
```typescript
enabled: true,
```
> 默认启用隐私检测。用户可设 false 完全禁用。
> detector.ts L38 和 privacy.ts L107 均检查此字段。


**L159**:
```typescript
s2Policy: "proxy" as "proxy" | "local",
```
> S2 默认走代理模式。使用 `as` 类型断言缩窄字面量类型，
> 防止 TypeScript 推断为宽泛的 string 类型。
> privacy.ts L54 和 configurable.ts L146 读取此字段。


**L160**:
```typescript
proxyPort: 8403,
```
> 隐私代理默认端口。live-config.ts 注释明确此值
> 不可热重载（端口启动后已绑定）。


**L161-L165**:
```typescript
checkpoints: { ... }
```
> 检查点→检测器映射。
> onUserMessage 同时运行 ruleDetector 和 localModelDetector——
> 注释说明：规则单独可能遗漏语义级敏感内容，
> LLM 单独可能将规则已命中的 S2 降级为 S1。
> onToolCallProposed / onToolCallExecuted 仅运行 ruleDetector——
> 工具调用频率高，每次调 LLM 开销过大。
> 使用 `as const` 断言确保数组元素为字面量类型。


**L166-L178**:
```typescript
rules: { keywords, patterns, tools }
```
> 规则引擎默认值：所有列表为空数组。
> 用户通过配置或 Dashboard 添加具体的关键词/正则/工具名。
> `as string[]` 类型断言使空数组具有正确的元素类型。


**L180-L185**:
```typescript
localModel: { ... }
```
> 本地模型默认配置：
> enabled: true — 默认启用本地模型检测
> type: "openai-compatible" — 使用 OpenAI 兼容 API
> model: "openbmb/minicpm4.1" — 默认模型
> endpoint: "http://localhost:11434" — Ollama 默认端口
> 注意：未设 provider 字段，这意味着消费方需用 ?? 提供回退值
> （privacy.ts L41: `?? "ollama"`）。


**L186-L190**:
```typescript
guardAgent: { ... }
```
> Guard Agent 默认配置：
> id: "guard" — Agent 标识符
> workspace: "~/.openclaw/workspace-guard" — 工作目录
> model: "ollama/openbmb/minicpm4.1" — provider/model 格式
> guard-agent.ts 的 getGuardAgentConfig() 解析此 model 字符串，
> 以 "/" 分割得到 provider 和 modelName。


**L191**:
```typescript
localProviders: [] as string[],
```
> 用户自定义的本地 provider 列表，默认为空。
> live-config.ts L76-L79 将其与默认列表拼接。


**L192**:
```typescript
toolAllowlist: [] as string[],
```
> 工具白名单，默认为空（所有工具均经过隐私检测）。


**L193-L202**:
```typescript
modelPricing: { ... }
```
> 云模型定价表，内置了主流模型的每百万 token 价格（美元）。
> 包含 Claude 4.6/3.5 Sonnet/Haiku、GPT-4o/Mini、O4-Mini、
> Gemini 2.0 Flash、DeepSeek Chat。
> token-stats.ts 查找时先精确匹配，再子串匹配。
> `as Record<string, ...>` 使其可被用户配置扩展。


**L203-L212**:
```typescript
redaction: { ... }
```
> 所有 PII 脱敏规则默认关闭（false）。
> types.ts 中 RedactionOptions 注释解释：
> "All default to false to avoid over-redaction."
> 用户按需在配置中逐项开启。


**L213-L218**:
```typescript
session: { ... }
```
> 会话管理默认配置：
> isolateGuardHistory: true — 隔离 Guard Agent 历史
> baseDir: "~/.openclaw" — 会话历史存储目录
> injectDualHistory: true — 向本地模型注入完整双轨历史
> historyLimit: 20 — 最多注入 20 条历史消息


**L219-L221**:
```typescript
routers: { privacy: { enabled: true, type: "builtin" } }
```
> 路由器注册表默认值：仅注册内置的 privacy 路由器。
> 用户可通过 Dashboard 或配置文件添加 token-saver、
> configurable 等其他路由器。
> `as Record<string, ...>` 使其可被用户配置的其他路由器扩展。


**L222-L226**:
```typescript
pipeline: { ... }
```
> 路由管线默认配置：三个检查点均只运行 privacy 路由器。
> router-pipeline.ts 的 getRoutersForCheckpoint() 读取此配置
> 来决定每个检查点运行哪些路由器以及顺序。


### 设计意图

  defaultPrivacyConfig 是 GuardClaw 的"零配置即可运行"基石。
  它同时承担两个角色：
  1. 运行时默认值——所有消费方通过 `{ ...defaultPrivacyConfig, ...userConfig }`
     合并，缺失字段自动回退到此默认值。
  2. 文档——开发者和用户通过阅读此对象即可了解所有可配置项及其默认行为。
  值得注意的是，此对象的类型并非直接使用 PrivacyConfig，而是由 TypeScript
  从字面量推断——这使得某些字段（如 checkpoints 数组）具有更窄的字面量类型，
  但也导致与 PrivacyConfig 在结构上略有差异（需要 `as` 断言）。
## Part A — Code 层面改动建议


#### 🟡 defaultPrivacyConfig 缺少 PrivacyConfig 类型注解


 现状（L157）：export const defaultPrivacyConfig = { ... }
 问题：defaultPrivacyConfig 的类型完全由字面量推断，而非显式
       标注为 PrivacyConfig。这意味着：
       a) 若在默认值中增加了 PrivacyConfig 没有的字段，TS 不会报错；
       b) 若 PrivacyConfig 新增了必填字段，此对象不会触发编译错误。
       必须通过大量 `as` 断言来缩窄类型，代码可读性下降。
 建议：添加 `satisfies PrivacyConfig` （TS 4.9+）或显式注解：
       ```
       export const defaultPrivacyConfig = { ... } satisfies Required<PrivacyConfig>;
       ```

       这样既保留字面量窄类型，又确保结构与 PrivacyConfig 一致。


#### 🟢 大量冗余的 `as` 类型断言


 现状（L159, L162-L164, L168-L178, L191-L202, L221）：
       几乎每个字段都需要 `as const` 或 `as string[]` 或 `as Record<...>`。
 问题：如果使用了 `satisfies PrivacyConfig`，这些断言大部分可以消除，
       TypeScript 会自动将字面量类型与目标类型对齐。
 建议：结合建议 #1，使用 satisfies 后删除冗余断言，仅保留必要的 `as const`。


#### 🟢 guardClawConfigSchema 与 PrivacyConfig 手动同步


 现状（L9-L144 vs types.ts L23-L112）：
       TypeBox schema 和 PrivacyConfig type 独立定义，需手动保持一致。
 问题：若一方新增字段，另一方很容易遗漏。当前已存在不一致——
       schema 中 routers 和 pipeline 有定义，但 PrivacyConfig
       类型中没有 routers 和 pipeline 字段（它们由独立的
       RouterRegistration 和 PipelineConfig 类型覆盖，但 PrivacyConfig
       本身并未包含）。
 建议：考虑使用 `Static<typeof guardClawConfigSchema>["privacy"]` 生成
       PrivacyConfig 类型，或至少在两处添加交叉引用注释。


#### 🟡 localModel.provider 在 schema 和默认值中定义但默认值未设置


 现状（L78）：schema 定义了 provider: Type.Optional(Type.String())
       但 defaultPrivacyConfig.localModel 未包含 provider 字段。
 问题：privacy.ts L41 和 configurable.ts L139 都使用
       `pCfg.localModel?.provider ?? "ollama"` 作为回退。
       这个 "ollama" 硬编码在消费方而非默认配置中，违反了
       "defaultPrivacyConfig 是单一事实来源"的设计原则。
 建议：在 defaultPrivacyConfig.localModel 中添加
       `provider: "ollama"`，消除消费方的硬编码回退。
## Part B — 逻辑/设计层面改动建议


#### 🔴 PrivacyConfig 类型缺少 routers / pipeline 字段


 现状：types.ts 中 PrivacyConfig（L23-L112）不包含 routers 和
       pipeline 字段，但 defaultPrivacyConfig（L219-L226）定义了
       这两个字段，且 schema（L111-L129）也有。
 问题：这导致一个类型安全缺口：
       a) live-config.ts L60 的 mergeConfig 使用 PrivacyConfig 类型，
          但其实现中没有合并 routers 和 pipeline（因为类型中没有这些字段）。
       b) hooks.ts L59 用 `{ privacy: getLiveConfig() }` 构建 pluginConfig，
          router-pipeline.ts 的 configure() 期望从中读取 routers 和 pipeline。
       c) 用户通过 Dashboard 修改 routers 配置后，热重载可能丢失这些字段。
 建议：在 PrivacyConfig 类型中添加：
       ```
       routers?: Record<string, RouterRegistration>;
       pipeline?: PipelineConfig;
       ```

       并更新 live-config.ts 的 mergeConfig 来合并这两个字段。


#### 🔴 live-config.ts mergeConfig 遗漏 routers / pipeline / toolAllowlist


 现状（live-config.ts L60-L86）：mergeConfig 逐字段深度合并了
       checkpoints、rules、localModel、guardAgent、session、
       localProviders、modelPricing、redaction，但遗漏了：
       - routers（路由器注册表）
       - pipeline（路由管线配置）
       - toolAllowlist（工具白名单）
 问题：用户通过 Dashboard 或 guardclaw.json 配置这些字段时，
       热重载后它们不会出现在 liveConfig 中。toolAllowlist 虽在
       defaultPrivacyConfig 中有默认值，但 mergeConfig 用顶层
       spread `{ ...defaultPrivacyConfig, ...userConfig }` 可以覆盖，
       routers 和 pipeline 的深度合并则完全缺失。
 建议：在 mergeConfig 中添加：
       ```
       routers: { ...defaultPrivacyConfig.routers, ...userConfig.routers },
       pipeline: { ...defaultPrivacyConfig.pipeline, ...userConfig.pipeline },
       toolAllowlist: [
         ...defaultPrivacyConfig.toolAllowlist,
         ...(userConfig.toolAllowlist ?? []),
       ],
       ```


#### 🟡 detector.ts mergeWithDefaults 与 live-config.ts mergeConfig 重复


 现状：detector.ts L180-L236 有一个 mergeWithDefaults 函数，
       privacy.ts L78-L96 有一个 getPrivacyConfig 函数，
       live-config.ts L60-L86 有一个 mergeConfig 函数。
       三者功能几乎一致——将用户配置与默认配置深度合并。
 问题：三套合并逻辑独立维护，行为不完全一致：
       - live-config.ts 合并了 modelPricing 和 redaction
       - detector.ts 完全没合并 modelPricing、redaction、localProviders
       - privacy.ts 没合并 modelPricing、redaction、localProviders
       当 defaultPrivacyConfig 新增字段时，三处都需要更新。
 建议：抽取统一的 mergePrivacyConfig(user, defaults) 函数到
       config-schema.ts 中，所有消费方统一调用。


#### 🟡 configurable.ts getPrivacyConfig 不合并默认值


 现状（configurable.ts L47-L49）：
       ```
       function getPrivacyConfig(pluginConfig: Record<string, unknown>): PrivacyConfig {
         return (pluginConfig?.privacy ?? {}) as PrivacyConfig;
       }
       ```

 问题：直接返回用户配置，不与 defaultPrivacyConfig 合并。
       如果用户只配置了部分字段（例如 s2Policy 但没配 localModel），
       后续代码访问 pCfg.localModel?.endpoint 会得到 undefined。
       而 privacy.ts 的 getPrivacyConfig 会合并默认值，行为不一致。
 建议：使用统一的合并函数（见建议 #7）。


#### 🟡 schema 中 checkpoints 枚举只有两个值，但系统可能扩展


 现状（L21, L26, L31）：checkpoints 的检测器数组元素类型为
       Type.Union([Type.Literal("ruleDetector"), Type.Literal("localModelDetector")])
 问题：如果后续添加新的检测器类型（如 "embeddingDetector"），
       需要在三个检查点的 schema 定义中各改一次。
 建议：提取公共的 detectorType schema：
       ```
       const DetectorTypeSchema = Type.Union([
         Type.Literal("ruleDetector"),
         Type.Literal("localModelDetector"),
       ]);
       ```

       在三个检查点中复用 Type.Array(DetectorTypeSchema)。


#### 🟢 modelPricing 默认值中的模型名可能过时


 现状（L193-L202）：内置了 "claude-sonnet-4.6"、"gpt-4o" 等模型名和价格。
 问题：模型名和定价会随 API 提供商更新而变化。硬编码在源码中
       意味着每次价格变动都需要修改代码并重新发布。
 建议：考虑将默认定价表移到外部配置文件（如 pricing.json），
       或在注释中标注"最后更新日期"以便维护。
## 优先级总览


| 优先级 | ID | 标题 |
| --- | --- | --- |
| 🔴 | 5 | PrivacyConfig 缺少 routers / pipeline 字段 |
| 🔴 | 6 | live-config mergeConfig 遗漏 routers/pipeline/allowlist |
| 🟡 | 1 | defaultPrivacyConfig 缺少类型注解 |
| 🟡 | 4 | localModel.provider 默认值缺失 |
| 🟡 | 7 | 三处 mergeConfig 重复且行为不一致 |
| 🟡 | 8 | configurable.ts getPrivacyConfig 不合并默认值 |
| 🟡 | 9 | schema 中 detectorType 枚举重复定义 |
| 🟢 | 2 | 大量冗余 `as` 类型断言 |
| 🟢 | 3 | schema 与 PrivacyConfig 手动同步 |
| 🟢 | 10 | modelPricing 默认值可能过时 |
