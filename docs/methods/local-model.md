# local-model.ts — 逐方法文档


 文件定位：本地/边缘模型调用与敏感度检测的核心模块
 所属模块：GuardClaw 隐私路由系统

 核心职责：
 1) 提供 provider 无关的聊天补全调用能力，支持三种 API 协议
    （OpenAI 兼容、Ollama 原生、用户自定义模块）；
 2) 利用本地模型进行隐私敏感度检测（S1/S2/S3 分类）；
 3) 利用本地模型进行 PII（个人可识别信息）提取与脱敏处理。

 敏感等级体系：
   S1 — 无敏感内容，直接放行至云端
   S2 — 中度敏感，走代理(proxy)脱敏后转发或本地(local)处理
   S3 — 高度敏感，强制本地模型处理，绝不上云

 API 协议类型（EdgeProviderType）：
   "openai-compatible" — POST /v1/chat/completions
       兼容 Ollama、vLLM、LiteLLM、LocalAI、LMStudio、SGLang、TGI 等
   "ollama-native"     — POST /api/chat (Ollama 原生 API)
   "custom"            — 用户自行编写模块，导出 callChat() 函数
## 类型：ChatMessage                              (L21)


单条聊天消息的结构。

字段说明：
  role: "system" | "user" | "assistant"
      消息角色。system 为系统指令，user 为用户输入，
      assistant 为模型回复。

  content: string
      消息文本内容。
## 类型：ChatCompletionOptions                     (L23-L29)


聊天补全请求的可选参数。

字段说明：
  temperature?: number
      采样温度，值越低输出越确定。系统默认 0.1（偏保守）。

  maxTokens?: number
      最大输出 token 数，默认 800。

  stop?: string[]
      停止词列表，模型生成到这些词时停止。

  frequencyPenalty?: number
      频率惩罚，抑制重复词汇。OpenAI 协议直接传递，
      Ollama 原生 API 转换为 repeat_penalty = 1.0 + frequencyPenalty。

  apiKey?: string
      可选的 API 密钥。仅 OpenAI 兼容协议使用，
      作为 Bearer Token 放入 Authorization 头。
## 类型：LlmUsageInfo                             (L31-L35)


LLM 调用的 token 用量统计。

字段说明：
  input: number   — 输入（prompt）token 数
  output: number  — 输出（completion）token 数
  total: number   — 总 token 数

用途：传给 TokenStatsCollector.record() 进行路由开销核算。
## 类型：ChatCompletionResult                      (L37-L40)


聊天补全调用的返回值。

字段说明：
  text: string
      模型返回的文本内容（已经过 stripThinkingTags 清洗）。

  usage?: LlmUsageInfo
      可选的 token 用量统计。
      并非所有 API 都返回 usage，因此标记为可选。
## 接口：CustomEdgeProvider                        (L46-L53)


用户自定义边缘模型提供者的接口规范。
当 localModel.type = "custom" 时，用户需要编写一个 Node 模块
导出 callChat() 函数，签名必须匹配此接口。

字段说明：
  callChat(endpoint, model, messages, options?): Promise<string>
      endpoint: string — 模型服务地址
      model: string — 模型名称
      messages: ChatMessage[] — 对话消息列表
      options?: ChatCompletionOptions — 可选配置
      返回值：模型输出的文本（string，非 ChatCompletionResult）

注意：自定义模块只需返回 string，不需要返回 usage 信息。
callChatCompletion 会将其包装为 { text } 形式的 ChatCompletionResult。
## 模块常量：_customProviderCache                   (L55)


Map<string, CustomEdgeProvider> — 自定义 provider 模块缓存。
key 为模块路径（modulePath），value 为已加载的 provider 实例。
避免对同一模块路径反复 import()，保证模块只被加载和校验一次。
## 函数：loadCustomProvider(modulePath)             (L57-L66)


### 作用

  动态加载用户自定义的 edge provider 模块，带缓存。
  校验模块必须导出 callChat 函数，否则抛出错误。

### 参数

  modulePath: string — 模块文件路径，用于 dynamic import()

### 返回值

  Promise<CustomEdgeProvider> — 已验证的 provider 实例

### 逐行逻辑


**L58**:
```typescript
const cached = _customProviderCache.get(modulePath);
```
> 先查缓存，避免重复加载。


**L59**:
```typescript
if (cached) return cached;
```
> 命中缓存直接返回，跳过后续 import。


**L60**:
```typescript
const mod = await import(modulePath) as CustomEdgeProvider;
```
> 动态导入用户指定的模块。
> as CustomEdgeProvider 类型断言——此时尚未校验，
> 下一行立即做运行时检查。


**L61-L63**:
```typescript
if (typeof mod.callChat !== "function") { throw ... }
```
> 运行时校验：模块必须导出 callChat 函数。
> 如果不满足，抛出明确的错误信息，指明路径和要求。


**L64**:
```typescript
_customProviderCache.set(modulePath, mod);
```
> 通过校验后存入缓存。


**L65**:
```typescript
return mod;
```
> 返回加载并验证过的 provider。


### 设计意图

  支持 type="custom" 场景，让用户可以接入任意推理后端。
  缓存机制避免热路径上反复 import()，且确保模块只校验一次。
函数：callChatCompletion(endpoint, model,        (L75-L103)
      messages, options?)

### 作用

  所有边缘模型调用的统一入口。根据 options.providerType 分发到
  对应的协议实现（OpenAI 兼容 / Ollama 原生 / 自定义模块）。

### 参数

  endpoint: string — 模型服务端点（如 "http://localhost:11434"）
  model: string — 模型名称（如 "openbmb/minicpm4.1"）
  messages: ChatMessage[] — 对话消息列表
  options?: ChatCompletionOptions & {
    providerType?: EdgeProviderType;  — API 协议类型，默认 "openai-compatible"
    customModule?: string;            — 自定义模块路径（type="custom" 时必填）
  }

### 返回值

  Promise<ChatCompletionResult> — 包含 text 和可选 usage 的结果

### 逐行逻辑


**L81**:
```typescript
const providerType = options?.providerType ?? "openai-compatible";
```
> 从 options 提取协议类型。
> ?? 兜底为 "openai-compatible"（最通用的协议）。


**L83**:
```typescript
let result: ChatCompletionResult;
```
> 声明结果变量，供 switch 各分支赋值。


