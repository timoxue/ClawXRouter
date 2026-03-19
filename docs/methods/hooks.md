# hooks.ts — 逐方法文档


 文件定位：GuardClaw 插件的 Hook 注册中心（所有隐私检测的总入口）
 所属模块：GuardClaw 隐私路由系统

 核心职责：向 OpenClaw 插件系统注册 13 个生命周期 Hook，覆盖从
 用户消息进入到会话结束的全流程隐私检测、PII 脱敏、双轨历史持久化、
 内存同步。是整个 GuardClaw 的"胶水层"——调用 RouterPipeline、
 SessionManager、MemoryIsolationManager 等各子系统完成实际工作。

 Hook 列表：
   1. before_model_resolve — 隐私检测 + 模型路由（核心 Hook，最复杂）
   2. before_prompt_build  — 注入 Guard Prompt / S2 标记 / 双轨历史
   3. before_tool_call     — 工具调用前的隐私检测 + 内存读取路由
   4. tool_result_persist  — 工具结果的 PII 脱敏 + 内存双写同步
   6. before_message_write — 双轨历史持久化 + 转录清洗
   7. session_end          — 会话结束时内存同步
   8. after_compaction     — 压缩后全量内存同步
   9. llm_output           — Token 用量追踪
  10. before_reset         — 重置前内存同步
  11. message_sending      — 出站消息隐私守卫
  12. before_agent_start   — 子 Agent 启动守卫
  13. message_received     — 观察性日志

 敏感等级：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理(proxy)脱敏转发 或 本地模型(local)
   S3 — 高度敏感，强制本地模型处理，数据不离开本地
## 函数：getPipelineConfig()                       (L59-L61)


### 作用

  构造传给 RouterPipeline.run() 的配置对象。
  当前仅包含 privacy 字段，值为实时隐私配置。

### 参数

  无

### 返回值

  Record<string, unknown> — { privacy: PrivacyConfig }

### 逐行逻辑


**L60**:
```typescript
return { privacy: getLiveConfig() };
```
> getLiveConfig() 返回内存中最新的隐私配置（可通过 Dashboard
> 热更新或 guardclaw.json 文件监听自动刷新）。
> 每次调用都读取最新值，确保 Hook 使用的配置与 Dashboard 实时同步。


### 设计意图

  将 pipeline 配置的构造抽到函数中，避免在每个 Hook 里重复写
  getLiveConfig() 拼装逻辑。未来如需向 pipeline 传入更多配置（如
  用户自定义路由器的额外 options），只需在此处扩展。
## 函数：shouldUseFullMemoryTrack(sessionKey)      (L75-L83)


### 作用

  判断当前会话是否应该读取未脱敏的完整内存轨道（MEMORY-FULL.md）。
  只有数据始终留在本地的会话才能访问完整轨道，防止 PII 泄露到云端。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  boolean — true 表示使用 MEMORY-FULL.md，false 表示使用 MEMORY.md（已脱敏）

### 逐行逻辑


**L76**:
```typescript
if (isActiveLocalRouting(sessionKey)) return true;
```
> S3 活跃本地路由中的会话：模型完全运行在本地，
> 可以安全读取完整（未脱敏）内存。


**L77**:
```typescript
if (isGuardSessionKey(sessionKey)) return true;
```
> Guard 子会话（sessionKey 以 ":guard" 结尾或包含 ":guard:"）
> 始终运行在本地模型上，允许读取完整内存。


**L78-L81**:
```typescript
if (isSessionMarkedPrivate(sessionKey)) { ... }
```
> 当前轮次被标记为私密（S2 或 S3）：
> - s2Policy === "local" → 数据留在本地 → 可以读完整轨道
> - s2Policy === "proxy" → 数据会经代理发往云端 → 必须读脱敏轨道
> 默认 s2Policy 为 "proxy"，因此 S2-proxy 会话读 MEMORY.md。


**L82**:
```typescript
return false;
```
> 默认情况（S1、未标记私密）：读脱敏轨道。


### 设计意图

  这是内存隔离的核心门控函数。设计原则："只有确保数据不离开本地的
  会话才能看到完整数据"。S2-proxy 虽然有脱敏处理，但 regex 脱敏
  可能遗漏，因此必须从源头就限制它只读已脱敏的 MEMORY.md。
## 常量：DEFAULT_GUARD_AGENT_SYSTEM_PROMPT          (L85-L95)


Guard Agent（本地隐私分析代理）的默认系统提示词。
关键规则：
  1. 直接分析数据，不写代码
  2. 不回显原始敏感值（工资、SSN、银行账号等）
  3. 可以讨论百分比、比率、异常
  4. 只回复一次，不模拟多轮对话
  5. 使用与用户相同的语言回复

可通过 prompts/guard-agent-system.md 文件覆盖此默认值。
## 函数：getGuardAgentSystemPrompt()               (L97-L99)


### 作用

  加载 Guard Agent 的系统提示词。优先从磁盘文件读取，不存在时回退到硬编码默认值。

### 参数

  无

### 返回值

  string — Guard Agent 系统提示词

### 逐行逻辑


**L98**:
```typescript
return loadPrompt("guard-agent-system", DEFAULT_GUARD_AGENT_SYSTEM_PROMPT);
```
> loadPrompt() 先查内存缓存，无缓存则读 prompts/guard-agent-system.md。
> 文件不存在或不可读时回退到 DEFAULT_GUARD_AGENT_SYSTEM_PROMPT 常量。
> 首次读取后缓存，进程生命周期内不再重复读文件（Dashboard 保存时会
> 调用 invalidatePrompt() 清除缓存使之重新读取）。


### 设计意图

  允许用户在不修改代码的情况下自定义 Guard Agent 行为。
  注意：此函数当前在 hooks.ts 中定义但未被使用（Guard Agent 的
  system prompt 注入发生在 guard-agent.ts 的子会话创建中）。
## 函数：isToolAllowlisted(toolName)               (L105-L109)


### 作用

  检查某个工具是否在隐私管道的白名单中（豁免检测和 PII 脱敏）。

### 参数

  toolName: string — 工具名称

### 返回值

  boolean — true 表示该工具被豁免

### 逐行逻辑


**L106**:
```typescript
const allowlist = getLiveConfig().toolAllowlist;
```
> 从实时配置读取 toolAllowlist 数组。默认为空（无豁免）。


**L107**:
```typescript
if (!allowlist || allowlist.length === 0) return false;
```
> 未配置或为空时，没有任何工具被豁免。


**L108**:
```typescript
return allowlist.includes(toolName);
```
> 精确匹配工具名。大小写敏感。


### 设计意图

  某些基础设施工具（如 gateway、web_fetch）的返回中自然包含 auth
  headers / tokens，如果对它们执行 PII 脱敏会破坏工具功能。
  通过白名单让用户显式声明哪些工具可以跳过隐私管道。
## 变量：_cachedWorkspaceDir                        (L112)


