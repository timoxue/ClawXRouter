# configurable.ts — 逐方法文档


 文件定位：可配置路由器（Configurable Router）
 所属模块：GuardClaw 隐私路由系统

 核心职责：提供一个通用的、可由 Dashboard UI 动态创建和配置的路由器。
 每个实例在运行时从 pluginConfig 中读取自身的 keywords / patterns / prompt
 等选项，实现"关键词匹配 → 正则匹配 → LLM 分类"的三级敏感度检测，
 并根据结果决定消息的路由动作（放行 / 重定向 / 阻断等）。

 敏感等级体系：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理或本地模型
   S3 — 高度敏感，强制本地模型处理
## 接口：ConfigurableRouterOptions                (L30-L35)


定义一个可配置路由器实例所接受的全部选项。

字段说明：
  keywords?: { S2?: string[]; S3?: string[] }
      关键词列表。文本中出现对应关键词时触发相应敏感等级。

  patterns?: { S2?: string[]; S3?: string[] }
      正则表达式列表。文本匹配对应正则时触发相应敏感等级。

  prompt?: string
      可选的 LLM 系统提示词。如果配置了此字段且本地模型可用，
      路由器会将消息发送给 LLM 进行语义级别的敏感度分类。

  action?: string
      匹配后的动作，默认 "redirect"。
      可选值参见 RouterAction: "passthrough" | "redirect" | "transform" | "block"
## 函数：getOptions(routerId, pluginConfig)        (L37-L45)


### 作用

  从全局插件配置中提取指定路由器的选项（ConfigurableRouterOptions）。

### 参数

  routerId: string — 路由器的唯一标识符（在 routers 字典中的 key）。
  pluginConfig: Record<string, unknown> — 完整的插件配置对象。

### 返回值

  ConfigurableRouterOptions — 该路由器的 options 子对象；若不存在则 {}。

### 逐行逻辑


**L41**:
```typescript
const privacy = (pluginConfig?.privacy ?? {}) as Record<string, unknown>;
```
> 从 pluginConfig 取 privacy 属性。
> 如果 pluginConfig 为 null/undefined，?. 短路为 undefined。
> ?? {} 确保 privacy 至少是空对象，不会后续取值时报错。
> as Record<string, unknown> 做类型断言供后续安全访问。


**L42**:
```typescript
const routers = (privacy.routers ?? {}) as Record<string, RouterRegistration>;
```
> 从 privacy 中取 routers 字典。
> 同样 ?? {} 防御 undefined，断言为 routerId → RouterRegistration 的映射。


**L43**:
```typescript
const reg = routers[routerId];
```
> 以传入的 routerId 作为 key，从 routers 字典中查找对应的注册记录。
> 如果该 routerId 尚未注册，reg 为 undefined。


**L44**:
```typescript
return (reg?.options ?? {}) as ConfigurableRouterOptions;
```
> 返回注册记录的 options 字段。
> reg?.options：如果 reg 为 undefined 则短路为 undefined。
> ?? {}：兜底返回空对象，确保调用方不需要做 null 检查。
> 最终断言为 ConfigurableRouterOptions 类型。


### 设计意图

  每次 detect() 调用都经过此函数实时读取配置，Dashboard 的改动即时生效。
  四层可选链 + 空值合并保证了在任何配置缺失场景下都不会抛出异常。
## 函数：getPrivacyConfig(pluginConfig)            (L47-L49)


### 作用

  从插件配置中提取 privacy 顶层配置，类型断言为 PrivacyConfig。

### 参数

  pluginConfig: Record<string, unknown>

### 返回值

  PrivacyConfig — 包含 localModel、s2Policy、guardAgent 等完整隐私配置。

### 逐行逻辑


**L48**:
```typescript
return (pluginConfig?.privacy ?? {}) as PrivacyConfig;
```
> pluginConfig?.privacy：安全取出 privacy 字段。
> ?? {}：如果为 undefined/null，回退到空对象。
> as PrivacyConfig：类型断言，让后续调用方可以按 PrivacyConfig 的
> 结构（localModel, s2Policy, guardAgent 等）访问属性。


### 设计意图

  纯辅助函数，消除各处重复的 pluginConfig.privacy 提取和类型断言。
  被 classifyWithPrompt() 和 resolveTargetForLevel() 复用。
## 函数：checkKeywords(text, keywords)             (L51-L66)


### 作用

  对输入文本执行关键词匹配，返回匹配到的最高敏感等级。

### 参数

  text: string — 待检测的文本内容（通常是用户消息）。
  keywords: { S2?: string[]; S3?: string[] } — 按等级分组的关键词列表。

### 返回值

  { level: SensitivityLevel; reason?: string }

### 逐行逻辑