**L84-L101**:
```typescript
switch (providerType) { ... }
```
> 三路分发：


**L85-L86**:
```typescript
case "ollama-native":
```
> 调用 callOllamaNative()，走 Ollama 原生 /api/chat 协议。


**L88-L95**:
```typescript
case "custom":
```
> L89: 检查 customModule 是否存在，不存在抛错。
> L92: 调用 loadCustomProvider 加载自定义模块。
> L93: 调用自定义模块的 callChat()，获得纯文本。
> L94: 将纯文本包装为 { text }——自定义模块不返回 usage。


**L97-L100**:
```typescript
case "openai-compatible": / default:
```
> 调用 callOpenAICompatible()，走 /v1/chat/completions 协议。
> default 也走此分支，作为兜底。


**L102**:
```typescript
return result;
```
> 返回统一的 ChatCompletionResult。


### 设计意图

  策略模式：将协议差异封装在各实现函数内部，对外暴露统一接口。
  使得 detectByLocalModel / desensitizeWithLocalModel 等上层逻辑
  无需关心底层 API 差异，只需调用 callChatCompletion 即可。
## 模块常量：GUARDCLAW_FETCH_TIMEOUT_MS             (L109)


值：60_000（60 秒）
OpenAI 兼容 API 调用的超时限制。
通过 AbortSignal.timeout() 传递给 fetch()，超时后自动中止请求。

注意：此超时仅用于 callOpenAICompatible，
callOllamaNative 没有设置超时（见 Code Review）。
函数：callOpenAICompatible(endpoint, model,      (L111-L164)
      messages, options?)

### 作用

  向 OpenAI 兼容端点发起聊天补全请求，支持 SSE 流式和非流式响应。
  兼容 Ollama、vLLM、LiteLLM、LocalAI、LMStudio、SGLang、TGI 等。

### 参数

  endpoint: string — 服务端点基址（如 "http://localhost:11434"）
  model: string — 模型名称
  messages: ChatMessage[] — 对话消息列表
  options?: ChatCompletionOptions — 可选配置

### 返回值

  Promise<ChatCompletionResult> — text + usage

### 逐行逻辑


**L117**:
```typescript
const url = `${endpoint}/v1/chat/completions`;
```
> 拼接 OpenAI 兼容的 completions 端点。


**L119**:
```typescript
const headers: Record<string, string> = { "Content-Type": "application/json" };
```
> 基础请求头。


**L120-L122**:
```typescript
if (options?.apiKey) { headers["Authorization"] = `Bearer ${options.apiKey}`; }
```
> 如果配置了 apiKey，加入 Bearer Token 认证头。
> 针对 vLLM、LiteLLM 等需要认证的场景。


**L124-L137**:
```typescript
const response = await fetch(url, { ... });
```
> 发起 POST 请求。


**L127-L135**:
```typescript
body: JSON.stringify({ ... })
```
> L128: model — 模型名称。
> L129: messages — 对话消息。
> L130: temperature — 默认 0.1，追求稳定输出。
> L131: max_tokens — 默认 800。
> L132: stream: true — 强制请求 SSE 流式响应。
> L133: stop — 条件展开：仅在 stop 数组存在时传入。
> L134: frequency_penalty — 条件展开：仅在 != null 时传入
> （注意用 != 而非 !==，同时覆盖 0 的合法值）。


**L136**:
```typescript
signal: AbortSignal.timeout(GUARDCLAW_FETCH_TIMEOUT_MS)
```
> 设置 60 秒超时。超时后 fetch 会被中止并抛出 AbortError。


**L139-L141**:
```typescript
if (!response.ok) { throw ... }
```
> 非 2xx 状态码抛出错误。


**L143-L146**:
```typescript
if (contentType.includes("text/event-stream") && response.body) {
```

             return await consumeSSEStream(response.body); }
> 检测响应 Content-Type：如果是 SSE 流（text/event-stream），
> 委托给 consumeSSEStream() 处理流式读取。
> 虽然请求设置了 stream: true，但服务端可能回退为非流式 JSON，
> 因此需要根据实际 Content-Type 分支处理。

**L148-L153**:
```typescript
const data = (await response.json()) as { ... };
```
> 非流式响应路径：解析 JSON body。
> 类型断言为 OpenAI 格式：choices[].message.content + usage。


**L152-L153**:
```typescript
let text = data.choices?.[0]?.message?.content ?? "";
```

             text = stripThinkingTags(text);
> 取第一个 choice 的内容，防御链式 ?. 确保不报错。
> stripThinkingTags 移除推理模型（如 MiniCPM、Qwen3）输出的
> <think>...</think> 标签。

**L155-L161**:
```typescript
const usage: LlmUsageInfo | undefined = data.usage ? { ... } : undefined;
```
> 如果 API 返回了 usage 信息，提取并标准化。
> total 优先用 API 返回值，否则手动计算 input + output。


**L163**:
```typescript
return { text, usage };
```
> 返回清洗后的文本和可选用量。


### 设计意图

  作为最通用的调用协议实现，需要同时处理流式和非流式响应。
  stream: true 可以让支持流的服务端（如 Ollama via OpenAI 兼容端口）
  更早开始返回数据。对不支持流的服务端，它们会忽略此参数并返回
  普通 JSON，代码通过 Content-Type 判断来正确处理两种情况。
## 函数：consumeSSEStream(body)                     (L166-L218)


### 作用

  消费 Server-Sent Events（SSE）流，逐块拼接 delta 内容，
  提取最终文本和 usage 信息。

### 参数

  body: ReadableStream<Uint8Array> — HTTP 响应的 body 流

### 返回值

  Promise<ChatCompletionResult> — 拼接后的完整文本 + usage

### 逐行逻辑


**L169**:
```typescript
const decoder = new TextDecoder();
```
> UTF-8 解码器，将二进制 chunk 转为字符串。


**L170**:
```typescript
const reader = body.getReader();
```
> 获取 ReadableStream 的 reader，用于逐块读取。


**L171**:
```typescript
let textParts: string[] = [];
```
> 收集所有 delta.content 片段，最后 join 得到完整文本。


**L172**:
```typescript
let usage: LlmUsageInfo | undefined;
```
> 用量统计，通常在最后一个 chunk 中返回。


**L173**:
```typescript
let buffer = "";
```
> 行缓冲区——SSE 以 "\n" 分隔事件行，但 chunk 边界
> 不一定与行边界对齐，需要缓冲不完整的尾行。


