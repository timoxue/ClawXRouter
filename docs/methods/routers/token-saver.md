# token-saver.ts — 逐方法文档


 文件定位：Token-Saver 路由器 — 基于 LLM-as-Judge 的模型降级路由
 所属模块：GuardClaw 隐私路由系统

 核心职责：
   使用本地 LLM 对用户请求的复杂度进行分级（SIMPLE / MEDIUM / COMPLEX / REASONING），
   然后将请求路由到能够胜任该分级的最便宜模型，从而节省 token 开销。
   这是一个 **优化型** 路由器（非安全型），在管线中权重较低，仅在安全路由器
   （privacy）放行后才起作用。

 术语：
   Tier — 任务复杂度分级：SIMPLE / MEDIUM / COMPLEX / REASONING
   Judge — 用于分类复杂度的本地 LLM（如 MiniCPM）
   Prompt-hash Cache — 基于 SHA-256 哈希的分类缓存，避免重复调用 LLM
## 类型：Tier                                    (L23)


任务复杂度分级的联合类型。

可选值：
  "SIMPLE"    — 简单任务：查询、翻译、格式化、是/否问答
  "MEDIUM"    — 中等任务：代码生成、数据分析、单文件编辑
  "COMPLEX"   — 复杂任务：系统设计、多文件重构、架构决策
  "REASONING" — 推理任务：数学证明、形式逻辑、算法正确性论证
## 类型：TokenSaverConfig                        (L25-L34)


Token-Saver 路由器的完整配置结构。

字段说明：
  enabled: boolean
      是否启用 token-saver 路由器（默认 false）
  judgeEndpoint: string
      Judge LLM 的 API 端点地址
  judgeModel: string
      Judge LLM 的模型名称
  judgeProviderType: EdgeProviderType
      Judge LLM 的 API 协议类型（"openai-compatible" / "ollama-native" / "custom"）
  judgeCustomModule?: string
      自定义 Provider 模块路径（仅 type="custom" 时使用）
  judgeApiKey?: string
      Judge LLM 的 API Key（如需鉴权）
  tiers: Record<Tier, { provider: string; model: string }>
      每个复杂度分级对应的目标 provider + model
  cacheTtlMs: number
      分类缓存的 TTL（毫秒），默认 300_000（5 分钟）
## 常量：DEFAULT_CONFIG                          (L36-L48)


### 作用

  Token-Saver 路由器的默认配置。所有未由用户显式覆盖的字段都从此取值。

### 逐行逻辑


**L37**:
```typescript
enabled: false
```
> 默认关闭。用户需在配置中显式 opt-in 才会启用 token-saver。


**L38**:
```typescript
judgeEndpoint: "http://localhost:11434"
```
> 默认指向本地 Ollama 端点。


**L39**:
```typescript
judgeModel: "openbmb/minicpm4.1"
```
> 默认使用 MiniCPM 4.1 作为 judge，轻量且够用。


**L40**:
```typescript
judgeProviderType: "openai-compatible"
```
> 默认使用 OpenAI-compatible 协议（/v1/chat/completions）。


**L41-L46**:
```typescript
tiers 映射
```
> SIMPLE   → gpt-4o-mini（最便宜）
> MEDIUM   → gpt-4o（中等）
> COMPLEX  → claude-sonnet-4.6（高质量）
> REASONING → o4-mini（推理专用）
> 这个梯度设计体现了 "用最便宜的能力匹配任务" 的核心理念。


**L47**:
```typescript
cacheTtlMs: 300_000
```
> 5 分钟缓存 TTL。同一 prompt 在 5 分钟内不会重新调用 judge。

## 常量：DEFAULT_JUDGE_PROMPT                    (L50-L62)


### 作用

  Judge LLM 的系统提示词，指导它把用户任务分到 4 个复杂度等级之一。
  可通过 prompts/token-saver-judge.md 文件覆盖（由 loadPrompt 加载）。

### 关键规则

  - 不确定时选更低的等级（省 token）
  - 短提示（< 20 词）且无技术深度 → SIMPLE
  - 包含代码块不等于 COMPLEX（短代码片段审查是 MEDIUM）
  - 输出格式：纯 JSON {"tier":"..."}

