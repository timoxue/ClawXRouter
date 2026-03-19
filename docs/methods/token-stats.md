# token-stats.ts — 逐方法文档


 文件定位：Token 用量统计收集器
 所属模块：GuardClaw 隐私路由系统

 核心职责：按 cloud / local / proxy 三条路由追踪 token 用量，
 支持按小时粒度、按会话粒度以及按来源（router 开销 vs task 实际请求）
 维度聚合统计。数据持久化到 JSON 文件，网关重启后不丢失。

 路由分类规则（基于 GuardClaw Sx 敏感等级）：
   S1 → cloud（直接走云端）
   S2 → proxy（脱敏转发）或 local（取决于 s2Policy 配置）
   S3 → local（强制本地模型）
## 类型：RouteCategory                              (L17)


路由分类联合类型：
  "cloud" — 请求直接发往云端 API
  "local" — 请求由本地模型处理（S3 或 S2-local）
  "proxy" — 请求经过隐私代理脱敏后转发（S2-proxy）
## 类型：TokenSource                                 (L20)


区分 token 来源：
  "router" — 路由器开销（检测/分类/PII 提取等 pipeline 内部 LLM 调用）
  "task"   — 实际的用户请求（即真正干活的 LLM 调用）

设计意图：让用户在仪表盘中清楚看到"为了保护隐私花了多少 token"
vs "实际完成任务花了多少 token"。
## 类型：TokenBucket                                 (L22-L29)


单个统计桶，累加同一维度下的所有请求。

字段说明：
  inputTokens:     number — 输入 token 累计
  outputTokens:    number — 输出 token 累计
  cacheReadTokens: number — 缓存读取 token 累计（Anthropic / OpenAI 缓存命中）
  totalTokens:     number — 总 token 数（若 API 提供直接用，否则 = input + output）
  requestCount:    number — 请求次数
  estimatedCost:   number — 估算费用（USD），仅对 cloud / proxy 有意义
## 类型：SourceBuckets                               (L31)


按 TokenSource 维度聚合的桶映射：
  { router: TokenBucket, task: TokenBucket }
## 类型：HourlyBucket                               (L33-L39)


单个小时的统计快照。

字段说明：
  hour:     string — ISO 格式小时键，如 "2026-03-18T14"
  cloud:    TokenBucket — 该小时内走 cloud 路由的用量
  local:    TokenBucket — 该小时内走 local 路由的用量
  proxy:    TokenBucket — 该小时内走 proxy 路由的用量
  bySource: SourceBuckets — 该小时内按 router/task 来源聚合
## 类型：SessionTokenStats                          (L41-L50)


单个会话维度的 token 统计。

字段说明：
  sessionKey:   string — 会话标识符
  highestLevel: "S1" | "S2" | "S3" — 该会话曾达到的最高敏感等级
  cloud / local / proxy: TokenBucket — 分路由维度
  bySource:     SourceBuckets — 分来源维度
  firstSeenAt:  number — 首次出现时间戳（ms）
  lastActiveAt: number — 最近活跃时间戳（ms）
## 类型：TokenStatsData                             (L52-L59)


顶层持久化数据结构，整个 collector 的完整快照。

字段说明：
  lifetime:      Record<RouteCategory, TokenBucket> — 全生命周期按路由聚合
  bySource:      SourceBuckets — 全生命周期按来源聚合
  hourly:        HourlyBucket[] — 按小时时间线（最多保留 72 个桶）
  sessions:      Record<string, SessionTokenStats> — 按会话聚合（最多 200 个）
  startedAt:     number — 统计开始时间
  lastUpdatedAt: number — 最后一次更新时间
## 类型：UsageEvent                                  (L61-L74)


单次 LLM 调用的用量事件，由 hooks.ts (llm_output) 和
local-model.ts / token-saver.ts 生成。

字段说明：
  sessionKey: string     — 所属会话
  provider:   string     — 提供商名（如 "openai"、"edge"）
  model:      string     — 模型名（如 "gpt-4o"、"openbmb/minicpm4.1"）
  source?:    TokenSource — "router" 或 "task"，缺省为 "task"
  usage?:     object     — API 返回的 token 计量
    input?:      number
    output?:     number
    cacheRead?:  number
    cacheWrite?: number  （目前仅记录到事件中，未计入 bucket）
    total?:      number
## 常量：MAX_HOURLY_BUCKETS = 72                     (L78)


最多保留 72 个小时桶 = 3 天。超出后从最旧的开始淘汰。
## 常量：MAX_SESSIONS = 200                          (L79)


