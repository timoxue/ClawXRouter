# privacy-proxy.ts — 逐方法文档


 文件定位：GuardClaw 隐私代理服务器（Privacy Proxy）
 所属模块：GuardClaw 隐私路由系统

 核心职责：实现一个轻量级 HTTP 反向代理，拦截被标记为 S2（中度敏感）
 的请求，在转发到原始云端 AI 提供商之前剥离 PII（个人身份信息）标记
 和不受支持的 JSON Schema 关键字。支持 OpenAI、Google/Gemini、
 Anthropic 三种 API 格式，支持 SSE 流式和非流式两种响应模式。

 数据流：
   openclaw agent → guardclaw-privacy provider → localhost:PROXY_PORT
     → 剥离 PII 标记 → 清理工具 Schema → 纵深防御 PII 脱敏
     → 转发到原始云端提供商 → 透传响应（含 SSE 流）

 敏感等级体系：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理(proxy)脱敏后转发到云端
   S3 — 高度敏感，强制本地模型处理（不经过此代理）
## 导入模块


**L18**:
```typescript
import * as http from "node:http"
```

     Node.js 内置 HTTP 模块，用于创建代理服务器。

**L19**:
```typescript
import { redactSensitiveInfo } from "./utils.js"
```

     规则化 PII 脱敏函数（两阶段：模式匹配 + 上下文关键词）。
     被用于代理的"纵深防御"环节——在 marker 剥离后，再做一轮
     regex-based 的 PII 清理，防止残余 PII 泄露到云端。

**L20**:
```typescript
import { getLiveConfig } from "./live-config.js"
```

     获取运行时热加载配置（PrivacyConfig）。代理在每个请求中
     调用 getLiveConfig().redaction 读取脱敏选项，支持不重启
     即生效的配置变更。
## 常量：GUARDCLAW_S2_OPEN / GUARDCLAW_S2_CLOSE    (L24-L25)


S2 PII 标记协议的开闭标签。

hooks.ts 的 before_prompt_build 钩子将脱敏后的文本用这对标签
包裹，注入到用户提示词前面。代理的 stripPiiMarkers() 在收到
请求后查找这对标签，提取其中的脱敏文本并替换整条消息内容，
从而丢弃标签之外的原始 PII。

  GUARDCLAW_S2_OPEN  = "<guardclaw-s2>"
  GUARDCLAW_S2_CLOSE = "</guardclaw-s2>"
## 类型：OriginalProviderTarget                     (L29-L35)


描述原始云端 AI 提供商的连接信息。代理需要知道请求最终要
转发到哪个云端提供商，此类型保存了所需的全部信息。

字段说明：
  baseUrl: string
      原始提供商的 API 基础 URL（如 "https://api.openai.com/v1"）。

  apiKey: string
      提供商的 API 密钥，代理在转发时附加到请求头中。

  provider: string
      提供商名称（如 "openai"、"anthropic"、"google"），
      用于判断认证头格式和 URL 拼接规则。

  api?: string
      API 协议标识（如 "openai-chat"、"anthropic-messages"、
      "google-generative-ai"），用于细分同一提供商下的不同协议。

  streaming?: boolean
      是否要求流式响应（目前未被代理直接读取）。
## 类型：StashedTarget / 常量：PROVIDER_STASH_TTL_MS (L37-L38)


StashedTarget 是内部类型，将 OriginalProviderTarget 附上时间戳
以支持 TTL 过期清理。

PROVIDER_STASH_TTL_MS = 120_000（2 分钟）：
  会话级暂存的最大存活时间。超过此时间未使用的暂存目标会被
  定时清理器和按需取出时的过期检查删除。

originalProviderTargets: Map<string, StashedTarget>
  以会话 key 为键、暂存目标为值的全局缓存。
## 函数：stashOriginalProvider(key, target)          (L41-L43)


### 作用

  将原始云端提供商信息按会话 key 暂存到内存 Map 中，
  供后续代理请求取出并转发。

### 参数

  key: string — 会话标识符（通常是 sessionKey）。
  target: OriginalProviderTarget — 原始提供商连接信息。

### 返回值

  void

### 逐行逻辑


**L42**:
```typescript
originalProviderTargets.set(key, { target, ts: Date.now() });
```
> 将目标对象和当前时间戳包装为 StashedTarget 存入 Map。
> 时间戳用于后续 TTL 过期检查。


### 设计意图

  hooks.ts 在 before_model_resolve 中将 providerOverride 切换为
  "guardclaw-privacy"，同时调用此函数暂存原始提供商信息。
  代理在收到请求时通过 x-guardclaw-session 头取回暂存的目标，
  实现"请求先经过本地代理脱敏、再转发到原始云端"的流程。
## 函数：getStashedProvider(key)                    (L45-L53)


### 作用

  根据会话 key 取出暂存的原始提供商信息。若已过期则自动删除
  并返回 undefined。

### 参数

  key: string — 会话标识符。

### 返回值

  OriginalProviderTarget | undefined — 存在且未过期时返回目标，
  否则返回 undefined。

### 逐行逻辑


**L46**:
```typescript
const entry = originalProviderTargets.get(key);
```
> 从 Map 中查找对应条目。


**L47**:
```typescript
if (!entry) return undefined;
```
> 无暂存记录——可能从未设置，或已被清理。


**L48-L50**:
```typescript
if (Date.now() - entry.ts > PROVIDER_STASH_TTL_MS) { ... }
```
> 检查是否超过 2 分钟 TTL。如果过期则从 Map 中删除并返回 undefined，
> 防止长时间未使用的过期目标被错误使用。


**L52**:
```typescript
return entry.target;
```
> 未过期，返回目标信息。注意这里不删除条目——同一会话可能
> 发起多次请求（如流式重试），需要复用同一暂存目标。


### 设计意图

  带 TTL 的暂存机制防止内存泄漏（会话异常结束时无法主动清除）。
  定时器 + 按需过期双重保障确保旧数据不会无限堆积。
## 函数：cleanupStaleProviderTargets()               (L55-L60)


### 作用

  定期遍历整个 originalProviderTargets Map，删除所有已过期的条目。

### 参数

  无

### 返回值

  void

### 逐行逻辑


**L56**:
```typescript
const now = Date.now();
```
> 缓存当前时间避免在循环中多次调用 Date.now()。


**L57-L58**:
```typescript
for (const [k, v] of originalProviderTargets) { ... }
```
> 遍历 Map 的所有条目，删除时间戳超过 TTL 的条目。
> ES6 Map 允许在 for-of 中安全删除当前遍历的 key。