**L176-L178**:
```typescript
while (true) { const { done, value } = await reader.read(); if (done) break; }
```
> 主循环：逐块读取直到流结束。


**L179**:
```typescript
buffer += decoder.decode(value, { stream: true });
```
> 将二进制 chunk 追加到缓冲区。
> { stream: true } 告诉 TextDecoder 此处可能是不完整的
> 多字节字符，不要急于输出替换字符。


**L181-L182**:
```typescript
const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
```
> 按换行符拆分。pop() 取走最后一个元素——它可能是不完整的行，
> 保留在 buffer 中等下一个 chunk 补全。


**L184-L188**:
```typescript
for (const line of lines) { ... if (!trimmed.startsWith("data:")) continue; }
```
> 遍历完整行，跳过非 data: 开头的行（如空行、:注释行）。
> payload = trimmed.slice(5).trim() 提取 data: 后的 JSON。
> [DONE] 信号表示流结束，跳过。


**L190-L208**:
```typescript
try { const chunk = JSON.parse(payload) ... }
```
> 解析每个 SSE data 块为 JSON。


**L195-L198**:
```typescript
delta?.content 存在时追加到 textParts。
```
> 注意：不采集 delta.reasoning_content（类型中声明了但不使用），
> 因为推理内容会被 stripThinkingTags 后续清理。


**L199-L205**:
```typescript
chunk.usage 存在时记录用量。
```
> 某些服务端（如 vLLM）在最后一个 chunk 中返回 usage。


**L206-L208**:
```typescript
catch {} — 静默跳过格式错误的 SSE 块。
```
> 网络抖动或服务端 bug 可能产生畸形 JSON，不应中断整个流。


**L211-L213**:
```typescript
finally { reader.releaseLock(); }
```
> 确保释放 reader 锁，避免 stream 泄漏。


**L215-L217**:
```typescript
let text = textParts.join(""); text = stripThinkingTags(text); return { text, usage };
```
> 拼接所有片段，清理 <think> 标签，返回结果。


### 设计意图

  流式处理让系统可以在模型还在生成时就开始接收数据。
  行缓冲 + pop 模式是处理 SSE 的标准手法，确保跨 chunk 边界
  的行能被正确拼接。静默忽略畸形 chunk 保证了鲁棒性。
函数：callOllamaNative(endpoint, model,          (L224-L267)
      messages, options?)

### 作用

  通过 Ollama 原生 API（/api/chat）发起非流式聊天补全请求。

### 参数

  endpoint: string — Ollama 服务地址（如 "http://localhost:11434"）
  model: string — 模型名称
  messages: ChatMessage[] — 对话消息列表
  options?: ChatCompletionOptions — 可选配置

### 返回值

  Promise<ChatCompletionResult> — text + usage

### 逐行逻辑


**L230**:
```typescript
const url = `${endpoint}/api/chat`;
```
> 拼接 Ollama 原生端点。与 OpenAI 兼容端点 /v1/chat/completions 不同。


**L232-L246**:
```typescript
const response = await fetch(url, { ... });
```
> 发起 POST 请求。


**L236**:
```typescript
stream: false — 明确关闭流式，一次性获取完整响应。
```


**L238-L243**:
```typescript
options 对象：
```
> L239: temperature — 默认 0.1。
> L240: num_predict — 对应 OpenAI 的 max_tokens，Ollama 用这个名称。
> L241: stop — 条件展开。
> L242: repeat_penalty — Ollama 的频率惩罚参数。
> 转换公式：repeat_penalty = 1.0 + frequencyPenalty。
> OpenAI 的 frequency_penalty 范围 [0,2]，Ollama 的 repeat_penalty
> 范围约 [1.0, 3.0]，此转换保持语义等价。


**L248-L250**:
```typescript
if (!response.ok) { throw ... }
```
> 非 2xx 状态码抛出错误。


**L252-L256**:
```typescript
const data = (await response.json()) as { ... };
```
> 解析 Ollama 原生格式的 JSON 响应。
> 字段名与 OpenAI 不同：message.content, prompt_eval_count, eval_count。


**L257-L258**:
```typescript
let text = data.message?.content ?? "";
```

             text = stripThinkingTags(text);
> 提取并清洗回复文本。

**L260-L264**:
```typescript
token 用量提取
```
> prompt_eval_count → input tokens
> eval_count → output tokens
> 只有在至少有一项非零时才创建 usage 对象。


**L266**:
```typescript
return { text, usage };
```


### 设计意图

  为 Ollama 原生用户提供直接支持，无需通过 OpenAI 兼容适配层。
  Ollama 的原生 API 字段名与 OpenAI 不同（num_predict vs max_tokens,
  repeat_penalty vs frequency_penalty, eval_count vs completion_tokens），
  此函数做了完整的参数/响应映射。
## 函数：stripThinkingTags(text)                    (L270-L277)


### 作用

  移除推理模型输出的 <think>...</think> 思考链标签，
  只保留最终的有效输出。

### 参数

  text: string — 模型原始输出文本

### 返回值

  string — 清理后的文本

### 逐行逻辑


**L271**:
```typescript
let result = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
```
> 正则移除所有完整的 <think>…</think> 块。
> [\s\S]*? 非贪婪匹配，处理多个思考块。
> trim() 清理残留空白。


**L272**:
```typescript
const lastThinkClose = result.lastIndexOf("</think>");
```
> 查找残留的 </think> 标签——处理不完整的标签场景：
> 如果模型输出了 <think>...(被截断的思考)...没有闭合标签，
> 上面的正则不会匹配。但如果只有 </think> 没有开始标签，
> 说明 <think> 可能在之前的流式 chunk 中。


**L273-L275**:
```typescript
if (lastThinkClose !== -1) { result = result.slice(lastThinkClose + 8).trim(); }
```
> 如果找到孤立的 </think>，取其后的内容——
> 这就是模型的实际输出（思考链之后的部分）。
> "</think>".length === 8。


**L276**:
```typescript
return result;
```


### 设计意图

  MiniCPM、Qwen3 等推理模型会在输出前插入 <think>…</think> 思考块。
  这些内容对分类/脱敏无用且可能干扰 JSON 解析。
  两步清理确保了完整标签和残缺标签都能被正确处理。