最多保留 200 个会话统计。超出后按 lastActiveAt 从最旧开始淘汰。
## 函数：emptyBucket()                               (L81-L83)


### 作用

  创建一个所有字段归零的 TokenBucket 对象。

### 参数

  无

### 返回值

  TokenBucket — 全零桶

### 逐行逻辑


**L82**:
```typescript
return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, requestCount: 0, estimatedCost: 0 };
```
> 返回一个字面量对象，所有计数器归零。
> 每次调用都产生新对象，避免多处共享同一引用导致的串改。


### 设计意图

  工厂函数模式。在 load()、record()、reset() 等多处需要初始化空桶，
  抽取为函数确保一致性并减少拼写错误。
## 函数：emptySourceBuckets()                        (L85-L87)


### 作用

  创建空的 SourceBuckets 对象（router + task 各一个空桶）。

### 参数

  无

### 返回值

  SourceBuckets — { router: emptyBucket(), task: emptyBucket() }

### 逐行逻辑


**L86**:
```typescript
return { router: emptyBucket(), task: emptyBucket() };
```
> 为 "router" 和 "task" 两个来源分别创建独立的空桶。


### 设计意图

  与 emptyBucket() 同理，保证各维度的 bySource 初始化一致。
## 函数：currentHourKey()                            (L89-L91)


### 作用

  生成当前时间的小时级别 key，用于匹配 hourly 桶。

### 参数

  无

### 返回值

  string — 形如 "2026-03-18T14" 的 ISO 前 13 位截断字符串。

### 逐行逻辑


**L90**:
```typescript
return new Date().toISOString().slice(0, 13);
```
> Date.toISOString() → "2026-03-18T14:35:12.456Z"
> .slice(0, 13)      → "2026-03-18T14"
> 这样同一小时内的所有事件都会落入同一个桶。


### 设计意图

  用 ISO 字符串截断而非 Date 运算来生成 key，简洁且天然排序。
  精度到小时足够用于仪表盘时间线图表。
## 函数：emptyStats()                                (L93-L102)


### 作用

  创建空的 TokenStatsData 对象，用于首次初始化或 reset。

### 参数

  无

### 返回值

  TokenStatsData — 全空初始状态

### 逐行逻辑


  L94-L101:
> lifetime: 三条路由各一个空桶
> bySource: router + task 各一个空桶
> hourly: 空数组（无历史小时数据）
> sessions: 空对象（无会话数据）
> startedAt / lastUpdatedAt: 当前时间戳

### 设计意图

  统一初始化入口，确保 load() 失败时和 reset() 后得到的数据结构一致。
## 函数：addToBucket(bucket, usage, cost)            (L104-L114)


### 作用

  将一次 LLM 调用的 usage 数据累加到目标桶中。

### 参数

  bucket: TokenBucket — 目标桶（会被就地修改）
  usage:  UsageEvent["usage"] — 可选的 token 用量对象
  cost:   number（默认 0）— 本次调用的估算费用

### 返回值

  void — 直接修改传入的 bucket 对象

### 逐行逻辑


**L105**:
```typescript
const input = usage?.input ?? 0;
```
> 安全取出 input token 数，usage 或 input 为 undefined 时回退到 0。


**L106**:
```typescript
const output = usage?.output ?? 0;
```
> 同理取出 output token 数。


**L107**:
```typescript
const cacheRead = usage?.cacheRead ?? 0;
```
> 取出缓存读取 token 数。


**L108**:
```typescript
bucket.inputTokens += input;
```
> 累加输入 token。


**L109**:
```typescript
bucket.outputTokens += output;
```
> 累加输出 token。


**L110**:
```typescript
bucket.cacheReadTokens += cacheRead;
```
> 累加缓存读取 token。


**L111**:
```typescript
bucket.totalTokens += usage?.total ?? (input + output);
```
> 若 API 返回了 total 则使用，否则用 input + output 估算。
> 注意：cacheRead 不计入 total，这是因为缓存命中的 token
> 通常在定价上有不同处理（或免费），不应与正常 token 混计。


**L112**:
```typescript
bucket.requestCount += 1;
```
> 请求次数 +1。


**L113**:
```typescript
bucket.estimatedCost += cost;
```
> 累加费用。注意 local 路由时 cost 传入 0。


### 设计意图

  将"累加到桶"的逻辑统一抽取，record() 中多处调用（lifetime、bySource、
  hourly、session），避免重复代码。就地修改而非返回新对象是为了性能
  （高频调用场景下避免 GC 压力）。