### 设计意图

  prompt 被设计为"偏保守"——宁可低估复杂度（用便宜模型处理可能略难的任务），
  也不高估（浪费昂贵模型资源）。这与安全路由器的"宁可高估敏感度"策略相反。
## 类型：CacheEntry                              (L66)


缓存条目：记录一个 prompt 哈希对应的分级结果和缓存时间戳。

字段说明：
  tier: Tier     — 缓存的复杂度分级
  ts: number     — 缓存写入时的 Date.now() 时间戳
## 模块级变量：classificationCache / cleanupTimer (L67-L72)


classificationCache: Map<string, CacheEntry>
  以 prompt 的 SHA-256 前 16 字符为 key，缓存 LLM judge 的分级结果。
  模块级单例，所有请求共享。

CACHE_CLEANUP_INTERVAL_MS: 60_000 (1 分钟)
  定时清理过期缓存条目的间隔。

CACHE_MAX_AGE_MS: 600_000 (10 分钟)
  清理器使用的最大年龄。注意：这与 config.cacheTtlMs 不同——
  cacheTtlMs（默认 5 分钟）控制缓存命中判断，CACHE_MAX_AGE_MS（10 分钟）
  控制清理器何时删除条目。这意味着条目在 5-10 分钟之间是"过期但未删除"的状态。

cleanupTimer: 清理定时器引用，确保只启动一次。
## 函数：startCacheCleanup()                     (L74-L85)


### 作用

  启动一个每 60 秒运行一次的定时器，清除 classificationCache 中
  超过 CACHE_MAX_AGE_MS（10 分钟）的过期条目。

### 参数

  无

### 返回值

  void

### 逐行逻辑


**L75**:
```typescript
if (cleanupTimer) return;
```
> 防止重复启动：如果定时器已存在则直接返回。


**L76-L81**:
```typescript
cleanupTimer = setInterval(() => { ... }, CACHE_CLEANUP_INTERVAL_MS);
```
> 每 60 秒遍历 classificationCache 的全部条目，
> 删除 ts 距今超过 CACHE_MAX_AGE_MS（10 分钟）的条目。
> 使用 for-of 遍历 Map，调用 Map.delete() 在迭代中删除是安全的。


**L82-L84**:
```typescript
if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer)
```
> 调用 .unref() 使定时器不阻止 Node.js 进程退出。
> 需要类型守卫是因为 setInterval 在不同环境返回类型不同
> （Node.js 返回 Timeout 对象，浏览器返回 number）。


### 设计意图

  惰性启动清理器——只在第一次实际使用缓存时才启动，避免未启用 token-saver
  时产生无用的定时器。.unref() 确保不会阻止进程优雅退出。
## 函数：hashPrompt(prompt)                      (L89-L91)


### 作用

  对用户提示进行 SHA-256 哈希，取前 16 个十六进制字符作为缓存 key。

### 参数

  prompt: string — 用户的原始提示文本

### 返回值

  string — 16 字符的十六进制哈希摘要

### 逐行逻辑


**L90**:
```typescript
return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
```
> 使用 Node.js crypto 模块生成 SHA-256 完整哈希（64 字符 hex），
> 然后截取前 16 字符。16 hex = 64 bit，对于缓存 key 的碰撞概率
> 足够低（~2^32 个不同 prompt 才会产生 50% 碰撞概率）。


### 设计意图

  用哈希而非原始 prompt 作为缓存 key，避免长 prompt 占用过多内存。
  截取 16 字符是空间和碰撞风险的平衡。
## 常量：VALID_TIERS                             (L93)


Set<Tier>，包含 4 个合法分级值。用于 parseTier() 中的快速验证。
## 函数：parseTier(response)                     (L95-L107)


### 作用

  从 LLM judge 的文本响应中提取复杂度分级。
  处理推理模型可能输出的 <think>...</think> 标签和格式变异。

### 参数

  response: string — LLM judge 的原始响应文本