## 函数：detectByLocalModel(context, config)        (L282-L331)


### 作用

  使用本地模型对检测上下文进行隐私敏感度分类。
  是 GuardClaw 检测管线中 "localModelDetector" 类型的入口函数。
  被 detector.ts 的 runDetectors() 调用。

### 参数

  context: DetectionContext — 检测上下文，包含 message / toolName / toolParams 等
  config: PrivacyConfig — 隐私配置

### 返回值

  Promise<DetectionResult> — 包含 level / levelNumeric / reason /
  detectorType / confidence 的检测结果

### 逐行逻辑


**L287-L295**:
```typescript
if (!config.localModel?.enabled) { return { level: "S1", ... confidence: 0 }; }
```
> 前置检查：如果本地模型未启用，直接返回 S1（安全）。
> confidence: 0 表示"这个结果没有意义，仅因功能关闭而返回"。


**L298**:
```typescript
const { system, user } = buildDetectionMessages(context);
```
> 构建系统提示词和用户消息。
> system 来自 prompts/detection-system.md（可自定义）。
> user 是 [CONTENT]...[/CONTENT] 格式的上下文拼接。


**L299**:
```typescript
const result = await callLocalModel(system, user, config);
```
> 调用本地模型获取响应。


**L300**:
```typescript
const parsed = parseModelResponse(result.text);
```
> 解析模型返回的 JSON 或文本，提取 level / reason / confidence。


**L302-L311**:
```typescript
if (result.usage) { collector?.record({ ... }); }
```
> 如果有 token 用量，记录到全局统计收集器。
> source: "router" — 标记为路由开销（而非实际任务消耗）。
> provider: "edge" — 表示这是边缘/本地模型调用。
> sessionKey 用 ?? "" 兜底，因为 context.sessionKey 可选。


**L313-L319**:
```typescript
return { level, levelNumeric, reason, detectorType: "localModelDetector", confidence };
```
> 构造并返回检测结果。
> confidence: parsed.confidence ?? 0.8 — 模型未返回置信度时默认 0.8。


**L320-L330**:
```typescript
catch (err) { ... return { level: "S1", ... confidence: 0 }; }
```
> 容错：模型调用失败时返回 S1（安全），避免系统卡死。
> 记录错误日志供运维排查。
> confidence: 0 表示结果不可靠。


### 设计意图

  作为规则检测器（detectByRules）的语义补充，能捕获规则引擎
  无法覆盖的隐含敏感内容（如 "帮我分析一下这份工资单"）。
  失败安全策略：本地模型不可用时不阻塞请求，回退到 S1。
  这与 detector.ts 中的短路优化互补——规则检测器已判定 S3 时，
  此函数不会被调用（节省 LLM 开销）。
## 常量：DEFAULT_DETECTION_SYSTEM_PROMPT            (L334-L370)


默认的敏感度检测系统提示词（当 prompts/detection-system.md 不存在时使用）。

定义了三级分类标准：
  S3 = PRIVATE — 财务（工资、税表）、医疗（病历、体检报告）、
                 凭证（密码、API Key）→ 绝不上云
  S2 = SENSITIVE — 地址、门禁码、手机号、邮箱、姓名、车牌 → 脱敏后可上云
  S1 = SAFE — 无敏感数据

特殊规则：
  - 密码/凭证 → 永远 S3（不降级为 S2）
  - 医疗数据 → 永远 S3
  - 门禁码/取件码 → S2（不升级为 S3）
  - 不确定时 → 选择更高等级

输出格式要求：{"level":"S1|S2|S3","reason":"brief"}
强调"只输出 JSON，不要其他内容"——减少模型"废话"干扰解析。
## 函数：buildDetectionMessages(context)            (L378-L411)


### 作用

  将 DetectionContext 构建为 system/user 两条消息，
  供本地模型进行敏感度分类。

### 参数

  context: DetectionContext — 检测上下文

### 返回值

  { system: string; user: string } — 系统提示词和用户消息

### 逐行逻辑


**L379**:
```typescript
const system = loadPrompt("detection-system", DEFAULT_DETECTION_SYSTEM_PROMPT);
```
> 从 prompts/detection-system.md 加载自定义系统提示词。
> 如果文件不存在，使用 DEFAULT_DETECTION_SYSTEM_PROMPT 常量。
> loadPrompt 内部有缓存，不会每次都读磁盘。


**L381**:
```typescript
const parts: string[] = ["[CONTENT]"];
```
> 开始构建 user 消息。[CONTENT] 标记开始。


**L383-L385**:
```typescript
if (context.message) { parts.push(`Message: ${context.message.slice(0, 1500)}`); }
```
> 如果有用户消息，截取前 1500 字符加入。
> 截断防止过长输入消耗过多 token 和超出模型上下文窗口。


**L387-L389**:
```typescript
if (context.toolName) { parts.push(`Tool: ${context.toolName}`); }
```
> 如果是工具调用场景，附加工具名称。


**L391-L394**:
```typescript
if (context.toolParams) { ... slice(0, 800) }
```
> 工具参数 JSON 化后截取前 800 字符。


**L396-L402**:
```typescript
if (context.toolResult) { ... slice(0, 800) }
```
> 工具执行结果。如果是 string 直接使用，否则 JSON.stringify。
> 截取前 800 字符。


**L404-L406**:
```typescript
if (context.recentContext && context.recentContext.length > 0) { ... }
```
> 取最近 3 条上下文以 " | " 连接，提供对话历史背景。
> slice(-3) 只取最后 3 条，避免信息过载。


**L408**:
```typescript
parts.push("[/CONTENT]");
```
> 闭合 [CONTENT] 标记。


**L410**:
```typescript
return { system, user: parts.join("\n") };
```
> 系统提示词和用户消息分别返回。


### 设计意图

  将 system prompt 与 user content 分离为两条消息，
  符合 chat 模型的最佳实践（system 定义行为，user 提供数据）。
  各字段截断阈值（1500/800/800）在 token 限制和信息完整性间做了平衡。
  [CONTENT]...[/CONTENT] 包裹让模型能明确识别待分类内容的边界。
函数：callLocalModel(systemPrompt, userContent,  (L418-L445)
      config)

### 作用

  根据 PrivacyConfig 中的 localModel 配置调用本地模型。
  是 callChatCompletion 的一层便捷封装，自动从 config 中提取
  endpoint/model/providerType/apiKey 等参数。