## 函数：lookupPricing(model)                        (L117-L133)


### 作用

  根据模型名称查找定价信息。查找策略：精确匹配 → 子串匹配 → 默认值。

### 参数

  model: string — 模型名称（如 "gpt-4o"、"claude-sonnet-4.6"）

### 返回值

  { inputPer1M: number; outputPer1M: number } — 每百万 token 的 USD 价格

### 逐行逻辑


**L118**:
```typescript
const pricing = getLiveConfig().modelPricing;
```
> 从运行时配置中读取 modelPricing 字典。
> getLiveConfig() 返回的是热加载的 PrivacyConfig，
> 可被仪表盘或配置文件变更实时更新。


**L119**:
```typescript
if (!pricing) return { inputPer1M: 3, outputPer1M: 15 };
```
> 若 modelPricing 未配置，回退到硬编码默认值。
> 3 / 15 对应的是 Claude Sonnet 级别的定价。


**L121-L123**:
```typescript
if (pricing[model]) { return { ... }; }
```
> 第一优先级：精确匹配。
> 若定价条目存在但 inputPer1M / outputPer1M 缺失，
> 仍然用 ?? 3 / ?? 15 回退。


**L125**:
```typescript
const lowerModel = model.toLowerCase();
```
> 转小写用于不区分大小写的子串匹配。


**L126-L129**:
```typescript
for (const [key, val] of Object.entries(pricing)) { ... }
```
> 第二优先级：遍历所有定价 key，如果 model 名包含某个 key
> 则匹配成功。例如 model="gpt-4o-2025-01-01" 会匹配
> key="gpt-4o"。


**L132**:
```typescript
return { inputPer1M: 3, outputPer1M: 15 };
```
> 第三优先级：完全没匹配到，返回默认值。


### 设计意图

  三级回退策略确保任何模型都能得到一个合理的价格估算。
  子串匹配处理模型版本后缀（如日期戳）的变化，
  用户只需在配置中写短名（"gpt-4o"）即可覆盖所有版本。
## 函数：calculateCost(model, usage)                 (L135-L140)


### 作用

  根据模型定价和 usage 数据计算单次请求的 USD 费用。

### 参数

  model: string          — 模型名称
  usage: UsageEvent["usage"] — token 用量

### 返回值

  number — 估算费用（USD）

### 逐行逻辑


**L136**:
```typescript
const input = usage?.input ?? 0;
```
> 安全取出 input token 数。


**L137**:
```typescript
const output = usage?.output ?? 0;
```
> 安全取出 output token 数。


**L138**:
```typescript
const p = lookupPricing(model);
```
> 查找该模型的定价。


**L139**:
```typescript
return (input * p.inputPer1M + output * p.outputPer1M) / 1_000_000;
```
> 公式：(输入token × 输入单价 + 输出token × 输出单价) / 100万
> 结果单位为 USD。
> 注意：cacheRead token 未参与计费 — 多数 API 对缓存命中
> 不收费或收费极低，这里简化忽略。


### 设计意图

  将费用计算与桶累加分离，保持 addToBucket 的通用性。
  cost 仅在 cloud / proxy 场景下有意义（local 路由 cost = 0）。
## 函数：classifyBySession(sessionKey)               (L148-L156)


### 作用

  根据会话的历史最高敏感等级，判断该请求应归入哪条路由统计。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  RouteCategory — "cloud" | "local" | "proxy"

### 逐行逻辑


**L149**:
```typescript
const level = getSessionHighestLevel(sessionKey);
```
> 从 session-state.ts 获取该会话的 highestLevel。
> 这是会话生命周期内的最高等级（审计用），不会因
> 每轮 resetTurnLevel() 而回退。


**L150**:
```typescript
if (level === "S3") return "local";
```
> S3 = 高敏感 → 必须本地处理。


**L151-L154**:
```typescript
if (level === "S2") { ... }
```
> S2 取决于 s2Policy 配置：
> "local" → 归入 local 统计
> "proxy"（默认）→ 归入 proxy 统计


**L155**:
```typescript
return "cloud";
```
> S1 或未知 → 默认走 cloud。


### 设计意图

  将路由分类逻辑从 record() 中抽出，保持 record() 的可读性。
  使用 highestLevel 而非 currentTurnLevel 是因为 token 统计
  关注的是"这个会话整体的费用归属"，而非单轮的即时状态。

  ⚠️ 注意：这意味着一个会话一旦被升级到 S3，后续所有请求
  （即使当前轮为 S1）都会被归入 "local"。这在统计口径上可能
  与实际路由行为不完全一致（因为 per-turn 语义下，S1 轮仍然
  走 cloud），详见 Code Review 部分。