### 返回值

  Tier — 解析出的分级，解析失败时 fallback 为 "MEDIUM"

### 逐行逻辑


**L97**:
```typescript
const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
```
> 移除推理模型（如 MiniCPM、Qwen3）可能输出的 <think>...</think>
> 思考链内容。使用非贪婪匹配 [\s\S]*? 处理多行。


**L98**:
```typescript
const match = cleaned.match(/\{[\s\S]*?"tier"\s*:\s*"([A-Z]+)"[\s\S]*?\}/);
```
> 用正则从清理后的文本中提取 JSON 对象中的 tier 字段值。
> 比 JSON.parse 更宽容——即使 JSON 有额外字段或格式瑕疵也能提取。
> 只匹配全大写字母 [A-Z]+，确保提取的是预期的枚举值。


**L99-L101**:
```typescript
if (match) { const tier = match[1] as Tier; if (VALID_TIERS.has(tier)) return tier; }
```
> 验证提取出的值确实在 VALID_TIERS 集合中。
> as Tier 是类型断言，实际安全性由 VALID_TIERS.has() 保证。


**L103-L105**:
```typescript
catch { // parse failure }
```
> 吞掉所有异常（不太可能发生，因为 replace + match 不会抛异常，
> 但作为防御性编程保留）。


**L106**:
```typescript
return "MEDIUM";
```
> 解析失败时的 fallback：MEDIUM 是中间档位，
> 不会过度浪费（COMPLEX）也不会质量太差（SIMPLE）。


### 设计意图

  对 LLM 输出采取"尽力解析、安全回退"策略。fallback 选 MEDIUM 而非 SIMPLE，
  是因为如果 LLM 无法正确输出 JSON，说明请求本身可能有一定复杂度。
## 函数：buildDecision(tier, config)             (L109-L121)


### 作用

  根据复杂度分级和配置，构造一个 RouterDecision 对象，
  将请求重定向到匹配的 provider/model。

### 参数

  tier: Tier                — 已确定的复杂度分级
  config: TokenSaverConfig  — 当前有效配置

### 返回值

  RouterDecision — 路由决策（action 为 "redirect" 或 "passthrough"）

### 逐行逻辑


**L110**:
```typescript
const target = config.tiers[tier];
```
> 从配置的 tiers 映射中查找当前分级对应的 provider + model。


**L111-L113**:
```typescript
if (!target) { return { level: "S1", action: "passthrough", reason: ... }; }
```
> 如果配置中没有该分级的映射（理论上不应发生，除非配置被部分覆盖），
> 则回退为 passthrough（不干预路由）。


**L114-L121**:
```typescript
return { level: "S1", action: "redirect", target: ..., reason: ..., confidence: 0.8 };
```
> 正常情况：构造一个 redirect 决策。
> level 始终设为 "S1"——token-saver 不涉及隐私敏感度判断，
> 它只做模型选择优化。
> confidence 固定为 0.8——表示较高但非绝对的信心。
> reason 记录分级结果如 "tier=SIMPLE"。


### 设计意图

  token-saver 的所有决策都在 S1 层级——它不提升敏感度，只在安全路由器放行后
  决定用哪个云端模型处理请求。这保证了安全路由器的决策优先级始终更高。
## 函数：resolveConfig(pluginConfig)             (L123-L160)


### 作用

  从插件全局配置中提取 token-saver 的运行时配置，
  合并用户配置和默认值。

### 参数

  pluginConfig: Record<string, unknown> — 插件的完整配置对象

### 返回值

  TokenSaverConfig — 完整的 token-saver 配置（所有字段已填充）

### 逐行逻辑


**L124-L126**:
```typescript
const routers = (pluginConfig?.privacy as ...)?.routers as ...;
```
> 从 pluginConfig.privacy.routers 中提取路由器注册表。
> 多级可选链 + as 类型断言处理嵌套的 unknown 类型。


**L127**:
```typescript
const tsConfig = routers?.["token-saver"];
```
> 取出 "token-saver" 这个路由器的注册配置。