### 参数

  systemPrompt: string — 系统提示词
  userContent: string — 用户消息内容
  config: PrivacyConfig — 隐私配置

### 返回值

  Promise<ChatCompletionResult> — text + usage

### 逐行逻辑


**L423**:
```typescript
const model = config.localModel?.model ?? "openbmb/minicpm4.1";
```
> 模型名称，默认 MiniCPM 4.1。


**L424**:
```typescript
const endpoint = config.localModel?.endpoint ?? "http://localhost:11434";
```
> 端点地址，默认 Ollama 本地端口。


**L425**:
```typescript
const providerType = config.localModel?.type ?? "openai-compatible";
```
> 协议类型，默认 OpenAI 兼容。


**L427**:
```typescript
const modelLower = model.toLowerCase();
```
> 模型名转小写，用于下面的特殊处理判断。


**L428**:
```typescript
const finalUser = modelLower.includes("qwen") ? `/no_think\n${userContent}` : userContent;
```
> Qwen 系列模型特殊处理：在用户消息前添加 /no_think 指令，
> 抑制 Qwen3 的"思考模式"输出。
> 这会减少输出中的 <think> 标签，加速推理并降低 token 消耗。


**L430-L444**:
```typescript
return await callChatCompletion(endpoint, model, messages, options);
```
> 委托给统一入口 callChatCompletion。
> temperature: 0.1 — 低温度，追求确定性分类。
> maxTokens: 800 — 足够输出分类 JSON。
> apiKey / providerType / customModule 从 config 传入。


### 设计意图

  将 PrivacyConfig 的字段解构与 callChatCompletion 的通用接口之间
  做了一层适配。支持 Qwen 系列的 /no_think 特殊指令，
  避免推理模型浪费大量 token 在"思考"上。
## 常量：DEFAULT_PII_EXTRACTION_PROMPT              (L547-L557)


默认的 PII 提取系统提示词（当 prompts/pii-extraction.md 不存在时使用）。

指导模型从文本中提取所有 PII，输出为 JSON 数组。
支持的 PII 类型：
  NAME — 人名（每个人）
  PHONE — 电话号码
  ADDRESS — 地址（包括缩写/简写）
  ACCESS_CODE — 门禁码/门牌码
  DELIVERY — 快递单号/取件码
  ID — 身份证号/SSN
  CARD — 银行卡/医保卡/保险卡号
  LICENSE_PLATE — 车牌号
  EMAIL — 邮箱
  PASSWORD — 密码
  PAYMENT — 支付信息（Venmo/PayPal/支付宝）
  BIRTHDAY — 生日
  TIME — 预约/配送时间
  NOTE — 私人备注

关键要求："提取每一个人名和每一种地址变体"
输出格式："只输出 JSON 数组——不要解释、不要 Markdown 代码围栏"
函数：desensitizeWithLocalModel(content, config, (L454-L496)
      sessionKey?)

### 作用

  使用本地模型进行两步脱敏：
    Step 1: 模型识别文本中的 PII 项，输出 JSON 数组
    Step 2: 编程式字符串替换（非模型重写）
  被 privacy.ts 路由器在 S2 场景下调用。

### 参数

  content: string — 待脱敏的原始文本
  config: PrivacyConfig — 隐私配置
  sessionKey?: string — 可选的会话标识，用于 token 统计

### 返回值

  Promise<{ desensitized: string; wasModelUsed: boolean; failed?: boolean }>
    desensitized — 脱敏后的文本（或原文如果模型不可用）
    wasModelUsed — 是否成功使用了模型
    failed — 是否发生了失败

### 逐行逻辑


**L459-L461**:
```typescript
if (!config.localModel?.enabled) { return { ..., wasModelUsed: false, failed: true }; }
```
> 模型未启用时返回原文，标记未使用模型且 failed=true。
> 调用方（如 hooks.ts 的脱敏流程）会回退到规则脱敏。


**L464-L467**:
```typescript
从 config 提取 endpoint / model / providerType / customModule。
```
> 与 callLocalModel 相同的默认值策略。


**L469-L474**:
```typescript
const piiItems = await extractPiiWithModel(endpoint, model, content, { ... });
```
> Step 1：调用 extractPiiWithModel 让模型识别所有 PII。
> 返回 Array<{ type: string; value: string }>。


**L476-L478**:
```typescript
if (piiItems.length === 0) { return { desensitized: content, wasModelUsed: true }; }
```
> 模型判定无 PII，返回原文，标记模型已使用（无需替换）。


**L481**:
```typescript
let redacted = content;
```


**L483**:
```typescript
const sorted = [...piiItems].sort((a, b) => b.value.length - a.value.length);
```
> 按 PII 值长度降序排序。
> 关键技巧：先替换长字符串，避免短字符串的替换破坏长字符串。
> 例如：先替换 "北京市朝阳区xxx路"，再替换 "北京市"。


**L484-L488**:
```typescript
for (const item of sorted) { ... }
```
> L485: 跳过空值或极短值（< 2 字符），避免误替换。
> L486: mapPiiTypeToTag 将模型返回的 type 映射为 [REDACTED:XXX] 标签。
> L488: replaceAll 替换所有出现位置。


**L491**:
```typescript
return { desensitized: redacted, wasModelUsed: true };
```


**L492-L495**:
```typescript
catch (err) { return { desensitized: content, wasModelUsed: false, failed: true }; }
```
> 失败时返回原文，标记失败。日志记录错误。


### 设计意图

  "模型识别 + 编程替换"的两步法比"让模型直接重写"更可靠：
  1) 模型输出结构化 JSON 比自由重写更容易控制质量；
  2) 编程替换保证了替换的精确性和完整性（不会遗漏出现位置）；
  3) 长度降序排序避免了部分替换问题。
  失败安全：模型不可用时返回原文，由调用方决定回退策略。
## 函数：mapPiiTypeToTag(type)                      (L499-L537)


### 作用

  将模型返回的 PII 类型字符串映射为标准的 [REDACTED:XXX] 标签。
  多种同义类型名映射到同一标签（如 SENDER_PHONE → [REDACTED:PHONE]）。

### 参数

  type: string — 模型输出的 PII 类型名称

### 返回值

  string — [REDACTED:XXX] 格式的脱敏标签

### 逐行逻辑