**L55**:
```typescript
for (const kw of keywords.S3 ?? []) {
```
> 遍历 S3 级别的关键词数组。
> ?? [] 防御 keywords.S3 为 undefined 时，for-of 不报错。
> **S3 优先检查**：因为 S3 是最高敏感级别，一旦命中可以立即返回。


**L56**:
```typescript
if (getKeywordRegex(kw).test(text)) {
```
> getKeywordRegex(kw)：将关键词转换为智能正则表达式。
> - 对特殊字符做转义（如 . * + 等）
> - 以 "." 开头的关键词（如 .env）只加后边界 (?![a-zA-Z0-9])
> - 其他关键词加前后词边界，支持中英文混合匹配
> - 内部有正则缓存(keywordRegexCache)，同一关键词只构造一次
> .test(text)：对输入文本执行正则匹配。


**L57**:
```typescript
return { level: "S3", reason: `S3 keyword: ${kw}` };
```
> 命中 S3 关键词，立即返回，携带命中原因字符串。
> 短路返回：不再继续检查其他 S3 或 S2 关键词。


**L60**:
```typescript
for (const kw of keywords.S2 ?? []) {
```
> 只有所有 S3 关键词都未命中时，才进入 S2 关键词的遍历。


**L61**:
```typescript
if (getKeywordRegex(kw).test(text)) {
```
> 逻辑与 L56 完全相同，只是等级变成 S2。


**L62**:
```typescript
return { level: "S2", reason: `S2 keyword: ${kw}` };
```
> 命中 S2 关键词，立即返回。


**L65**:
```typescript
return { level: "S1" };
```
> 所有关键词都未命中，返回 S1（安全/无敏感）。
> 不携带 reason，因为"无匹配"不需要解释。


### 设计意图

  高优先级短路：S3 → S2 → S1，一旦命中高级别就不再检查低级别。
  getKeywordRegex() 的缓存机制避免了频繁创建正则对象的性能开销。
## 函数：checkPatterns(text, patterns)             (L68-L87)


### 作用

  对输入文本执行正则表达式匹配，返回匹配到的最高敏感等级。

### 参数

  text: string — 待检测的文本。
  patterns: { S2?: string[]; S3?: string[] } — 按等级分组的正则字符串列表。

### 返回值

  { level: SensitivityLevel; reason?: string }

### 逐行逻辑


**L72**:
```typescript
for (const pat of patterns.S3 ?? []) {
```
> 遍历 S3 正则列表。?? [] 防御 undefined。


**L73**:
```typescript
try {
```
> 用 try-catch 包裹正则构造和测试，
> 因为 pat 是用户输入的字符串，可能不是合法正则。


**L74**:
```typescript
if (new RegExp(pat, "i").test(text)) {
```
> new RegExp(pat, "i")：动态构造正则，"i" 标志表示大小写不敏感。
> 与 checkKeywords 不同，这里不经过 getKeywordRegex()，
> 而是直接使用用户提供的原始正则字符串——
> 因此用户可以写出复杂模式，如 \b\d{3}-\d{2}-\d{4}\b (SSN格式)。
> .test(text)：执行匹配。


**L75**:
```typescript
return { level: "S3", reason: `S3 pattern: ${pat}` };
```
> 命中，立即返回 S3。


**L77**:
```typescript
} catch { /* skip invalid regex */ }
```
> 如果 new RegExp(pat) 抛出 SyntaxError（非法正则），
> 静默捕获，跳过该条规则，继续检查下一条。
> 这是关键的容错点——不能因为一条坏规则导致整个路由器崩溃。


**L79-L84**:
```typescript
（S2 正则检查，逻辑与 S3 完全对称）
```


**L86**:
```typescript
return { level: "S1" };
```
> 所有正则都未命中，返回 S1。


### 与 checkKeywords 的区别

  checkKeywords：关键词 → getKeywordRegex() 智能转换 → 词边界匹配（适合简单词）。
  checkPatterns：用户直接提供正则字符串 → 原样构造 RegExp（适合复杂模式）。
函数：classifyWithPrompt(message, systemPrompt, pluginConfig)
                                                 (L89-L126)

### 作用

  使用本地 LLM 对消息进行语义级别的敏感度分类。
  这是检测管线中的"第三道防线"。

### 参数

  message: string — 用户消息文本。
  systemPrompt: string — LLM 系统提示词，指导分类行为。
  pluginConfig: Record<string, unknown> — 完整插件配置。

### 返回值

  Promise<{ level: SensitivityLevel; reason?: string } | null>
  返回 null 表示 LLM 不可用或解析失败（调用方会忽略 null）。

### 逐行逻辑


**L94**:
```typescript
const pCfg = getPrivacyConfig(pluginConfig);
```
> 提取隐私配置，获取 localModel 连接信息。


**L95**:
```typescript
const lm = pCfg.localModel;
```
> 取出本地模型配置对象，包含 enabled / endpoint / model / apiKey / type 等。


