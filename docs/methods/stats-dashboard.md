# stats-dashboard.ts — 逐方法文档


 文件定位：GuardClaw 统计仪表盘的 HTTP 服务端处理器 + 内嵌 SPA 前端
 所属模块：GuardClaw 隐私路由系统

 核心职责：
   1. 提供一组 REST API 端点（/plugins/guardclaw/stats/api/*），用于查询
      Token 统计、会话、检测日志、配置读写、Prompt 管理和分类测试。
   2. 提供一个内嵌的 HTML SPA 仪表盘（GET /plugins/guardclaw/stats/），
      用于可视化展示上述数据并支持在线配置。
   3. 支持配置热更新（hot-reload）：POST /api/config 修改后立即生效，
      同时持久化到 ~/.openclaw/guardclaw.json。
   4. 支持自定义路由的动态注册和 Pipeline 执行顺序调整。

 术语说明：
   S1 = 无敏感内容，直接放行
   S2 = 中度敏感，走代理(proxy)脱敏或本地模型(local)
   S3 = 高度敏感，强制本地模型处理
   Pipeline = 路由管道，按 checkpoint（onUserMessage/onToolCallProposed/onToolCallExecuted）
             分阶段执行多个 Router
## 常量：GUARDCLAW_CONFIG_PATH                 (L30-L34)


GuardClaw 配置文件的持久化路径。

**L30-L34**:
```typescript
join(process.env.HOME ?? "/tmp", ".openclaw", "guardclaw.json")
```
> 拼接路径为 ~/.openclaw/guardclaw.json
> 若 HOME 环境变量不存在（如容器环境），fallback 到 /tmp

## 函数：saveGuardClawConfig(privacy)          (L36-L49)


### 作用

  将 privacy 配置对象合并到磁盘上的 guardclaw.json 文件中，
  实现配置的持久化保存。不修改 openclaw.json，因此不会触发主进程重启。

### 参数

  privacy: Record<string, unknown> — 需要持久化的 privacy 配置子对象

### 返回值

  void — 无返回值；写入失败时静默吞掉异常（best-effort）

### 逐行逻辑


**L37**:
```typescript
try {
```
> 整个函数包裹在 try-catch 中，保证写入失败不会影响运行时


**L38**:
```typescript
const dir = join(process.env.HOME ?? "/tmp", ".openclaw")
```
> 计算配置目录路径


**L39**:
```typescript
mkdirSync(dir, { recursive: true })
```
> 确保 .openclaw 目录存在，recursive 避免已存在时报错


**L40**:
```typescript
let existing: Record<string, unknown> = {}
```
> 初始化一个空对象用于存放已有配置


**L41-L43**:
```typescript
try { existing = JSON.parse(readFileSync(...)) } catch {}
```
> 尝试读取已有配置文件并解析为 JSON
> 若文件不存在则 catch 静默跳过，使用空对象


**L44**:
```typescript
const updated = { ...existing, privacy }
```
> 将新的 privacy 字段合并到已有配置中（浅合并）
> 注意：这里是顶层合并，privacy 内部字段是整体替换而非深合并


**L45**:
```typescript
writeFileSync(GUARDCLAW_CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8")
```
> 将合并后的配置写入磁盘，JSON 格式化缩进 2 空格


**L46-L48**:
```typescript
catch { /* best-effort persistence */ }
```
> 外层 catch 吞掉所有异常，写入失败不影响正常运行


### 设计意图

  分离 guardclaw.json 与主配置 openclaw.json，避免配置修改触发
  主进程重启。best-effort 策略保证配置保存是非阻塞的。
## 类型：DashboardDeps                         (L51-L55)


仪表盘所需的外部依赖注入接口。

字段说明：
  pluginId: string
      插件标识符
  pluginConfig: Record<string, unknown>
      插件完整配置对象，包含 privacy 子配置
  pipeline: RouterPipeline | null
      路由管道实例，用于执行 test-classify 和动态注册路由
## 变量：deps (模块级)                          (L57)


模块级单例变量，保存通过 initDashboard() 注入的依赖。
初始值为 null，在 statsHttpHandler 内通过 !deps 检查
是否已初始化。
## 函数：initDashboard(d)                      (L59-L61)


### 作用

  初始化仪表盘模块，注入运行时依赖（pluginId、pluginConfig、pipeline）。
  必须在 statsHttpHandler 被调用前执行。

### 参数

  d: DashboardDeps — 包含 pluginId、pluginConfig、pipeline 的依赖对象

### 返回值

  void

### 逐行逻辑


**L60**:
```typescript
deps = d;
```
> 将依赖存入模块级变量 deps，后续 statsHttpHandler 中使用


### 设计意图

  采用依赖注入模式，将仪表盘模块与插件生命周期解耦。
  调用方（如插件入口）在初始化阶段注入所需引用。
## 函数：readBody(req)                         (L63-L70)


### 作用

  将 HTTP 请求体（IncomingMessage）的流数据全部读取并拼接为 UTF-8 字符串。

### 参数

  req: IncomingMessage — Node.js 的 HTTP 请求对象

### 返回值

  Promise<string> — 完整的请求体字符串

### 逐行逻辑


**L64**:
```typescript
return new Promise((resolve, reject) => {
```
> 将基于事件的流式读取包装为 Promise


**L65**:
```typescript
const chunks: Buffer[] = []
```
> 用数组收集所有数据块


**L66**:
```typescript
req.on("data", (c: Buffer) => chunks.push(c))
```
> 监听 data 事件，将每个 Buffer 块推入数组


**L67**:
```typescript
req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
```
> 流结束时将所有块拼接为一个 Buffer 并转为 UTF-8 字符串


**L68**:
```typescript
req.on("error", reject)
```
> 流错误时 reject Promise


### 设计意图

  标准的 Node.js 流式读取 body 工具函数。未设置大小限制，
  依赖调用方或上游中间件做 body 大小控制。
## 函数：json(res, data, status?)              (L72-L75)


### 作用

  以 JSON 格式返回 HTTP 响应。

### 参数

  res: ServerResponse — HTTP 响应对象
  data: unknown — 需要序列化的数据
  status: number (默认 200) — HTTP 状态码

### 返回值

  void

### 逐行逻辑


**L73**:
```typescript
res.writeHead(status, { "Content-Type": "application/json" })
```
> 写入响应头，设定 JSON content type


**L74**:
```typescript
res.end(JSON.stringify(data))
```
> 将 data 序列化为 JSON 字符串并结束响应


### 设计意图

  简洁的 JSON 响应工具函数，减少重复代码。
## 函数：html(res, body)                       (L77-L80)


### 作用

  以 HTML 格式返回 HTTP 响应。

### 参数

  res: ServerResponse — HTTP 响应对象
  body: string — HTML 字符串

### 返回值

  void

### 逐行逻辑


**L78**:
```typescript
res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
```
> 设置 Content-Type 为 HTML + UTF-8 编码


**L79**:
```typescript
res.end(body)
```
> 将 HTML 内容写入并结束响应


### 设计意图

  用于返回仪表盘 SPA 页面的 HTML 内容。
## 函数：statsHttpHandler(req, res)            (L82-L314)


### 作用

  GuardClaw 仪表盘的核心 HTTP 路由处理器。根据请求路径和方法
  分发到不同的 API 端点处理逻辑。支持以下端点：
    GET  /                    → 返回 Dashboard SPA HTML
    GET  /api/summary         → Token 统计汇总
    GET  /api/hourly          → 每小时统计时间线
    GET  /api/sessions        → 会话级统计
    POST /api/reset           → 重置统计数据
    GET  /api/detections      → 检测事件日志
    GET  /api/config          → 当前配置
    POST /api/config          → 更新配置（热更新 + 持久化）
    GET  /api/prompts         → 所有可编辑 Prompt
    POST /api/prompts         → 保存 Prompt
    POST /api/test-classify   → 干跑分类测试

### 参数

  req: IncomingMessage — HTTP 请求
  res: ServerResponse — HTTP 响应

### 返回值

  Promise<boolean> — true 表示已处理该请求，false 表示路径不匹配、
  应交给后续处理器

### 逐行逻辑


**L86**:
```typescript
const url = req.url ?? ""
```
> 取请求 URL，空值防御


**L87**:
```typescript
const reqPath = url.split("?")[0]
```
> 截掉查询字符串，只保留路径部分


**L88**:
```typescript
const base = "/plugins/guardclaw/stats"
```
> 基础路径前缀


**L90**:
```typescript
if (!reqPath.startsWith(base)) return false
```
> 不匹配基础前缀则返回 false，表示该请求不由此处理器负责


**L92**:
```typescript
const sub = reqPath.slice(base.length) || "/"
```
> 取基础路径后的子路径，空则默认为 "/"


#### GET / → Dashboard HTML (L94-L97)


**L94-L97**:
```typescript
if (req.method === "GET" && sub === "/")
```
> 返回完整的 Dashboard SPA HTML 页面
> 调用 dashboardHtml() 生成内嵌的 SPA


#### GET /api/summary (L99-L104)


**L100**:
```typescript
const collector = getGlobalCollector()
```
> 获取全局 TokenStatsCollector 单例


**L101**:
```typescript
if (!collector) { json(res, { error: "not initialized" }, 503) }
```
> 未初始化时返回 503


**L102**:
```typescript
json(res, collector.getSummary())
```
> 返回生命周期统计汇总（cloud/local/proxy token 计数、费用等）


#### GET /api/hourly (L106-L111)


**L109**:
```typescript
json(res, collector.getHourly())
```
> 返回按小时聚合的 token 用量时间线数据


#### GET /api/sessions (L113-L118)


**L116**:
```typescript
json(res, collector.getSessionStats())
```
> 返回各会话的 token 统计（cloud/local/proxy 分项、按来源分项等）


#### POST /api/reset (L120-L126)


**L123**:
```typescript
await collector.reset()
```
> 重置所有 token 统计数据


**L124**:
```typescript
json(res, { ok: true })
```
> 返回成功确认


#### GET /api/detections (L128-L151)


**L129**:
```typescript
const states = getAllSessionStates()
```
> 从 session-state 模块获取所有会话状态（Map<string, SessionPrivacyState>）


**L130-L136**:
```typescript
const events: Array<{...}> = []
```
> 定义检测事件数组，包含 sessionKey/level/checkpoint/reason/timestamp


**L137-L147**:
```typescript
states.forEach(...)
```
> 遍历所有会话状态，从每个 state 的 detectionHistory 中
> 提取检测记录并 push 到 events 数组


**L148**:
```typescript
events.sort((a, b) => b.timestamp - a.timestamp)
```
> 按时间戳降序排列（最新在前）


**L149**:
```typescript
json(res, events.slice(0, 500))
```
> 只返回最近 500 条，防止数据量过大


#### GET /api/config (L153-L173)


**L154**:
```typescript
const liveConfig = getLiveConfig()
```
> 从 live-config 模块获取当前运行时配置


**L155**:
```typescript
const cfgAny = liveConfig as Record<string, unknown>
```
> 类型断言以访问非类型化字段（routers、pipeline）


**L156-L171**:
```typescript
json(res, { privacy: { ... } })
```
> 返回完整的 privacy 配置对象，包括 enabled、localModel、
> guardAgent、s2Policy、proxyPort、checkpoints、rules、
> localProviders、modelPricing、session、routers、pipeline


#### POST /api/config (L175-L216)


**L176**:
```typescript
if (!deps) { json(res, { error: "dashboard not initialized" }, 503) }
```
> 依赖未注入时返回 503


**L178**:
```typescript
const body = JSON.parse(await readBody(req))
```
> 读取并解析请求体 JSON


**L180**:
```typescript
if (body.privacy) { ... }
```
> 仅当请求中包含 privacy 字段时执行更新


**L181**:
```typescript
updateLiveConfig(body.privacy)
```
> 更新运行时配置（热生效，不需重启）


**L183-L184**:
```typescript
const existingPrivacy = ...; const mergedPrivacy = { ...existingPrivacy, ...body.privacy }
```
> 从 deps.pluginConfig 读取已有 privacy 配置并与新值浅合并


**L187**:
```typescript
saveGuardClawConfig(mergedPrivacy)
```
> 将合并后配置持久化到 guardclaw.json


**L190-L208**:
```typescript
if (body.privacy.routers && deps.pipeline) { ... }
```
> 动态处理路由器更新：
> L192: 遍历提交的 routers 配置
> L193: 若为 configurable 类型且 pipeline 中不存在，则动态注册
> L194-L198: 调用 createConfigurableRouter(id) 创建并注册到 pipeline
> L202-L205: 调用 pipeline.configure() 重新配置 pipeline 的
> routers 和执行顺序
> L207: 更新 deps.pluginConfig 使后续 test-classify 能读到新配置


**L211**:
```typescript
json(res, { ok: true })
```
> 成功时返回确认


**L212-L213**:
```typescript
catch (err) { json(res, { error: String(err) }, 400) }
```
> JSON 解析错误或其他异常返回 400


#### EDITABLE_PROMPTS 定义 (L220-L224)


**L220-L224**:
```typescript
const EDITABLE_PROMPTS = { ... }
```
> 定义三种可编辑 Prompt：
> - "detection-system": 隐私检测分类提示词（S1/S2/S3）
> - "token-saver-judge": Token 节省路由的任务复杂度判断提示词
> - "pii-extraction": PII（个人信息）提取引擎提示词
> 每种包含 label（显示名）和 defaultContent（默认内容）


#### GET /api/prompts (L226-L239)


**L228-L236**:
```typescript
for (const [name, meta] of Object.entries(EDITABLE_PROMPTS))
```
> 遍历所有可编辑 Prompt
> L229: readPromptFromDisk(name) — 尝试从磁盘读取自定义版本
> L230-L235: 构建结果对象，包含 label、content（磁盘版或默认值）、
> isCustom（是否已自定义）、defaultContent


#### POST /api/prompts (L241-L259)


**L243**:
```typescript
const body = JSON.parse(...) as { name: string; content: string }
```
> 解析请求体，期望包含 name 和 content


**L244**:
```typescript
if (!body.name || typeof body.content !== "string")
```
> 验证必填字段


**L249**:
```typescript
if (!EDITABLE_PROMPTS[body.name] && !body.name.startsWith("custom-"))
```
> 限制只能保存内置 Prompt 或 custom-* 前缀的自定义路由 Prompt


**L253**:
```typescript
writePrompt(body.name, body.content)
```
> 调用 prompt-loader 模块写入 Prompt 到磁盘（立即生效）


#### POST /api/test-classify (L263-L311)


**L264**:
```typescript
if (!deps?.pipeline) { ... 503 }
```
> pipeline 未初始化时返回 503


**L266**:
```typescript
const body = JSON.parse(...) as { message: string; checkpoint?: string; router?: string }
```
> 解析测试请求：message（必填）、checkpoint（可选，默认 onUserMessage）、
> router（可选，指定单个路由测试）


**L267-L270**:
```typescript
if (!body.message?.trim()) → 400
```
> 验证 message 非空


**L271**:
```typescript
const checkpoint = (body.checkpoint ?? "onUserMessage") as ...
```
> 设定 checkpoint，默认 onUserMessage


**L273-L306**:
```typescript
if (body.router) { ... } else { ... }
```
> 分支1 (L274-L291): 指定 router 时，调用 pipeline.runSingle()
> 只运行单个路由进行分类，不存在的 router 返回 404
> 分支2 (L292-L306): 未指定 router 时，调用 pipeline.run()
> 运行完整 pipeline，返回合并后的决策结果
> 两个分支都返回 level/action/target/reason/confidence/routerId


**L307-L310**:
```typescript
catch (err) { json(res, { error: String(err) }, 500) }
```
> 分类执行异常返回 500


**L313**:
```typescript
return false
```
> 所有端点都未匹配时返回 false


### 设计意图

  这是整个仪表盘的"大脑"，采用简单的 if-chain 路由模式
  （而非框架化路由），保持零外部 HTTP 框架依赖。
  返回 boolean 使其可嵌入更大的请求处理链中。
  POST /api/config 的热更新逻辑是最复杂的部分：
  它不仅更新运行时配置，还动态注册新路由并持久化到文件。
## 函数：dashboardHtml()                       (L318-L2416)


### 作用

  返回完整的 Dashboard SPA HTML 字符串，包含：
  - CSS 样式（行内，L327-L517）
  - HTML 结构（L519-L1065）：
      头部状态栏、Tab 导航、Overview/Sessions/Detections/
      Router Rules/Configuration 五个面板
  - JavaScript 逻辑（L1067-L2413）：
      i18n 国际化、数据获取与渲染、配置读写、Prompt 编辑、
      分类测试、自定义路由管理、Pipeline 顺序拖拽等

### 参数

  无

### 返回值

  string — 完整的 HTML 文档字符串

### 设计意图

  将整个前端打包为一个内联 SPA 字符串返回，无需额外静态文件服务。
  唯一的外部依赖是 CDN 上的 Chart.js（L325）用于绘制折线图。
  这种"单文件 SPA"模式使部署极其简单——只需后端服务即可。

  以下分别记录 dashboardHtml 内嵌 JavaScript 中的各函数。

/* ----------------------------------------------------------
 以下函数均定义在 dashboardHtml() 返回的 <script> 块内，
 运行在浏览器端。
---------------------------------------------------------- */
## [前端] i18n 翻译表 T 与全局变量             (L1068-L1274)


**L1068**:
```typescript
var BASE = '/plugins/guardclaw/stats/api'
```
> API 基础路径


**L1069**:
```typescript
var hourlyChart = null
```
> Chart.js 实例缓存，避免重复创建


**L1070-L1071**:
```typescript
var _detections = []; var _detectionFilter = 'all'
```
> 检测事件缓存和当前过滤器状态


**L1074**:
```typescript
var LANG = localStorage.getItem('gc-lang') || 'en'
```
> 从 localStorage 读取用户语言偏好，默认英文


**L1075-L1274**:
```typescript
var T = { ... }
```
> 双语翻译字典（en/zh），约 200 个 key
> 覆盖所有 UI 文案：标签、按钮、提示、错误信息等

## [前端] 函数：t(k)                           (L1275)


### 作用

  国际化翻译函数，根据当前语言返回对应文案。

### 参数

  k: string — 翻译 key

### 返回值

  string — 翻译后的文案，未找到时返回 key 本身

### 逐行逻辑


**L1275**:
```typescript
return (T[k] && T[k][LANG]) || k
```
> 从翻译表 T 中查找 key 对应当前语言的值
> 若不存在则直接返回 key 作为 fallback

## [前端] 函数：setLang(lang)                  (L1277-L1303)


### 作用

  切换界面语言（中/英），更新所有带 data-i18n* 属性的 DOM 元素，
  并刷新所有动态内容。

### 参数

  lang: string — 目标语言 ('en' 或 'zh')

### 返回值

  void

### 逐行逻辑


**L1278**:
```typescript
LANG = lang
```
> 更新全局语言变量


**L1279**:
```typescript
localStorage.setItem('gc-lang', lang)
```
> 持久化语言偏好到 localStorage


**L1280-L1282**:
```typescript
querySelectorAll('[data-i18n]').forEach(...)
```
> 更新所有 textContent 类型的翻译元素


**L1284-L1286**:
```typescript
querySelectorAll('[data-i18n-html]').forEach(...)
```
> 更新所有 innerHTML 类型的翻译元素（支持 HTML 实体）


**L1288-L1290**:
```typescript
querySelectorAll('[data-i18n-ph]').forEach(...)
```
> 更新所有 placeholder 类型的翻译元素


**L1292-L1294**:
```typescript
querySelectorAll('[data-i18n-opt]').forEach(...)
```
> 更新所有 <option> 的翻译元素


**L1296**:
```typescript
document.getElementById('lang-toggle').textContent = lang === 'en' ? '中文' : 'EN'
```
> 切换语言按钮显示（当前英文则显示"中文"，反之显示"EN"）


**L1297**:
```typescript
querySelectorAll('.add-row .btn-outline').forEach(...)
```
> 统一更新所有 "Add" 按钮文案


**L1298**:
```typescript
hourlyChart = null
```
> 清除图表实例，使下次刷新时重建（因图例文案需更新）


**L1299-L1302**:
```typescript
refreshAll(); renderCustomRouterCards(); updateAvailableRouters(); loadPrompts()
```
> 切换语言后重新渲染所有动态内容


### 设计意图

  完全前端驱动的 i18n 实现，不需服务端参与。
  通过 data-i18n* 属性标记 DOM 元素实现批量翻译。
## [前端] 标签管理系统                         (L1304-L1347)


_tags 变量 (L1305-L1310)：
  全局标签状态对象，key 为标签组名称，value 为字符串数组。
  涵盖 keyword(kw)、pattern(pat)、tool、toolpath、
  localProviders(lp)、pipeline 执行顺序(pipe-*)。

_checkpoints 变量 (L1312)：
  各 checkpoint 阶段的检测器选择状态。

_routers 变量 (L1313)：
  所有路由器配置的运行时状态。
## [前端] 函数：escHtml(s)                     (L1315-L1317)


### 作用

  HTML 实体转义，防止 XSS 攻击。

### 参数

  s: any — 需要转义的值

### 返回值

  string — 转义后的安全字符串

### 逐行逻辑


**L1316**:
```typescript
return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
```

         .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
> 依次转义 &、<、>、" 四种特殊字符
> 注意：未转义单引号 '，在某些上下文中可能不安全

### 设计意图

  用于所有动态拼接 HTML 的场景，防止用户输入的关键词/模式
  被当作 HTML 执行。
## [前端] 函数：renderTags(key)                (L1319-L1326)


### 作用

  渲染指定标签组的所有标签到对应的 DOM 容器中。

### 参数

  key: string — 标签组名称（如 'kw-s2', 'pat-s3'）

### 返回值

  void

### 逐行逻辑


**L1320**:
```typescript
var c = document.getElementById('cfg-tags-' + key)
```
> 通过约定的 ID 前缀查找容器元素


**L1321**:
```typescript
if (!c) return
```
> 容器不存在则跳过


**L1322-L1325**:
```typescript
c.innerHTML = _tags[key].map(...)
```
> 将标签数组映射为 HTML 字符串：
> 每个标签是 <span class="tag"> + 文本 + 删除按钮 ×
> 删除按钮通过 data-key 和 data-idx 记录位置信息


### 设计意图

  通用标签渲染函数，被 keywords、patterns、tools、paths、
  localProviders 等所有标签列表共用。
## [前端] 函数：addTag(key)                    (L1328-L1338)


### 作用

  从输入框读取值并添加到对应标签组，去重处理。

### 参数

  key: string — 标签组名称

### 返回值

  void

### 逐行逻辑


**L1329**:
```typescript
var input = document.getElementById('cfg-tags-' + key + '-input')
```
> 约定的输入框 ID 格式


**L1331**:
```typescript
var val = input.value.trim()
```
> 去除首尾空白


**L1332**:
```typescript
if (val && _tags[key].indexOf(val) === -1) { _tags[key].push(val) }
```
> 非空且不重复时才添加


**L1334**:
```typescript
renderTags(key)
```
> 重新渲染标签列表


**L1336-L1337**:
```typescript
input.value = ''; input.focus()
```
> 清空输入框并保持焦点，方便连续添加

## [前端] 函数：removeTag(el)                  (L1340-L1347)


### 作用

  从标签组中移除指定索引的标签。

### 参数

  el: HTMLElement — 触发点击的删除按钮元素（带 data-key 和 data-idx）

### 逐行逻辑


**L1341-L1342**:
```typescript
从 data attribute 中读取 key 和 idx
```

**L1344**:
```typescript
_tags[key].splice(idx, 1)
```
> 从数组中移除该标签

**L1345**:
```typescript
renderTags(key)
```
> 重新渲染

## [前端] 函数：toggleChip(el)                 (L1350-L1358)


### 作用

  切换 checkpoint 检测器芯片的激活状态。
  控制各 checkpoint 阶段启用哪些检测器（ruleDetector / localModelDetector）。

### 参数

  el: HTMLElement — 被点击的 chip 按钮（带 data-ck 和 data-det 属性）

### 逐行逻辑


**L1351-L1352**:
```typescript
读取 ck (checkpoint 简称) 和 det (检测器名)
```

**L1353**:
```typescript
if (!ck || !det || !_checkpoints[ck]) return
```
> 防御性检查

**L1355**:
```typescript
var idx = arr.indexOf(det)
```

**L1356**:
```typescript
if (idx === -1) { arr.push(det); el.classList.add('active') }
```
> 不存在则添加并高亮

**L1357**:
```typescript
else { arr.splice(idx, 1); el.classList.remove('active') }
```
> 已存在则移除并取消高亮


### 设计意图

  实现 toggle 行为：点击同一 chip 在 on/off 之间切换。
## [前端] 函数：syncChips()                    (L1360-L1370)


### 作用

  根据 _checkpoints 状态同步所有 chip 的 CSS active 类。
  通常在 loadConfig 后调用，将服务端配置反映到 UI。

### 逐行逻辑


**L1361-L1369**:
```typescript
querySelectorAll('.chip[data-ck]').forEach(...)
```
> 遍历所有 chip 元素，根据 _checkpoints 中是否包含
> 对应的 detector 来添加/移除 active 类

## [前端] 路由器管理函数组                     (L1372-L1420)


renderRouters() (L1373-L1394)：
  渲染路由器列表卡片，包含 toggle 开关、名称、类型标签和删除按钮。
  无路由时显示占位文案。

toggleRouter(el) (L1396-L1399)：
  切换路由器的 enabled 状态。

removeRouter(el) (L1401-L1404)：
  从 _routers 中删除指定路由并重新渲染。

addRouter() (L1406-L1420)：
  从输入框读取 id/type/module 并创建新路由器。
## [前端] 模型定价管理函数组                   (L1422-L1490)


_pricing 变量 (L1423)：
  运行时模型定价数据，key 为模型名，值包含 inputPer1M/outputPer1M。

DEFAULT_PRICING (L1425-L1434)：
  内置默认定价，覆盖 claude-sonnet-4.6、gpt-4o、gpt-4o-mini、
  o4-mini、gemini-2.0-flash、deepseek-chat 等主流模型。

renderPricing() (L1436-L1454)：
  将 _pricing 渲染为表格行，每行包含模型名、输入价格、
  输出价格的可编辑 input 和删除按钮。

updatePricing(el) (L1456-L1461)：
  input onchange 回调，更新对应模型的价格字段。

addPricingRow() (L1463-L1478)：
  从三个输入框（model/input/output）读取并添加新定价行。

removePricing(model) (L1480-L1483)：
  删除指定模型的定价。

loadDefaultPricing() (L1485-L1490)：
  加载内置默认定价，仅填充尚未存在的模型。
## [前端] Tab 切换                             (L1492-L1500)


**L1493-L1500**:
```typescript
querySelectorAll('.tab').forEach(...)
```
> 为每个 tab 绑定 click 事件：
> 移除所有 tab 和 panel 的 active 类，
> 然后为当前 tab 和对应 panel 添加 active 类

## [前端] 格式化工具函数                       (L1502-L1535)


fmt(n) (L1503-L1507)：
  数字格式化为 K/M 单位。>= 1M 显示如 "1.2M"，>= 1K 显示如 "3.5K"

timeAgo(ts) (L1509-L1515)：
  时间戳转为相对时间文案（"5s ago", "3m ago", "2h ago", "1d ago"）

fmtTime(ts) (L1517-L1523)：
  时间戳转为 HH:MM:SS 格式

fmtCost(n) (L1525-L1529)：
  费用格式化。0 显示 "$0.00"，< 0.01 显示 "<$0.01"，
  其余显示 "$X.XX"

fillRow(cat, b) (L1531-L1535)：
  生成 token 统计表格的一行 HTML <tr>，包含分类名、
  输入/输出/缓存/总计 token 数、请求数和费用
## [前端] 函数：refreshStats()                 (L1538-L1591)


### 作用

  并行请求 /api/summary 和 /api/hourly，更新 Overview 面板的
  所有卡片数值、统计表格、信息栏和折线图。

### 参数

  无

### 返回值

  Promise<void>

### 逐行逻辑


**L1540-L1543**:
```typescript
Promise.all([fetch summary, fetch hourly])
```
> 并行请求两个 API 以减少延迟


**L1546**:
```typescript
if (summary.error) throw new Error(summary.error)
```
> API 返回错误时抛出


**L1548-L1554**:
```typescript
更新 5 张卡片
```
> 分别填充 cloud/local/proxy tokens、请求数


**L1556-L1562**:
```typescript
计算数据保护率
```
> prot = local + proxy; rate = prot / total * 100


**L1564-L1566**:
```typescript
计算云端费用
```
> cloudCost = cloud.estimatedCost + proxy.estimatedCost
> 注意：proxy 也计入云端费用，因为脱敏后仍发给云端


**L1568-L1575**:
```typescript
填充 detail 表格和 by-source 表格
```
> 两张表格分别按类别和来源展示 token 统计


**L1577-L1580**:
```typescript
填充 info-bar
```
> 显示系统运行时间和最近活跃时间


**L1582-L1584**:
```typescript
更新状态指示灯为绿色（在线）
```


**L1586**:
```typescript
updateChart(hourly)
```
> 更新/创建折线图


**L1587-L1590**:
```typescript
catch 错误时将状态指示灯设为红色
```


### 设计意图

  Dashboard 首屏核心数据加载函数。通过 Promise.all 并行请求
  优化首屏渲染速度。
## [前端] 函数：resetStats()                   (L1593-L1605)


### 作用

  重置所有 token 统计数据。弹出确认对话框后执行 POST /api/reset。

### 逐行逻辑


**L1594**:
```typescript
if (!confirm(...)) return
```
> 用户取消则不执行


**L1596**:
```typescript
await fetch(BASE + '/reset', { method: 'POST' })
```
> 发送重置请求


**L1599**:
```typescript
showToast(t('overview.reset_ok'))
```
> 成功提示


**L1600-L1601**:
```typescript
refreshStats(); refreshSessions()
```
> 重置后刷新数据

## [前端] 函数：updateChart(hourly)            (L1607-L1641)


### 作用

  根据每小时数据更新或创建 Chart.js 折线图。

### 参数

  hourly: Array — 每小时 token 统计数组

### 逐行逻辑


**L1608-L1611**:
```typescript
将 hourly 数据映射为 labels / cloudData / localData / proxyData
```


**L1612-L1617**:
```typescript
if (hourlyChart) → 已有图表则更新数据并 update('none')
```
> 'none' 参数跳过动画以提高性能


**L1618-L1641**:
```typescript
else → 创建新的 Chart.js 实例
```
> 三条折线：Cloud(蓝)、Local(绿)、Redacted(橙)
> 启用 fill 填充、tension 曲线平滑、自定义颜色和字体


### 设计意图

  采用"复用实例 + 数据更新"模式而非每次销毁重建，提高渲染效率。
## [前端] 会话相关函数                         (L1643-L1680)


totalForSession(s) (L1644-L1646)：
  计算单个会话的总 token 数 (cloud + local + proxy)

totalReqsForSession(s) (L1647-L1649)：
  计算单个会话的总请求数

refreshSessions() (L1651-L1680)：
  请求 /api/sessions 并渲染会话列表表格。
  每行显示 session key（截断）、最高级别、各类 token 数、
  按来源分项（router/task）、费用、请求数和最近活跃时间。
## [前端] 检测日志相关函数                     (L1682-L1717)


refreshDetections() (L1683-L1688)：
  请求 /api/detections 并缓存到 _detections 变量，然后渲染。

filterDetections(level, el) (L1690-L1695)：
  切换检测日志过滤器（All/S1/S2/S3），更新按钮高亮状态并重新渲染。

renderDetections() (L1697-L1717)：
  根据当前过滤器渲染检测事件表格。
  最多显示 100 条，每行含时间、session key、级别标签、
  checkpoint 标签和原因。空数据时显示占位文案。
## [前端] 函数：loadConfig()                   (L1725-L1809)


### 作用

  从 /api/config 加载当前配置并填充所有表单字段和状态变量。
  是 Configuration 面板的初始化函数。

### 参数

  无

### 返回值

  Promise<void>

### 逐行逻辑


**L1727**:
```typescript
var cfg = await fetch(BASE + '/config').then(...)
```
> 请求当前配置


**L1728-L1735**:
```typescript
解构 privacy 下各子对象
```
> lm=localModel, ga=guardAgent, rules, sess=session,
> ck=checkpoints, routers, pipeline


**L1737-L1751**:
```typescript
填充基础配置表单字段
```
> enabled、localModel（type/provider/endpoint/model/apiKey/module）、
> guardAgent（id/workspace/model）


**L1750-L1754**:
```typescript
填充路由策略和会话配置字段
```


**L1757-L1760**:
```typescript
填充脱敏规则 checkbox
```
> 遍历 8 种 PII 规则类型，设置 checked 状态


**L1762-L1764**:
```typescript
同步 _checkpoints 状态
```
> 从配置中读取各 checkpoint 启用的检测器列表


**L1765**:
```typescript
syncChips()
```
> 将状态反映到 UI chip 组件


**L1767-L1775**:
```typescript
同步标签数据
```
> 将 rules 中的 keywords/patterns/tools/paths 数据
> 加载到对应的 _tags 数组


**L1778-L1784**:
```typescript
加载模型定价数据
```


**L1786-L1788**:
```typescript
加载 pipeline 执行顺序
```


**L1790-L1793**:
```typescript
加载路由器配置到 _routers
```


**L1796-L1798**:
```typescript
同步 privacy router 的 enabled toggle
```


**L1800-L1803**:
```typescript
渲染所有标签列表（排除 pipe-* 系列）
```


**L1804**:
```typescript
toggleModuleField()
```
> 根据 API Protocol 是否为 custom 显示/隐藏自定义模块字段


**L1805**:
```typescript
loadTokenSaverConfig()
```
> 加载 token-saver 路由的特有配置
> ⚠️ 注意：此函数在文件中未找到定义！（见 Code Review）


**L1806-L1807**:
```typescript
renderCustomRouterCards(); updateAvailableRouters()
```
> 渲染自定义路由卡片和 pipeline 选择器


### 设计意图

  集中式配置加载函数，确保页面初始化时所有表单字段与服务端一致。
## [前端] 函数：saveConfig()                   (L1813-L1867)


### 作用

  收集 Configuration 面板中的所有表单数据，POST 到 /api/config 保存。

### 参数

  无

### 返回值

  Promise<void>

### 逐行逻辑


**L1815-L1852**:
```typescript
构建 payload 对象
```
> 从各 DOM 元素读取值，组装成与 PrivacyConfig 一致的结构
> 包含 localModel、guardAgent、s2Policy、proxyPort、
> localProviders、modelPricing、session、redaction
> 注意：空值用 undefined 处理，避免覆盖服务端默认值


**L1853-L1857**:
```typescript
fetch POST 发送 payload
```


**L1859-L1863**:
```typescript
根据结果显示成功/失败 toast
```


### 设计意图

  仅保存 Configuration 面板的内容。Privacy Router 和 Token-Saver
  各有独立的保存函数，职责分离。
## [前端] 函数：showToast(msg, isError?)       (L1869-L1875)


### 作用

  在页面右下角显示一个 3 秒后自动消失的 toast 提示。

### 逐行逻辑


**L1870-L1873**:
```typescript
设置文案、CSS 类（error 时背景为红色）、显示 toast
```

**L1874**:
```typescript
setTimeout → 3 秒后隐藏
```

## [前端] 函数：refreshAll()                   (L1877-L1881)


### 作用

  同时刷新 Overview、Sessions、Detections 三个面板的数据。
  在页面初始化和自动刷新定时器中调用。

### 逐行逻辑


**L1878-L1880**:
```typescript
refreshStats(); refreshSessions(); refreshDetections()
```
> 并行发起三个独立的数据刷新

## [前端] Prompt 编辑器函数组                  (L1883-L1921)


_prompts 变量 (L1885)：
  缓存从服务端获取的所有 prompt 数据。

loadPrompts() (L1887-L1894)：
  请求 /api/prompts 并缓存结果，然后调用 renderRouterPrompts
  分别渲染到 Privacy Router 和 Token-Saver 的 prompt 编辑区域。

savePrompt(name) (L1896-L1915)：
  将指定 prompt 的编辑器内容 POST 到 /api/prompts 保存。
  成功后显示 toast 并重新加载 prompts。

resetPrompt(name) (L1917-L1921)：
  将 prompt 编辑器内容恢复为默认值（仅 UI 恢复，未自动保存）。
## [前端] 函数：runTestClassify()              (L1925-L1977)


### 作用

  执行完整 pipeline 分类测试。读取测试消息和 checkpoint 选择，
  POST 到 /api/test-classify，显示返回的分类结果。

### 参数

  无（从 DOM 读取输入）

### 返回值

  Promise<void>

### 逐行逻辑


**L1926-L1927**:
```typescript
读取测试消息，空值时 toast 提示
```


**L1928**:
```typescript
var checkpoint = getElementById('test-checkpoint').value
```
> 读取 checkpoint 选择


**L1931-L1932**:
```typescript
隐藏结果区域，显示 loading 状态
```


**L1934-L1938**:
```typescript
POST { message, checkpoint } 到 test-classify
```


**L1941-L1943**:
```typescript
处理错误响应
```


**L1945-L1950**:
```typescript
填充主要结果字段
```
> level（带颜色标签）、action、target（provider/model 格式）、
> routerId、reason、confidence（百分比格式）


**L1951-L1971**:
```typescript
处理各路由独立结果
```
> 若 data.routers 存在，渲染每个路由的独立分类结果卡片
> 每张卡片显示 routerId、level 标签、action → target、reason


**L1972**:
```typescript
resultEl.classList.add('visible')
```
> 显示结果区域


### 设计意图

  让用户在不实际路由请求的情况下测试分类效果。
  支持查看各路由独立结果便于调试。
## [前端] UI 折叠函数                          (L1979-L1991)


toggleSection(el) (L1981-L1985)：
  切换路由卡片的展开/折叠状态。
  同时切换 header 和 body 的 collapsed 类。

toggleAdv(el) (L1987-L1991)：
  切换"高级配置"区域的展开/折叠状态。
  使用 open 类控制显隐。
[前端] 函数：renderRouterPrompts(containerId, promptNames)
                                             (L1999-L2019)

### 作用

  在指定容器中渲染 prompt 编辑器。每个 prompt 包含标题、
  自定义标记、重置按钮、保存按钮和 textarea 编辑器。

### 参数

  containerId: string — 容器元素 ID
  promptNames: string[] — 要渲染的 prompt 名称列表

### 逐行逻辑


**L2003-L2017**:
```typescript
遍历 promptNames，为每个构建 HTML
```
> L2006: 已自定义的 prompt 显示 "customized" 徽标
> L2011: 重置按钮调用 resetPrompt()
> L2012: 保存按钮调用 savePrompt()
> L2015: textarea 预填充当前内容


**L2018**:
```typescript
innerHTML 设置或显示 loading 占位
```

## [前端] 函数：runRouterTest(routerId)        (L2023-L2053)


### 作用

  针对单个路由运行分类测试。与 runTestClassify 类似，但
  POST body 中包含 router 字段以指定单一路由。

### 参数

  routerId: string — 路由 ID（如 'privacy', 'token-saver', 或自定义 ID）

### 逐行逻辑


**L2024-L2026**:
```typescript
从对应路由的测试输入框读取消息
```

**L2032-L2035**:
```typescript
POST { message, router: routerId }
```

**L2043-L2047**:
```typescript
填充路由专属结果面板的各字段
```

**L2048**:
```typescript
显示结果面板
```


### 设计意图

  允许用户单独测试某个路由而非整条 pipeline，
  便于调试特定路由的行为。
## [前端] 函数：savePrivacyRouter()            (L2057-L2090)


### 作用

  保存 Privacy Router 的配置（checkpoints、keywords、patterns、
  tools、paths），POST 到 /api/config。

### 逐行逻辑


**L2059-L2075**:
```typescript
构建 payload
```
> 从 _checkpoints 和 _tags 中收集：
> - checkpoints.onUserMessage / onToolCallProposed / onToolCallExecuted
> - rules.keywords.S2 / S3
> - rules.patterns.S2 / S3
> - rules.tools.S2.tools / S2.paths / S3.tools / S3.paths


**L2076-L2089**:
```typescript
POST 并显示 toast
```


### 设计意图

  Privacy Router 的配置独立于全局配置保存，
  避免意外覆盖 localModel、guardAgent 等字段。
## [前端] 函数：savePipelineOrder()            (L2094-L2119)


### 作用

  保存 Pipeline 执行顺序配置，POST 到 /api/config。

### 逐行逻辑


**L2096-L2104**:
```typescript
构建 payload
```
> privacy.pipeline 下三个 checkpoint 的路由 ID 数组
> 从 _tags['pipe-um'], _tags['pipe-tcp'], _tags['pipe-tce'] 读取


**L2105-L2118**:
```typescript
POST 并显示 toast
```

## [前端] 自定义路由管理函数组                 (L2121-L2405)


BUILTIN_ROUTERS = ['privacy', 'token-saver'] (L2123)：
  内置路由 ID，自定义路由管理时排除这些。

_customRouterData (L2124)：
  自定义路由数据缓存。

getCustomRouterIds() (L2126-L2129)：
  从 _routers 中筛选非内置且类型为 configurable 的路由 ID。

renderCustomRouterCards() (L2132-L2231)：
  为每个自定义路由渲染完整的配置卡片，包含：
  - 启用开关
  - S2/S3 关键词和正则模式标签列表
  - 分类 Prompt 编辑器
  - 测试面板
  - 删除和保存按钮
  渲染完 DOM 后立即调用 renderTags 填充标签。

getAllRouterIds() (L2233-L2240)：
  获取所有路由 ID（内置 + 自定义），确保内置路由始终在前。

renderPipePicker(pipeKey) (L2242-L2253)：
  渲染 Pipeline 阶段的路由选择按钮。已在该阶段的路由
  显示为 in-use 样式且不可再次添加。

renderPipeTags(pipeKey) (L2255-L2266)：
  渲染 Pipeline 阶段中已选路由的标签列表（带序号和拖拽支持）。
  渲染后调用 initPipeDrag 初始化拖拽。

togglePipeRouter(pipeKey, routerId) (L2268-L2274)：
  将路由添加到指定 Pipeline 阶段（不重复添加）。

removePipeTag(el) (L2276-L2283)：
  从 Pipeline 阶段移除指定路由。

initPipeDrag(pipeKey) (L2285-L2313)：
  为 Pipeline 标签初始化 HTML5 drag-and-drop 排序。
  支持 dragstart/dragend/dragover/drop 事件。
  drop 时将拖拽项从原位置移除并插入到目标位置。

updateAvailableRouters() (L2315-L2319)：
  刷新所有三个 Pipeline 阶段的标签和选择器。

addCustomRouter() (L2321-L2335)：
  创建新的自定义路由。
**L2323**:
```typescript
将 ID 标准化为小写字母、数字、下划线和连字符
```

**L2325**:
```typescript
检查 ID 是否重复
```

**L2326-L2329**:
```typescript
创建默认配置 (type='configurable', 空 keywords/patterns)
```

**L2332-L2334**:
```typescript
重新渲染并 toast 提示
```


removeCustomRouter(id) (L2337-L2363)：
  删除自定义路由。弹出确认框后：
  - 从 _routers 和 _tags 中清除相关数据
  - POST 当前 _routers 到 /api/config 持久化删除
  - 成功后重新渲染

saveCustomRouter(id) (L2365-L2405)：
  保存单个自定义路由的完整配置（enabled、keywords、patterns、prompt）。
  构建包含所有路由配置的 payload 后 POST 到 /api/config。
## [前端] 初始化逻辑                           (L2407-L2412)


**L2408**:
```typescript
refreshAll()
```
> 页面加载时立即刷新所有数据面板


**L2409**:
```typescript
loadConfig()
```
> 加载并填充配置表单


**L2410**:
```typescript
loadPrompts()
```
> 加载 prompt 数据


**L2411**:
```typescript
setInterval(refreshAll, 30000)
```
> 每 30 秒自动刷新数据


**L2412**:
```typescript
if (LANG !== 'en') setLang(LANG)
```
> 若用户语言非英文，立即切换（触发翻译和重新渲染）


## Part A — Code 层面改动建议

#### 🔴 loadTokenSaverConfig / saveTokenSaverConfig 未定义


 现状（L1805, L912）：
   loadConfig() 在 L1805 调用 loadTokenSaverConfig()；
   HTML 中 Token-Saver 保存按钮 onclick 调用 saveTokenSaverConfig()。
   但这两个函数在整个文件中均未找到定义。

 问题：
   浏览器控制台会抛出 ReferenceError，Token-Saver 路由
   的配置加载/保存功能完全失效。loadConfig() 中 try-catch
   可能吞掉了 loadTokenSaverConfig() 的错误使其不明显。

 建议：
   补充 loadTokenSaverConfig() 和 saveTokenSaverConfig() 的实现，
   或从尚未合并的分支中恢复。应读取 token-saver router 的
   tier mapping、cache TTL 等配置并填充对应 DOM 字段。
#### 🔴 escHtml 未转义单引号


 现状（L1315-L1317）：
   escHtml 只转义 &、<、>、"。

 问题：
   大量 onclick 处理器使用转义后的单引号 \\' 拼接字符串
   （如 onclick="addTag('kw-s2')"）。若标签值中包含单引号，
   可能导致 HTML attribute 注入。例如用户添加关键词 "it's"
   会破坏 HTML 结构。

 建议：
   在 escHtml 中增加 .replace(/'/g, '&#39;') 转义单引号，
   或将事件绑定改为 addEventListener 方式避免 inline handler。
#### 🟡 readBody 未设置大小限制


 现状（L63-L70）：
   readBody 不限制 body 大小，将所有数据块拼接到内存。

 问题：
   恶意请求可发送巨量 body 导致内存耗尽（DoS）。
   虽然是内部工具不面向公网，但作为最佳实践应加以防护。

 建议：
   增加 MAX_BODY_SIZE（如 1MB），当累计长度超限时
   reject 并返回 413 Payload Too Large。
#### 🟡 saveGuardClawConfig 只做浅合并


 现状（L44）：
   const updated = { ...existing, privacy } — 整体替换 privacy 字段。

 问题：
   若 existing.privacy 中有其他字段（如 pipeline），而此次只
   更新 rules，则 pipeline 会丢失。POST /api/config 的处理
   (L184) 也只做了 { ...existingPrivacy, ...body.privacy }
   的浅合并，嵌套字段同理丢失。

 建议：
   使用深合并（deepMerge）或在持久化前确保 mergedPrivacy
   包含完整子字段。
#### 🟡 dashboardHtml 函数体过大


 现状（L318-L2416）：
   单个函数返回约 2100 行的 HTML + CSS + JS 字符串。

 问题：
   难以维护、搜索和测试。任何 CSS/JS 修改都需要在
   TypeScript 模板字符串中操作，无法享受 IDE 的前端支持。

 建议：
   将 HTML/CSS/JS 拆分为独立文件，构建时内联或运行时
   通过 readFileSync 加载。至少将 <script> 内容提取为
   独立 .js 文件。
#### 🟢 重复的 mergedPrivacy 计算


 现状（L184 和 L201）：
   POST /api/config 中 mergedPrivacy 被计算了两次
   （第一次 L184，第二次 L201），且第二次用 L201 的
   重新声明（const）覆盖了 L184 的同名变量。

 问题：
   代码冗余且容易混淆。两次合并使用相同逻辑但在不同作用域。

 建议：
   将 mergedPrivacy 的计算提到 if (body.privacy) 块顶部，
   只计算一次，后续复用。
#### 🟢 检测事件未分页


 现状（L149）：
   GET /api/detections 返回最近 500 条，前端 renderDetections
   (L1707) 再截取前 100 条显示。

 问题：
   服务端始终返回 500 条但前端只显示 100 条，浪费带宽。
   且无分页机制，随着使用量增长性能会下降。

 建议：
   支持 ?limit= 和 ?offset= 查询参数实现服务端分页。
## Part B — 逻辑/设计层面改动建议

#### 🔴 POST /api/config 中动态路由注册逻辑不完整


 现状（L190-L199）：
   仅在 router 不存在时注册新的 configurable router
   （hasRouter 检查），但不处理已存在路由的更新或删除。

 问题：
   1. 删除自定义路由后，前端 removeCustomRouter 会 POST
      更新后的 _routers，但服务端只检查"是否需要新增"，
      不会从 pipeline 中取消注册已删除的路由。
   2. 修改已有路由的 options 后，pipeline 中的路由实例
      不会更新（因 hasRouter 返回 true 直接跳过）。

 建议：
   在 POST /api/config 中：
   - 对比新旧 routers 配置，移除已删除的路由
   - 对已存在路由更新其 options（configurable router 应
     支持运行时 reconfigure）
#### 🟡 缺少 privacy router enabled 状态的保存


 现状：
   Privacy Router 卡片有 enabled toggle (L679, cfg-privacy-enabled)，
   但 savePrivacyRouter() (L2057-L2090) 的 payload 中未包含
   这个 enabled 状态。

 问题：
   用户在 UI 上禁用 Privacy Router 后点击"保存隐私路由"
   并不会真正保存 enabled=false。

 建议：
   在 savePrivacyRouter() 的 payload 中加入：
   routers: { privacy: { enabled: cfg-privacy-enabled.checked, ... } }
#### 🟡 测试分类 sessionKey 硬编码为 "__test__"


 现状（L276, L295）：
   test-classify API 使用硬编码的 sessionKey: "__test__"。

 问题：
   如果路由器逻辑依赖会话历史（如会话级别提升后的缓存），
   测试结果可能被之前的测试请求的会话状态污染。
   多次测试会在 "__test__" session 中累积检测历史。

 建议：
   每次测试使用临时 sessionKey（如 __test__${Date.now()}），
   或在测试后清理 __test__ session 的状态。
#### 🟡 前端定价默认值与服务端可能不同步


 现状（L1425-L1434）：
   DEFAULT_PRICING 在前端 JS 中硬编码。

 问题：
   若服务端的模型定价更新，前端的默认值不会自动同步。
   "Load Defaults" 按钮加载的是前端硬编码值而非服务端默认值。

 建议：
   增加一个 GET /api/default-pricing 端点返回服务端默认定价，
   或在 /api/config 响应中包含 defaultPricing 字段。
#### 🟢 setInterval 无条件每 30 秒刷新


 现状（L2411）：
   setInterval(refreshAll, 30000) — 即使页面处于后台或
   非活跃 tab 也持续轮询。

 问题：
   浪费服务端资源和网络带宽。

 建议：
   使用 document.visibilitychange 事件，在页面不可见时
   暂停轮询、可见时恢复。
## 优先级总览


 🔴 高优先级（应尽快修复）
- #1  loadTokenSaverConfig / saveTokenSaverConfig 未定义 → Token-Saver 配置功能失效
- #2  escHtml 未转义单引号 → 潜在 XSS / HTML 注入风险
- #8  动态路由注册逻辑不完整 → 路由删除/更新不生效

 🟡 中优先级（下一迭代）
- #3  readBody 无大小限制 → DoS 风险
- #4  浅合并导致配置字段丢失
- #5  dashboardHtml 函数体过大（2100 行）
- #9  Privacy Router enabled 状态未保存
- #10 测试 sessionKey 硬编码导致状态污染
- #11 前端/服务端定价默认值不同步

 🟢 低优先级（优化建议）
- #6  mergedPrivacy 重复计算
- #7  检测事件未分页
- #12 后台 tab 仍轮询