**L128**:
```typescript
const options = (tsConfig?.options ?? {}) as Record<string, unknown>;
```
> 取出路由器的 options 子对象，这是 token-saver 特有的配置项。


**L130-L132**:
```typescript
const privacyLocalModel = (pluginConfig?.privacy as ...)?.localModel as ...;
```
> 同时读取 privacy.localModel 作为 judge 配置的备用来源。
> 这样用户如果已经配置了 privacy.localModel，token-saver 可以复用，
> 无需重复配置。


**L134-L159**:
```typescript
return { ... };
```
> 构造最终配置，每个字段的优先级链为：
> options.xxx  ??  privacyLocalModel.xxx  ??  DEFAULT_CONFIG.xxx
> 即：token-saver 专有配置 > 全局 localModel 配置 > 默认值。


**L135**:
```typescript
enabled: tsConfig?.enabled ?? DEFAULT_CONFIG.enabled
```
> enabled 从路由器注册配置读取（非 options），因为它是 RouterRegistration
> 的标准字段。


**L136-L147**:
```typescript
judgeEndpoint / judgeModel / judgeProviderType
```
> 三级 fallback 链。例如 judgeEndpoint：
> options.judgeEndpoint → privacyLocalModel.endpoint → DEFAULT_CONFIG.judgeEndpoint


**L148-L153**:
```typescript
judgeCustomModule / judgeApiKey
```
> 两级 fallback（无 DEFAULT_CONFIG 默认值，因为这些是可选的认证/模块字段）。


**L154-L157**:
```typescript
tiers: { ...DEFAULT_CONFIG.tiers, ...(options.tiers ?? {}) }
```
> 用展开运算符合并 tiers：用户只需覆盖想改的分级，其他保留默认值。


**L158**:
```typescript
cacheTtlMs: (options.cacheTtlMs as number) ?? DEFAULT_CONFIG.cacheTtlMs
```
> 缓存 TTL 可配置。


### 设计意图

  三级 fallback 设计让配置更灵活：大部分用户只需配置全局的 privacy.localModel，
  token-saver 自动复用，无需重复声明 judge 的 endpoint/model。
  高级用户可以通过 options.judgeXxx 指定独立的 judge 模型。
## 路由器实例：tokenSaverRouter                  (L164-L236)


实现 GuardClawRouter 接口的路由器实例。
id = "token-saver"
方法：tokenSaverRouter.detect(context, pluginConfig)
                                              (L167-L235)

### 作用

  Token-Saver 路由器的核心检测方法。判断用户请求的复杂度，
  并返回一个将请求路由到匹配模型的 RouterDecision。

### 参数

  context: DetectionContext          — 检测上下文（含 message, sessionKey, dryRun 等）
  pluginConfig: Record<string, unknown> — 插件的完整配置

### 返回值

  Promise<RouterDecision> — 路由决策：
    - passthrough：不干预（未启用 / 子代理 / 空消息 / 失败）
    - redirect：重定向到 tier 对应的目标模型

### 逐行逻辑


**L171**:
```typescript
const config = resolveConfig(pluginConfig);
```
> 解析并合并配置。


**L172-L174**:
```typescript
if (!config.enabled && !context.dryRun) { return passthrough; }
```
> 未启用时直接放行。dryRun 模式下（来自 dashboard 测试）跳过 enabled 检查，
> 与 privacy.ts 的 dryRun 处理方式一致。


**L178**:
```typescript
const isSubagent = context.sessionKey?.includes(":subagent:") ?? false;
```
> 通过检查 sessionKey 中是否包含 ":subagent:" 标记来判断是否为子代理会话。
> 子代理（如 GuardAgent）有自己的默认模型，不需要 token-saver 介入。


**L179-L181**:
```typescript
if (isSubagent) { return passthrough with reason; }
```
> 子代理直接跳过，避免为每条子代理消息调用一次 judge LLM。


**L183**:
```typescript
const prompt = context.message ?? "";
```
> 取出用户消息文本。


**L184-L186**:
```typescript
if (!prompt.trim()) { return passthrough; }
```
> 空消息没有分类的意义，直接放行。