**L96**:
```typescript
if (!lm?.enabled || !lm.endpoint) return null;
```
> **前置守卫**：
> - !lm?.enabled：模型未启用（enabled 为 false 或 lm 本身不存在）→ 跳过。
> - !lm.endpoint：未配置端点 URL → 无法调用 → 跳过。
> 返回 null 意味着 LLM 分类被跳过，不影响其他检测手段。


**L98**:
```typescript
try {
```
> 整个 LLM 调用和响应解析包裹在 try-catch 中。


**L99-L113**:
```typescript
const raw = await callChatCompletion(lm.endpoint, lm.model ?? "", [...], {...});
```
> 调用 callChatCompletion() 发起 LLM 聊天补全请求。
> 参数 1: lm.endpoint — 模型 API 地址（如 http://localhost:11434）。
> 参数 2: lm.model ?? "" — 模型名称，未配置时传空字符串。
> 参数 3: 消息数组 —
> [
> { role: "system", content: systemPrompt },  ← 路由器自定义的分类指令
> { role: "user",   content: message },       ← 待分类的用户消息
> ]
> 参数 4: 选项对象 —
> temperature: 0     ← 确定性输出，同样的输入始终得到同样的分类
> maxTokens: 256     ← 分类结果很短，限制 token 防止浪费
> apiKey: lm.apiKey  ← 可选的 API 密钥
> providerType: (lm.type ?? "openai-compatible")  ← 默认走 OpenAI 兼容协议
> customModule: lm.module  ← type="custom" 时使用的自定义模块路径


**L114**:
```typescript
const text = raw.text.trim();
```
> 取 LLM 返回的文本内容并去除首尾空白。
> raw.text 是 callChatCompletion() 返回的 assistant 消息内容。


**L115**:
```typescript
const jsonMatch = text.match(/\{[\s\S]*?\}/);
```
> 用正则从 LLM 输出中提取第一个 JSON 对象。
> \{[\s\S]*?\} —— 匹配 { 到最近的 } 之间的内容（非贪婪）。
> 这样做的原因是 LLM 可能在 JSON 前后输出额外的解释文字，
> 例如 "Based on analysis, the result is: {"level":"S3","reason":"..."}"。


**L116**:
```typescript
if (!jsonMatch) return null;
```
> 如果 LLM 输出中没有找到 JSON 对象（模型没按要求输出），
> 返回 null，视为分类失败。


**L117**:
```typescript
const parsed = JSON.parse(jsonMatch[0]);
```
> 解析提取到的 JSON 字符串为 JavaScript 对象。
> jsonMatch[0] 是正则匹配的完整字符串（即 {...} 部分）。


**L118**:
```typescript
const level = String(parsed.level ?? "S1").toUpperCase();
```
> 读取 parsed.level 字段，做多重防御：
> - ?? "S1"：如果 level 字段缺失，默认为 "S1"（安全）。
> - String()：确保类型为字符串（防止模型输出数字等）。
> - .toUpperCase()：统一大小写（防止模型输出 "s2" 而非 "S2"）。


**L119-L121**:
```typescript
if (level === "S2" || level === "S3") {
```

             return { level: level as SensitivityLevel, reason: parsed.reason ?? "LLM classification" };
             }
> 如果 level 是 S2 或 S3，返回对应等级。
> reason 优先使用模型给出的原因，若模型未给则用默认文案。
> as SensitivityLevel 做类型缩窄（此时我们已确认值为 "S2"|"S3"）。

**L122**:
```typescript
return { level: "S1" };
```
> level 不是 S2 也不是 S3（可能是 "S1" 或其他意外值），
> 统一视为安全，返回 S1。


**L123-L125**:
```typescript
} catch { return null; }
```
> 捕获所有异常：
> - 网络超时 / 连接拒绝（callChatCompletion 失败）
> - JSON.parse 失败（LLM 输出格式异常）
> - 任何其他运行时错误
> 全部返回 null，让调用方忽略 LLM 结果，不影响关键词/正则检测。


### 设计意图

  LLM 分类是可选增强，采用"尽力而为"策略：能用就用，不能用就安静退出。
  通过 JSON 提取而非纯文本解析提高了对不同模型输出风格的兼容性。
## 函数：resolveTargetForLevel(level, pluginConfig) (L132-L156)


### 作用

  根据敏感等级确定消息应重定向到的目标 provider 和 model。

### 参数

  level: SensitivityLevel — "S2" 或 "S3"。
  pluginConfig: Record<string, unknown> — 完整插件配置。

### 返回值

  { provider: string; model: string }

### 逐行逻辑


**L136**:
```typescript
const pCfg = getPrivacyConfig(pluginConfig);
```
> 提取隐私配置。


#### S3 分支 (L137-L144)


**L137**:
```typescript
if (level === "S3") {
```
> S3 是最高敏感级别，必须使用完全本地的模型处理。


