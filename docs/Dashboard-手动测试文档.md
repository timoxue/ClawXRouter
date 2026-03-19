# GuardClaw Dashboard 手动测试文档

> 版本：2026.3.12  
> 适用范围：`/plugins/guardclaw/stats/` Dashboard 全部 5 个 Tab  
> 测试类型：手动功能测试 + 端到端行为验证

---

## 目录

- [前置条件](#前置条件)
- [Tab 1: Overview（概览）](#tab-1-overview概览)
- [Tab 2: Sessions（会话）](#tab-2-sessions会话)
- [Tab 3: Detection Log（检测日志）](#tab-3-detection-log检测日志)
- [Tab 4: Router Rules（路由规则）](#tab-4-router-rules路由规则)
- [Tab 5: Configuration（配置）](#tab-5-configuration配置)
- [端到端行为验证场景](#端到端行为验证场景)
- [Toast 通知速查表](#toast-通知速查表)
- [API 端点速查表](#api-端点速查表)
- [测试用例状态追踪](#测试用例状态追踪)

---

## 前置条件

| 条件 | 说明 |
|------|------|
| OpenClaw 服务 | 运行中，guardclaw 插件已加载 |
| 本地模型 | Ollama 或兼容服务运行在 `http://localhost:11434`，模型 `openbmb/minicpm4.1` |
| Dashboard 入口 | 浏览器访问 `http://localhost:<port>/plugins/guardclaw/stats/` |
| 浏览器 | Chrome / Firefox / Safari（最新版） |
| 开发者工具 | 打开 Network 面板以便观察 API 调用 |

### 启动日志验证

打开 OpenClaw 服务启动后，终端日志应包含以下条目（顺序可能不同）：

```
[GuardClaw] Privacy provider registered (proxy port: 8403)
[GuardClaw] Router pipeline initialized (built-in: privacy)
[GuardClaw] Dashboard registered at /plugins/guardclaw/stats
[GuardClaw] Token stats initialized (~/.openclaw/guardclaw-stats.json)
[GuardClaw] All hooks registered (13 hooks, pipeline-driven)
[GuardClaw] Plugin initialized (pipeline + privacy proxy + guard agent + dashboard)
```

如果缺少任何条目，检查插件配置是否正确、本地模型服务是否可达。

---

## Tab 1: Overview（概览）

### TC-1.1 首次加载 — 状态指示灯

| 项目 | 内容 |
|------|------|
| **操作** | 打开 Dashboard 页面 |
| **API 调用** | `GET /api/summary` + `GET /api/hourly`（并行发出） |
| **预期（正常）** | 右上角状态灯变**绿色**，文字显示 "Online"；旁边显示 "Updated HH:MM:SS" |
| **预期（异常）** | 如果服务未初始化（collector 为 null），状态灯变**红色**，显示 "Error: not initialized" |
| **Network 验证** | 开发者工具应看到两个并行请求，状态码 200；异常时 summary 返回 503 |

### TC-1.2 Token 统计卡片

| 项目 | 内容 |
|------|------|
| **操作** | 观察顶部 4 张统计卡片 |
| **预期** | |

- **Cloud Tokens**（蓝色 `#38bdf8`）：显示云端请求总 token 数 + "X requests"
- **Local Tokens**（绿色 `#4ade80`）：显示本地模型总 token 数 + "X requests"
- **Proxy Tokens**（橙色 `#fb923c`）：显示经代理总 token 数 + "X requests"
- **Privacy Rate**（紫色 `#a78bfa`）：显示 `(Local + Proxy) / Total × 100%`，副标题 "X of Y tokens protected"

| 验证方法 | 浏览器访问 `GET /api/summary`，对比 `lifetime.cloud.totalTokens`、`lifetime.local.totalTokens`、`lifetime.proxy.totalTokens` |
|----------|---|

### TC-1.3 Token 数值格式化

| 项目 | 内容 |
|------|------|
| **操作** | 产生足量消息使 token 数覆盖不同数量级 |
| **预期** | |

| Token 数范围 | 显示格式 | 示例 |
|---|---|---|
| 0 – 999 | 原始数字 | `456` |
| 1,000 – 999,999 | X.XK | `1.5K` |
| 1,000,000+ | X.XM | `2.3M` |

### TC-1.4 小时级时间线图表

| 项目 | 内容 |
|------|------|
| **操作** | 观察 "Hourly Token Usage" 区域的折线图 |
| **API 调用** | `GET /api/hourly` |
| **预期** | |

- Chart.js 折线图包含三条数据线：
  - Cloud（蓝色 `#38bdf8`，半透明填充）
  - Local（绿色 `#4ade80`，半透明填充）
  - Proxy（橙色 `#fb923c`，半透明填充）
- X 轴格式：`MM-DD HH:00`（最多 12 个刻度）
- Y 轴：token 数量
- 图例可点击以隐藏/显示对应数据线
- 无数据时图表区域为空但不报错

### TC-1.5 详情表格

| 项目 | 内容 |
|------|------|
| **操作** | 观察图表下方的数据表格 |
| **预期** | 三行数据，列如下： |

| Category | Input | Output | Cache Read | Total | Requests |
|----------|-------|--------|------------|-------|----------|
| Cloud | inputTokens | outputTokens | cacheReadTokens | totalTokens | requestCount |
| Local | ... | ... | ... | ... | ... |
| Proxy | ... | ... | ... | ... | ... |

| 验证方法 | 与 `GET /api/summary` → `lifetime.cloud/local/proxy` 中的各字段逐一对比 |
|----------|---|

### TC-1.6 Uptime 和 Last Activity

| 项目 | 内容 |
|------|------|
| **操作** | 观察表格下方信息栏 |
| **预期** | 显示 "Uptime: Xs ago" 和 "Last activity: Xs ago"（时间单位随间隔变化：s/m/h/d） |
| **验证** | 与 `GET /api/summary` 中 `startedAt` 和 `lastUpdatedAt` 计算差值对比 |

### TC-1.7 手动刷新

| 项目 | 内容 |
|------|------|
| **操作** | 点击右上角 **Refresh** 按钮 |
| **预期** | 所有卡片数值刷新、图表数据更新、时间戳更新为当前时间 |
| **Network** | 触发 `GET /api/summary` + `GET /api/hourly` + `GET /api/sessions` + `GET /api/detections` |

### TC-1.8 自动刷新（30 秒间隔）

| 项目 | 内容 |
|------|------|
| **操作** | 不做任何操作，等待 30 秒以上 |
| **预期** | Dashboard 自动刷新一次（`setInterval(refreshAll, 30000)`） |
| **验证** | Network 面板中每 30 秒出现一组请求 |

---

## Tab 2: Sessions（会话）

### TC-2.1 空状态

| 项目 | 内容 |
|------|------|
| **操作** | 无会话（重启后首次访问）时切换到 Sessions tab |
| **预期** | 表格区域显示 "No session data yet" |
| **API 调用** | `GET /api/sessions`（返回空数组） |

### TC-2.2 会话列表

| 项目 | 内容 |
|------|------|
| **操作** | 通过 Agent 发送若干消息后，切换到 Sessions tab |
| **API 调用** | `GET /api/sessions` |
| **预期** | 表格显示所有活跃会话，各列说明如下： |

| 列 | 说明 |
|---|---|
| Session | 会话 Key（超过 20 字符截断 + "..."，完整值在 title 属性中） |
| Level | 最高敏感度标签：S1（蓝）、S2（橙）、S3（绿），使用 `level-tag` 样式 |
| Cloud | 该会话的云端 token 数 |
| Local | 该会话的本地 token 数 |
| Proxy | 该会话的代理 token 数 |
| Total | Cloud + Local + Proxy |
| Requests | 三类请求数之和 |
| Last Active | 相对时间（如 "5s ago"、"2m ago"） |

### TC-2.3 Session Key 悬浮提示

| 项目 | 内容 |
|------|------|
| **操作** | 鼠标悬停在被截断的 Session Key 上 |
| **预期** | 浏览器原生 tooltip 显示完整的 session key（通过 `title` 属性实现） |

---

## Tab 3: Detection Log（检测日志）

### TC-3.1 空状态

| 项目 | 内容 |
|------|------|
| **操作** | 无检测事件时切换到 Detection Log tab |
| **预期** | 表格区域显示 "No detections yet" |

### TC-3.2 检测事件列表

| 项目 | 内容 |
|------|------|
| **操作** | 发送包含敏感内容的消息（如含 S2/S3 关键词），然后查看 Detection Log |
| **API 调用** | `GET /api/detections`（返回最多 500 条，按时间倒序排列） |
| **预期** | 表格列说明如下： |

| 列 | 说明 |
|---|---|
| Time | 检测时间，格式 "HH:MM:SS" |
| Session | 会话 Key（截断到 16 字符） |
| Level | S1/S2/S3 带颜色标签 |
| Checkpoint | `onUserMessage` / `onToolCallProposed` / `onToolCallExecuted`（灰色背景标签） |
| Reason | 检测原因，如 "S2 keyword detected: salary"、"LLM classification" |

> 前端只渲染前 100 条（`filtered.slice(0, 100)`）。

### TC-3.3 过滤器 — All

| 项目 | 内容 |
|------|------|
| **操作** | 点击 "All" 过滤按钮 |
| **预期** | 显示所有级别的检测事件；"All" 按钮变为高亮（`active` class）；其他按钮不高亮 |

### TC-3.4 过滤器 — S1

| 项目 | 内容 |
|------|------|
| **操作** | 点击 "S1" 过滤按钮 |
| **预期** | 只显示 `level === "S1"` 的事件；"S1" 按钮高亮 |

### TC-3.5 过滤器 — S2

| 项目 | 内容 |
|------|------|
| **操作** | 点击 "S2" 过滤按钮 |
| **预期** | 只显示 `level === "S2"` 的事件 |

### TC-3.6 过滤器 — S3

| 项目 | 内容 |
|------|------|
| **操作** | 点击 "S3" 过滤按钮 |
| **预期** | 只显示 `level === "S3"` 的事件 |

### TC-3.7 过滤后空状态

| 项目 | 内容 |
|------|------|
| **操作** | 选择一个不存在事件的级别过滤器（如没有 S3 事件时点 "S3"） |
| **预期** | 显示 "No detections for S3" |

---

## Tab 4: Router Rules（路由规则）

> 这是功能最复杂的页面，分为 5 个子区域。

### 4A. Pipeline Test（全 Pipeline 分类测试）

#### TC-4A.1 基础分类测试 — S2 触发

| 项目 | 内容 |
|------|------|
| **前提** | Privacy Router 中已配置 S2 关键词 "工资"，且 ruleDetector 在 onUserMessage 启用 |
| **操作** | ① 在 "Test Classification" 文本框输入 `帮我分析一下这个月的工资单` ② 下拉框选 "onUserMessage" ③ 点击 **Classify (Full Pipeline)** |
| **API 调用** | `POST /api/test-classify` → body: `{ "message": "帮我分析一下这个月的工资单", "checkpoint": "onUserMessage" }` |
| **预期** | ① 出现 "Classifying..." 加载文字 ② 加载消失，结果面板出现 ③ Level 显示 S2（橙色标签） ④ Reason 包含 "S2 keyword detected: 工资" |
| **服务端行为** | dry-run，无副作用，不写入 Detection Log |

#### TC-4A.2 安全消息测试 — S1

| 项目 | 内容 |
|------|------|
| **操作** | 输入 `write a poem about spring`，点击 Classify |
| **预期** | Level=S1, Action=passthrough |

#### TC-4A.3 空消息校验

| 项目 | 内容 |
|------|------|
| **操作** | 文本框留空，点击 Classify |
| **预期** | Toast 提示 "Enter a test message"（红色错误样式，3 秒后自动消失） |
| **API** | 不发出请求（前端拦截） |

#### TC-4A.4 不同 Checkpoint 测试

| 项目 | 内容 |
|------|------|
| **操作** | 保持相同消息，分别选择 `onToolCallProposed` 和 `onToolCallExecuted` 进行测试 |
| **预期** | 结果可能因 checkpoint 配置的检测器（ruleDetector / localModelDetector）不同而不同 |
| **注意** | 默认配置中三个 checkpoint 均只启用 localModelDetector；如需测试 ruleDetector，需先在 Privacy Router 中手动启用 |

### 4B. Pipeline Order（Pipeline 执行顺序）

#### TC-4B.1 查看当前顺序

| 项目 | 内容 |
|------|------|
| **操作** | 观察 "Pipeline Order" 区域三个 checkpoint 下的标签 |
| **预期** | 默认配置下，三个 checkpoint 各显示 `① privacy` 一个标签 |

#### TC-4B.2 添加路由器到 Pipeline

| 项目 | 内容 |
|------|------|
| **操作** | 在 "onUserMessage" 行的 picker 中点击 `+ token-saver` 按钮 |
| **预期（未在列表中）** | 标签 `② token-saver` 出现在 `① privacy` 之后 |
| **预期（已在列表中）** | 按钮半透明（class `in-use`），点击无效 |

#### TC-4B.3 拖拽排序

| 项目 | 内容 |
|------|------|
| **操作** | 将 `② token-saver` 标签拖拽到 `① privacy` 前面 |
| **预期** | 序号自动更新：`① token-saver` `② privacy` |

#### TC-4B.4 移除路由器

| 项目 | 内容 |
|------|------|
| **操作** | 点击标签上的 "×" 按钮 |
| **预期** | 该路由器从 checkpoint 列表中移除；picker 中对应按钮恢复可点击状态 |

#### TC-4B.5 保存 Pipeline Order

| 项目 | 内容 |
|------|------|
| **操作** | 点击 **Save Pipeline Order** |
| **API 调用** | `POST /api/config` → `{ "privacy": { "pipeline": { "onUserMessage": ["privacy", "token-saver"], "onToolCallProposed": [...], "onToolCallExecuted": [...] } } }` |
| **预期** | Toast "Pipeline order saved" |
| **服务端行为** | `updateLiveConfig()` 热更新内存 + `writeConfigFile()` 持久化磁盘 + `pipeline.configure()` 重配置 |

### 4C. Privacy Router（隐私路由器）

#### TC-4C.1 折叠/展开

| 项目 | 内容 |
|------|------|
| **操作** | 点击 "Privacy Router" 标题栏 |
| **预期** | 内容区折叠/展开；箭头 ▼ 旋转为 ▶（或反向） |

#### TC-4C.2 启用/禁用开关

| 项目 | 内容 |
|------|------|
| **操作** | 切换 "Enabled" 滑动开关 |
| **预期** | 开关视觉状态切换（蓝色 = 启用，灰色 = 禁用）；影响后续 Save 的 payload |

#### TC-4C.3 Checkpoint 检测器配置

| 项目 | 内容 |
|------|------|
| **操作 1** | 在 onUserMessage 下点击 "ruleDetector" chip |
| **预期 1** | chip 高亮（`active` class），表示 ruleDetector 添加到 `_checkpoints.um` 数组 |
| **操作 2** | 再次点击同一 chip |
| **预期 2** | chip 取消高亮，ruleDetector 从数组中移除 |
| **注意** | 默认只有 localModelDetector 启用；ruleDetector 需手动启用才会执行关键词/模式匹配 |

#### TC-4C.4 添加 S2 关键词

| 项目 | 内容 |
|------|------|
| **操作** | ① 在 S2 Keywords 输入框输入 `salary` ② 按 **Enter** 或点击 **Add** |
| **预期** | ① 输入框清空并重新聚焦 ② 标签列表出现 `salary` 标签（含 × 删除按钮） |
| **后续验证** | 保存 Privacy Router 后，含 "salary" 的消息被检测为 S2 |

#### TC-4C.5 删除关键词

| 项目 | 内容 |
|------|------|
| **操作** | 点击 `salary` 标签上的 **×** |
| **预期** | 标签从列表中移除 |

#### TC-4C.6 重复关键词去重

| 项目 | 内容 |
|------|------|
| **操作** | 连续添加两次 `salary` |
| **预期** | 只出现一个标签（前端 `indexOf` 去重） |

#### TC-4C.7 添加 S3 关键词

| 项目 | 内容 |
|------|------|
| **操作** | 在 S3 Keywords 区域添加 `SSN` |
| **预期** | 标签出现在 **S3 — High Sensitivity** 列下 |
| **后续验证** | 保存后，含 "SSN" 的消息被检测为 S3，路由到本地模型 |

#### TC-4C.8 添加 Regex Pattern

| 项目 | 内容 |
|------|------|
| **操作** | 在 S2 Regex Patterns 添加 `\d{3}-\d{4}` |
| **预期** | Pattern 标签出现 |
| **后续验证** | 保存后，含 "123-4567" 的消息匹配此正则，被检测为 S2 |

#### TC-4C.9 添加 Tool Names

| 项目 | 内容 |
|------|------|
| **操作** | 在 S2 Tool Names 添加 `execute_sql` |
| **预期** | 标签出现 |
| **后续验证** | 保存后，Agent 调用 `execute_sql` 工具时触发 S2（在 `onToolCallProposed` checkpoint） |

#### TC-4C.10 添加 Tool Paths

| 项目 | 内容 |
|------|------|
| **操作** | 在 S3 Tool Paths 添加 `/credentials/` |
| **预期** | 标签出现 |
| **后续验证** | 保存后，工具参数中包含 `/credentials/` 路径时触发 S3 阻断 |

#### TC-4C.11 LLM Prompts 编辑

| 项目 | 内容 |
|------|------|
| **操作** | ① 找到 "Privacy Detection (S1/S2/S3 Classifier)" 编辑器 ② 修改 prompt 内容 ③ 点击 **Save** |
| **API 调用** | `POST /api/prompts` → `{ "name": "detection-system", "content": "..." }` |
| **预期** | ① Toast: `Prompt "detection-system" saved & applied` ② 编辑器刷新，出现 "customized" 蓝色标签 |
| **服务端行为** | `writePrompt()` 写入 `prompts/detection-system.md` → `loadPrompt()` 热加载 |

#### TC-4C.12 重置 Prompt 到默认值

| 项目 | 内容 |
|------|------|
| **操作** | 点击 **Reset Default** |
| **预期** | 编辑器内容恢复为内置默认 prompt；**注意：此操作不自动保存**，需再次点击 Save 才会持久化 |

#### TC-4C.13 Privacy Router 单独测试

| 项目 | 内容 |
|------|------|
| **操作** | ① 在 "Test (Privacy Router Only)" 输入 `请帮我查看银行账户余额` ② 点击 **Test Privacy Router** |
| **API 调用** | `POST /api/test-classify` → `{ "message": "...", "router": "privacy" }` |
| **预期** | 结果面板显示 Level / Action / Target / Reason / Confidence（仅 privacy 路由器的判定，不走整个 pipeline） |

#### TC-4C.14 保存 Privacy Router

| 项目 | 内容 |
|------|------|
| **操作** | 修改完规则后点击 **Save Privacy Router** |
| **API 调用** | `POST /api/config` → `{ "privacy": { "checkpoints": { "onUserMessage": [...], ... }, "rules": { "keywords": { "S2": [...], "S3": [...] }, "patterns": {...}, "tools": {...} } } }` |
| **预期** | Toast "Privacy Router saved" |
| **服务端行为** | `updateLiveConfig()` 热更新 + `writeConfigFile()` 持久化 |
| **验证** | 保存后立即发送匹配新规则的消息，应看到对应 S2/S3 检测日志 |

### 4D. Token-Saver Router（Token 节省路由器）

#### TC-4D.1 启用 Token-Saver

| 项目 | 内容 |
|------|------|
| **操作** | 切换 "Enabled" 开关为**启用** |
| **预期** | 滑块变蓝；下方配置字段可交互 |
| **注意** | Token-Saver 默认禁用（`enabled: false`） |

#### TC-4D.2 配置 Judge Model

| 项目 | 内容 |
|------|------|
| **操作** | 填写 Judge Endpoint = `http://localhost:11434`，Judge Model = `openbmb/minicpm4.1`，API Protocol = `openai-compatible` |
| **预期** | 字段正常填入 |
| **说明** | 留空时继承全局 Local Model 配置 |

#### TC-4D.3 配置 Tier → Model 映射

| 项目 | 内容 |
|------|------|
| **操作** | 在 Tier-to-Model 网格中填写： |

| Tier | Provider | Model |
|------|----------|-------|
| SIMPLE | openai | gpt-4o-mini |
| MEDIUM | openai | gpt-4o |
| COMPLEX | anthropic | claude-sonnet-4.6 |
| REASONING | openai | o4-mini |

| **预期** | 所有字段正常填入且无报错 |

#### TC-4D.4 配置 Cache TTL

| 项目 | 内容 |
|------|------|
| **操作** | Cache TTL (ms) 输入 `300000`（5 分钟） |
| **预期** | 字段接受数字输入 |

#### TC-4D.5 Token-Saver Prompt 编辑

| 项目 | 内容 |
|------|------|
| **操作** | 编辑 "Token-Saver (Task Complexity Judge)" prompt 并保存 |
| **预期** | 与 TC-4C.11 类似：Toast 确认 + "customized" 标签 |

#### TC-4D.6 Token-Saver 单独测试

| 项目 | 内容 |
|------|------|
| **操作** | ① 输入 `hello` ② 点击 **Test Token-Saver** |
| **API 调用** | `POST /api/test-classify` → `{ "message": "hello", "router": "token-saver" }` |
| **预期** | Level=S1, Action=redirect, Target=openai/gpt-4o-mini, Reason="tier=SIMPLE" |

| **操作** | 输入一段复杂的系统设计需求 |
| **预期** | Level=S1, Action=redirect, Target=anthropic/claude-sonnet-4.6, Reason="tier=COMPLEX" |

#### TC-4D.7 保存 Token-Saver

| 项目 | 内容 |
|------|------|
| **操作** | 点击 **Save Token-Saver** |
| **API 调用** | `POST /api/config` → `{ "privacy": { "routers": { "token-saver": { "enabled": true, "type": "builtin", "options": { "judgeEndpoint": "...", "judgeModel": "...", "tiers": {...}, "cacheTtlMs": 300000 } } } } }` |
| **预期** | ① Toast "Token-Saver config saved" ② 页面自动调用 `loadConfig()` 刷新 |
| **服务端行为** | `pipeline.configure()` 重配置；新路由器配置立即生效 |

### 4E. Custom Routers（自定义路由器）

#### TC-4E.1 创建自定义路由器

| 项目 | 内容 |
|------|------|
| **操作** | 在底部 "Router ID" 输入 `content-filter`，点击 **+ Add Custom Router** |
| **预期** | ① Toast: `Router "content-filter" created — configure and save it below` ② 新路由器卡片出现（含 Enabled 开关、关键词/模式规则、LLM prompt、测试区） ③ Pipeline Order picker 中新增 `+ content-filter` 按钮 |
| **ID 规范化** | 输入自动转小写，非 `a-z0-9_-` 字符替换为 `-` |

#### TC-4E.2 重复 ID 错误

| 项目 | 内容 |
|------|------|
| **操作** | 再次输入 `content-filter` 并点击添加 |
| **预期** | Toast 错误: `Router "content-filter" already exists` |

#### TC-4E.3 空 ID 错误

| 项目 | 内容 |
|------|------|
| **操作** | 不输入 ID 直接点击添加 |
| **预期** | Toast 错误: "Enter a router ID" |

#### TC-4E.4 配置自定义路由器关键词

| 项目 | 内容 |
|------|------|
| **操作** | 在 content-filter 卡片中：① S2 Keywords 添加 `violence` ② S3 Keywords 添加 `terrorism` |
| **预期** | 各区域出现对应标签 |

#### TC-4E.5 配置 LLM System Prompt

| 项目 | 内容 |
|------|------|
| **操作** | 在 LLM System Prompt 文本框中输入分类 prompt |
| **预期** | 文本框显示输入内容 |
| **说明** | 可选；如设置，router 会额外调用本地 LLM 进行分类（除了关键词/模式匹配） |

#### TC-4E.6 测试自定义路由器

| 项目 | 内容 |
|------|------|
| **操作** | 在 Test 区域输入 `The movie depicts graphic violence`，点击 **Test** |
| **API 调用** | `POST /api/test-classify` → `{ "message": "...", "router": "content-filter" }` |
| **预期** | Level=S2, Reason="S2 keyword: violence" |

#### TC-4E.7 保存自定义路由器

| 项目 | 内容 |
|------|------|
| **操作** | 点击 **Save content-filter** |
| **API 调用** | `POST /api/config` → `{ "privacy": { "routers": { "content-filter": { "enabled": true, "type": "configurable", "options": { "keywords": { "S2": ["violence"], "S3": ["terrorism"] }, "patterns": {...}, "prompt": "..." } } } } }` |
| **预期** | Toast: `Router "content-filter" saved` |
| **服务端行为** | `createConfigurableRouter("content-filter")` 注册到 pipeline（如果尚未注册）；`pipeline.configure()` 应用新配置 |

#### TC-4E.8 删除自定义路由器

| 项目 | 内容 |
|------|------|
| **操作** | 点击路由器卡片标题栏的红色 **Delete** 按钮 |
| **预期** | ① 浏览器 `confirm()` 对话框: `Delete router "content-filter"? This cannot be undone.` ② 确认后 Toast: `Router "content-filter" deleted` ③ 卡片消失 |
| **API 调用** | `POST /api/config` → `{ "privacy": { "routers": { ... } } }`（不再包含被删路由器） |
| **取消** | 点击"取消"时无任何变化 |

---

## Tab 5: Configuration（配置）

### TC-5.1 GuardClaw 总开关

| 项目 | 内容 |
|------|------|
| **操作** | 关闭 "GuardClaw Enabled" 开关，点击 **Save Configuration** |
| **API 调用** | `POST /api/config` → `{ "privacy": { "enabled": false, ... } }` |
| **预期** | Toast "Configuration saved" |
| **行为验证** | 发送任何消息 → 终端日志中不再出现 `[GuardClaw]` 检测相关条目；Detection Log 不产生新事件 |
| **恢复** | 重新打开开关并保存 |

### TC-5.2 Local Model 配置

| 项目 | 内容 |
|------|------|
| **操作** | 修改以下字段并保存：API Protocol = `ollama-native`，Provider = `ollama`，Endpoint = `http://localhost:11434`，Model = `qwen3:8b`，API Key = （留空） |
| **预期** | Toast "Configuration saved" |
| **行为验证** | 后续 localModelDetector 使用新的 endpoint/model 进行分类；如模型不存在应在日志中看到调用失败 |

### TC-5.3 API Protocol — Custom Module 字段联动

| 项目 | 内容 |
|------|------|
| **操作 1** | API Protocol 下拉框选择 `custom` |
| **预期 1** | "Custom Module Path" 输入框出现 |
| **操作 2** | 切换回 `openai-compatible` |
| **预期 2** | "Custom Module Path" 输入框隐藏 |

### TC-5.4 Guard Agent 配置

| 项目 | 内容 |
|------|------|
| **操作** | 修改 Agent ID = `guard-v2`, Workspace = `~/.openclaw/guard-v2`, Model = `ollama/qwen3.5-27b`，保存 |
| **预期** | 保存后 S3 消息路由到新配置的 Guard Agent |
| **日志验证** | S3 消息应出现 `[GuardClaw] S3 — routing to ollama/qwen3.5-27b` |

### TC-5.5 S2 策略切换 — 从 proxy 到 local

| 项目 | 内容 |
|------|------|
| **操作** | S2 Handling Strategy 选择 `local (route entirely to local model)`，保存 |
| **预期** | 保存后 S2 消息不再经过 Privacy Proxy，直接路由到本地模型 |
| **日志验证** | 发送 S2 消息后应出现 `[GuardClaw] S2 — routing to ollama/...` |
| **对比** | 之前 proxy 模式下应为 `[GuardClaw] S2 — routing through privacy proxy` |

### TC-5.6 S2 策略切换 — 从 local 到 proxy

| 项目 | 内容 |
|------|------|
| **操作** | S2 Handling Strategy 切换回 `proxy (strip PII via privacy proxy)`，保存 |
| **预期** | S2 消息恢复使用 Privacy Proxy |
| **日志验证** | 应出现 `[GuardClaw] S2 — routing through privacy proxy` |

### TC-5.7 Proxy Port 修改

| 项目 | 内容 |
|------|------|
| **操作** | Proxy Port 修改为 `8404`，保存 |
| **预期** | Toast "Configuration saved" |
| **注意** | 字段下方提示 "Requires restart to take effect"——重启前 proxy 仍监听旧端口 |
| **重启后验证** | 启动日志应显示 `Privacy proxy started on port 8404` |

### TC-5.8 Session Settings

| 项目 | 内容 |
|------|------|
| **操作** | ① 关闭 "Isolate Guard History" ② Base Directory 改为 `~/.openclaw-test` ③ 保存 |
| **预期** | 配置立即生效（`updateLiveConfig()`） |

### TC-5.9 Local Providers 管理

| 项目 | 内容 |
|------|------|
| **操作 1** | 在 Local Providers 输入 `my-inference-server`，点击 **Add** |
| **预期 1** | 标签出现 |
| **操作 2** | 保存配置 |
| **预期 2** | `my-inference-server` 加入 `localProviders` 列表 |
| **行为** | 该 provider 被视为 "local"，S3 内容可安全路由到此 provider |

### TC-5.10 多字段修改 + 保存

| 项目 | 内容 |
|------|------|
| **操作** | 同时修改多个字段（enabled、localModel、guardAgent、s2Policy、session 等），点击 **Save Configuration** |
| **API 调用** | `POST /api/config` → 完整 payload 包含所有 privacy 子字段 |
| **预期** | ① Toast "Configuration saved" ② `GET /api/config` 返回更新后的完整配置 ③ 磁盘配置文件同步更新 |

### TC-5.11 保存失败处理

| 项目 | 内容 |
|------|------|
| **操作** | 模拟网络断开（DevTools Offline 模式）或后端返回错误 |
| **预期** | Toast 红色错误样式: "Save failed: ..."（fetch 错误消息或服务端返回的 error 字段） |

---

## 端到端行为验证场景

> 以下场景跨越多个 Tab，验证 Dashboard 操作对实际 Agent 行为的端到端影响。

### E2E-1: 添加 S2 关键词 → 检测生效

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | **Router Rules** → Privacy Router → Checkpoints → 启用 `ruleDetector`（onUserMessage） | chip 高亮 |
| 2 | S2 Keywords 添加 `工资` | 标签出现 |
| 3 | 点击 **Save Privacy Router** | Toast "Privacy Router saved" |
| 4 | 回到 Agent，发送 `帮我分析一下这个月的工资明细` | -- |
| 5 | 查看终端日志 | `[GuardClaw] S2 — routing through privacy proxy [privacy]` |
| 6 | Dashboard → **Detection Log** → Refresh | 新事件：Level=S2, Checkpoint=onUserMessage, Reason 含 "S2 keyword detected: 工资" |
| 7 | Dashboard → **Overview** | Proxy tokens 增加；Cloud tokens 不增或增少量 |
| 8 | Dashboard → **Sessions** | 该会话 Level 显示 S2 |

### E2E-2: 添加 S3 关键词 → 完全本地路由

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | Privacy Router → 启用 `ruleDetector` + S3 Keywords 添加 `SSN` → Save | -- |
| 2 | 发送 `What's the SSN for John Doe?` | -- |
| 3 | 终端日志 | `[GuardClaw] S3 — routing to ollama/openbmb/minicpm4.1 [privacy]` |
| 4 | Detection Log | Level=S3 |
| 5 | Overview | Local tokens 增加；Cloud tokens 不增加 |

### E2E-3: 创建自定义路由器 → 加入 Pipeline → 触发

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | Router Rules → 底部创建 `content-filter` 自定义路由器 | 卡片出现 |
| 2 | 添加 S3 Keyword: `confidential` → **Save content-filter** | Toast 确认 |
| 3 | Pipeline Order → onUserMessage 添加 `content-filter` → **Save Pipeline Order** | Toast 确认 |
| 4 | Test Classification 输入 `This document is confidential` → Classify | Level=S3, Router=content-filter |
| 5 | 实际发送该消息 | 路由到本地模型 |

### E2E-4: Token-Saver 启用 → 智能模型降级

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | Token-Saver → 启用 + 配置 Tier 映射 → **Save** | Toast 确认 |
| 2 | Pipeline Order → onUserMessage 添加 `token-saver` → **Save** | Toast 确认 |
| 3 | 发送 `hello` | 路由到 `openai/gpt-4o-mini`（SIMPLE tier） |
| 4 | 发送复杂系统设计需求 | 路由到 `anthropic/claude-sonnet-4.6`（COMPLEX tier） |

### E2E-5: S2 Policy 切换行为对比

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | Configuration → S2 Policy = `proxy` → Save | -- |
| 2 | 发送 S2 消息 | 日志: `routing through privacy proxy` |
| 3 | Configuration → S2 Policy = `local` → Save | -- |
| 4 | 发送相同 S2 消息 | 日志: `routing to ollama/...`（直接本地） |

### E2E-6: 禁用 GuardClaw → 所有检测跳过

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | Configuration → 关闭 "GuardClaw Enabled" → Save | -- |
| 2 | 发送包含 S2/S3 关键词的消息 | 无 `[GuardClaw]` 检测日志 |
| 3 | Detection Log | 无新事件 |
| 4 | 消息直接发到默认云端模型 | Cloud tokens 增加 |

### E2E-7: Prompt 修改 → 分类行为变化

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | Router Rules → Privacy Router → LLM Prompts → 编辑 Detection System prompt | 修改为更严格规则（如"任何包含数字的消息判为 S2"） |
| 2 | **Save** prompt | Toast 确认 |
| 3 | Test Classification: `my phone is 12345` | 修改前可能为 S1，修改后应为 S2 |
| 4 | **Reset Default** → Save | 恢复原始行为 |

---

## Toast 通知速查表

### 成功通知（绿色背景）

| Toast 文本 | 触发场景 |
|-----------|---------|
| `Configuration saved` | Configuration tab 保存成功 |
| `Privacy Router saved` | Privacy Router 保存成功 |
| `Token-Saver config saved` | Token-Saver 保存成功 |
| `Pipeline order saved` | Pipeline Order 保存成功 |
| `Router "X" created — configure and save it below` | 创建自定义路由器成功 |
| `Router "X" saved` | 自定义路由器保存成功 |
| `Router "X" deleted` | 删除自定义路由器成功 |
| `Prompt "X" saved & applied` | Prompt 保存成功 |

### 错误通知（红色背景）

| Toast 文本 | 触发场景 |
|-----------|---------|
| `Enter a test message` | 测试分类时文本框为空 |
| `Enter a router ID` | 创建路由器时未输入 ID |
| `Router "X" already exists` | 重复创建同名路由器 |
| `Test failed: ...` | 测试分类请求失败或返回错误 |
| `Save failed: ...` | 保存请求失败（网络错误或后端返回 error） |

> 所有 Toast 显示 3 秒后自动消失（`setTimeout 3000ms`）。

---

## API 端点速查表

> Base path: `/plugins/guardclaw/stats/api`

| Method | Path | 说明 | 返回 |
|--------|------|------|------|
| GET | `/summary` | Token 统计汇总 | `{ lifetime: { cloud, local, proxy }, startedAt, lastUpdatedAt }` |
| GET | `/hourly` | 小时级时间线 | `[{ hour, cloud, local, proxy }]` |
| GET | `/sessions` | 会话统计列表 | `[{ sessionKey, highestLevel, cloud, local, proxy, lastActiveAt }]` |
| GET | `/detections` | 检测事件日志 | `[{ sessionKey, level, checkpoint, reason, timestamp }]`（≤500 条） |
| GET | `/config` | 当前完整配置 | `{ privacy: { enabled, localModel, guardAgent, s2Policy, ... } }` |
| POST | `/config` | 更新配置 | Body: `{ privacy: { ... } }` → `{ ok: true }` |
| GET | `/prompts` | 所有可编辑 prompt | `{ "name": { label, content, isCustom, defaultContent } }` |
| POST | `/prompts` | 保存 prompt | Body: `{ name, content }` → `{ ok: true }` |
| POST | `/test-classify` | Dry-run 分类 | Body: `{ message, checkpoint?, router? }` → `{ level, action, target, reason, confidence, routerId }` |

---

## 测试用例状态追踪

使用以下模板追踪测试执行情况：

| 用例 ID | 名称 | 状态 | 备注 |
|---------|------|------|------|
| TC-1.1 | 首次加载 — 状态指示灯 | ☐ | |
| TC-1.2 | Token 统计卡片 | ☐ | |
| TC-1.3 | Token 数值格式化 | ☐ | |
| TC-1.4 | 小时级时间线图表 | ☐ | |
| TC-1.5 | 详情表格 | ☐ | |
| TC-1.6 | Uptime 和 Last Activity | ☐ | |
| TC-1.7 | 手动刷新 | ☐ | |
| TC-1.8 | 自动刷新 | ☐ | |
| TC-2.1 | Sessions 空状态 | ☐ | |
| TC-2.2 | 会话列表 | ☐ | |
| TC-2.3 | Session Key 悬浮提示 | ☐ | |
| TC-3.1 | Detection Log 空状态 | ☐ | |
| TC-3.2 | 检测事件列表 | ☐ | |
| TC-3.3 | 过滤器 — All | ☐ | |
| TC-3.4 | 过滤器 — S1 | ☐ | |
| TC-3.5 | 过滤器 — S2 | ☐ | |
| TC-3.6 | 过滤器 — S3 | ☐ | |
| TC-3.7 | 过滤后空状态 | ☐ | |
| TC-4A.1 | Pipeline 基础分类测试 | ☐ | |
| TC-4A.2 | S1 安全消息测试 | ☐ | |
| TC-4A.3 | 空消息校验 | ☐ | |
| TC-4A.4 | 不同 Checkpoint 测试 | ☐ | |
| TC-4B.1 | 查看 Pipeline 顺序 | ☐ | |
| TC-4B.2 | 添加路由器到 Pipeline | ☐ | |
| TC-4B.3 | 拖拽排序 | ☐ | |
| TC-4B.4 | 移除路由器 | ☐ | |
| TC-4B.5 | 保存 Pipeline Order | ☐ | |
| TC-4C.1 | 折叠/展开 | ☐ | |
| TC-4C.2 | 启用/禁用开关 | ☐ | |
| TC-4C.3 | Checkpoint 检测器配置 | ☐ | |
| TC-4C.4 | 添加 S2 关键词 | ☐ | |
| TC-4C.5 | 删除关键词 | ☐ | |
| TC-4C.6 | 重复关键词去重 | ☐ | |
| TC-4C.7 | 添加 S3 关键词 | ☐ | |
| TC-4C.8 | 添加 Regex Pattern | ☐ | |
| TC-4C.9 | 添加 Tool Names | ☐ | |
| TC-4C.10 | 添加 Tool Paths | ☐ | |
| TC-4C.11 | LLM Prompts 编辑 | ☐ | |
| TC-4C.12 | 重置 Prompt 到默认值 | ☐ | |
| TC-4C.13 | Privacy Router 单独测试 | ☐ | |
| TC-4C.14 | 保存 Privacy Router | ☐ | |
| TC-4D.1 | 启用 Token-Saver | ☐ | |
| TC-4D.2 | 配置 Judge Model | ☐ | |
| TC-4D.3 | 配置 Tier 映射 | ☐ | |
| TC-4D.4 | 配置 Cache TTL | ☐ | |
| TC-4D.5 | Token-Saver Prompt 编辑 | ☐ | |
| TC-4D.6 | Token-Saver 单独测试 | ☐ | |
| TC-4D.7 | 保存 Token-Saver | ☐ | |
| TC-4E.1 | 创建自定义路由器 | ☐ | |
| TC-4E.2 | 重复 ID 错误 | ☐ | |
| TC-4E.3 | 空 ID 错误 | ☐ | |
| TC-4E.4 | 配置自定义路由器关键词 | ☐ | |
| TC-4E.5 | 配置 LLM Prompt | ☐ | |
| TC-4E.6 | 测试自定义路由器 | ☐ | |
| TC-4E.7 | 保存自定义路由器 | ☐ | |
| TC-4E.8 | 删除自定义路由器 | ☐ | |
| TC-5.1 | GuardClaw 总开关 | ☐ | |
| TC-5.2 | Local Model 配置 | ☐ | |
| TC-5.3 | Custom Module 字段联动 | ☐ | |
| TC-5.4 | Guard Agent 配置 | ☐ | |
| TC-5.5 | S2 → local 切换 | ☐ | |
| TC-5.6 | S2 → proxy 切换 | ☐ | |
| TC-5.7 | Proxy Port 修改 | ☐ | |
| TC-5.8 | Session Settings | ☐ | |
| TC-5.9 | Local Providers | ☐ | |
| TC-5.10 | 多字段保存 | ☐ | |
| TC-5.11 | 保存失败处理 | ☐ | |
| E2E-1 | S2 关键词→检测生效 | ☐ | |
| E2E-2 | S3 关键词→本地路由 | ☐ | |
| E2E-3 | 自定义路由器→Pipeline | ☐ | |
| E2E-4 | Token-Saver→模型降级 | ☐ | |
| E2E-5 | S2 Policy 切换对比 | ☐ | |
| E2E-6 | 禁用 GuardClaw | ☐ | |
| E2E-7 | Prompt 修改→分类变化 | ☐ | |