**L188**:
```typescript
startCacheCleanup();
```
> 确保缓存清理定时器已启动（惰性初始化，首次到达此处时启动）。


**L191**:
```typescript
const cacheKey = hashPrompt(prompt);
```
> 计算 prompt 的 SHA-256 前 16 字符作为缓存 key。


**L192-L195**:
```typescript
const cached = classificationCache.get(cacheKey); if (cached && ...) { ... }
```
> 检查缓存：如果缓存命中且未超过 cacheTtlMs，直接返回缓存的分级决策。
> 注意这里用的是 config.cacheTtlMs（默认 5 分钟），
> 与清理器的 CACHE_MAX_AGE_MS（10 分钟）不同。


**L199**:
```typescript
const judgeSystemPrompt = loadPrompt("token-saver-judge", DEFAULT_JUDGE_PROMPT);
```
> 尝试从 prompts/token-saver-judge.md 文件加载自定义 prompt，
> 找不到则使用 DEFAULT_JUDGE_PROMPT 作为 fallback。
> 这使得用户可以在不修改代码的情况下调整 judge 的分类标准。


**L200-L214**:
```typescript
const result = await callChatCompletion(...);
```
> 调用 callChatCompletion()，传入 judge 的 endpoint/model/messages 和选项。
> temperature: 0 — 确保分类结果稳定、可复现。
> maxTokens: 1024 — judge 应只输出一个小 JSON，但留出余量
> 以防推理模型输出 <think> 标签。
> providerType / customModule / apiKey — 透传 judge 的连接配置。


**L217-L226**:
```typescript
if (result.usage) { ... collector?.record({ ... }); }
```
> 如果 LLM 返回了 usage 信息（token 计数），
> 将其记录到全局 TokenStatsCollector，source 标记为 "router"
> 表示这是路由开销（非实际任务 token）。
> 这允许 dashboard 区分"用于分类的 token 开销"和"用于任务的 token 开销"。


**L228**:
```typescript
const tier = parseTier(result.text);
```
> 解析 LLM 响应中的 tier 值。


**L229**:
```typescript
classificationCache.set(cacheKey, { tier, ts: Date.now() });
```
> 将分类结果写入缓存，供后续相同/相似 prompt 复用。


**L230**:
```typescript
return buildDecision(tier, config);
```
> 根据 tier 构造最终的 RouterDecision。


**L231-L234**:
```typescript
catch (err) { console.error(...); return passthrough; }
```
> LLM 调用失败时的容错处理：记录错误日志，返回 passthrough。
> 这保证了 judge 故障不会阻断正常请求——只是退化为不做模型优化。


### 设计意图

  detect() 方法的整体策略是"安全第一，优化第二"：
  1. 多层短路条件（未启用、子代理、空消息、缓存命中）避免不必要的 LLM 调用
  2. LLM 调用失败时 graceful degradation 为 passthrough
  3. 所有决策都在 S1 层级，确保不影响安全路由器的判断
  4. usage 记录让运营方能看到 judge 本身消耗了多少 token
## 导出列表                                       (L238-L241)


生产导出：
  tokenSaverRouter — 路由器实例，供 router-pipeline 注册使用

测试导出：
  parseTier            — 解析 LLM 响应中的 tier
  hashPrompt           — SHA-256 前 16 字符哈希
  classificationCache  — 缓存 Map（测试中可直接操作）
  resolveConfig        — 配置解析逻辑
  DEFAULT_CONFIG       — 默认配置常量
  DEFAULT_JUDGE_PROMPT — 默认 judge 提示词
  Tier, TokenSaverConfig — 类型导出
---

## Code Review — 代码审查

## Part A — Code 层面改动建议