**L138**:
```typescript
const guardCfg = getGuardAgentConfig(pCfg);
```
> 获取 Guard Agent 配置。
> Guard Agent 是一个专门用于处理敏感请求的本地 AI Agent。
> getGuardAgentConfig() 返回 { id, model, workspace, provider, modelName }
> 或 null（如果未配置）。


**L139**:
```typescript
const defaultProvider = pCfg.localModel?.provider ?? "ollama";
```
> 取本地模型的 provider 作为兜底值。
> 如果连 localModel.provider 都没配，最终兜底为 "ollama"。


**L140-L143**:
```typescript
return {
```

               provider: guardCfg?.provider ?? defaultProvider,
               model: guardCfg?.modelName ?? pCfg.localModel?.model ?? "openbmb/minicpm4.1",
             };
> provider 优先级链：guardAgent.provider → localModel.provider → "ollama"
> model 优先级链：guardAgent.modelName → localModel.model → "openbmb/minicpm4.1"
> "openbmb/minicpm4.1" 是系统默认的本地模型。

#### S2 分支 (L146-L155)


**L146**:
```typescript
const s2Policy = pCfg.s2Policy ?? "proxy";
```
> 读取 S2 策略配置，默认 "proxy"。
> 两种策略：
> "proxy" — 通过隐私代理脱敏后转发给云端模型。
> "local" — 与 S3 一样强制本地处理。


**L147-L154**:
```typescript
if (s2Policy === "local") { ... return { provider, model }; }
```
> 如果 s2Policy 为 "local"，逻辑与 S3 分支完全相同：
> 获取 guardAgent 配置，用同样的优先级链确定 provider 和 model。
> 这意味着管理员可以通过一个配置项将 S2 流量也切到本地。


**L155**:
```typescript
return { provider: "guardclaw-privacy", model: "" };
```
> 默认的 "proxy" 策略：
> provider 设为 "guardclaw-privacy" — 这是一个特殊的 provider ID，
> hooks.ts 识别后会走隐私代理通道（先脱敏再转发）。
> model 为空字符串，表示由代理自行决定使用哪个云端模型。


### 设计意图

  S3 必须纯本地、S2 可选本地或代理，这种分级策略平衡了安全性和性能。
  与内置 privacy router 保持一致的目标格式，确保 hooks.ts 统一处理。
## 函数：createConfigurableRouter(id)              (L163-L223)


### 作用

  工厂函数：创建一个符合 GuardClawRouter 接口的可配置路由器实例。
  这是本文件的核心导出，供路由器注册系统调用。

### 参数

  id: string — 路由器唯一标识符，用于从配置中查找对应的 options。

### 返回值

  GuardClawRouter — 包含 id 属性和 detect() 异步方法的对象。

### 逐行逻辑