## 类：TokenStatsCollector                           (L160-L328)


核心收集器类。持有完整的 TokenStatsData，提供记录、查询、
持久化和自动刷盘能力。全局通过 setGlobalCollector / getGlobalCollector
访问唯一实例。

私有字段：
  data:       TokenStatsData — 完整统计数据
  filePath:   string — 持久化文件路径
  flushTimer: 定时器引用（自动刷盘）
  dirty:      boolean — 脏标记，有新数据时设 true
## 构造函数：constructor(filePath)                   (L166-L169)


### 作用

  初始化 collector 实例，设置文件路径和空数据。

### 参数

  filePath: string — 持久化 JSON 文件的路径

### 返回值

  TokenStatsCollector 实例

### 逐行逻辑


**L167**:
```typescript
this.filePath = filePath;
```
> 保存目标文件路径。


**L168**:
```typescript
this.data = emptyStats();
```
> 用空数据初始化，等待 load() 从磁盘恢复。


### 设计意图

  构造函数不做 I/O，保持同步。load() 是异步的，由调用方显式调用，
  符合"构造时不副作用"的最佳实践。
## 方法：load()                                      (L172-L198)


### 作用

  从磁盘读取持久化的统计数据，与空默认值合并以处理字段缺失。

### 参数

  无

### 返回值

  Promise<void>

### 逐行逻辑


**L173**:
```typescript
try {
```
> 整个读取过程包在 try-catch 中，文件不存在或解析失败时
> 安静地回退到空数据。


**L174**:
```typescript
const raw = await readFile(this.filePath, "utf-8");
```
> 异步读取 JSON 文件全文。


**L175**:
```typescript
const parsed = JSON.parse(raw) as Partial<TokenStatsData>;
```
> 解析 JSON。用 Partial<> 表示任何字段都可能缺失。


**L176-L178**:
```typescript
const rawSessions = ...
```
> 安全提取 sessions 字段。若不是 object 则回退到 {}。
> 防御旧版本数据中 sessions 可能是 null / undefined / array 的情况。


**L179**:
```typescript
const parsedBySource = parsed.bySource as Partial<SourceBuckets> | undefined;
```
> 安全类型断言。bySource 是后期新增字段，旧数据中可能不存在。


**L180-L194**:
```typescript
this.data = { ... }
```
> 使用展开运算符将解析数据合并到空默认值上：
> { ...emptyBucket(), ...parsed.lifetime?.cloud }
> 这样即使旧数据缺少某些字段（如 cacheReadTokens），
> 也能得到 0 而非 undefined。
> hourly: 若不是数组则回退到 []
> sessions: 直接使用 rawSessions（已做安全检查）
> startedAt / lastUpdatedAt: 缺失时用 Date.now()


**L195-L197**:
```typescript
catch { this.data = emptyStats(); }
```
> 任何错误（文件不存在、JSON 损坏、权限问题）→ 静默回退。
> 这是"统计数据非关键"设计理念的体现。


### 设计意图

  防御性合并策略确保数据结构在版本升级时不会 crash。
  新增字段自动获得零值默认，旧字段原样保留。
  catch 不打日志是因为文件不存在是首次启动的正常情况。
## 方法：startAutoFlush()                            (L201-L209)


### 作用

  启动定时自动刷盘（每 5 分钟），确保数据不因进程异常退出而丢失。

### 参数

  无

### 返回值

  void

### 逐行逻辑


**L202**:
```typescript
if (this.flushTimer) return;
```
> 幂等守卫：若已有定时器则不重复创建。


**L203-L205**:
```typescript
this.flushTimer = setInterval(() => { ... }, 300_000);
```
> 每 300,000ms = 5 分钟执行一次。
> 仅在 dirty === true 时才实际写盘，避免无谓 I/O。
> flush() 的错误被 .catch(() => {}) 吞掉，
> 因为 interval 回调中无法 await。


**L206-L208**:
```typescript
if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer)
```
> 在 Node.js 环境下对定时器调用 unref()，使其不阻止进程退出。
> 类型检查是因为 setInterval 在不同运行时（浏览器 vs Node）
> 返回类型不同。