**L500**:
```typescript
const t = type.toUpperCase().replace(/\s+/g, "_");
```
> 标准化：转大写，空格替换为下划线。
> 处理模型输出不一致的情况（如 "sender name" → "SENDER_NAME"）。


**L501-L535**:
```typescript
const mapping: Record<string, string> = { ... };
```
> 33 个映射条目，覆盖：
> - ADDRESS, ACCESS_CODE, DELIVERY（含 COURIER_ 系列）
> - NAME（含 SENDER_NAME, RECIPIENT_NAME）
> - PHONE（含 SENDER_PHONE, FACILITY_PHONE, LANDLINE, MOBILE）
> - EMAIL, ID（含 ID_CARD, ID_NUMBER）
> - CARD（含 BANK_CARD, CARD_NUMBER）
> - SECRET（含 PASSWORD, API_KEY, TOKEN）
> - IP, LICENSE_PLATE, TIME, DATE, SALARY, AMOUNT


**L536**:
```typescript
return mapping[t] ?? `[REDACTED:${t}]`;
```
> 查表命中则返回标准标签。
> 未命中则动态生成 [REDACTED:原始类型名]，
> 保证任何未知类型也能被脱敏标记。


### 设计意图

  模型输出的 PII 类型名称不可控（可能用各种同义词），
  此映射表做了归一化处理，确保下游看到的标签是一致的。
  兜底的动态生成保证了开放集兼容——新模型可能输出训练集外的类型。
## 函数：replaceAll(str, search, replacement)       (L540-L544)


### 作用

  全局字符串替换（replaceAll polyfill）。
  通过转义 search 中的正则特殊字符后构造 RegExp 实现。

### 参数

  str: string — 原始字符串
  search: string — 要搜索的子串
  replacement: string — 替换为的字符串

### 返回值

  string — 替换后的字符串

### 逐行逻辑


**L542**:
```typescript
const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
```
> 转义 search 中所有正则特殊字符。
> 例如 "1234#" 中的 "#" 不是正则元字符，但 "$" 和 "." 等是。
> 确保 PII 值中可能出现的特殊字符不会被当作正则语法。


**L543**:
```typescript
return str.replace(new RegExp(escaped, "g"), replacement);
```
> 用 "g" 标志做全局替换。


### 设计意图

  兼容较老的 Node 版本（String.prototype.replaceAll 在 Node 15+ 才原生支持）。
  同时处理了 PII 值中可能包含的正则特殊字符（如门禁码 "1234#"）。
函数：extractPiiWithModel(endpoint, model,       (L565-L611)
      content, opts?)

### 作用

  调用本地模型从文本中提取 PII 项，返回结构化的 JSON 数组。
  是 desensitizeWithLocalModel 的 Step 1。

### 参数

  endpoint: string — 模型服务地址
  model: string — 模型名称
  content: string — 待分析的文本内容
  opts?: {
    apiKey?: string;
    providerType?: EdgeProviderType;
    customModule?: string;
    sessionKey?: string;
  }

### 返回值

  Promise<Array<{ type: string; value: string }>> — PII 项数组

### 逐行逻辑


**L571**:
```typescript
const textSnippet = content.slice(0, 3000);
```
> 截取前 3000 字符。比检测的 1500 字符限制更大，
> 因为 PII 提取需要更完整的文本上下文来识别所有 PII。


**L573-L575**:
```typescript
const systemPrompt = loadPromptWithVars("pii-extraction", DEFAULT_PII_EXTRACTION_PROMPT, { CONTENT: textSnippet });
```
> 从 prompts/pii-extraction.md 加载提示词模板。
> 如果模板中有 {{CONTENT}} 占位符，会被替换为 textSnippet。


**L577**:
```typescript
const promptHasContent = systemPrompt.includes(textSnippet) && textSnippet.length > 10;
```
> 检测系统提示词中是否已经包含了文本内容。
> 如果自定义模板通过 {{CONTENT}} 嵌入了文本，
> 则用户消息只需说"提取上面文本中的 PII"。
> textSnippet.length > 10 防止极短文本导致误判。


**L578-L580**:
```typescript
const userMessage = promptHasContent ? "Extract all PII..." : textSnippet;
```
> 如果内容已在 system prompt 中：user 只需指令。
> 如果内容不在 system prompt 中：user 消息即为待分析文本。


**L582-L597**:
```typescript
const result = await callChatCompletion(endpoint, model, [...], { ... });
```
> 调用模型。关键参数差异：
> temperature: 0.0 — 零温度，追求完全确定性的 PII 提取。
> maxTokens: 2500 — 比检测的 800 大很多，因为 PII 列表可能很长。
> stop: ["Input:", "Task:"] — 防止模型"续写"示例。


**L599-L608**:
```typescript
if (result.usage) { collector?.record({ ... }); }
```
> 记录 token 用量到统计系统。source: "router"。


**L610**:
```typescript
return parsePiiJson(result.text);
```
> 将模型文本输出解析为结构化 PII 数组。


### 设计意图

  提示词模板支持 {{CONTENT}} 变量替换，让用户可以自定义
  提取指令和文本的排列方式。promptHasContent 检查实现了
  "内容在 system vs 内容在 user"两种模式的自动切换。
  stop 词防止模型在输出 JSON 后继续编造更多示例。
## 函数：parsePiiJson(raw)                          (L614-L666)


### 作用

  解析模型输出的 PII JSON 数组。
  处理多种模型输出格式不一致的情况（Markdown 围栏、尾部逗号、
  Python 风格单引号、截断的 JSON 等）。

### 参数

  raw: string — 模型原始输出文本

### 返回值

  Array<{ type: string; value: string }> — 结构化 PII 项；解析失败返回 []

### 逐行逻辑


**L616**:
```typescript
let cleaned = raw.replace(/\s+/g, " ").trim();
```
> 将所有空白字符（包括换行）归一化为单个空格。
> 部分模型会在 JSON 数组元素间插入换行。