**L163-L164**:
```typescript
export function createConfigurableRouter(id: string): GuardClawRouter {
```

             return {
> 工厂模式：不用 class，直接返回符合 GuardClawRouter 接口的对象字面量。
> 闭包捕获 id 参数，使得后续 detect() 能通过 id 找到自己的配置。

**L165**:
```typescript
id,
```
> 将传入的 id 赋值为路由器标识符，满足 GuardClawRouter.id 要求。


#### detect() 方法 (L166-L221)


**L166-L168**:
```typescript
async detect(context, pluginConfig): Promise<RouterDecision> {
```
> 异步检测方法，接收检测上下文和插件配置，返回路由决策。
> context 中包含 message（用户消息）、toolName、toolParams 等。


#### 步骤①：初始化 (L170-L173)


**L170**:
```typescript
const opts = getOptions(id, pluginConfig);
```
> **实时**从配置中读取该路由器的 options。
> 每次 detect() 都重新读取，不缓存，确保 Dashboard 修改即时生效。


**L171**:
```typescript
const text = context.message ?? "";
```
> 取出用户消息文本。如果 context.message 为 undefined（如纯工具调用场景），
> 回退为空字符串，后续条件判断会因 text 为空而跳过检测。


**L172**:
```typescript
const levels: SensitivityLevel[] = [];
```
> 累积数组：收集所有检测环节命中的敏感等级。
> 最终取最大值，实现"多探测器投票取最严"的策略。


**L173**:
```typescript
const reasons: string[] = [];
```
> 累积数组：收集所有命中原因描述，最终合并为一个完整的说明。


#### 步骤②：关键词检测 (L176-L182)


**L176**:
```typescript
if (opts.keywords && text) {
```
> 双重条件：
> - opts.keywords 存在（路由器配置了关键词规则）
> - text 非空（有内容可检测）
> 任一不满足则跳过此环节。


**L177**:
```typescript
const kw = checkKeywords(text, opts.keywords);
```
> 调用 checkKeywords() 执行关键词匹配。
> 返回 { level, reason? }。


**L178-L181**:
```typescript
if (kw.level !== "S1") { levels.push(kw.level); if (kw.reason) reasons.push(kw.reason); }
```
> 只有在命中（非 S1）时才将结果推入累积数组。
> S1 表示"安全"，不需要记录。


#### 步骤③：正则检测 (L185-L191)


**L185**:
```typescript
if (opts.patterns && text) {
```
> 同样的双重条件守卫。


**L186**:
```typescript
const pat = checkPatterns(text, opts.patterns);
```
> 调用 checkPatterns() 执行正则匹配。


**L187-L190**:
```typescript
if (pat.level !== "S1") { ... }
```
> 非 S1 结果推入累积数组。
> 注意：关键词和正则的结果是**并行累积**的，不是互斥的。
> 如果关键词命中 S2、正则命中 S3，两个都会被记录。


#### 步骤④：LLM 语义分类 (L194-L200)


**L194**:
```typescript
if (opts.prompt && text) {
```
> 只有配置了 prompt 且有文本时才执行 LLM 分类。
> 这是整个管线中最慢的环节（需要网络调用），因此是可选的。


**L195**:
```typescript
const llm = await classifyWithPrompt(text, opts.prompt, pluginConfig);
```
> 异步调用 LLM。可能返回分类结果或 null。


**L196-L199**:
```typescript
if (llm && llm.level !== "S1") { ... }
```
> llm 为 null（LLM 不可用/出错）时条件不满足，静默跳过。
> llm.level 为 S1 时也不累积——只收集"有问题"的信号。


#### 步骤⑤：结果聚合与决策 (L202-L220)


**L202**:
```typescript
if (levels.length === 0) {
```
> 三个检测环节都没有产生非 S1 的结果。


**L203**:
```typescript
return { level: "S1", action: "passthrough", reason: "No match" };
```
> 完全安全：返回 S1 + passthrough（放行）。
> 消息将不经过任何路由处理，直接发送给原始目标模型。


**L206**:
```typescript
const finalLevel = maxLevel(...levels);
```
> 从所有命中等级中取最高值。
> maxLevel() 将 S1/S2/S3 映射为数值 1/2/3，取 Math.max，再转回字符串。
> 例：levels = ["S2", "S3"] → maxLevel = "S3"。
> 这实现了"任一检测器报高敏感，最终就是高敏感"的保守策略。


**L207**:
```typescript
const action = (opts.action ?? "redirect") as RouterAction;
```
> 从路由器配置中读取命中后的动作。
> 默认 "redirect"：将请求重定向到本地/代理模型。
> 其他可选值：
> "passthrough" — 放行（虽然检测到但不干预）
> "transform"   — 转换消息内容（如脱敏）
> "block"       — 直接阻断请求


**L209**:
```typescript
let target: { provider: string; model: string } | undefined;
```
> 声明可选的重定向目标变量。


**L210**:
```typescript
if (finalLevel !== "S1" && action === "redirect") {
```
> 只有在确实检测到敏感内容（非 S1）且动作为 redirect 时，
> 才需要解析重定向目标。其他动作（block/transform/passthrough）
> 不需要 target 信息。


**L211**:
```typescript
target = resolveTargetForLevel(finalLevel, pluginConfig);
```
> 根据敏感等级和 s2Policy 确定目标 provider/model。
> S3 → 本地模型，S2 → 看 s2Policy 决定本地或代理。


**L214-L220**:
```typescript
return { level: finalLevel, action, target, reason: reasons.join("; "), confidence: ... };
```
> 构造并返回最终的 RouterDecision：
> level: 最终敏感等级（三个检测器结果的最大值）。
> action: 路由动作（默认 "redirect"）。
> target: 重定向目标（仅 redirect 时有值），
> hooks.ts 会根据此字段执行实际的请求转发。
> reason: 所有命中原因用 "; " 连接成一个字符串。
> 例："S3 keyword: 身份证; S2 pattern: \d{18}"
> 用于日志记录和 Dashboard 展示。
> confidence: 置信度分数。
> levels.some((l) => l !== "S1") ? 0.8 : 0.5
> - 0.8：有至少一个检测器给出了非 S1 的判定，置信度较高。
> - 0.5：理论上此分支不会走到（因为 L202 已处理了全 S1 的情况），
> 但作为防御性编码保留。


### 设计亮点总结

  1. **三级管线**：keyword（μs级）→ regex（μs级）→ LLM（ms~s级），
     成本递增、语义理解递增、互相补充。
  2. **累积聚合而非短路**：三个检测器都会执行（如果配置了），
     结果取最高等级，确保不因某个检测器的盲区而漏报。
  3. **实时配置**：闭包只捕获 id，options 每次实时读取。
  4. **完全容错**：每个环节独立容错，任何一个失败不影响其他环节。

## Part A — Code 层面改动建议


#### 🔴 resolveTargetForLevel() 中 S3 和 S2-local 分支存在完全重复代码


 现状（L137-L154）：
   S3 分支和 S2 + s2Policy==="local" 分支的函数体完全相同——
   都是 getGuardAgentConfig → defaultProvider → return { provider, model }。
   共 12 行代码被原样复制。

 问题：
   - 违反 DRY 原则，维护时容易只改一处忘另一处。
   - privacy.ts 中的 detectionToDecision() 也有同样的重复（L39-L67），
     说明这个模式已经被复制了两次。

 建议重构：

   function resolveTargetForLevel(level, pluginConfig) {
     const pCfg = getPrivacyConfig(pluginConfig);

     // S2 + proxy 策略走隐私代理
     if (level === "S2" && (pCfg.s2Policy ?? "proxy") === "proxy") {
       return { provider: "guardclaw-privacy", model: "" };
     }

     // S3 和 S2-local 统一走本地模型
     const guardCfg = getGuardAgentConfig(pCfg);
     const defaultProvider = pCfg.localModel?.provider ?? "ollama";
     return {
       provider: guardCfg?.provider ?? defaultProvider,
       model: guardCfg?.modelName ?? pCfg.localModel?.model ?? "openbmb/minicpm4.1",
     };
   }

 进一步：可以考虑在 types.ts 或新建 target-resolver.ts 中提供一个
 共享的 resolveLocalTarget(pCfg) 函数，让 configurable.ts 和 privacy.ts
 都复用，彻底消除三处重复。


#### 🔴 checkPatterns() 每次调用都 new RegExp()，无缓存


 现状（L74, L81）：
   每次 detect() 调用时，checkPatterns() 对每个正则字符串都执行
   new RegExp(pat, "i")。如果有 20 条正则且每秒 100 次请求，
   则每秒构造 2000 个 RegExp 对象。

 对比：
   - checkKeywords() 已通过 getKeywordRegex() 使用了 keywordRegexCache。
   - rules.ts 中的 checkPatterns() 使用了 getOrCompileRegex()，带缓存
     和 PATTERN_CACHE_MAX = 500 的 LRU 淘汰策略。
   - 本文件的 checkPatterns() 却没有任何缓存，是同一代码库内的不一致。

 建议：
   直接复用 rules.ts 中已导出的 getOrCompileRegex()（如果导出），
   或者在本地维护一个简单缓存：

   import { getOrCompileRegex } from "../rules.js";  // 如果已导出

   function checkPatterns(text, patterns) {
     for (const pat of patterns.S3 ?? []) {
       const re = getOrCompileRegex(pat);
       if (re?.test(text)) return { level: "S3", reason: `S3 pattern: ${pat}` };
     }
     // ... S2 同理
   }

   注意：getOrCompileRegex() 目前在 rules.ts 中未 export。
   需要先将其导出，或在本文件顶部新增一个等效的缓存 Map。


#### 🟡 import 语句可合并


 现状（L16-L28）：
   从 "../types.js" 有两个 import 语句：
     import type { DetectionContext, ..., RouterRegistration } from "../types.js";
     import type { PrivacyConfig } from "../types.js";
   另外还有：
     import { maxLevel } from "../types.js";

 建议合并：

   import {
     maxLevel,
     type DetectionContext,
     type GuardClawRouter,
     type RouterAction,
     type RouterDecision,
     type SensitivityLevel,
     type RouterRegistration,
     type PrivacyConfig,
   } from "../types.js";

 影响：纯代码整洁度，无运行时影响。


#### 🟡 ConfigurableRouterOptions.action 应使用 RouterAction 类型


 现状（L34）：
   action?: string;

 问题：
   action 字段声明为 string，但实际在 L207 处被 as RouterAction 强制转换：
     const action = (opts.action ?? "redirect") as RouterAction;
   这意味着类型系统无法在配置阶段捕获非法值（如 "blcok" 拼写错误）。

 建议：
   action?: RouterAction;

 这样在 Dashboard 配置验证时就能利用类型约束，减少运行时的 as 断言。


#### 🟡 classifyWithPrompt 中 JSON 提取正则可能误匹配嵌套 JSON


 现状（L115）：
   const jsonMatch = text.match(/\{[\s\S]*?\}/);

 问题：
   非贪婪匹配 *? 会在遇到第一个 } 时停止。如果 LLM 输出如下：
     {"level": "S3", "reason": "contains {secret}"}
   正则会匹配到 {"level": "S3", "reason": "contains {secret}"} 的第一个 }，
   即 {"level": "S3", "reason": "contains {secret}，导致 JSON.parse 失败。

 建议（轻量修复）：
   尝试贪婪匹配并做 JSON.parse 容错：

   const jsonMatch = text.match(/\{[\s\S]*\}/);
   if (!jsonMatch) return null;
   let parsed: Record<string, unknown>;
   try {
     parsed = JSON.parse(jsonMatch[0]);
   } catch {
     // 如果贪婪匹配失败，回退到非贪婪
     const fallback = text.match(/\{[\s\S]*?\}/);
     if (!fallback) return null;
     try { parsed = JSON.parse(fallback[0]); } catch { return null; }
   }

 或使用更健壮的 JSON 提取库。


#### 🟢 confidence 值硬编码，缺乏语义区分


 现状（L219）：
   confidence: levels.some((l) => l !== "S1") ? 0.8 : 0.5

 问题：
   无论是关键词精确命中、正则命中、还是 LLM 模糊判定，置信度都是 0.8。
   对比 rules.ts 中 detectByRules() 返回 confidence: 1.0（规则是确定性的），
   这里的 0.8 丢失了信息来源的区分。

 建议：
   根据命中来源给出不同置信度，或在累积时记录来源类型：
     keyword 命中 → 0.95（确定性高）
     pattern 命中 → 0.90（正则可能有误匹配）
     LLM 命中    → 0.70（模型判断有不确定性）
   最终取加权或最大值。
## Part B — 逻辑/设计层面改动建议


#### 🔴 LLM 分类无条件执行，即使关键词/正则已命中 S3


 现状（L194-L200）：
   只要 opts.prompt && text 为真，就会发起 LLM 调用，
   即使 checkKeywords 已经返回 S3（最高级别）。

 问题：
   - LLM 调用是整个管线中最慢的环节（通常 200ms~2s）。
   - 如果关键词已命中 S3，继续调用 LLM 不会改变最终结果
     （maxLevel 已经是 S3，不会更高），纯属浪费延迟和算力。
   - 代码注释（L193）写的是 "only if no keyword/pattern hit or for extra accuracy"，
     但实现并没有做这个判断——注释与代码不一致。

 建议（两种策略选一）：

   策略 A — 已有 S3 时跳过 LLM：
     if (opts.prompt && text && !levels.includes("S3")) {
       const llm = await classifyWithPrompt(...);
       ...
     }

   策略 B — 仅在关键词/正则都未命中时启用 LLM（注释原意）：
     if (opts.prompt && text && levels.length === 0) {
       const llm = await classifyWithPrompt(...);
       ...
     }

   策略 A 更保守（多数情况等效），策略 B 更省资源。
   无论选哪种，都应修正 L193 的注释使其与实现一致。


#### 🔴 getPrivacyConfig() 不合并 defaultPrivacyConfig，与 privacy.ts 行为不一致


 现状（L47-L49）：
   configurable.ts 的 getPrivacyConfig 直接返回：
     (pluginConfig?.privacy ?? {}) as PrivacyConfig
   即原样返回用户配置，缺失字段就是 undefined。

 对比 privacy.ts（L78-L96）的 getPrivacyConfig：
   对每个子对象都做了 { ...defaultPrivacyConfig.xxx, ...userConfig.xxx } 的深度合并。

 问题：
   configurable.ts 中 classifyWithPrompt 和 resolveTargetForLevel 依赖
   pCfg.localModel、pCfg.s2Policy 等字段。如果用户只配置了部分字段，
   这里拿到的是 undefined 而非默认值。
   例如：用户没配 s2Policy，privacy.ts 走 "proxy"（通过默认值合并），
   而 configurable.ts 也走 "proxy"（通过 ?? "proxy"），看似一致——
   但如果未来增加新的默认字段，configurable.ts 会遗漏。

 建议：
   - 方案 A：复用 privacy.ts 的 getPrivacyConfig（需要先将其导出）。
   - 方案 B：在本文件中也做默认值合并。
   - 方案 C（推荐）：将 getPrivacyConfig 提到公共模块（如 config-utils.ts），
     两个文件统一 import。


#### 🟡 detect() 不处理 enabled 标志和 dryRun


 对比 privacy.ts（L107-L109）：
   if (privacyConfig.enabled === false && !context.dryRun) {
     return { level: "S1", action: "passthrough", reason: "Privacy detection disabled" };
   }

 configurable.ts 的 detect() 中没有类似检查。

 问题：
   - RouterRegistration 有 enabled 字段。如果 Dashboard 上禁用了某个
     可配置路由器，detect() 仍然会执行全部检测逻辑。
   - 虽然 router-pipeline.ts 可能在外层做了 enabled 检查，
     但防御性编程建议在 detect() 内部也做一道守卫。
   - dryRun 模式（Dashboard 测试功能）也需要考虑：
     即使 enabled=false，dryRun=true 时应该仍然执行检测。

 建议（在 detect 方法开头添加）：

   const reg = getRegistration(id, pluginConfig);
   if (reg?.enabled === false && !context.dryRun) {
     return { level: "S1", action: "passthrough", reason: "Router disabled" };
   }


#### 🟡 detect() 未利用 DetectionContext 中的 toolName / toolParams / toolResult


 现状：
   detect() 只检查 context.message。

 对比 rules.ts 的 detectByRules()：
   检查了 message、toolName、toolParams、toolResult 五个维度。

 问题：
   configurable router 可以出现在 onToolCallProposed / onToolCallExecuted
   pipeline 中（如配置所允许）。此时 context.message 可能为空，
   但 toolName / toolParams 包含了需要检测的内容。
   当前实现会因 text 为空而跳过所有检测，导致工具调用场景下路由器失效。

 建议：
   - 将 toolName、JSON.stringify(toolParams)、toolResult 也纳入检测文本：

     const parts: string[] = [];
     if (context.message) parts.push(context.message);
     if (context.toolName) parts.push(context.toolName);
     if (context.toolParams) parts.push(JSON.stringify(context.toolParams));
     if (context.toolResult) parts.push(
       typeof context.toolResult === "string"
         ? context.toolResult
         : JSON.stringify(context.toolResult)
     );
     const text = parts.join(" ");

   - 或者为 tool 场景增加独立的 keywords/patterns 配置维度。


#### 🟡 RouterDecision 缺少 routerId，下游难以溯源


 现状：
   RouterDecision 类型定义中有 routerId?: string 字段（types.ts L166），
   但 createConfigurableRouter 返回的 RouterDecision 没有设置此字段。

 对比：
   当多个路由器（privacy + configurable-A + configurable-B）同时运行时，
   router-pipeline 需要知道是哪个路由器做出了决策。
   如果不设 routerId，日志和 Dashboard 中无法区分决策来源。

 建议（在 L214 的返回对象中添加）：
   return {
     level: finalLevel,
     action,
     target,
     reason: reasons.join("; "),
     confidence: ...,
     routerId: id,       // ← 添加
   };


#### 🟢 LLM 分类缺少超时控制


 现状：
   classifyWithPrompt() 调用 callChatCompletion() 时没有传入超时参数。
   如果本地模型响应缓慢（如加载中、资源不足），整个 detect() 会被阻塞。

 问题：
   detect() 在请求的关键路径上。一个卡住的 LLM 调用会导致用户请求
   长时间挂起，而关键词/正则检测可能已经在毫秒内完成了。

 建议：
   增加超时机制（如 AbortController 或 Promise.race）：

   const CLASSIFY_TIMEOUT_MS = 5000;
   const result = await Promise.race([
     callChatCompletion(lm.endpoint, lm.model ?? "", messages, options),
     new Promise((_, reject) =>
       setTimeout(() => reject(new Error("LLM classify timeout")), CLASSIFY_TIMEOUT_MS)
     ),
   ]);

   超时后 catch 返回 null，回退到关键词/正则的结果。


#### 🟢 建议为 checkKeywords / checkPatterns 提取通用的检测循环


 现状：
   checkKeywords 和 checkPatterns 结构几乎相同：
     for S3 → match → return S3
     for S2 → match → return S2
     return S1

 建议提取通用函数：

   function checkWithMatcher(
     entries: { S2?: string[]; S3?: string[] },
     matcher: (entry: string) => boolean,
     labelPrefix: string,
   ): { level: SensitivityLevel; reason?: string } {
     for (const e of entries.S3 ?? []) {
       if (matcher(e)) return { level: "S3", reason: `S3 ${labelPrefix}: ${e}` };
     }
     for (const e of entries.S2 ?? []) {
       if (matcher(e)) return { level: "S2", reason: `S2 ${labelPrefix}: ${e}` };
     }
     return { level: "S1" };
   }

   // 使用
   checkWithMatcher(opts.keywords, kw => getKeywordRegex(kw).test(text), "keyword");
   checkWithMatcher(opts.patterns, pat => { try { return new RegExp(pat,"i").test(text); } catch { return false; } }, "pattern");

 这样新增检测维度（如 S4）时只需改一处。
## Review 优先级总览


 🔴 高优先级（应尽快修复）
 A1. resolveTargetForLevel 重复代码 → 提取共享函数
 A2. checkPatterns 无正则缓存   → 复用 rules.ts 的缓存机制
 B1. LLM 在 S3 已命中时仍调用 → 短路跳过 + 修正注释
 B2. getPrivacyConfig 不合并默认值 → 与 privacy.ts 统一

 🟡 中优先级（建议在下个迭代处理）
 A4. action 类型从 string 改为 RouterAction
 A5. JSON 提取正则可能误匹配嵌套 JSON
 B3. detect() 不检查 enabled / dryRun
 B4. detect() 忽略 toolName / toolParams / toolResult
 B5. RouterDecision 缺少 routerId

 🟢 低优先级（锦上添花）
 A3. import 语句合并
 A6. confidence 硬编码
 B6. LLM 分类缺少超时控制
 B7. checkKeywords / checkPatterns 提取通用循环