### 设计意图

  5 分钟刷盘频率是在"数据安全性"和"磁盘 I/O 开销"之间的折中。
  unref() 确保统计定时器不会阻止 Node 进程正常退出。
  session_end hook 中还会显式调用 flush()，所以最多丢失 5 分钟数据。
## 方法：stopAutoFlush()                             (L212-L217)


### 作用

  停止定时自动刷盘。

### 参数

  无

### 返回值

  void

### 逐行逻辑


**L213**:
```typescript
if (this.flushTimer) {
```
> 仅在定时器存在时才操作。


**L214**:
```typescript
clearInterval(this.flushTimer);
```
> 清除定时器。


**L215**:
```typescript
this.flushTimer = null;
```
> 置空引用，让 startAutoFlush() 的幂等守卫重新生效。


### 设计意图

  与 startAutoFlush() 配对，用于 collector 生命周期管理。
  当前代码中未见显式调用 stopAutoFlush()，留作未来优雅关闭使用。
## 方法：record(event)                               (L220-L272)


### 作用

  记录一次 LLM 调用的 token 用量事件。将数据累加到
  lifetime、bySource、hourly、session 四个维度。
  这是整个收集器最核心的方法。

### 参数

  event: UsageEvent — 包含 sessionKey、provider、model、source、usage

### 返回值

  void

### 逐行逻辑


**L221**:
```typescript
const category = classifyBySession(event.sessionKey);
```
> 根据会话的 highestLevel 决定路由分类（cloud/local/proxy）。


**L222**:
```typescript
const source: TokenSource = event.source ?? "task";
```
> 来源默认为 "task"（实际请求），router 开销需显式标注。


**L223**:
```typescript
const now = Date.now();
```
> 一次性获取时间戳，保证同一事件在各维度使用一致的时间。


**L225-L227**:
```typescript
const cost = category !== "local" ? calculateCost(...) : 0;
```
> 仅对 cloud 和 proxy 路由计算费用。
> local 路由走本地模型，无 API 费用。


**L229**:
```typescript
addToBucket(this.data.lifetime[category], event.usage, cost);
```
> 累加到 lifetime 维度的对应路由桶。


**L230**:
```typescript
addToBucket(this.data.bySource[source], event.usage, cost);
```
> 累加到 bySource 维度（router vs task）。


**L232**:
```typescript
const hourKey = currentHourKey();
```
> 获取当前小时 key。


**L233**:
```typescript
let hourly = this.data.hourly.find((h) => h.hour === hourKey);
```
> 在 hourly 数组中查找当前小时的桶。
> 使用线性查找 — 数组最多 72 个元素，find 足够快。


**L234-L239**:
```typescript
if (!hourly) { ... }
```
> 当前小时首次出现 → 创建新桶并推入数组。
> 若数组长度超过 MAX_HOURLY_BUCKETS（72），
> 从尾部截取最近的 72 个，淘汰最旧的。


**L241**:
```typescript
if (!hourly.bySource) hourly.bySource = emptySourceBuckets();
```
> 防御性检查：旧的持久化数据可能没有 bySource 字段。
> 运行时按需初始化。


**L242**:
```typescript
addToBucket(hourly[category], event.usage, cost);
```
> 累加到当前小时的路由桶。


**L243**:
```typescript
addToBucket(hourly.bySource[source], event.usage, cost);
```
> 累加到当前小时的来源桶。


**L246**:
```typescript
const sk = event.sessionKey;
```
> 取出 sessionKey 用于会话维度追踪。


**L247**:
```typescript
if (sk) {
```
> 仅在有 sessionKey 时才做会话级统计。


**L248-L261**:
```typescript
let sess = this.data.sessions[sk]; if (!sess) { ... }
```
> 若会话首次出现 → 创建新的 SessionTokenStats。
> 初始化时记录 firstSeenAt，highestLevel 从 session-state 获取。


**L262**:
```typescript
if (!sess.bySource) sess.bySource = emptySourceBuckets();
```
> 同 hourly 的防御性初始化。


**L263**:
```typescript
sess.highestLevel = getSessionHighestLevel(sk);
```
> 每次 record 都刷新 highestLevel。
> 因为在 record() 被调用之前，pipeline 可能已经
> 通过 trackSessionLevel() 提升了等级。


**L264**:
```typescript
sess.lastActiveAt = now;
```
> 更新最后活跃时间。


**L265**:
```typescript
addToBucket(sess[category], event.usage, cost);
```
> 累加到会话的路由桶。


**L266**:
```typescript
addToBucket(sess.bySource[source], event.usage, cost);
```
> 累加到会话的来源桶。