### 设计意图

  getStashedProvider() 只在被查询时做单条过期检查。
  此函数作为后台定时器补充，每 60 秒清扫一次全局 Map，
  清除那些从未被查询到的"孤儿"条目，防止内存泄漏。
## 定时器：_providerCleanupInterval                  (L62-L65)


**L62**:
```typescript
setInterval(cleanupStaleProviderTargets, 60_000);
```
> 每 60 秒触发一次全局清理。


**L63-L65**:
```typescript
if (typeof ... === "object" && "unref" in ...) { .unref(); }
```
> 调用 .unref() 使定时器不阻止 Node.js 进程退出。
> typeof 检查兼容非 Node 环境（虽然实际部署在 Node 中）。

变量 + 函数：defaultProviderTarget /
             setDefaultProviderTarget(target)     (L72-L76)

### 作用

  提供一个全局默认的原始提供商目标。当代理收到请求但无法通过
  会话 key 取到暂存目标时（如 x-guardclaw-session 头缺失），
  使用此默认目标作为回退。

### 参数

  target: OriginalProviderTarget — 在插件注册阶段设置的默认目标。

### 返回值

  void

### 逐行逻辑


**L72**:
```typescript
let defaultProviderTarget: OriginalProviderTarget | null = null;
```
> 模块级变量，初始为 null，在插件启动时通过 setter 设置。


**L74-L76**:
```typescript
export function setDefaultProviderTarget(target) { ... }
```
> 简单赋值。由外部启动代码在注册 provider 后调用。


### 设计意图

  双层回退：per-session 暂存 > 全局默认。确保即使会话 key
  传递链路断裂，代理仍能将请求正确转发到某个云端提供商，
  而非返回 502 错误。
## 类型：ProxyHandle                                (L80-L84)


代理服务器启动后返回的句柄，供外部代码获取代理地址和控制生命周期。

字段说明：
  baseUrl: string
      代理的完整基础 URL（如 "http://127.0.0.1:8403"）。

  port: number
      代理监听的端口号。

  close: () => Promise<void>
      关闭代理服务器的方法。内部有 2 秒 grace period
      强制关闭残留连接。
## 函数：readRequestBody(req)                        (L88-L95)


### 作用

  将 HTTP 请求的 body 读取为 UTF-8 字符串。

### 参数

  req: http.IncomingMessage — Node.js HTTP 请求对象。

### 返回值

  Promise<string> — 完整的请求体文本。

### 逐行逻辑


**L89**:
```typescript
return new Promise((resolve, reject) => {
```
> 包装为 Promise 以支持 async/await 调用。


**L90**:
```typescript
const chunks: Buffer[] = [];
```
> 收集流式数据块。


**L91**:
```typescript
req.on("data", (chunk) => chunks.push(chunk));
```
> 每收到一个数据块就追加到数组。


**L92**:
```typescript
req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
```
> 流结束时合并所有块并转为 UTF-8 字符串。


**L93**:
```typescript
req.on("error", reject);
```
> 错误时 reject Promise。


### 设计意图

  标准的 Node.js 流式 body 读取模式。代理需要先完整读取请求体
  才能解析 JSON、修改内容再转发，因此不能直接 pipe。
## 常量：UNSUPPORTED_SCHEMA_KEYWORDS                 (L101-L122)


下游 AI 提供商（特别是 Google Gemini）不支持的 JSON Schema 关键字集合。
包含高级验证关键字（patternProperties、format 等）、JSON Schema
引用关键字（$ref、$defs 等）和约束关键字（minLength、minimum 等）。

代理在转发前从工具参数 Schema 中递归移除这些关键字，避免下游
API 返回 400 错误。
## 函数：stripUnsupportedSchemaKeywords(obj)         (L124-L138)


### 作用

  递归遍历任意 JSON 对象，移除所有不被下游提供商支持的
  JSON Schema 关键字。

### 参数

  obj: unknown — 待清理的 JSON 值（可能是对象、数组或原始类型）。

### 返回值

  unknown — 清理后的 JSON 值。原始类型和数组元素会被原样或递归返回。

### 逐行逻辑


**L125**:
```typescript
if (!obj || typeof obj !== "object") return obj;
```
> 基本类型（null、string、number、boolean）无需处理。


**L126**:
```typescript
if (Array.isArray(obj)) return obj.map(stripUnsupportedSchemaKeywords);
```
> 数组：对每个元素递归清理。


**L128**:
```typescript
const cleaned: Record<string, unknown> = {};
```
> 创建新对象，而非修改原对象（对外层引用安全）。


**L129-L136**:
```typescript
for (const [key, value] of Object.entries(...)) { ... }
```
> 遍历所有键值对。如果 key 在 UNSUPPORTED_SCHEMA_KEYWORDS 中
> 则跳过（L130: continue）。否则对 object 类型的值递归处理，
> 原始类型值直接保留。


**L137**:
```typescript
return cleaned;
```
> 返回不含不支持关键字的新对象。


### 设计意图

  深度递归确保嵌套 Schema（如 properties 内的子 Schema）中的
  不支持关键字也被清除。创建新对象而非原地修改，避免污染
  上游调用者持有的原始对象引用。
## 函数：cleanToolSchemas(tools)                     (L144-L163)


### 作用

  清理 OpenAI 格式请求体中工具参数的 JSON Schema。
  处理 `tools[].function.parameters` 路径。

### 参数

  tools: unknown[] | undefined — OpenAI 格式的 tools 数组。

### 返回值

  boolean — 如果有任何 Schema 被修改则返回 true。

### 逐行逻辑


**L147**:
```typescript
if (!Array.isArray(tools) || tools.length === 0) return false;
```
> 无工具或空数组，直接返回无变更。


**L148**:
```typescript
let cleaned = false;
```
> 变更标记，用于日志记录。


**L149-L162**:
```typescript
for (let i = 0; i < tools.length; i++) { ... }
```
> 遍历每个工具定义：
> L150: 将 tools[i] 类型断言为 Record
> L152: 取出 tool.function（OpenAI 格式嵌套在 function 字段下）
> L153: 取出 fn.parameters（工具参数的 JSON Schema）
> L154-L159: 如果 parameters 存在且为对象，调用
> stripUnsupportedSchemaKeywords 清理。用 !== 判断
> 是否产生了新对象（递归总是创建新对象，所以 !== 总为 true
> 只要 params 是对象——这里的比较实际上总是 true，但语义上
> 表达"如果确实有变化"的意图）。
> L157-L158: 用清理后的结果覆盖原 parameters，标记 cleaned。