缓存工作区目录路径。在第一个提供 ctx.workspaceDir 的 Hook 中设置。
供 syncMemoryWrite() 等需要解析相对路径的辅助函数使用。
注意是模块级变量，进程生命周期内只设置一次。
## 函数：registerHooks(api)                        (L114-L1052)


### 作用

  GuardClaw 的主入口函数。向 OpenClaw 插件 API 注册全部 13 个
  生命周期 Hook，并完成初始化工作（内存目录、Session Manager）。

### 参数

  api: OpenClawPluginApi — OpenClaw 提供的插件 API 对象，
       包含 on() 注册 Hook、logger、config 等。

### 返回值

  void — 无返回值，通过 side effect 注册 Hook。

### 逐行逻辑 — 初始化部分


**L115**:
```typescript
const privacyCfgInit = getLiveConfig();
```
> 获取启动时的隐私配置快照，用于初始化。


**L116**:
```typescript
const sessionBaseDir = privacyCfgInit.session?.baseDir;
```
> 读取 session 基础目录配置（默认 ~/.openclaw）。


**L118-L121**:
```typescript
const memoryManager = getDefaultMemoryManager(); ...
```
> 获取 MemoryIsolationManager 单例，异步初始化
> memory/ 和 memory-full/ 目录。失败时仅记录错误不阻塞启动。


**L123**:
```typescript
getDefaultSessionManager(sessionBaseDir);
```
> 初始化 DualSessionManager 单例，设置基础目录。


### 设计意图

  将所有 Hook 注册集中在一个函数中，由 provider.ts 在插件初始化时
  调用一次。初始化采用"尽力而为"策略——内存目录创建失败不阻塞插件
  启动，只记录错误日志。
## Hook 1：before_model_resolve                    (L128-L406)


### 作用

  最核心的 Hook。在 OpenClaw 解析模型之前拦截，执行隐私检测并
  决定消息应该路由到哪个模型/提供商。

  输出：{ providerOverride, modelOverride } 或 undefined（不干预）。

### 参数

  event: { prompt } — 用户输入的 prompt 字符串
  ctx: { sessionKey, workspaceDir, agentId } — 会话上下文

### 返回值

  { providerOverride?: string, modelOverride?: string } | void
  返回 override 时 OpenClaw 会使用指定的 provider/model 替代默认值。

### 逐行逻辑


**L129-L131**:
```typescript
try { const { prompt } = event; ...
```
> 提取 prompt 和 sessionKey。sessionKey 为空则直接返回。


**L134-L136**:
```typescript
clearActiveLocalRouting / resetTurnLevel / consumeDetection
```
> 每轮开始时"重置"上一轮的状态：
> - clearActiveLocalRouting：清除"S3 本地路由"标记
> - resetTurnLevel：将当前轮次敏感级别重置为 S1
> - consumeDetection：消费（清除）上一轮的待处理检测结果
> 这实现了"per-turn 语义"——每轮独立判断，不继承历史状态。


**L138-L139**:
```typescript
const privacyConfig = getLiveConfig(); if (!privacyConfig.enabled) return;
```
> 读取实时配置，如果隐私保护未启用则直接跳过。


**L141-L147**:
```typescript
if (isGuardSessionKey(sessionKey)) { ... }
```
> Guard 子会话：直接路由到 Guard Agent 配置的本地模型。
> getGuardAgentConfig() 解析 "provider/model" 格式的模型引用。
> 如果 Guard Agent 未配置（返回 null），不做任何路由覆盖。


**L149**:
```typescript
if (ctx.workspaceDir) _cachedWorkspaceDir = ctx.workspaceDir;
```
> 缓存工作区目录，供后续内存同步使用。


**L151-L152**:
```typescript
const msgStr = String(prompt); if (shouldSkipMessage(msgStr)) return;
```
> 跳过已脱敏消息、系统消息、时间戳消息等不需要检测的内容。


#### S3 快速路径（L154-L181）


**L159-L162**:
```typescript
const rulePreCheck = detectByRules(...)
```
> 用同步的规则检测器（关键词 + 正则 + 工具类型）做预检。
> 规则检测是确定性的、零开销的。


**L164-L181**:
```typescript
if (rulePreCheck.level === "S3") { ... }
```
> 规则已确认 S3（最高敏感级别）→ 立即路由到本地模型。
> 无需运行完整 pipeline（LLM 检测器、token-saver 等），
> 避免浪费计算资源，也避免将敏感内容暴露给 LLM 检测器。
> L165-L168: recordDetection / trackSessionLevel / setActiveLocalRouting / stashDetection
> 记录检测结果、设置会话级别、标记本地路由、暂存检测结果
> （供 before_prompt_build 和 before_message_write 读取）。
> L175-L180: 构造 provider/model override
> 优先使用 guardAgent 配置，回退到 localModel 配置，
> 最终兜底 "ollama" / "openbmb/minicpm4.1"。


#### 正常路径：完整 pipeline（L183-L199）


**L184-L188**:
```typescript
const pipeline = getGlobalPipeline(); if (!pipeline) { ... return; }
```
> 获取全局 RouterPipeline 单例。未初始化时发出警告并返回。


**L190-L199**:
```typescript
const decision = await pipeline.run("onUserMessage", ...)
```
> 运行完整路由管道：所有已注册的路由器（privacy、token-saver、
> 自定义路由器）并行执行，结果按权重合并。
> 返回 RouterDecision：{ level, action, target, reason, ... }


**L201-L205**:
```typescript
recordDetection(...); if (decision.level === "S1" && action === "passthrough") return;
```
> 记录检测结果。如果是 S1 + passthrough（无敏感内容），直接返回
> 不做任何路由覆盖，让原始 provider 处理。


#### S3 来自 LLM 检测器（L207-L231）


**L208-L231**:
```typescript
if (decision.level === "S3") { ... }
```
> pipeline 的 LLM 检测器判定为 S3（规则没有在上面的快速路径
> 捕获到）。路由到本地模型。
> - 如果 decision.target 存在（路由器指定了目标），使用它
> - 否则回退到 guardAgent → localModel → 默认值


#### S2 脱敏（L236-L257）


**L237-L257**:
```typescript
if (decision.level === "S2") { ... }
```
> 调用 desensitizeWithLocalModel() 用本地模型脱敏。
> 关键安全保障：如果脱敏失败（本地模型不可用），
> 自动升级到 S3（完全本地处理），绝不发送原始 PII 到云端。
> 这是"宁可过度保护也不泄露"的设计哲学。


#### 暂存检测结果（L260-L266）


**L260-L266**:
```typescript
stashDetection(sessionKey, { level, reason, desensitized, ... })
```
> 将检测结果暂存到 pendingDetections Map 中。
> before_prompt_build 和 before_message_write 会读取这些结果。


#### S2-local 路由（L269-L278）


**L269-L278**:
```typescript
if (decision.level === "S2" && action === "redirect" && target !== "guardclaw-privacy")
```
> S2 但路由器指定了非代理的目标（如直接重定向到边缘模型）。
> 标记会话为私密，路由到指定 target。


#### S2-proxy 路由（L281-L304）