**L267**:
```typescript
this.evictOldSessions();
```
> 触发会话淘汰检查。


**L270**:
```typescript
this.data.lastUpdatedAt = now;
```
> 更新全局最后更新时间。


**L271**:
```typescript
this.dirty = true;
```
> 标记有未持久化的数据，下次 autoFlush 会写盘。


### 设计意图

  四维度并行累加（lifetime / bySource / hourly / session）支撑仪表盘
  的多种视图需求。category 基于 session 级别而非 turn 级别，
  这与"费用归属"的统计视角一致。dirty 标记 + 定时刷盘的懒写入策略
  避免了每次 record 都触发磁盘 I/O。
## 方法：evictOldSessions() (private)                (L274-L282)


### 作用

  当会话数超过 MAX_SESSIONS 时，淘汰最不活跃的会话。

### 参数

  无

### 返回值

  void

### 逐行逻辑


**L275**:
```typescript
const keys = Object.keys(this.data.sessions);
```
> 获取所有会话 key。


**L276**:
```typescript
if (keys.length <= MAX_SESSIONS) return;
```
> 未超限 → 直接返回，O(1)。


**L277-L279**:
```typescript
const sorted = keys.sort((a, b) => ...lastActiveAt...);
```
> 按 lastActiveAt 升序排列（最旧的排前面）。


**L280**:
```typescript
const toRemove = sorted.slice(0, keys.length - MAX_SESSIONS);
```
> 取出需要淘汰的 key 列表（多出 MAX_SESSIONS 的部分）。


**L281**:
```typescript
for (const k of toRemove) delete this.data.sessions[k];
```
> 逐个删除最不活跃的会话。


### 设计意图

  防止长时间运行的网关积累过多会话数据导致内存膨胀。
  淘汰策略为 LRU（按最后活跃时间），与 session_end 清理互补。
  每次 record() 都调用，但 keys.length <= 200 时直接返回，开销极小。
## 方法：getStats()                                  (L285-L287)


### 作用

  返回完整的统计数据快照。

### 参数

  无

### 返回值

  TokenStatsData — 当前完整数据（直接返回引用，非深拷贝）

### 逐行逻辑


**L286**:
```typescript
return this.data;
```
> 直接返回内部数据引用。调用方可读取但不应修改。


### 设计意图

  供需要完整数据的场景使用（如调试）。返回引用而非拷贝
  是性能考量，但调用方必须遵守只读约定。
## 方法：getSummary()                                (L290-L297)


### 作用

  返回精简的摘要数据，供仪表盘 API (/api/summary) 使用。

### 参数

  无

### 返回值

  { lifetime, bySource, lastUpdatedAt, startedAt }

### 逐行逻辑


  L291-L296:
> 仅挑选 lifetime（三路由总量）、bySource（来源总量）、
> 时间戳等关键字段返回。
> 不包含 hourly 和 sessions 以减小响应体积。

### 设计意图

  仪表盘首页只需概览数据，详细的 hourly / sessions 走独立 API。
  stats-dashboard.ts 中的 /api/summary 端点直接调用此方法。
## 方法：getHourly()                                 (L300-L302)


### 作用

  返回按小时的统计时间线。

### 参数

  无

### 返回值

  HourlyBucket[] — 最多 72 个小时桶的数组

### 逐行逻辑


**L301**:
```typescript
return this.data.hourly;
```
> 直接返回 hourly 数组引用。


### 设计意图

  供仪表盘的时间线图表使用（/api/hourly 端点）。
## 方法：getSessionStats()                           (L305-L309)


### 作用

  返回所有会话的统计数据，按最近活跃时间降序排列。

### 参数

  无

### 返回值

  SessionTokenStats[] — 已排序的会话统计数组

### 逐行逻辑


**L306-L308**:
```typescript
return Object.values(this.data.sessions).sort(...)
```
> 将 sessions 字典转为数组，按 lastActiveAt 降序排列。
> 最近活跃的会话排在最前面。


### 设计意图

  供仪表盘的会话列表视图使用（/api/sessions 端点）。
  降序排列让运维人员优先看到最近的活跃会话。
## 方法：reset()                                     (L312-L316)


### 作用

  重置所有统计数据为空并立即刷盘。

### 参数

  无

### 返回值

  Promise<void>

### 逐行逻辑


**L313**:
```typescript
this.data = emptyStats();
```
> 用全空数据覆盖当前数据。


**L314**:
```typescript
this.dirty = true;
```
> 标记为脏。