#### 🟡 cacheTtlMs vs CACHE_MAX_AGE_MS 双 TTL 令人困惑


 现状（L69-L70, L193）：
   CACHE_MAX_AGE_MS = 600_000（10 分钟）用于定时清理，
   config.cacheTtlMs = 300_000（5 分钟）用于缓存命中判断。
 问题：
   两个独立的 TTL 参数控制同一个缓存的不同生命周期阶段，
   容易产生混淆。条目在 5-10 分钟之间处于"过期但未删除"状态，
   浪费内存。如果用户把 cacheTtlMs 调到 > 10 分钟，
   清理器会在缓存还"有效"时就删除条目。
 建议：
   清理器应使用 config.cacheTtlMs 或其倍数（如 2x）作为清理阈值，
   而非独立的硬编码常量。或者直接在缓存命中检查时删除过期条目
   （lazy eviction），移除定时清理器。


#### 🟢 缓存无容量上限


 现状（L67）：
   classificationCache 是一个无容量限制的 Map。
 问题：
   如果系统处理大量不同 prompt，缓存会无限增长。
   虽然定时清理器会删除过期条目，但在高吞吐场景下
   清理间隔（60 秒）内可能积累大量条目。
 建议：
   参考 rules.ts 的 PATTERN_CACHE_MAX = 500 模式，
   添加一个最大容量限制，超出时 evict 最旧条目。


#### 🟢 hardcoded confidence 值


 现状（L119）：
   confidence 硬编码为 0.8。
 问题：
   所有分级的 confidence 相同，无法反映实际分类的可靠程度。
   例如 SIMPLE（短消息）和 REASONING（长复杂消息）的分类信心
   可能不同。
 建议：
   可以考虑让 judge prompt 同时输出 confidence，
   或根据 tier 设置不同的默认 confidence 值。
   低优先级——当前 confidence 主要用于 pipeline 加权平均，
   对最终路由决策影响不大。


#### 🟢 parseTier 中 try-catch 无实际必要


 现状（L96-L105）：
   整个解析逻辑包在 try-catch 中。
 问题：
   String.replace() 和 String.match() 不会抛异常，
   try-catch 是多余的。
 建议：
   可以移除 try-catch，简化代码。或保留作为未来扩展的防御——
   影响极小，纯风格问题。
## Part B — 逻辑/设计层面改动建议


#### 🔴 routerId 未设置在 RouterDecision 中


 现状（L109-L121, L172-L174）：
   buildDecision() 和 detect() 的所有 return 语句都没有设置
   routerId 字段。
 问题：
   router-pipeline.ts 的 runGroup()（L217-L219）会在调用后
   手动设置 d.routerId = id，所以从 pipeline 走的路径没问题。
   但 runSingle()（L260-L262）也会设置 routerId。
   然而如果直接调用 tokenSaverRouter.detect()（绕过 pipeline），
   返回的 RouterDecision 没有 routerId，导致日志和调试信息缺失。
   对比 privacy.ts——privacy 路由器也没有自己设置 routerId，
   所以这是所有路由器的共同问题。但作为最佳实践，路由器应自己
   设置 routerId。
 建议：
   在 buildDecision() 返回的对象中添加 routerId: "token-saver"，
   并在 detect() 的每个 early return 中也添加。
   或者在 detect() 的末尾统一添加一个 wrapper。


#### 🔴 detect() 只检查 context.message，忽略 toolName/toolParams/toolResult


 现状（L183-L184）：
   detect() 只从 context.message 获取文本进行分类。
 问题：
   DetectionContext 接口还包含 toolName、toolParams、toolResult 等字段。
   当 checkpoint 为 onToolCallProposed 或 onToolCallExecuted 时，
   message 可能为空，但 toolName/toolParams 中可能有判断复杂度的有用信息。
   例如一个 "read_file" 工具调用是 SIMPLE，而一个 "run_terminal_command"
   可能是 COMPLEX。
   对比 configurable.ts——它虽然也只检查 message，但它有 keyword/pattern
   作为后备。token-saver 完全依赖 LLM judge，message 为空时就直接放行了。
 建议：
   当 message 为空但 toolName 存在时，可以将 toolName + toolParams
   组合成一个文本传给 judge。或者对 tool checkpoint 直接 passthrough
   并在注释中明确说明这是有意为之的设计（当前的空消息检查看起来像是
   遗漏而非有意）。