### 设计意图

  OpenAI/Anthropic 格式的工具定义嵌套在 tools[].function.parameters 中。
  此函数专门处理该路径，与 cleanGoogleToolSchemas() 形成互补，
  覆盖两大类 API 格式。
## 函数：cleanGoogleToolSchemas(tools)               (L169-L189)


### 作用

  清理 Google Gemini 原生格式请求体中工具参数的 JSON Schema。
  处理 `tools[].functionDeclarations[].parameters` 路径。

### 参数

  tools: unknown[] | undefined — Google 格式的 tools 数组。

### 返回值

  boolean — 如果有任何 Schema 被修改则返回 true。

### 逐行逻辑


**L172**:
```typescript
if (!Array.isArray(tools) || tools.length === 0) return false;
```
> 空工具直接返回。


**L174-L188**:
```typescript
for (const tool of tools) { ... }
```
> 遍历工具数组：
> L175: 类型守卫——跳过 null/非对象。
> L176-L177: 取出 functionDeclarations（驼峰）或
> function_declarations（蛇形）。Google API 文档使用驼峰，
> 但部分 SDK 或手动构造可能使用蛇形，双重兼容。
> L178: 不是数组则跳过。
> L179-L186: 对每个声明中的 parameters 调用
> stripUnsupportedSchemaKeywords。注意这里直接赋值
> （原地修改 decl），不做 !== 比较，因为总是会产生新对象。


### 设计意图

  Google Gemini API 的工具定义结构与 OpenAI 不同，嵌套在
  functionDeclarations 数组中。同时兼容驼峰和蛇形命名，
  提高对不同 SDK 版本和手动构造请求的兼容性。
## 函数：stripPiiMarkers(messages)                   (L197-L226)


### 作用

  从 OpenAI/Anthropic 格式的 messages 数组中剥离 S2 PII 标记。
  将被标签包裹的脱敏文本提取出来，替换整条消息内容。

### 参数

  messages: Array<{ role: string; content: unknown }> — 消息数组。
    content 可能是 string 或 content-part 数组。

### 返回值

  boolean — 如果有标记被剥离则返回 true。

### 逐行逻辑


**L200**:
```typescript
let stripped = false;
```
> 变更标记。


**L202-L223**:
```typescript
for (const msg of messages) { ... }
```
> 遍历每条消息：


#### 分支 1: content 是 string (L203-L210)

> L204: 查找 GUARDCLAW_S2_OPEN 的位置。
> L205: 查找 GUARDCLAW_S2_CLOSE 的位置。
> L206: 如果任一标签缺失或顺序不对（close <= open），跳过。
> 这保证了只处理完整、合法的标记对。
> L207-L209: 用 slice 截取两个标签之间的文本并 trim 去除
> 首尾空白。这段文本就是 hooks.ts 注入的脱敏后内容。
> 直接覆盖 msg.content，丢弃标签之外的原始 PII。


#### 分支 2: content 是数组 (L211-L222)

> 用于处理 multi-part 消息格式（如包含图片和文本的消息）。
> L212: 遍历每个 part。
> L213: 跳过非文本 part。
> L214-L219: 同分支 1 的逻辑，在 part.text 上操作。

### 设计意图

  这是 S2-proxy 流程的核心环节。hooks.ts 在 before_prompt_build
  中将脱敏文本用 <guardclaw-s2>...</guardclaw-s2> 标签包裹并
  prepend 到用户消息前。OpenClaw 最终将 prependContext 和原始
  消息拼接为一条 content string：
    "<guardclaw-s2>\n脱敏文本\n</guardclaw-s2>\n\n原始PII"
  此函数提取标签内的脱敏文本，有效地丢弃了原始 PII 部分。
  支持 string 和 array 两种 content 格式以兼容不同 SDK。
## 函数：stripPiiMarkersGoogleContents(contents)    (L232-L261)


### 作用

  从 Google Gemini 原生格式的 contents 数组中剥离 S2 PII 标记。
  处理 `contents[].parts[].text` 路径。

### 参数

  contents: unknown[] | undefined — Google 格式的 contents 数组。

### 返回值

  boolean — 如果有标记被剥离则返回 true。

### 逐行逻辑


**L235**:
```typescript
if (!Array.isArray(contents) || contents.length === 0) return false;
```
> 空内容直接返回。


**L238-L258**:
```typescript
for (const entry of contents) { ... }
```
> L239-L240: 类型守卫——跳过 null/非对象。
> L241: 取出 entry.parts。
> L242: 如果 parts 不是数组则跳过。
> L244-L256: 对每个 part：
> L245-L247: 类型守卫——跳过 null/非对象/非 string text。
> L249-L255: 标签查找 + 提取脱敏文本，逻辑与
> stripPiiMarkers 的 string 分支完全一致。


### 设计意图

  Google Gemini 原生 API 使用 contents[].parts[].text 而非
  messages[].content 的结构。此函数是 stripPiiMarkers 的
  Google 格式镜像，确保无论请求走哪种 API 格式，PII 标记
  都能被正确剥离。
常量：ANTHROPIC_PATTERNS / ANTHROPIC_APIS /
      GOOGLE_NATIVE_APIS / GOOGLE_URL_MARKERS    (L265-L269)

提供商识别的匹配列表：

  ANTHROPIC_PATTERNS = ["anthropic"]
      provider 名称中包含 "anthropic" 即识别为 Anthropic。

  ANTHROPIC_APIS = ["anthropic-messages"]
      API 协议为 "anthropic-messages" 也识别为 Anthropic。

  GOOGLE_NATIVE_APIS = ["google-generative-ai", "google-gemini-cli",
                         "google-ai-studio"]
      这些 api 标识表示使用 Google 原生 API（非 OpenAI 兼容层）。

  GOOGLE_URL_MARKERS = ["generativelanguage.googleapis.com",
                         "aiplatform.googleapis.com"]
      baseUrl 中包含这些域名即识别为 Google。
## 函数：isGoogleTarget(target)                     (L271-L281)


### 作用

  判断一个提供商目标是否是 Google/Gemini/Vertex AI。
  这影响 URL 构建（是否插入 /openai/ 段）和可能的格式处理。

### 参数

  target: OriginalProviderTarget — 提供商目标信息。

### 返回值

  boolean — 是 Google 提供商返回 true。

### 逐行逻辑


**L272**:
```typescript
const api = (target.api ?? "").toLowerCase();
```
> 读取 API 协议标识，统一转小写比较。