**L315**:
```typescript
await this.flush();
```
> 立即写盘，确保重置操作是持久的。


### 设计意图

  供仪表盘的"重置统计"按钮使用（/api/reset 端点）。
  同步 flush 确保重置不会因进程重启而"回滚"。
## 方法：flush()                                     (L319-L327)


### 作用

  将当前统计数据序列化为 JSON 写入磁盘。

### 参数

  无

### 返回值

  Promise<void>

### 逐行逻辑


**L320**:
```typescript
try {
```
> 整个写入过程包在 try-catch 中，失败静默（下次重试）。


**L321**:
```typescript
await mkdir(dirname(this.filePath), { recursive: true });
```
> 确保目标目录存在。recursive: true 意味着多级目录不存在时
> 也能创建。每次 flush 都调用 mkdir 是防御性做法。


**L322**:
```typescript
await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
```
> 将完整数据格式化为带缩进的 JSON 写入文件。
> 缩进方便人工调试查看。


**L323**:
```typescript
this.dirty = false;
```
> 写盘成功 → 清除脏标记。


**L324-L326**:
```typescript
catch { }
```
> 写失败时静默。统计数据属于"尽力而为"，
> 不应因磁盘问题导致请求处理中断。


### 设计意图

  "非关键数据 + 静默失败"的设计模式。writeFile 是原子性的
  （Node.js 内部先写临时文件再 rename），不会产生半写的 JSON。
  autoFlush 的 interval 和 session_end 的显式 flush 共同保证
  数据最终会被持久化。
## 模块级变量：globalCollector                       (L332)


全局唯一的 TokenStatsCollector 实例引用。
初始为 null，由插件初始化时调用 setGlobalCollector() 设置。
## 函数：setGlobalCollector(collector)               (L334-L336)


### 作用

  设置全局 collector 单例。

### 参数

  collector: TokenStatsCollector — 要设置的实例

### 返回值

  void

### 逐行逻辑


**L335**:
```typescript
globalCollector = collector;
```
> 直接赋值。无防重设保护。


### 设计意图

  模块级单例模式，避免通过参数层层传递 collector。
  hooks.ts / local-model.ts / token-saver.ts / stats-dashboard.ts
  均通过 getGlobalCollector() 获取同一实例。
## 函数：getGlobalCollector()                        (L338-L340)


### 作用

  获取全局 collector 实例。

### 参数

  无

### 返回值

  TokenStatsCollector | null — 未初始化时返回 null

### 逐行逻辑


**L339**:
```typescript
return globalCollector;
```
> 直接返回模块级变量。


### 设计意图

  调用方统一通过 ?. 或 null 检查来容忍未初始化状态。
  例如 hooks.ts: `const collector = getGlobalCollector(); if (!collector) return;`
  这保证了 token 统计模块的可选性 — 即使 collector 未初始化，
  其他模块也能正常工作。

                  C O D E   R E V I E W

##

### Part A — Code 层面改动建议


#### 🟡 cacheRead / cacheWrite token 定价缺失


 现状（L135-L139）：calculateCost() 仅用 input / output 计算费用。
 问题：Anthropic API 对 cacheRead 收费为 input 价格的 10%，
       cacheWrite 收费为 input 的 125%。在高缓存命中场景下
       （如长对话），忽略 cacheRead 会导致费用低估。
 建议：在 modelPricing 类型中新增 cacheReadPer1M / cacheWritePer1M
       可选字段，calculateCost() 中加入缓存 token 的费用计算。


#### 🟢 hourly 查找可用 Map 优化


 现状（L233）：this.data.hourly.find((h) => h.hour === hourKey)
 问题：线性查找，O(n)。虽然 n ≤ 72 影响极小，但在高频
       record() 调用下每次都遍历不够优雅。
 建议：维护一个 hourlyMap: Map<string, HourlyBucket> 作为辅助
       索引。或者因为 hourly 是按时间追加的，直接检查末尾元素
       即可（当前小时 99% 情况下是最后一个桶）。


#### 🟢 evictOldSessions() 每次 record 都完整排序


 现状（L274-L282）：每次 record() 都调用 evictOldSessions()，
       内部 sort 全量 key 数组。
 问题：当 sessions 接近 200 时，每次 record 都做一次 O(n log n) 排序。
       虽然 n ≤ 200 不大，但可以更高效。
 建议：仅在 keys.length > MAX_SESSIONS 时才排序（当前已有此守卫），
       或者用 min-heap 追踪最旧会话。实际影响极小，仅作风格建议。