**L281-L304**:
```typescript
if (decision.level === "S2" && target?.provider === "guardclaw-privacy")
```
> S2 走隐私代理路径：
> 1. 标记会话为 S2 私密
> 2. 从 api.config 读取默认 provider 的 baseUrl/apiKey
> 3. stashOriginalProvider() 将原始 provider 信息暂存
> （隐私代理需要知道最终转发到哪里）
> 4. 返回 providerOverride: "guardclaw-privacy"
> OpenClaw 会将请求发送到本地隐私代理服务器


#### 自定义路由器的 redirect（L307-L313）


**L307-L313**:
```typescript
if (decision.action === "redirect" && decision.target)
```
> 非隐私路由器（如 token-saver）的自定义重定向。


#### block 动作（L316-L330）


**L316-L330**:
```typescript
if (decision.action === "block")
```
> 阻断动作：路由到边缘本地模型作为安全兜底。
> S3 时标记本地路由，其他级别标记私密。


#### transform 动作（L335-L397）


**L335-L397**:
```typescript
if (decision.action === "transform")
```
> 路由器重写了 prompt 内容。
> - S3 transform → 路由到本地模型
> - S2 transform → 使用 transformedContent 作为脱敏后的负载
> - s2Policy="local" → 路由到本地模型
> - s2Policy="proxy" → 走隐私代理
> - S1 transform → 无敏感数据，让原始 provider 处理


**L399-L402**:
```typescript
return; // 默认不覆盖
```
> 所有分支都未命中时，不做任何路由覆盖。


**L403-L405**:
```typescript
catch (err) → 记录错误日志
```
> 整个 Hook 包在 try-catch 中，确保异常不会阻塞 OpenClaw 主流程。


### 设计意图

  before_model_resolve 是整个隐私系统的决策中枢。它实现了"S3 快速路径"
  优化（规则检测到 S3 时跳过昂贵的 pipeline），以及"脱敏失败升级到 S3"
  的安全保障。所有路由决策都在此 Hook 中完成，后续 Hook 只负责执行
  （注入 prompt、脱敏转录、同步内存等）。
## Hook 2：before_prompt_build                     (L412-L472)


### 作用

  在 OpenClaw 构建最终 prompt 之前，根据暂存的检测结果：
  - S3 / S2-local：注入完整轨道的对话历史（双轨历史增量）
  - S2-proxy：注入脱敏标记（<guardclaw-s2>...<\/guardclaw-s2>）

### 参数

  _event: 未使用
  ctx: { sessionKey, agentId }

### 返回值

  { prependContext: string } | void
  prependContext 会被 OpenClaw 拼接到用户 prompt 前面。

### 逐行逻辑


**L414-L415**:
```typescript
const sessionKey = ctx.sessionKey ?? ""; if (!sessionKey) return;
```
> 提取 sessionKey，为空时跳过。


**L417-L418**:
```typescript
const pending = getPendingDetection(sessionKey); if (!pending || pending.level === "S1") return;
```
> 读取 before_model_resolve 暂存的检测结果。
> 无待处理检测或 S1 级别时不需要注入任何内容。


**L420-L424**:
```typescript
const privacyConfig = getLiveConfig(); ...
```
> 读取配置：injectDualHistory（是否注入双轨历史，默认 true）
> 和 historyLimit（注入的最大消息数，默认 20）。


**L429-L438**:
```typescript
if (pending.level === "S3") { ... }
```
> S3 场景：数据完全在本地处理。
> 调用 loadDualTrackContext() 加载"完整轨道比脱敏轨道多出来的"
> 消息增量，格式化为对话上下文注入。
> 这样本地模型能看到之前 S3 交互的原始内容（主转录中是
> "🔒 [Private content]" 占位符）。


**L440-L452**:
```typescript
S2-local 场景
```
> 与 S3 相同，数据留在本地，注入完整历史。


**L464-L468**:
```typescript
S2-proxy 场景
```
> 注入 "<guardclaw-s2>\n{脱敏内容}\n</guardclaw-s2>" 标记。
> OpenClaw 的 prependContext 会将此拼接到用户 prompt 前面，
> 使 prompt 变成：
> "<guardclaw-s2>\n{脱敏}\n</guardclaw-s2>\n\n{原始PII}"
> 隐私代理的 stripPiiMarkers() 会提取标记间的内容，丢弃后面的原始 PII。


### 设计意图

  S3/S2-local 的双轨历史注入解决了一个关键问题：本地模型需要看到之前
  被遮蔽的敏感对话才能给出有意义的回复，但这些内容在主转录中已被占位符替代。
  S2-proxy 的标记注入是与隐私代理的"安全契约"——即使 OpenClaw 改变
  prependContext 语义，代理的 fallback regex 脱敏仍提供纵深防御。
## Hook 3：before_tool_call                        (L477-L580)


### 作用

  在工具调用执行前进行多层检查：
  1. 文件访问守卫——阻止云端模型访问受保护的内存路径
  2. 内存读取路由——将 memory_get 重定向到正确的轨道
  3. 子 Agent / A2A 消息守卫——规则检测 spawn/send 内容
  4. 通用工具调用检测——可配置为规则或 pipeline

### 参数

  event: { toolName, params }
  ctx: { sessionKey }

### 返回值

  { block: true, blockReason: string } — 阻断工具调用
  { params: Record } — 修改工具参数（路径重定向）
  void — 不干预

### 逐行逻辑


**L479-L481**:
```typescript
提取 toolName、sessionKey。toolName 为空时跳过。
```


#### 文件访问守卫（L488-L497）


**L489**:
```typescript
if (!isGuardSessionKey(sessionKey) && !isActiveLocalRouting(sessionKey))
```
> 仅对云端模型生效。本地模型（Guard 子会话和 S3 活跃路由）
> 被信任可以读取完整历史。


**L491**:
```typescript
const pathValues = extractPathsFromParams(typedParams);
```
> 从工具参数中提取所有路径（支持 path、file、command 等字段）。


**L492-L496**:
```typescript
for (const p of pathValues) { if (isProtectedMemoryPath(p, baseDir)) ... }
```
> 检查路径是否匹配受保护模式（sessions/full、memory-full、MEMORY-FULL.md）。
> 匹配则阻断工具调用，返回原因说明。


#### 内存读取路由（L501-L509）


**L501**:
```typescript
if (toolName === "memory_get" && shouldUseFullMemoryTrack(sessionKey))
```
> 仅对完全本地的会话，将 MEMORY.md → MEMORY-FULL.md，
> memory/ → memory-full/。通过修改 params.path 实现透明重定向。


#### 子 Agent / A2A 守卫（L512-L531）


**L512-L513**:
```typescript
isSpawn = toolName === "sessions_spawn"; isSend = toolName === "sessions_send";
```
> 拦截子 Agent 创建和 A2A 消息发送。


**L515-L530**:
```typescript
对 task 或 message 字段做规则检测。
```
> S3 → 阻断（敏感数据不应发给子 Agent）
> S2 → 标记会话为私密（但不阻断）
> 注意：这里只用规则检测（不调 LLM），避免子 Agent 创建时的额外开销。