**L273**:
```typescript
const provider = target.provider.toLowerCase();
```

**L274**:
```typescript
const url = target.baseUrl.toLowerCase();
```
> 同样转小写。


**L276**:
```typescript
if (api === "openai-completions" || api === "openai-chat") return false;
```
> 显式排除：即使提供商名叫 "google"，如果 api 明确标记为
> OpenAI 协议，说明用户通过 Google 的 OpenAI 兼容层调用，
> 不需要插入 /openai/ 段（URL 已经是 OpenAI 格式）。


**L277**:
```typescript
if (GOOGLE_NATIVE_APIS.some((p) => api.includes(p))) return true;
```
> API 标识匹配 Google 原生协议。


**L278**:
```typescript
if (provider === "google" || provider.includes("gemini") || ...) return true;
```
> 提供商名称匹配。


**L279**:
```typescript
if (GOOGLE_URL_MARKERS.some((p) => url.includes(p))) return true;
```
> URL 中包含 Google 域名。


**L280**:
```typescript
return false;
```


### 设计意图

  Google Gemini 的原生 API 基础 URL（如 .../v1beta）不含 /openai/ 路径段，
  但代理默认按 OpenAI 格式构建路径。buildUpstreamUrl() 需要知道目标
  是否为 Google 以决定是否插入 /openai/ 兼容段。此函数综合 api、
  provider、url 三个维度做多层匹配，并通过"显式排除 OpenAI 协议"
  避免误判 Google OpenAI 兼容层。
## 函数：resolveAuthHeaders(target)                  (L283-L298)


### 作用

  根据提供商类型生成正确的认证请求头。不同提供商使用不同的
  认证方式：Anthropic 用 x-api-key + anthropic-version，
  其他（OpenAI、Google 等）用 Bearer token。

### 参数

  target: OriginalProviderTarget — 提供商目标信息。

### 返回值

  Record<string, string> — 认证请求头字典。无 apiKey 时返回空对象。

### 逐行逻辑


**L284**:
```typescript
const headers: Record<string, string> = {};
```
> 空头字典。


**L285**:
```typescript
if (!target.apiKey) return headers;
```
> 无 API 密钥则返回空头。可能是不需要认证的内部服务。


**L287**:
```typescript
const p = target.provider.toLowerCase();
```

**L288**:
```typescript
const api = (target.api ?? "").toLowerCase();
```
> 统一转小写进行比较。


**L290-L292**:
```typescript
if (ANTHROPIC_PATTERNS... || ANTHROPIC_APIS...) { ... }
```
> Anthropic 使用自定义认证头：
> x-api-key: 密钥本身
> anthropic-version: 固定为 "2023-06-01"（API 版本锁定）


**L293-L295**:
```typescript
else { headers["Authorization"] = `Bearer ${target.apiKey}`; }
```
> 其他所有提供商使用标准 Bearer token 格式。


### 设计意图

  抽象出提供商认证差异，让代理的转发逻辑不必关心具体认证格式。
  anthropic-version 硬编码为 "2023-06-01"，这是 Anthropic Messages API
  的当前稳定版本。未来若需要支持新版本，可从配置中读取。
## 函数：resolveTarget(sessionHeader)                (L302-L310)


### 作用

  解析代理请求应转发到的原始提供商目标。先尝试按会话 key
  查找暂存目标，失败则回退到全局默认目标。

### 参数

  sessionHeader: string | undefined — 请求中的 x-guardclaw-session 头。

### 返回值

  OriginalProviderTarget | null — 解析到的目标；两层都找不到时返回 null。

### 逐行逻辑


**L305-L308**:
```typescript
if (sessionHeader) { const t = getStashedProvider(sessionHeader); if (t) return t; }
```
> 如果有会话头，尝试从暂存 Map 中取出 per-session 目标。
> 如果取到就返回（优先级最高）。


**L309**:
```typescript
return defaultProviderTarget;
```
> 回退到全局默认。如果也没设置，返回 null。


### 设计意图

  两层回退机制保证大多数场景下代理都能找到转发目标：
  1. per-session 暂存（hooks.ts 在路由时设置）——精确匹配
  2. 全局默认（插件启动时设置）——兜底
  返回 null 时代理会返回 502 错误，提示配置缺失。
## 函数：completionToSSE(responseJson)               (L318-L355)


### 作用

  将非流式 OpenAI chat completion 响应转换为 SSE（Server-Sent Events）
  格式的流式块序列。当上游不支持流式响应但客户端请求了 stream=true
  时使用此函数进行格式转换。

### 参数

  responseJson: Record<string, unknown> — 完整的 OpenAI 格式响应 JSON。

### 返回值

  string — SSE 格式的事件流文本，以 "data: [DONE]\n\n" 结尾。

### 逐行逻辑


**L319-L322**:
```typescript
提取响应元数据：
```
> id: 响应 ID，默认 "chatcmpl-proxy"
> model: 模型名
> created: 创建时间戳，默认当前时间
> choices: 选择数组


**L324**:
```typescript
const chunks: string[] = [];
```
> 收集所有 SSE 数据行。


**L326-L351**:
```typescript
for (const choice of choices) { ... }
```
> 为每个 choice 生成两个 SSE 事件：
> 1. 内容块 (L332-L339):
> delta 包含 role="assistant" + content。
> finish_reason 为 null（表示还有后续）。
> 格式: "data: {JSON}\n\n"
> 2. 结束块 (L343-L350):
> delta 为空对象 {}，finish_reason 为实际值（通常 "stop"）。
> 如果原始响应有 usage 统计，附加到最后一个块中。


**L353**:
```typescript
chunks.push("data: [DONE]\n\n");
```
> SSE 流结束标记，OpenAI SDK 据此关闭流读取。


**L354**:
```typescript
return chunks.join("");
```
> 合并为单个字符串返回。


### 设计意图

  某些上游提供商（或配置）不支持流式响应。当客户端请求了 stream=true，
  代理先尝试真正的流式转发（tryStreamUpstream），失败后回退到
  非流式请求 + SSE 转换。此函数将非流式响应"伪装"为流式事件流，
  使 SDK 端能正常解析，对客户端完全透明。
函数：buildUpstreamUrl(targetBaseUrl, reqUrl, target?)
                                                  (L377-L386)

### 作用

  构建转发到上游提供商的完整 URL。将代理收到的请求路径
  （去掉 /v1 前缀）拼接到目标的 baseUrl 后面。
  对 Google 目标额外插入 /openai/ 兼容段。