**L619-L622**:
```typescript
cleaned = cleaned.replace(/^```(?:json)?\s∗/i, "").replace(/\s*```$/i, "").trim();
```
> 去除 Markdown 代码围栏。
> 匹配开头的 ```json 和结尾的 ```。
> 模型可能忽略"不要 markdown 围栏"的指令。


**L625**:
```typescript
const arrayStart = cleaned.indexOf("[");
```
> 查找 JSON 数组的起始位置。


**L626**:
```typescript
if (arrayStart < 0) return [];
```
> 找不到 [ 说明没有 JSON 数组，返回空。


**L627**:
```typescript
let jsonStr = cleaned.slice(arrayStart);
```
> 从 [ 开始截取，忽略前面可能的废话文本。


**L630-L639**:
```typescript
查找闭合括号
```
> L631: 优先找最后一个 ]，正常闭合。
> L634-L638: 找不到 ] 时，找最后一个 }，
> 手动补上 "]"——处理模型输出被截断的情况。
> L638: 都找不到则返回空。


**L643**:
```typescript
jsonStr = jsonStr.replace(/,\s*\]/g, "]");
```
> 修复尾部逗号（trailing comma）。
> 如 [{"type":"NAME","value":"Alex"},] → 移除最后的逗号。


**L647-L649**:
```typescript
Python 风格单引号修复
```
> L648: 匹配 key 位置的单引号 → 替换为双引号。
> 正则使用 lookbehind (?<=[\[,{]\s*) 确保只匹配 JSON key。
> L649: 匹配 value 位置的单引号 → 替换为双引号。
> 正则使用 lookbehind (?<=:\s*) 确保只匹配 JSON value。
> 某些本地模型（如 CodeLlama、部分量化模型）输出 Python 风格 JSON。


**L651-L664**:
```typescript
try { JSON.parse ... } catch { ... }
```
> L652: 解析 JSON。
> L653: 非数组则返回空。
> L654-L660: 过滤有效项——必须同时有 string 类型的 type 和 value 字段。
> L662: catch 中打印错误日志并返回空数组。


### 设计意图

  本地模型的 JSON 输出质量参差不齐，此函数做了多层防御式解析：
  1) 去 Markdown 围栏 → 2) 定位 [ 开始 → 3) 寻找闭合 ] 或 } →
  4) 修复尾逗号 → 5) 单引号→双引号 → 6) JSON.parse → 7) 类型过滤。
  任何一步失败都安全降级为返回空数组（宁可漏提取不误替换）。
## 函数：parseModelResponse(response)               (L671-L728)


### 作用

  解析本地模型的敏感度分类响应，提取 level / reason / confidence。
  被 detectByLocalModel 调用。

### 参数

  response: string — 模型原始输出文本

### 返回值

  { level: SensitivityLevel; reason?: string; confidence?: number }

### 逐行逻辑


**L677**:
```typescript
try { ... }
```
> 整体包裹在 try-catch 中，任何解析错误都不会传播。


**L678**:
```typescript
const jsonMatch = response.match(/\{[\s\S]*?\}/);
```
> 从响应中提取第一个 JSON 对象（最短匹配）。
> 即使模型在 JSON 前后加了废话，也能定位 JSON。


**L679-L694**:
```typescript
if (jsonMatch) { ... }
```
> L680: JSON.parse 解析提取的 JSON 字符串。
> L687: 将 level 转大写后校验是否为合法值（S1/S2/S3）。
> L688-L694: 合法则返回结构化结果（保留 reason 和 confidence）。


**L697-L712**:
```typescript
文本回退（Fallback）
```
> 如果 JSON 解析失败（模型没输出合法 JSON），
> 在全文中搜索关键词。
> L699-L704: 包含 "S3" 或 "PRIVATE" → 返回 S3，confidence 0.6。
> L705-L710: 包含 "S2" 或 "SENSITIVE" → 返回 S2，confidence 0.6。
> confidence 0.6 表示"从文本推断，不如 JSON 解析可靠"。


**L713-L718**:
```typescript
最终兜底
```
> 完全无法解析时，默认返回 S1（安全），confidence 0.3。
> 0.3 表示"这个结果可信度很低"。


**L720-L727**:
```typescript
catch (err) { return { level: "S1", reason: "Parse error", confidence: 0 }; }
```
> 异常兜底。confidence: 0。


### 设计意图

  三级降级策略：JSON 解析 → 文本关键词搜索 → 默认 S1。
  不同来源的结果赋予不同的 confidence：
    JSON 解析成功 → 使用模型自己给的 confidence
    文本匹配 → 0.6
    默认兜底 → 0.3
    异常 → 0
  这使得 detector.ts 合并多个检测结果时，能通过 confidence
  判断每个结果的可靠程度。
  安全导向：解析失败时回退到 S1 而非更高等级——
  宁可放行也不误拦截（因为 ruleDetector 会作为补充）。
## CODE REVIEW — 改动建议

## Part A — Code 层面改动建议


#### 🔴 callOllamaNative 缺少超时设置


 现状（L232-L246）：callOllamaNative 的 fetch 调用没有设置
   AbortSignal.timeout()，而 callOpenAICompatible（L136）设置了
   60 秒超时。
 问题：如果 Ollama 原生端点无响应或挂起，请求将永远阻塞。
   这在 Ollama 加载大模型或 GPU 内存不足时尤其可能发生。
   callOpenAICompatible 已有此防护，说明这是遗漏而非有意设计。
 建议：在 callOllamaNative 的 fetch 中添加：
   signal: AbortSignal.timeout(GUARDCLAW_FETCH_TIMEOUT_MS)


#### 🔴 replaceAll 每次调用创建新 RegExp，无缓存


 现状（L540-L544）：replaceAll 每次调用都 new RegExp(escaped, "g")。
   desensitizeWithLocalModel 中对每个 PII 项都调用一次。
 问题：如果模型提取了 20+ 个 PII 项，会创建 20+ 个 RegExp 对象。
   与 rules.ts 中 patternCache（L12-L38）的缓存策略形成对比。
   虽然此处性能影响较小（PII 值通常不多），但与代码库整体风格不一致。
 建议：由于 PII 值在每次调用间不太可能重复，且数量有限，
   这里不需要全局缓存。但如果要保持一致，可以用
   String.prototype.replaceAll()（Node 15+ 已原生支持）替代
   正则方案，简化代码。当前的 polyfill 注释提到"for older Node"，
   如果项目已不再支持 Node 14，可以直接用原生方法。