#### 通用工具调用检测（L541-L576）


**L541**:
```typescript
if (!isActiveLocalRouting(sessionKey) && !isToolAllowlisted(toolName))
```
> S3 本地路由中的工具调用跳过检测（模型已在本地，重新检测会
> 阻断本地模型正常需要的工具调用）。白名单工具也跳过。


**L542-L543**:
```typescript
const detectors = privacyConfig.checkpoints?.onToolCallProposed ?? ["ruleDetector"];
```
> 检测方法由配置驱动。默认只用规则检测器（快速）。
> 配置了 "localModelDetector" 时运行完整 pipeline（含 LLM）。


**L547-L565**:
```typescript
usePipeline ? pipeline.run() : detectByRules()
```
> 两种检测路径：完整 pipeline 或仅规则。


**L569-L575**:
```typescript
S3 → 阻断工具调用；S2 → 标记会话私密。
```


### 设计意图

  多层防御：(1) 路径级保护防止云端模型偷读完整内存，
  (2) 内存路由确保本地模型能读到未脱敏数据，
  (3) 子 Agent 守卫防止敏感数据通过 A2A 泄露，
  (4) 通用检测覆盖所有其他工具调用。
## Hook 4：tool_result_persist                     (L586-L767)


### 作用

  工具执行后结果持久化前的单一处理器，负责：
  1. 内存双写同步（Agent 写 MEMORY.md 时同步到 MEMORY-FULL.md）
  2. memory_search 结果过滤（按轨道过滤搜索结果）
  3. S3 本地路由的双轨拆分（原文→full，脱敏→clean+主转录）
  4. 通用 PII 脱敏 + 规则检测 + LLM 同步检测

  这是一个同步 Hook（非 async），因为它需要在返回前修改消息内容。

### 参数

  event: { message, params? }
  ctx: { sessionKey, toolName }

### 返回值

  { message: unknown } — 修改后的工具结果消息
  void — 不修改

### 逐行逻辑


**L588-L592**:
```typescript
提取 sessionKey 和 message，为空时跳过。
```


#### 内存双写同步（L596-L605）


**L596**:
```typescript
if (ctx.toolName === "write" || ctx.toolName === "write_file")
```
> Agent 使用 write/write_file 工具写入文件。


**L598**:
```typescript
const writePath = String(...)
```
> 从 event.params.path 提取写入路径。