### 参数

  targetBaseUrl: string — 目标的基础 URL。
  reqUrl: string | undefined — 代理收到的请求路径（如 "/v1/chat/completions"）。
  target?: OriginalProviderTarget — 完整目标信息，用于判断是否为 Google。

### 返回值

  string — 完整的上游 URL。

### 逐行逻辑


**L378**:
```typescript
let baseUrl = targetBaseUrl.replace(/\/+$/, "");
```
> 去除 baseUrl 末尾的斜杠，避免拼接时出现双斜杠。


**L379**:
```typescript
const forwardPath = (reqUrl ?? "/v1/chat/completions").replace(/^\/v1/, "");
```
> 代理以 /v1 前缀挂载。去除 /v1 前缀得到实际的 API 路径
> （如 "/chat/completions"）。无 reqUrl 时默认 chat completions。


**L381-L383**:
```typescript
if (target && isGoogleTarget(target) && !baseUrl.includes("/openai")) {
```
> Google 原生 API 的 baseUrl（如 .../v1beta）不含 /openai/ 段。
> 但代理转发的是 OpenAI 格式的请求体，需要走 Google 的
> OpenAI 兼容端点。因此在 baseUrl 后追加 /openai/。
> 检查 !baseUrl.includes("/openai") 避免重复插入。


**L385**:
```typescript
return `${baseUrl}${forwardPath}`;
```
> 拼接最终 URL。例如：
> OpenAI: "https://api.openai.com/v1" + "/chat/completions"
> Google: "https://...googleapis.com/v1beta/openai" + "/chat/completions"