#### 🟢 硬编码默认定价 { inputPer1M: 3, outputPer1M: 15 }


 现状（L119, L122, L128, L132）：四处重复出现相同的默认值。
 问题：违反 DRY。若默认值需调整，需要改四处。
 建议：提取为模块级常量 DEFAULT_PRICING = { inputPer1M: 3, outputPer1M: 15 }。


### Part B — 逻辑/设计层面改动建议


#### 🔴 classifyBySession 使用 highestLevel 与 per-turn 路由不一致


 现状（L149）：classifyBySession() 调用 getSessionHighestLevel()，
       返回会话生命周期内的最高敏感等级。
 问题：GuardClaw 自 session-state.ts 引入 per-turn 语义后，
       路由决策基于 currentTurnLevel（每轮 reset），但统计
       归类仍基于 highestLevel。这导致：
       - 场景：会话第 1 轮 S3 → 走 local，统计归 local ✓
         第 2 轮 S1 → 实际走 cloud，统计仍归 local ✗
       - 结果：cloud 路由的费用被错误地归到 local 桶，
         仪表盘的"已节省费用"（cloud - local 差值）被高估。

       hooks.ts 的 llm_output hook（L916-L929）调用 collector.record()
       时并没有传入实际的 route category — 它完全依赖
       classifyBySession() 内部判断。
 建议：在 UsageEvent 中新增可选字段 routeCategory?: RouteCategory，
       由 hooks.ts 根据实际路由决策显式传入。classifyBySession()
       仅作为 fallback 使用。


#### 🔴 local-model.ts 和 token-saver.ts 中 source="router" 的

    记录使用 provider="edge"，但 classifyBySession 完全忽略 provider

 现状：local-model.ts（L302-L306）和 token-saver.ts（L217-L221）
       调用 collector.record() 时传入 provider: "edge"，表示这是
       本地模型调用。但 record() 内部通过 classifyBySession()
       判断路由，完全不看 provider 字段。
 问题：如果 session 的 highestLevel 是 S1（例如 token-saver
       在 S1 会话中运行），本地模型的 router 开销 token 会被
       归入 cloud 桶，并按云端定价计费。这明显不正确 —
       edge/local 调用不应产生费用。
 建议：record() 中检查 provider 字段，当 provider 属于
       localProviders 列表时强制 category = "local" 且 cost = 0。


#### 🟡 flush() 的 JSON.stringify + writeFile 不是真正原子性


 现状（L322）：直接 writeFile 到目标路径。
 问题：Node.js 的 writeFile 并非原子操作（底层是 open + write + close）。
       若进程在写入过程中被 kill，可能留下半写的 JSON 文件，
       下次 load() 会解析失败并丢失所有历史数据。
 建议：先写临时文件（如 `${filePath}.tmp`），再 rename 到目标路径。
       rename 在同一文件系统上是原子操作。


#### 🟡 UsageEvent.usage.cacheWrite 被记录但从未使用


 现状（L71）：UsageEvent 类型定义了 cacheWrite 字段。
 问题：addToBucket()（L104-L114）完全没有读取 cacheWrite，
       TokenBucket 类型中也没有 cacheWriteTokens 字段。
       这个字段只是"路过"但不落地。
 建议：要么在 TokenBucket 中增加 cacheWriteTokens 字段并在
       addToBucket 中累加，要么从 UsageEvent 中移除该字段
       以避免给调用方造成"会被统计"的错误预期。


#### 🟢 getStats() 返回内部引用，无只读保护


 现状（L286）：return this.data; 直接返回内部对象。
 问题：调用方若修改返回值（如 dashboard 渲染时意外 mutate），
       会直接破坏 collector 的内部状态。
 建议：返回 structuredClone(this.data) 或至少在 JSDoc 中
       明确标注"只读"。当前实际调用方（stats-dashboard）仅做
       JSON.stringify，风险低，但 API 设计上不够安全。


### 优先级总览


  🔴 高优先级（应尽快修复）
     #5  classifyBySession 与 per-turn 路由语义不一致
     #6  本地模型 router 开销被错误归入 cloud 桶

  🟡 中优先级（下次迭代）
     #1  cacheRead/cacheWrite 定价缺失
     #7  flush() 非原子写入
     #8  cacheWrite 字段声明但未使用

  🟢 低优先级（锦上添花）
     #2  hourly 查找优化
     #3  evictOldSessions 排序频率
     #4  硬编码默认定价违反 DRY
     #9  getStats() 返回引用无只读保护