#### 🟡 resolveConfig 未合并 defaultPrivacyConfig


 现状（L123-L160）：
   resolveConfig() 从 pluginConfig.privacy.routers["token-saver"].options
   和 pluginConfig.privacy.localModel 读取配置，与 DEFAULT_CONFIG 合并。
 问题：
   对比 privacy.ts 的 getPrivacyConfig()（L78-L96），它用
   { ...defaultPrivacyConfig, ...userConfig } 做深度合并。
   token-saver 的 resolveConfig() 虽然也实现了类似的逐字段合并，
   但它维护了自己独立的 DEFAULT_CONFIG，与 defaultPrivacyConfig.localModel
   的默认值可能不同步。例如如果 defaultPrivacyConfig.localModel.model
   被修改为其他模型，token-saver 的 judgeModel 不会自动跟随。
 建议：
   考虑让 DEFAULT_CONFIG 的 judgeEndpoint/judgeModel 直接引用
   defaultPrivacyConfig.localModel 对应的值，而非硬编码字面量。
   这样两处配置保持同步。


#### 🟡 judge 调用无超时控制


 现状（L200-L214）：
   callChatCompletion() 内部使用 GUARDCLAW_FETCH_TIMEOUT_MS = 60_000
   （60 秒）的 AbortSignal.timeout。
 问题：
   对于一个只需要输出 {"tier":"SIMPLE"} 的 judge 调用来说，
   60 秒超时太长了。如果本地模型卡死或响应极慢，
   请求会被阻塞很久才 fallback 到 passthrough。
   这对用户体验影响大——用户在等待模型路由时会感知到明显延迟。
 建议：
   在 callChatCompletion 的 options 中传入一个更短的超时
   （如 10-15 秒），或在 detect() 中用 Promise.race()
   加一个自定义超时。


#### 🟡 S2-proxy 场景下 token-saver 的行为可能冗余


 现状：
   router-pipeline.ts（L340-L358）中的 mergeDecisionsWeighted()
   特别处理了 S2-proxy + token-saver 的场景——当 privacy 路由器
   返回 S2-proxy 时，会采纳 token-saver 选择的 model 作为 proxy
   的目标模型。
 问题：
   token-saver 在 detect() 中完全不感知 privacy 路由器的结果，
   它只根据消息复杂度选模型。pipeline 层面的合并逻辑虽然正确，
   但 token-saver 不知道最终请求会走 proxy 还是直连，
   可能选择了一个在 proxy 模式下不支持的模型。
 建议：
   这更多是一个架构层面的观察。当前设计是可行的（pipeline 负责协调），
   但如果未来 proxy 有模型限制，可能需要让 token-saver 感知上游决策。


#### 🟢 缺少 dryRun 结果中的诊断信息


 现状（L172-L174）：
   dryRun 模式下跳过 enabled 检查，正常执行 judge 调用。
 问题：
   dryRun 的结果与正常模式完全相同，但 dashboard 测试页面
   可能希望看到更多诊断信息（如 judge 的原始响应、缓存命中/未命中状态等）。
 建议：
   在 dryRun 模式下，可以在 RouterDecision 的 reason 中附加
   额外的诊断文本（如 "cache=hit" 或 "judge_raw=..."），
   方便调试。低优先级。
## 优先级总览


| 优先级 | 编号 | 标题 |
| --- | --- | --- |
| 🔴 高 | 5 | routerId 未设置在 RouterDecision 中 |
| 🔴 高 | 6 | 只检查 message，忽略 tool 上下文 |
| 🟡 中 | 1 | 双 TTL 令人困惑 |
| 🟡 中 | 7 | 未与 defaultPrivacyConfig 同步 |
| 🟡 中 | 8 | judge 调用缺少短超时 |
| 🟡 中 | 9 | S2-proxy 场景下可能冗余 |
| 🟢 低 | 2 | 缓存无容量上限 |
| 🟢 低 | 3 | hardcoded confidence 值 |
| 🟢 低 | 4 | parseTier 中无用的 try-catch |
| 🟢 低 | 10 | dryRun 缺少诊断信息 |