#### 🟡 parsePiiJson 的单引号修复正则使用了 lookbehind


 现状（L648-L649）：使用 (?<=...) lookbehind 断言修复 Python 风格引号。
 问题：lookbehind 在 Node 10+ 已支持，但如果 PII 值本身包含
   单引号（如人名 "O'Brien"），此正则可能产生错误替换。
   例如 {'name': "O'Brien"} 中的嵌套引号会被误处理。
 建议：在正则替换后增加一次 try-parse 检查；如果 JSON.parse
   仍然失败，回退到原始 raw 重新尝试不做引号替换的解析。


#### 🟡 DEFAULT_DETECTION_SYSTEM_PROMPT 和 DEFAULT_PII_EXTRACTION_PROMPT

    体积较大，内联在源码中

 现状（L334-L370, L547-L557）：两个长字符串常量直接写在 TS 源码中。
 问题：修改提示词需要改代码、重新编译。虽然 loadPrompt 支持
   外部文件覆盖，但默认值仍然硬编码在源码里。
 建议：将默认提示词移到 prompts/ 目录下的 .md 文件中，
   与 loadPrompt 的设计意图一致。代码中的常量可以简化为
   极短的兜底字符串（"Classify as S1/S2/S3."）。


#### 🟢 import 组织：types.js 有两次 import


 现状（L10-L16, L18）：types.js 有两个 import 语句——
   一个 import type {...}，一个 import { levelToNumeric }。
 问题：可以合并为一个 import 语句。
 建议：
   import { type DetectionContext, ..., levelToNumeric } from "./types.js";
## Part B — 逻辑/设计层面改动建议


#### 🔴 detectByLocalModel 不检查 dryRun 标志


 现状（L287-L295）：detectByLocalModel 只检查 config.localModel?.enabled，
   不检查 context.dryRun。
 问题：detector.ts（L38）和 privacy.ts（L107）都检查了
   `enabled === false && !context.dryRun`——即 dryRun 时即使 enabled=false
   也要运行检测（供 Dashboard 测试）。但 detectByLocalModel 在
   enabled=false 时直接返回 S1，忽略了 dryRun。
   结果：Dashboard 的 dry-run 测试无法测试到本地模型检测器。
 建议：将 L287 改为：
   if (!config.localModel?.enabled && !context.dryRun) {
   这与 detector.ts 和 privacy.ts 的行为保持一致。
   但需要注意：dryRun 属于 DetectionContext，而当前参数只有
   context: DetectionContext 和 config: PrivacyConfig，
   context 在此函数的签名中已包含 dryRun 字段——只需要读取它。
   不过当前函数签名没有直接传入 context，需要稍作调整
   以传入 dryRun 标志。


#### 🔴 detectByLocalModel 缺少 toolAllowlist 检查


 现状（L282-L331）：detectByLocalModel 没有检查
   config.toolAllowlist。
 问题：types.ts（L96-L98）定义了 toolAllowlist 字段，
   用于豁免特定工具的隐私检测。rules.ts 中 detectByRules 应该
   有此检查。但 detectByLocalModel 作为另一个检测器，
   如果工具已在白名单中，仍然会发起 LLM 调用——浪费资源。
 建议：在 enabled 检查后增加：
   if (context.toolName && config.toolAllowlist?.includes(context.toolName)) {
     return { level: "S1", ..., reason: "Tool in allowlist" };
   }


#### 🟡 callLocalModel 硬编码 temperature 和 maxTokens


 现状（L437-L439）：callLocalModel 总是传 temperature: 0.1, maxTokens: 800。
 问题：config-schema.ts 的 localModel 配置中没有这些字段。
   用户无法通过配置文件调整检测调用的温度或 token 限制。
   不同模型在不同 temperature 下表现差异较大。
 建议：在 PrivacyConfig.localModel 中添加可选字段：
   temperature?: number;
   maxTokens?: number;
   代码中用 ?? 兜底为当前默认值。


#### 🟡 extractPiiWithModel 的 stop 词可能误截断输出


 现状（L593）：stop: ["Input:", "Task:"]
 问题：如果用户文本中包含 "Input:" 或 "Task:" 字样
   （如 "Input: 请分析这份报告"），模型在输出 PII JSON 时
   可能因 stop 词提前截断，导致 JSON 不完整。
 建议：使 stop 词更具特异性（如 "\n\nInput:", "\n\nTask:"），
   或在自定义 prompt 模板中避免使用这些词。


#### 🟡 parseModelResponse 使用非贪婪匹配 {[\s\S]*?} 可能

    匹配不完整的 JSON

 现状（L678）：response.match(/\{[\s\S]*?\}/)
 问题：如果模型输出 {"level":"S2","reason":"contains {address}"}，
   非贪婪匹配会在第一个 } 处停止，得到 {"level":"S2","reason":"contains {address"}
   这是个非法 JSON 导致 parse 失败，回退到文本关键词搜索。
   虽然回退后仍能工作，但丢失了 reason 信息。
 建议：使用更精确的 JSON 提取（如匹配平衡大括号），
   或者用 parsePiiJson 类似的"找最后一个 }"策略。


#### 🟢 custom provider 不返回 usage，无法统计 token


 现状（L93-L94）：custom provider 的 callChat 返回 string，
   封装为 { text }，usage 永远为 undefined。
 问题：使用 custom provider 的用户无法在 Dashboard 看到 token
   用量统计。CustomEdgeProvider 接口定义于 L46-L53。
 建议：扩展 CustomEdgeProvider.callChat 的返回类型为
   Promise<string | ChatCompletionResult>，
   如果用户返回了 ChatCompletionResult 对象则提取 usage。
   保持向后兼容：string 返回值仍包装为 { text }。
## 优先级总览


| 优先级 | 编号 + 标题 |
| --- | --- |
| 🔴 | 1. callOllamaNative 缺少超时设置 |
| 🔴 | 6. detectByLocalModel 不检查 dryRun 标志 |
| 🔴 | 7. detectByLocalModel 缺少 toolAllowlist 检查 |
| 🔴 | 2. replaceAll 每次创建新 RegExp（风格不一致） |
| 🟡 | 3. parsePiiJson 单引号正则可能误替换 |
| 🟡 | 4. 长提示词内联源码而非外部文件 |
| 🟡 | 8. callLocalModel 硬编码 temperature/maxTokens |
| 🟡 | 9. extractPiiWithModel stop 词可能误截断 |
| 🟡 | 10. parseModelResponse 非贪婪匹配可能不完整 |
| 🟢 | 5. types.js 重复 import 可合并 |
| 🟢 | 11. custom provider 不返回 usage |