**L599**:
```typescript
if (writePath && isMemoryWritePath(writePath))
```
> 检查是否是内存文件路径（MEMORY.md 或 memory/*.md）。


**L601**:
```typescript
syncMemoryWrite(writePath, workspaceDir, ...).catch(...)
```
> 异步触发双写同步：
> 读取刚写入的内容 → 写入 MEMORY-FULL.md（完整版）
> → PII 脱敏后覆盖回 MEMORY.md（脱敏版）。
> 使用 .catch() 忽略错误，不阻塞工具结果返回。


#### memory_search 结果过滤（L610-L614）


**L611**:
```typescript
const filtered = filterMemorySearchResults(msg, shouldUseFullMemoryTrack(sessionKey));
```
> QMD（语义搜索）会同时索引 MEMORY.md 和 MEMORY-FULL.md。
> 根据会话类型过滤：
> - 本地会话：排除 MEMORY.md 结果（偏好完整版）
> - 云端会话：排除 MEMORY-FULL.md 结果（防止 PII 泄露）


#### S3 本地路由：双轨拆分（L620-L642）


**L620**:
```typescript
if (isActiveLocalRouting(sessionKey))
```
> S3 场景：本地模型看到的是完整数据。


**L622**:
```typescript
const textContent = extractMessageText(msg);
```
> 从 AgentMessage 提取文本内容（支持 string 和 content array）。


**L623-L639**:
```typescript
if (textContent && textContent.length >= 10) { ... }
```
> 原文写入 full 轨道，PII 脱敏后写入 clean 轨道。
> 如果脱敏后内容有变化，同时修改主转录中的消息。
> 这确保未来 S1 轮次（云端模型）不会从主转录中看到 S3 工具结果的原始 PII。


#### 白名单工具跳过（L646）


**L646**:
```typescript
if (ctx.toolName && isToolAllowlisted(ctx.toolName)) return;
```
> 白名单工具的结果不做任何处理。


#### 通用检测 + PII 脱敏（L651-L763）


**L661**:
```typescript
const wasPrivateBefore = isSessionMarkedPrivate(sessionKey);
```
> 快照当前轮次的隐私状态（在检测运行前）。
> 这是因为 markSessionAsPrivate() 会立即更新 currentTurnLevel，
> 如果在检测后才检查 isSessionMarkedPrivate() 会永远为 true，
> 导致 LLM 双写 fallback 逻辑被错误跳过。


**L663-L671**:
```typescript
const ruleCheck = detectByRules({ checkpoint: "onToolCallExecuted", ... })
```
> 对工具结果执行规则检测。


**L681**:
```typescript
const effectiveLevel = ruleCheck.level === "S3" ? "S2" as const : ruleCheck.level;
```
> 关键降级逻辑：tool_result_persist 检测到 S3 时已经"太晚了"——
> 云端模型已在处理此轮请求。无法将路由切换到本地。
> 因此降级到 S2 行为（PII 脱敏是此阶段仍可用的最强保护）。
> 审计日志中仍记录真实的 S3 级别。


**L695-L706**:
```typescript
PII 脱敏 + 双写
```
> 执行 redactSensitiveInfo() 正则脱敏。
> 如果检测到敏感内容 / 脱敏产生了变化 / 轮次之前已是私密状态，
> 执行双轨写入（原文→full，脱敏→clean）。


**L708-L712**:
```typescript
if (wasRedacted) { ... return { message: modified }; }
```
> 如果正则脱敏改变了内容，修改主转录中的消息。


#### LLM 同步检测（L720-L763）


**L720**:
```typescript
if (privacyConfig.localModel?.enabled && ruleCheck.level !== "S3")
```
> 当本地模型可用且规则没有检测到 S3 时，追加 LLM 语义检测。


**L721-L724**:
```typescript
const llmResult = syncDetectByLocalModel(...)
```
> syncDetectByLocalModel 使用 synckit 在 Worker 线程中同步阻塞
> 执行 LLM 推理（通过 Atomics.wait）。超时 20s 后优雅回退到
> 仅规则结果。


**L726**:
```typescript
if (llmResult.level !== "S1" && llmResult.levelNumeric > ruleCheck.levelNumeric)
```
> LLM 的判定比规则更严格时才采纳。


**L730-L731**:
```typescript
trackSessionLevel / markSessionAsPrivate
```
> 同样使用 S3→S2 降级策略（模型路由无法中途更改）。


**L748-L753**:
```typescript
LLM 首次检测到敏感 + 规则/正则未触发 + 轮次之前不是私密
```
> → 执行双轨写入（避免与上面已执行的双写重复）。


**L757-L761**:
```typescript
LLM 检测到 S3 → 执行 PII 脱敏并修改消息
```
> 即使模型路由无法更改，至少确保工具结果在进入模型上下文和
> 持久化转录前被脱敏。


### 设计意图

  tool_result_persist 是唯一能修改持久化转录的同步 Hook。它实现了
  "三层检测"（规则→正则脱敏→LLM 语义检测）和"太晚了则降级"的安全策略。
  LLM 同步检测使用 Worker 线程是因为此 Hook 必须同步返回修改后的消息，
  不能 async。
## Hook 6：before_message_write                    (L772-L872)


### 作用

  消息写入转录前的最后处理：
  1. 双轨历史持久化（user/assistant/system 消息）
  2. 本地模型响应的 PII 脱敏
  3. 用户消息的转录清洗（S3→占位符，S2→脱敏文本）

### 参数

  event: { message } — AgentMessage 对象
  ctx: { sessionKey }

### 返回值

  { message: object } — 修改后的消息
  void — 不修改

### 逐行逻辑


**L774-L781**:
```typescript
提取 sessionKey、message、role、pending 检测结果。
```


#### 双轨历史持久化（L792-L839）


**L792**:
```typescript
const needsDualHistory = isSessionMarkedPrivate(sessionKey) || (pending?.level === "S3") || isActiveLocalRouting(sessionKey);
```
> 判断是否需要双轨持久化。注意 pending?.level === "S3" 的场景：
> Guard Agent 在物理隔离的子会话中运行，主会话不一定被标记为私密，
> 但仍需记录 S3 用户消息（原文→full，占位符→clean）用于审计。


**L793**:
```typescript
if (needsDualHistory && role !== "tool")
```
> 排除 tool 角色消息——它们在 tool_result_persist（Hook 4）中
> 已经处理过，避免双重写入。


**L798-L813**:
```typescript
role === "user" && pending.level !== "S1"
```
> 用户消息的双轨处理：
> - full 轨道：写入原始内容（pending.originalPrompt）
> - clean 轨道：S3 → "🔒 [Private message]" 占位符
> S2 → 脱敏后的文本


**L815-L828**:
```typescript
role === "assistant" && isActiveLocalRouting(sessionKey)
```
> 本地模型的 assistant 回复：可能包含回显的 PII。
> - full 轨道：写入原文
> - clean 轨道：写入 PII 脱敏后的版本


**L829-L838**:
```typescript
其他角色 (system / S1-user / 非本地路由的 assistant)
```
> 调用 sessionManager.persistMessage()，它内部处理 guard-agent
> 过滤（guard → 仅写 full，其他 → 双写）。


#### PII 脱敏本地模型响应（L846-L855）


**L846**:
```typescript
if (role === "assistant" && isActiveLocalRouting(sessionKey))
```
> 本地模型可能回显 PII（如"你的身份证号 310101... 有效"）。
> 在写入主转录前脱敏，确保后续云端轮次不会看到原始 PII。


#### 用户消息转录清洗（L858-L868）


**L858**:
```typescript
if (role !== "user") return;
```
> 只处理用户消息。


**L861-L863**:
```typescript
S3 → 用占位符 "🔒 [Private message — processed locally]" 替换消息内容
```

**L865-L868**:
```typescript
S2 → 用脱敏后的文本替换消息内容
```
> consumeDetection() 消费暂存的检测结果（一次性使用）。


### 设计意图

  before_message_write 是转录清洗的最后一道关。它确保主转录中
  永远不会出现 S3 原始内容（只有占位符），S2 内容也被脱敏后的
  版本替代。双轨持久化确保审计和本地模型仍能访问完整历史。
## Hook 7：session_end                             (L877-L896)


### 作用

  会话结束时执行清理和同步。

### 参数

  event: { sessionKey }
  ctx: { sessionKey }

### 返回值

  void

### 逐行逻辑


**L879**:
```typescript
const sessionKey = event.sessionKey ?? ctx.sessionKey;
```
> 优先从 event 读取 sessionKey，回退到 ctx。


**L882**:
```typescript
const wasPrivate = isSessionMarkedPrivate(sessionKey);
```
> 记录会话是否曾为私密（用于日志）。


**L885-L887**:
```typescript
await memMgr.syncAllMemoryToClean(privacyConfig);
```
> 全量同步：MEMORY-FULL.md → 过滤 guard 内容 → PII 脱敏 → MEMORY.md。
> 同时同步所有日期内存文件（memory-full/*.md → memory/*.md）。


**L889**:
```typescript
clearSessionState(sessionKey);
```
> 清除内存中的会话状态（sessionStates、activeLocalRouting、pendingDetections）。


**L891-L892**:
```typescript
const collector = getGlobalCollector(); if (collector) await collector.flush();
```
> 刷新 Token 统计收集器的缓冲区。


### 设计意图

  会话结束是执行全量内存同步的最佳时机——确保所有 Guard Agent 交互
  和脱敏内容都已正确同步到 clean 轨道。clearSessionState 释放内存。
## Hook 8：after_compaction                        (L901-L911)


### 作用

  OpenClaw 压缩对话历史后触发，执行全量内存同步。

### 参数

  _event: 未使用
  ctx: { workspaceDir }

### 返回值

  void

### 逐行逻辑


**L903**:
```typescript
if (ctx.workspaceDir) _cachedWorkspaceDir = ctx.workspaceDir;
```
> 更新缓存的工作区目录。


**L904-L906**:
```typescript
syncAllMemoryToClean(privacyConfig);
```
> 压缩可能改变了 MEMORY.md 的内容结构，需要重新同步。


### 设计意图

  压缩后 MEMORY.md 内容可能被重写，需要确保 MEMORY-FULL.md
  包含压缩后的新增内容，同时 MEMORY.md 保持脱敏状态。
## Hook 9：llm_output                              (L916-L930)


### 作用

  LLM 输出事件，追踪 Token 用量用于成本估算。

### 参数

  event: { sessionId, provider, model, usage }
  ctx: { sessionKey }

### 返回值

  void

### 逐行逻辑


**L918-L919**:
```typescript
const collector = getGlobalCollector(); if (!collector) return;
```
> 获取全局 TokenStatsCollector。未初始化时跳过。


**L920-L928**:
```typescript
collector.record({ sessionKey, provider, model, source: "task", usage })
```
> 记录一条 Token 使用记录。
> source 固定为 "task"（区分 detection、desensitization 等其他来源）。


### 设计意图

  为 Dashboard 的成本估算面板提供数据。所有 LLM 调用（包括检测、脱敏、
  正常对话）的 Token 用量都通过此 Hook 收集。
## Hook 10：before_reset                           (L935-L945)


### 作用

  会话重置前执行全量内存同步，与 session_end 类似。

### 参数

  _event: 未使用
  ctx: { workspaceDir }

### 返回值

  void

### 逐行逻辑


**L937-L941**:
```typescript
更新工作区缓存 + syncAllMemoryToClean
```
> 重置会清除所有上下文，必须在此之前确保内存已同步。


### 设计意图

  防止重置导致未同步的 Guard Agent 内容丢失。
## Hook 11：message_sending                        (L950-L983)


### 作用

  出站消息守卫。当 OpenClaw 向外部发送消息时，检测敏感内容。

### 参数

  event: { content }
  ctx: { sessionKey }

### 返回值

  { cancel: true } — 取消发送
  { content: string } — 替换为脱敏内容
  void — 不干预

### 逐行逻辑


**L952-L956**:
```typescript
content 为空或隐私未启用时跳过。
```


**L958-L966**:
```typescript
运行 pipeline 检测。
```
> 使用 "onUserMessage" checkpoint（复用用户消息的检测逻辑）。


**L968-L970**:
```typescript
S3 或 block → 取消发送。
```
> 敏感数据绝不能外发。


**L972-L978**:
```typescript
S2 → 脱敏后发送。
```
> 如果脱敏失败 → 取消发送（同"宁可过度保护"原则）。


### 设计意图

  message_sending 是出站消息的最后一道防线。防止通过 A2A 通信
  或其他出站通道泄露敏感数据。
## Hook 12：before_agent_start                     (L988-L1038)


### 作用

  子 Agent 启动前的隐私守卫。检测子 Agent 的 prompt 是否包含敏感内容。

### 参数

  event: { prompt }
  ctx: { sessionKey, agentId }

### 返回值

  { providerOverride, modelOverride } — 路由到本地模型
  { prompt: string } — 替换为脱敏后的 prompt
  void — 不干预

### 逐行逻辑


**L991-L992**:
```typescript
if (!sessionKey.includes(":subagent:") || !prompt?.trim()) return;
```
> 仅拦截子 Agent 会话（sessionKey 包含 ":subagent:"）。
> prompt 为空时跳过。


**L994-L995**:
```typescript
隐私未启用时跳过。
```


**L997-L1004**:
```typescript
运行 pipeline 检测。
```


**L1010-L1020**:
```typescript
S3 / block → 路由到本地模型。
```
> 修改系统提示词不是可靠的安全控制（云端模型已经看到了 prompt），
> 因此直接将整个子 Agent 路由到本地模型。


**L1021-L1033**:
```typescript
S2 → 尝试脱敏 prompt。
```
> 脱敏成功 → 返回脱敏后的 prompt
> 脱敏失败 → 路由到本地模型（同"升级到 S3"策略）


### 设计意图

  子 Agent 可能接收来自主 Agent 的敏感上下文。此 Hook 确保
  敏感 prompt 要么被脱敏（S2），要么路由到本地模型（S3/block）。
## Hook 13：message_received                       (L1043-L1049)


### 作用

  纯观察性 Hook，记录收到的消息来源。不做任何修改。

### 参数

  event: { from }
  _ctx: 未使用

### 返回值

  void

### 逐行逻辑


**L1045-L1046**:
```typescript
隐私未启用时跳过。
```


**L1047**:
```typescript
api.logger.info?.(`[GuardClaw] Message received from ${event.from ?? "unknown"}`);
```
> 使用可选链 ?.() 调用 info（防止 logger.info 未定义）。


### 设计意图

  为调试和监控提供消息流的可见性。catch 为空块因为这只是观察性日志，
  失败不应影响任何功能。
## 辅助函数：shouldSkipMessage(msg)                (L1058-L1062)


### 作用

  判断消息是否应跳过隐私检测。

### 参数

  msg: string — 消息文本

### 返回值

  boolean — true 表示跳过

### 逐行逻辑


**L1059**:
```typescript
if (msg.includes("[REDACTED:") || msg.startsWith("[SYSTEM]")) return true;
```
> 已脱敏（包含 [REDACTED:XXX] 标签）或系统消息 → 跳过。
> 避免对已处理过的内容重复检测。


**L1060**:
```typescript
if (/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(msg)) return true;
```
> 匹配时间戳格式消息（如 "[Mon 2024-01-01 12:00..."）→ 跳过。
> 这类消息是 OpenClaw 系统生成的时间标记，不含用户内容。


### 设计意图

  避免对已处理或系统生成的内容做无意义的检测，减少误报和开销。
## 辅助函数：extractMessageText(msg)               (L1067-L1088)


### 作用

  从 AgentMessage 对象中提取文本内容。
  支持三种格式：string、{ content: string }、{ content: [{ type: "text", text: string }] }

### 参数

  msg: unknown — AgentMessage 对象（类型不确定）

### 返回值

  string — 提取的文本内容，不存在时返回空字符串

### 逐行逻辑


**L1068**:
```typescript
if (typeof msg === "string") return msg;
```
> 最简情况：消息本身就是字符串。


**L1069**:
```typescript
if (!msg || typeof msg !== "object") return "";
```
> null / undefined / 非对象 → 空字符串。


**L1072**:
```typescript
if (typeof m.content === "string") return m.content;
```
> OpenAI 格式：content 为字符串。


**L1074-L1085**:
```typescript
if (Array.isArray(m.content)) { ... }
```
> 多模态格式：content 为数组（可含 text、image 等 part）。
> 提取所有 text part 的文本，用换行符连接。
> 支持 string 类型的 part 和 { text: string } 对象类型的 part。


### 设计意图

  OpenClaw 的 AgentMessage 可能是多种格式（取决于 provider）。
  此函数做统一的文本提取，避免每个 Hook 重复写类型判断逻辑。
## 辅助函数：replaceMessageText(msg, newText)      (L1096-L1125)


### 作用

  替换 AgentMessage 中的文本内容，保持原有结构不变。
  对于 content array 格式，替换第一个 text part 并移除后续 text part，
  保留非 text part（图片、文件引用等）的原始顺序。

### 参数

  msg: unknown — 原始 AgentMessage
  newText: string — 替换后的文本

### 返回值

  unknown | null — 修改后的消息对象，无法替换时返回 null

### 逐行逻辑


**L1097**:
```typescript
if (typeof msg === "string") return newText;
```
> 字符串消息直接返回新文本。


**L1098**:
```typescript
if (!msg || typeof msg !== "object") return null;
```
> 无法处理的类型返回 null。


**L1101-L1103**:
```typescript
if (typeof m.content === "string") return { ...m, content: newText };
```
> OpenAI 字符串格式：直接替换 content。


**L1105-L1121**:
```typescript
content array 格式
```
> 遍历所有 part：
> - 第一个 text part → 用新文本替换
> - 后续 text part → 跳过（不加入新数组）
> - 非 text part → 保留
> 如果没有找到 text part → 在数组头部插入一个新的 text part。


### 设计意图

  必须保持消息的结构完整性（role、metadata、非文本 part），
  只替换文本内容。合并多个 text part 为一个避免结构混乱。
辅助函数：loadDualTrackContext(sessionKey, agentId, limit)
                                                 (L1134-L1147)

### 作用

  加载 full 轨道和 clean 轨道之间的"增量"消息，格式化为可注入的对话上下文。

### 参数

  sessionKey: string — 会话标识符
  agentId?: string — Agent ID，默认 "main"
  limit?: number — 最大消息数

### 返回值

  Promise<string | null> — 格式化的上下文字符串，无有效增量时返回 null

### 逐行逻辑


**L1140**:
```typescript
const mgr = getDefaultSessionManager();
```
> 获取 DualSessionManager 单例。


**L1141**:
```typescript
const delta = await mgr.loadHistoryDelta(sessionKey, agentId ?? "main", limit);
```
> loadHistoryDelta() 读取 full 和 clean 轨道，
> 返回仅存在于 full 中的消息（即 Guard Agent 交互和 S3 原始内容）。
> 去重使用 "role:timestamp:content前80字符" 作为 key。


**L1142**:
```typescript
if (delta.length === 0) return null;
```
> 没有增量 → 不需要注入。


**L1143**:
```typescript
return DualSessionManager.formatAsContext(delta);
```
> 格式化为 "[Full conversation history (original, authoritative)]\n..."。
> 每条消息格式为 "Role [ts=ISO]: content"。
> 长内容截断到 2000 字符。


### 设计意图

  为 before_prompt_build 提供双轨历史的增量上下文。本地模型能看到
  在主转录中被占位符替换的原始敏感交互，从而给出更有意义的回复。
## 常量：MEMORY_WRITE_PATTERNS                      (L1151-L1155)


正则数组，用于识别内存文件路径：
  - /^MEMORY\.md$/  — 顶层长期记忆
  - /^memory\.md$/  — 小写变体
  - /^memory\//     — 日期内存目录下的文件
## 辅助函数：isMemoryWritePath(writePath)           (L1157-L1160)


### 作用

  判断写入路径是否是内存文件（需要触发双写同步）。

### 参数

  writePath: string — 写入路径

### 返回值

  boolean

### 逐行逻辑


**L1158**:
```typescript
const rel = writePath.replace(/^\.\//, "");
```
> 去掉 "./" 前缀得到相对路径。


**L1159**:
```typescript
return MEMORY_WRITE_PATTERNS.some((p) => p.test(rel));
```
> 与三个模式逐一匹配。


### 设计意图

  作为 tool_result_persist Hook 中内存双写逻辑的前置判断。
辅助函数：syncMemoryWrite(writePath, workspaceDir, privacyConfig, logger, isGuardSession)
                                                 (L1167-L1219)

### 作用

  Agent 写入内存文件后，执行双写同步：
  MEMORY.md → 读取内容 → 原文写入 MEMORY-FULL.md，PII 脱敏后覆盖回 MEMORY.md。

### 参数

  writePath: string — Agent 写入的文件路径
  workspaceDir: string — 工作区根目录
  privacyConfig: PrivacyConfig — 隐私配置（含脱敏选项）
  logger: { info, warn } — 日志接口
  isGuardSession: boolean — 是否为 Guard 会话（默认 false）

### 返回值

  Promise<void>

### 逐行逻辑


**L1174**:
```typescript
const rel = writePath.replace(/^\.\//, "");
```
> 标准化为相对路径。


**L1175-L1177**:
```typescript
path.isAbsolute(writePath) ? writePath : path.resolve(workspaceDir, rel)
```
> 解析为绝对路径用于文件读取。


**L1179-L1183**:
```typescript
读取刚写入的文件内容。读取失败时静默返回。
```


**L1186**:
```typescript
if (!content.trim()) return;
```
> 空文件跳过。


**L1189-L1196**:
```typescript
确定对应的 full 轨道路径
```
> MEMORY.md → MEMORY-FULL.md
> memory/X.md → memory-full/X.md
> 其他路径 → 返回（不是内存文件）。


**L1201**:
```typescript
await fs.promises.mkdir(path.dirname(fullAbsPath), { recursive: true });
```
> 确保 memory-full/ 目录存在。


**L1205-L1208**:
```typescript
Guard 会话的内容用 HTML 注释标记包裹
```
> "<!-- guardclaw:guard-begin -->" 和 "<!-- guardclaw:guard-end -->"
> 这样 filterGuardContent() 在 FULL→CLEAN 同步时能可靠地剥离它们。


**L1211-L1218**:
```typescript
PII 脱敏并覆盖回 clean 版本
```
> memMgr.redactContentPublic() 优先用本地模型脱敏，回退到正则。
> 如果脱敏后内容有变化 → 覆盖回原文件 + 记录日志。


### 设计意图

  确保内存的双轨一致性：full 轨道始终是完整超集，clean 轨道始终是脱敏版本。
  Guard 会话内容用标记包裹是因为 filterGuardContent() 依赖这些标记来剥离
  Guard Agent 特有的内容（如分析结果、敏感数据摘要）。
辅助函数：filterMemorySearchResults(msg, useFullTrack)
                                                 (L1226-L1265)

### 作用

  过滤 memory_search 工具的返回结果，确保每种会话类型只看到对应轨道的结果。

### 参数

  msg: unknown — memory_search 返回的 AgentMessage
  useFullTrack: boolean — 是否使用完整轨道

### 返回值

  unknown | null — 修改后的消息，无需修改时返回 null

### 逐行逻辑


**L1230-L1231**:
```typescript
提取消息文本。
```


**L1234**:
```typescript
const parsed = JSON.parse(textContent);
```
> memory_search 返回 JSON 格式的搜索结果。


**L1237**:
```typescript
const results = (parsed).results;
```
> 提取 results 数组。


**L1240-L1255**:
```typescript
results.filter(...)
```
> 根据 useFullTrack 标志过滤：
> - 完全本地会话（useFullTrack=true）：排除 MEMORY.md 和 memory/ 的结果
> （偏好完整版本，避免看到脱敏内容）
> - 云端会话（useFullTrack=false）：排除 MEMORY-FULL.md 和 memory-full/ 的结果
> （防止 PII 泄露）


**L1257**:
```typescript
if (filtered.length === results.length) return null;
```
> 无需过滤时返回 null（不修改消息）。


**L1259-L1261**:
```typescript
构造新的 JSON 并替换消息文本。
```


### 设计意图

  QMD（语义搜索引擎）通过 extraPaths 配置同时索引了两个轨道。
  此函数确保搜索结果不会跨轨道泄露——云端会话永远看不到完整轨道的内容。

### Part A — Code 层面改动建议


#### 🟡 S3 路由兜底逻辑重复


 现状（L175-L180, L224-L230, L249-L253, L323-L328, L345-L350, L367-L372）：
    每次需要路由到本地模型时都重复以下代码：
      const guardCfg = getGuardAgentConfig(privacyConfig);
      const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
      return { providerOverride: guardCfg?.provider ?? defaultProvider,
               modelOverride: guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1" };
    至少出现 6 次，违反 DRY 原则。

 问题：每次复制粘贴都可能引入不一致（如某处忘了 ?? "openbmb/minicpm4.1" 兜底）。
       修改兜底模型名时需要改 6 个地方。

 建议：抽取为辅助函数：
    function resolveLocalModelOverride(config: PrivacyConfig): { providerOverride: string; modelOverride: string } {
      const guardCfg = getGuardAgentConfig(config);
      const defaultProvider = config.localModel?.provider ?? "ollama";
      return {
        providerOverride: guardCfg?.provider ?? defaultProvider,
        modelOverride: guardCfg?.modelName ?? config.localModel?.model ?? "openbmb/minicpm4.1",
      };
    }


#### 🟢 getGuardAgentSystemPrompt() 未被使用


 现状（L97-L99）：
    函数定义存在但在 hooks.ts 中未被任何地方调用。

 问题：死代码增加维护负担。

 建议：确认 guard-agent.ts 是否使用此函数。如果不需要，删除它和
       DEFAULT_GUARD_AGENT_SYSTEM_PROMPT 常量。如果需要，移到 guard-agent.ts 中。


#### 🟡 S2-proxy 路径中 provider 配置提取逻辑重复


 现状（L283-L296, L377-L389）：
    S2-proxy 的原始 provider 提取逻辑重复出现两次：
      const defaults = api.config.agents?.defaults as Record<string, unknown> | undefined;
      const primaryModel = (defaults?.model as Record<string, unknown> | undefined)?.primary as string ?? "";
      const defaultProvider = (defaults?.provider as string) || primaryModel.split("/")[0] || "openai";
      ...

 问题：两处代码几乎完全一样，修改一处容易忘记另一处。

 建议：抽取为 resolveOriginalProvider(api) 辅助函数。


#### 🟢 魔法字符串 "openbmb/minicpm4.1"


 现状（L178, L229, L253, L328, L350, L372, L1014, L1028）：
    默认模型名 "openbmb/minicpm4.1" 作为硬编码字符串出现 8 次。

 问题：更换默认模型需要修改 8 个地方。

 建议：定义为模块级常量 DEFAULT_LOCAL_MODEL = "openbmb/minicpm4.1"。


#### 🟢 _cachedWorkspaceDir 可能为 undefined


 现状（L112, L599）：
    _cachedWorkspaceDir 在 syncMemoryWrite 中使用时回退到 process.cwd()。

 问题：process.cwd() 不一定是工作区目录（如插件在不同目录启动）。
       如果第一个提供 ctx.workspaceDir 的 Hook 尚未触发，可能导致
       内存文件被写入错误位置。

 建议：在 registerHooks 初始化时就尝试获取 workspaceDir（如果 api 提供的话），
       或在 syncMemoryWrite 中检查 _cachedWorkspaceDir 是否为 undefined 时
       发出警告日志。


### Part B — 逻辑/设计层面改动建议


#### 🔴 tool_result_persist 中 S3→S2 降级后仍可能泄露部分数据


 现状（L681）：
    effectiveLevel = ruleCheck.level === "S3" ? "S2" : ruleCheck.level
    在 tool_result_persist 检测到 S3 时降级到 S2（PII 脱敏）。

 问题：PII 脱敏依赖 redactSensitiveInfo() 的正则规则，对于非结构化
       敏感数据（如自然语言描述的疾病诊断、法律纠纷细节）可能完全无法
       脱敏。也就是说，规则判定为 S3（应完全本地处理）的数据可能在
       仅执行 S2 级别的正则脱敏后仍以明文形式到达云端模型。

 建议：当 tool_result_persist 检测到 S3 时，考虑直接将工具结果替换为
       通用占位符（如 "[Sensitive data detected — redacted for safety]"），
       而非依赖正则脱敏。虽然会损失上下文，但安全优先。
       或者，记录到一个"待审查"列表供用户事后检查。


#### 🔴 before_model_resolve 中 S2-proxy 的 stashOriginalProvider 在 providerConfig 不存在时静默跳过


 现状（L287-L297）：
    if (providerConfig) { stashOriginalProvider(...); }
    如果 providerConfig 不存在（用户配置中未定义该 provider），
    不 stash 任何 target，但仍返回 providerOverride: "guardclaw-privacy"。

 问题（L302-L553, privacy-proxy.ts L555-L565）：
    隐私代理在收到请求时调用 resolveTarget()，如果没有 stash 的 target
    且 defaultProviderTarget 也为 null，会返回 502 错误。
    用户看到的是 "no original provider target configured"，
    但不清楚是因为 provider 配置缺失。

 建议：在 providerConfig 不存在时记录 warn 日志，说明 provider 未配置，
       并考虑回退到其他 provider 或直接不走 proxy 路径。


#### 🟡 message_sending Hook 使用 "onUserMessage" checkpoint


 现状（L963-L964）：
    pipeline.run("onUserMessage", { checkpoint: "onUserMessage", ... })
    出站消息使用了 "onUserMessage" checkpoint。

 问题：出站消息语义上不是"用户消息"。路由器在做 checkpoint 分发时
       可能对 "onUserMessage" 有特殊处理（如只在此 checkpoint 运行
       特定检测器）。message_sending 的检测需求可能不同。

 建议：考虑添加独立的 "onMessageSending" checkpoint，或至少在
       context 中传递一个标记表明这是出站检测。


#### 🟡 before_tool_call 中 sessions_spawn / sessions_send 仅用规则检测


 现状（L512-L531）：
    子 Agent 任务和 A2A 消息只用 detectByRules() 检测。
    而后面的通用工具检测（L541-L576）支持可配置的 pipeline 检测。

 问题：子 Agent 的 task 可能包含语义敏感但无关键词的内容（如
       "分析这个人的健康状况"），规则检测器无法捕获。

 建议：对 sessions_spawn / sessions_send 也支持可配置的 pipeline 检测，
       或至少在子 Agent 场景的 context 中包含父会话的敏感级别作为参考。


#### 🟢 Hook 编号不连续（缺少 Hook 5）


 现状：Hook 编号从 4 跳到 6（after_tool_call 被移除后编号未更新）。

 问题：代码注释和文档中的编号不连续可能造成混淆。

 建议：统一重新编号或在跳过位置加注释说明 Hook 5 为什么不存在。


### 优先级总览


| 编号 | 优先级 | 标题                                          |
|------|--------|-----------------------------------------------|
|   6  | 🔴     | S3→S2 降级可能泄露非结构化敏感数据             |
|   7  | 🔴     | S2-proxy stash 失败时静默返回 proxy override   |
|   1  | 🟡     | S3 路由兜底逻辑重复 (6 次)                     |
|   3  | 🟡     | S2-proxy provider 提取逻辑重复 (2 次)          |
|   8  | 🟡     | message_sending 复用 onUserMessage checkpoint  |
|   9  | 🟡     | sessions_spawn/send 仅用规则检测               |
|   2  | 🟢     | getGuardAgentSystemPrompt() 未被使用           |
|   4  | 🟢     | 魔法字符串 "openbmb/minicpm4.1" (8 处)         |
|   5  | 🟢     | _cachedWorkspaceDir 回退到 process.cwd() 风险  |
|  10  | 🟢     | Hook 编号不连续                                |