### 设计意图

  代理对外暴露统一的 /v1/* 接口。此函数负责将请求路径透明映射
  到不同提供商的实际端点。Google 特殊处理确保 OpenAI 格式请求
  被正确路由到 Google 的兼容端点。
## 常量：STREAM_FIRST_CHUNK_TIMEOUT_MS               (L390)


流式请求首个数据块的超时时间：30 秒。如果上游在 30 秒内
未返回任何数据，视为流式不可用，回退到非流式模式。
函数：tryStreamUpstream(parsed, upstreamUrl,
        upstreamHeaders, res, log)                (L398-L466)

### 作用

  尝试以流式模式将请求转发到上游提供商。如果流式成功（收到
  第一个数据块），将完整的 SSE 流 pipe 到客户端响应；如果超时
  或失败，返回 false 让调用方回退到非流式模式。

### 参数

  parsed: Record<string, unknown> — 清理后的请求体 JSON。
  upstreamUrl: string — 上游 URL。
  upstreamHeaders: Record<string, string> — 上游请求头（含认证）。
  res: ServerResponse — 客户端的 HTTP 响应对象。
  log: { info, warn, error } — 日志接口。

### 返回值

  Promise<boolean> — true 表示流式成功完成，false 表示需要回退。

### 逐行逻辑


**L405**:
```typescript
const controller = new AbortController();
```
> 创建 abort 控制器用于超时取消。


**L406**:
```typescript
const timeout = setTimeout(() => controller.abort(), STREAM_FIRST_CHUNK_TIMEOUT_MS);
```
> 30 秒后自动 abort fetch 请求。


**L408-L419**:
```typescript
try { upstream = await fetch(...) } catch { ... return false; }
```
> 发起 fetch 请求。如果被 abort 或网络错误，清除定时器并返回 false。
> signal: controller.signal 将 abort 控制器绑定到 fetch。


**L421-L424**:
```typescript
if (!upstream.body || !upstream.ok) { ... return false; }
```
> 无 body 或非 2xx 状态码，视为不可用，返回 false。


**L426**:
```typescript
const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
```
> 获取 ReadableStream 的 reader 用于手动控制读取。


**L429-L437**:
```typescript
try { firstRead = await reader.read(); } catch { ... return false; }
```
> 等待第一个数据块。如果读取失败（如连接断开），释放锁并返回 false。
> 此时超时定时器仍在运行——如果 30 秒内没收到数据，abort 会
> 触发 reader.read() 的 catch 分支。


**L437**:
```typescript
clearTimeout(timeout);
```
> 收到第一个块后清除超时定时器——流已"活跃"。


**L439-L441**:
```typescript
if (firstRead.done) { return false; }
```
> 空流（上游立即结束），视为不可用。


**L444-L449**:
```typescript
res.writeHead(upstream.status, { ... });
```
> 流式生效——向客户端发送响应头：
> Content-Type: 从上游获取，默认 "text/event-stream"
> Cache-Control: no-cache（SSE 标准头）
> Connection: keep-alive


**L450**:
```typescript
res.write(Buffer.from(firstRead.value));
```
> 将第一个数据块写入客户端。


**L452-L464**:
```typescript
try { while (true) { ... } } catch { ... } finally { ... }
```
> 持续读取上游数据并写入客户端：
> L454: 读取下一个块。
> L455: done 为 true 时跳出循环。
> L456-L458: 检查 res.writableEnded 防止写入已关闭的响应。
> L460-L461: 异常时记录警告（上游提前断开）。
> L463: finally 确保响应正确结束。


**L465**:
```typescript
return true;
```
> 流式传输完成。


### 设计意图

  流式传输需要"先尝试再判断"——只有收到第一个数据块才能确认
  上游支持流式。30 秒超时防止无限等待。失败后返回 false 让
  调用方优雅降级到非流式 + SSE 转换模式，对客户端透明。
  手动 reader 控制（而非直接 pipe）是为了实现"首块超时"语义：
  pipe 不支持部分超时的中断。
## 函数：startPrivacyProxy(port, logger?)           (L470-L675)


### 作用

  启动隐私代理 HTTP 服务器。这是整个文件的主入口函数。
  服务器监听指定端口，处理所有进入的 POST 请求：
    1. 剥离 PII 标记
    2. 清理工具 Schema
    3. 纵深防御 PII 脱敏
    4. 解析目标提供商
    5. 构建上游 URL
    6. 转发请求（流式/非流式）

### 参数

  port: number — 代理监听端口（默认 8403，由配置决定）。
  logger?: { info, warn, error } — 可选日志接口，缺省使用 console。

### 返回值

  Promise<ProxyHandle> — 代理句柄，含 baseUrl、port 和 close 方法。

### 逐行逻辑


**L474-L478**:
```typescript
const log = logger ?? { ... };
```
> 设置日志实例。如果未提供 logger，使用 console 的
> log/warn/error 方法作为默认。


**L480**:
```typescript
const server = http.createServer(async (req, res) => { ... });
```
> 创建 HTTP 服务器。请求处理器是一个 async 函数，
> 因为内部需要 await 读取 body 和转发请求。


#### 请求处理器内部


**L481-L485**:
```typescript
if (req.method !== "POST") { ... }
```
> 只接受 POST 方法。所有 AI API 都使用 POST 提交 chat
> completion 请求。其他方法返回 405 Method Not Allowed。


**L488**:
```typescript
log.info(`[GuardClaw Proxy] Incoming ${req.method} ${req.url}`);
```
> 记录进入的请求方法和路径。


**L489**:
```typescript
const body = await readRequestBody(req);
```
> 完整读取请求体。


**L490**:
```typescript
const parsed = JSON.parse(body);
```
> 解析为 JSON 对象。后续所有操作在此对象上进行修改。


#### Step 1: 剥离 PII 标记 (L492-L497)


**L493**:
```typescript
const hadOpenAiMarkers = stripPiiMarkers(parsed.messages ?? []);
```
> 处理 OpenAI/Anthropic 格式的 messages。


**L494**:
```typescript
const hadGoogleMarkers = stripPiiMarkersGoogleContents(parsed.contents);
```
> 处理 Google 格式的 contents。
> 两个函数会原地修改 parsed 中的消息内容。


**L495-L497**:
```typescript
if (hadOpenAiMarkers || hadGoogleMarkers) { log... }
```
> 日志记录是否有标记被剥离。


#### Step 2: 清理工具 Schema (L499-L504)


**L500**:
```typescript
const hadOpenAiSchemaFix = cleanToolSchemas(parsed.tools);
```
> 清理 OpenAI 格式工具定义。


**L501**:
```typescript
const hadGoogleSchemaFix = cleanGoogleToolSchemas(parsed.tools);
```
> 清理 Google 格式工具定义。
> 注意两个函数可以安全地对同一个 tools 数组运行——
> OpenAI 格式看 tool.function.parameters，
> Google 格式看 tool.functionDeclarations[].parameters，
> 路径互不冲突。


#### Step 2b: 纵深防御 PII 脱敏 (L506-L549)


**L514**:
```typescript
const redactionOpts = getLiveConfig().redaction;
```
> 读取实时脱敏选项。每个请求都重新读取，支持热加载。


**L515**:
```typescript
const allMessages = (parsed.messages ?? parsed.contents ?? []) ...;
```
> 统一 OpenAI 和 Google 两种消息数组。


**L516-L549**:
```typescript
for (const msg of allMessages) { ... }
```
> 遍历所有非 system 角色的消息：
> L517-L518: const role = String(msg.role ?? "").toLowerCase();
> if (role === "system") continue;
> 跳过 system 消息——系统指令可能包含"密码"、"secret"等词，
> 但这些是合法的安全指令，不应被脱敏。
> L520-L525: 分支 1 — content 是 string：
> 调用 redactSensitiveInfo() 脱敏。如果有变化则替换原内容。
> L526-L536: 分支 2 — content 是数组（multi-part）：
> 遍历每个 text part 做同样处理。
> L538-L548: 分支 3 — Google 格式 parts 数组：
> Google 的 contents[].parts[].text 路径。


  纵深防御的三种场景：
    1. prependContext 语义变更导致标记未包裹原始消息
    2. 本地模型脱敏时遗漏了部分 PII
    3. 内容绕过标记协议直接注入

#### Step 3: 解析目标提供商 (L551-L565)


**L552**:
```typescript
const sessionKey = req.headers["x-guardclaw-session"] as string | undefined;
```
> 从请求头中读取会话 key。此头由 OpenClaw SDK 自动附加。


**L553**:
```typescript
const target = resolveTarget(sessionKey);
```
> 按优先级解析目标：per-session 暂存 > 全局默认。


**L555-L565**:
```typescript
if (!target) { ... }
```
> 找不到任何目标，返回 502 错误。这通常意味着
> stashOriginalProvider 未被调用（hooks 配置问题）。


#### Step 4: 构建上游 URL (L567-L568)


**L568**:
```typescript
const upstreamUrl = buildUpstreamUrl(target.baseUrl, req.url, target);
```
> 拼接最终 URL。Google 目标会自动插入 /openai/ 段。


#### Step 5: 构建请求头 + 限制 max_tokens (L570-L583)


**L571-L574**:
```typescript
const upstreamHeaders = { "Content-Type": "application/json", ...resolveAuthHeaders(target) };
```
> 合并 Content-Type 和提供商认证头。


**L577**:
```typescript
const MAX_COMPLETION_TOKENS = 16384;
```
> 硬编码的最大生成 token 数上限。


**L578-L583**:
```typescript
for (const key of ["max_tokens", "max_completion_tokens"]) { ... }
```
> 检查并钳位 max_tokens / max_completion_tokens。
> 某些上游提供商对这些值有限制，超出会返回 400。
> 代理主动 cap 到 16384 以避免此类拒绝。


#### Step 6: 转发请求 (L585-L638)


**L585**:
```typescript
const clientWantsStream = !!parsed.stream;
```
> 客户端是否请求流式响应。


**L588-L591**:
```typescript
if (clientWantsStream) { ... }
```
> 先尝试流式转发。tryStreamUpstream 成功则直接返回。
> 失败时 fallthrough 到下面的非流式路径。


**L595**:
```typescript
const upstreamBody = { ...parsed, stream: false };
```
> 强制禁用流式——这是非流式请求或流式失败后的回退。


**L596-L616**:
```typescript
非流式 fetch + 超时处理：
```
> L596-L597: AbortController + 120 秒超时。
> 流式超时 30 秒（只等首块），非流式等整个响应需要更长。
> L599-L605: fetch 上游。
> L606-L615: catch 处理：
> AbortError → "Upstream request timed out (120s)"
> 其他错误 → 原始错误信息
> 返回 504 Gateway Timeout。
> L616: clearTimeout——正常响应后取消超时。


**L618-L632**:
```typescript
if (clientWantsStream) { ... }
```
> 客户端想要流但上游只返回了非流式响应——进行 SSE 转换：
> L619: 解析上游 JSON 响应。
> L621-L628: 如果上游成功，调用 completionToSSE() 转换为
> SSE 格式，以 text/event-stream 返回。
> L629-L632: 如果上游失败（非 2xx），原样转发错误响应。


**L633-L638**:
```typescript
else { ... }
```
> 客户端本来就不要流——直接透传上游响应（status + body）。


#### 异常处理 (L639-L652)


**L639**:
```typescript
catch (err) { ... }
```
> 顶层 try-catch 兜底。记录错误，返回 500 Internal Server Error。
> L641: 检查 headersSent 避免重复写入头。
> L644: 检查 writableEnded 避免写入已关闭的响应。


#### 服务器级错误处理 (L656-L658)


**L656-L658**:
```typescript
server.on("error", (err) => { ... });
```
> 捕获服务器级别的错误（如端口冲突），记录日志。


#### 启动监听 (L660-L674)


**L660**:
```typescript
return new Promise<ProxyHandle>((resolve, reject) => { ... });
```
> 包装为 Promise，在 listen 成功时 resolve，失败时 reject。


**L661**:
```typescript
server.listen(port, "127.0.0.1", () => { ... });
```
> 只绑定 127.0.0.1（localhost）——代理仅供本机使用，
> 不应暴露到网络上。


**L662-L670**:
```typescript
resolve({ baseUrl, port, close: () => ... });
```
> 返回 ProxyHandle：
> baseUrl: "http://127.0.0.1:{port}"
> port: 实际端口
> close: 异步关闭函数。server.close() 后 2 秒强制 resolve，
> 防止残留连接导致无限挂起。


**L673**:
```typescript
server.on("error", reject);
```
> 启动阶段的错误（如 EADDRINUSE）会 reject Promise。


### 设计意图

  这是隐私代理的主函数，编排了完整的 S2 请求处理流水线：
    标记剥离 → Schema 清理 → 纵深防御脱敏 → 目标解析 → URL 构建
    → 认证头生成 → 流式/非流式转发
  设计为支持三种 API 格式（OpenAI、Google、Anthropic）的通用代理。
  流式处理采用"尝试流式 → 超时回退非流式 + SSE 转换"的渐进策略，
  最大化流式体验同时保证可靠性。
  绑定 127.0.0.1 是安全考虑——代理处理含密钥的请求，不应暴露给外部。


## Part A — Code 层面改动建议


#### 🟡 cleanToolSchemas 的 !== 比较永远为 true


 现状（L155-L156）：
   stripUnsupportedSchemaKeywords() 总是创建新对象（L128 const cleaned = {}），
   所以 `result !== params` 的引用比较永远为 true（只要 params 是对象）。

 问题：
   cleaned 标记的语义是"是否有实际变更"，但这个比较无法正确区分。
   cleanGoogleToolSchemas (L183-L184) 甚至直接跳过了比较，直接赋值
   并设 cleaned = true，两个函数的处理方式不一致。

 建议：
   两种方案：
   (a) 让 stripUnsupportedSchemaKeywords 在无需删除任何 key 时返回原对象引用；
   (b) 移除 !== 比较，与 cleanGoogleToolSchemas 保持一致——始终赋值。
   推荐 (b)，更简单且两函数行为统一。


#### 🟢 UNSUPPORTED_SCHEMA_KEYWORDS 可考虑按提供商分组


 现状（L101-L122）：
   所有不支持的关键字放在一个 Set 中，统一移除。

 问题：
   OpenAI 实际上支持部分关键字（如 minLength、maximum），但 Google 不支持。
   统一移除可能导致 OpenAI 请求丢失有用的验证约束。

 建议：
   可按提供商维护不同的移除列表。但考虑到工具 Schema 的验证约束
   主要影响模型生成质量而非功能正确性，当前统一移除的方案可接受，
   标记为低优先级。


#### 🟡 completionToSSE 不处理 tool_calls / function_call


 现状（L326-L351）：
   只从 choice.message.content 中提取文本内容生成 SSE 块。

 问题：
   如果上游返回了 tool_calls（工具调用请求），这些信息会在
   SSE 转换中丢失。虽然 S2-proxy 场景下大部分请求是纯文本
   对话，但如果模型决定调用工具，客户端将收不到该指令。

 建议：
   在 content 块之后检查 choice.message.tool_calls，如果有，
   为每个 tool_call 生成额外的 SSE delta 块。


#### 🟢 MAX_COMPLETION_TOKENS 硬编码


 现状（L577）：
   MAX_COMPLETION_TOKENS = 16384 写死在代码中。

 问题：
   不同提供商的限制不同（GPT-4o 支持 16k，Claude 支持更高）。
   硬编码可能不必要地限制某些提供商的能力。

 建议：
   可从 PrivacyConfig 或提供商配置中读取。但考虑到这是安全上限
   （防止意外的巨大请求），硬编码 16k 是合理的保守选择。
   标记为低优先级。


#### 🟡 parsed 对象被原地修改


 现状（L490 及后续）：
   JSON.parse 得到的 parsed 对象被 stripPiiMarkers、cleanToolSchemas、
   纵深防御脱敏等函数原地修改。

 问题：
   虽然 parsed 是局部变量，原地修改不会影响外部调用者，
   但代码的可读性和调试性受影响——中间某步的修改可能
   影响后续步骤的假设（如 Step 2b 读取的 messages 可能
   已被 Step 1 修改过）。

 建议：
   当前实际上是有意为之——每步操作累积在同一对象上，最终
   序列化后转发。可以加注释明确这个流水线语义。


#### 🔴 JSON.parse(body) 未做错误处理


 现状（L490）：
   const parsed = JSON.parse(body); 在 try-catch 内部，但
   catch 返回的是通用 500 错误，错误消息中包含原始异常字符串
   （可能泄露内部结构信息）。

 问题：
   如果请求体不是合法 JSON（如被截断、编码错误），JSON.parse
   会抛出 SyntaxError。当前被外层 catch 捕获后返回
   "GuardClaw proxy error: SyntaxError: ..."，应该返回更精确的
   400 Bad Request 并避免泄露内部信息。

 建议：
   在 JSON.parse 外包一层 try-catch，专门返回 400：
   ```
   let parsed;
   try { parsed = JSON.parse(body); } catch {
     res.writeHead(400, { "Content-Type": "application/json" });
     res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
     return;
   }
   ```

## Part B — 逻辑/设计层面改动建议


#### 🔴 纵深防御脱敏对 Google contents 格式的遍历不完整


 现状（L515-L549）：
   allMessages 统一为 `parsed.messages ?? parsed.contents ?? []`。
   然后对每个 msg 检查 msg.content（OpenAI 格式）和 msg.parts（Google 格式）。

 问题：
   Google contents 格式的结构是 contents[].parts[].text，其中
   contents[] 的元素没有 .content 属性，只有 .parts。
   代码在 L520 检查 msg.content（OpenAI 路径），对 Google 格式
   的 contents 元素这个检查会直接跳过（content 不存在）。
   然后在 L538 检查 msg.parts（Google 路径），这条路径是对的。

   但问题在于：如果请求同时包含 parsed.messages 和 parsed.contents
   （不太可能但理论上可能），L515 的 ?? 只会取第一个非空数组。
   更重要的是，对 Google 格式，msg.role 的获取方式正确
   （Google contents 也有 role 字段），但 system role 在 Google
   格式中叫 "model" 而不是 "system"。当前只跳过 role === "system"，
   Google 的模型响应（role === "model"）不会被跳过，这是正确的。

   实际问题较小——因为 Google 格式和 OpenAI 格式不会混用在
   同一请求中。但代码的意图不够清晰。

 建议：
   将 OpenAI 和 Google 的纵深防御分为两个独立的处理块，
   类似 Step 1 和 Step 2 的分开处理方式，提高可读性和正确性。


#### 🟡 非流式回退缺少 Google 原生格式支持


 现状（L618-L632）：
   clientWantsStream + 非流式回退路径中，completionToSSE() 假设
   上游返回 OpenAI 格式（id, choices, message.content）。

 问题：
   如果目标是 Google 原生 API（非 OpenAI 兼容层），响应格式
   不同（candidates[].content.parts[]）。当前代码通过
   buildUpstreamUrl 插入 /openai/ 段来走 Google 的 OpenAI
   兼容端点，所以实际上响应是 OpenAI 格式的。但如果
   isGoogleTarget 的判断有误（如新的 Google API 版本），
   回退路径可能收到无法解析的响应。

 建议：
   在 completionToSSE 中增加对非 OpenAI 格式响应的基本容错
   （如检查 choices 不存在时尝试 candidates）。


#### 🟡 代理未设置请求的 Content-Length


 现状（L599-L605）：
   转发请求时使用 fetch + JSON.stringify(upstreamBody) 但未
   显式设置 Content-Length 头。

 问题：
   fetch API 通常会自动处理 Content-Length，但代理对请求体
   做了修改（PII 剥离、Schema 清理、max_tokens 截断），修改后
   的 body 长度与原始不同。fetch 会根据实际 body 计算长度，
   所以功能上没有问题。但如果某些代理/CDN 缓存了原始的
   Content-Length 头并传递下去，可能导致截断。

 建议：
   当前使用 fetch 而非手动 http.request，Content-Length 由
   fetch 自动管理，无需额外处理。仅作为 awareness 记录。


#### 🔴 代理 close() 中 Promise 可能被 resolve 两次


 现状（L665-L669）：
   close: () => new Promise<void>((r) => {
     server.close(() => r());
     setTimeout(() => r(), 2000);
   })

 问题：
   如果 server.close() 在 2 秒内完成，r() 会被调用两次
   （一次 close 回调，一次 setTimeout）。虽然 Promise resolve
   多次不会报错（第二次调用被忽略），但 setTimeout 回调
   不会被自动取消，造成微小的内存泄漏和不必要的定时器保留。

 建议：
   使用标记变量或 clearTimeout：
   ```
   close: () => new Promise<void>((r) => {
     const t = setTimeout(() => r(), 2000);
     server.close(() => { clearTimeout(t); r(); });
   })
   ```


#### 🟡 stashOriginalProvider 未处理并发写入


 现状（L41-L43）：
   直接 Map.set 覆盖旧值。

 问题：
   如果同一会话快速连续发起两个请求，第二个 stash 会覆盖第一个。
   在单线程 Node.js 中这通常不是问题（hooks 同步执行 stash
   后才返回，下一个请求才处理）。但如果 hooks 是 async 且
   两个请求交错执行，可能出现 stash 被覆盖的情况。

 建议：
   当前设计在单线程 + 同步 stash 的前提下是安全的。
   如果未来引入并发处理，需要考虑加锁或版本号机制。
   作为 awareness 记录。


#### 🟡 anthropic-version 硬编码为 "2023-06-01"


 现状（L292）：
   headers["anthropic-version"] = "2023-06-01";

 问题：
   Anthropic API 可能更新版本。硬编码的版本号可能与用户
   实际使用的 SDK 版本不匹配，导致行为差异或兼容性问题。

 建议：
   从 OriginalProviderTarget 或配置中读取 anthropic-version，
   或从原始请求头中透传。hooks.ts 在 stash 时可以同时保存
   provider-specific 头信息。


#### 🟡 与 hooks.ts 的安全契约依赖 prependContext 语义


 现状：
   hooks.ts L454-L468 注释明确说明了安全契约：prependContext
   将脱敏文本 prepend 到用户消息前，代理的 stripPiiMarkers
   提取标签内容并丢弃标签外的原始 PII。

 问题：
   如果 OpenClaw 修改 prependContext 的语义（如改为独立消息
   而非拼接到 content），标记将出现在独立的 message 中，
   原始 PII 仍保留在后续消息中。代理的纵深防御（Step 2b）
   可以部分缓解，但 regex 脱敏不如标记协议精确。

 建议：
   hooks.ts 中已有注释警告此风险。可在代理侧增加额外的
   防御措施：如果发现消息中有 PII 标记但不是 prepend 格式
   （标记在消息开头但后面没有更多内容），记录警告并加强
   纵深防御的脱敏力度。
## 优先级总览


| 🔴 | 高优先级（应尽快修复） |
| --- | --- |
| 6 | JSON.parse 无专门错误处理，可能泄露内部信息 |
| 7 | 纵深防御对 Google 格式遍历逻辑不够清晰 |
| 10 | close() 中 Promise 可被 resolve 两次 |
| 🟡 | 中优先级（下一迭代） |
| 1 | cleanToolSchemas 的 !== 比较永远为 true |
| 3 | completionToSSE 不处理 tool_calls |
| 5 | parsed 对象被原地修改，流水线语义不够显式 |
| 8 | 非流式回退缺少 Google 原生格式容错 |
| 9 | Content-Length 管理依赖 fetch 自动处理 |
| 11 | stashOriginalProvider 并发写入 awareness |
| 12 | anthropic-version 硬编码 |
| 13 | 安全契约依赖 prependContext 语义 |
| 🟢 | 低优先级（锦上添花） |
| 2 | UNSUPPORTED_SCHEMA_KEYWORDS 可按提供商分组 |
| 4 | MAX_COMPLETION_TOKENS 硬编码 |
