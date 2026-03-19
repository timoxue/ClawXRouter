# session-manager.ts — 逐方法文档


 文件定位：双轨会话历史管理器（Dual Session Manager）
 所属模块：GuardClaw 隐私路由系统

 核心职责：维护每个会话的两套独立消息历史——"full"（完整轨道，
 包含所有消息含 Guard Agent 交互）和"clean"（干净轨道，剔除了
 Guard Agent 交互，专供云端模型使用）。消息以 JSONL 格式逐行
 追加到磁盘文件，实现隐私隔离下的对话上下文持久化。

 核心概念：
   full  — 完整历史，包含所有原始内容（含 S3 敏感交互、Guard Agent 消息）
   clean — 干净历史，排除 Guard Agent 消息，云端模型仅能看到此轨道
   delta — full 与 clean 的差集，即仅存在于 full 中的敏感消息
   JSONL — 每行一条 JSON 记录的文件格式，便于追加写入和流式读取
## 类型：SessionMessage                           (L11-L18)


单条会话消息的数据结构。

字段说明：
  role: "user" | "assistant" | "system" | "tool"
      消息的角色标识。与 OpenAI Chat API 的 role 语义一致。

  content: string
      消息文本内容。

  timestamp?: number
      Unix 毫秒时间戳。写入历史时若缺省则自动填充 Date.now()。

  toolCallId?: string
      工具调用 ID，用于关联 tool 角色消息与其触发的 assistant 消息。

  toolName?: string
      工具名称，记录该消息来自哪个工具的执行结果。

  sessionKey?: string
      所属会话标识。用于 isGuardAgentMessage() 判断是否为
      Guard 子会话的消息（sessionKey 以 ":guard" 结尾/包含 ":guard:"）。
## 类：DualSessionManager                         (L23-L373)


双轨会话管理器的核心类。维护 full/clean 两套 JSONL 历史文件，
提供写入、读取、差集计算、格式化等操作。

私有字段：
  baseDir: string
      会话历史的根目录，默认 ~/.openclaw。
      构造函数中会将 ~ 展开为用户 HOME 目录。

  writeLocks: Map<string, Promise<void>>
      per-file 写锁映射。key 是文件绝对路径，value 是上一次
      写操作的 Promise。用于串行化同一文件的并发追加，防止
      JSONL 行交错。

  seededSessions: Set<string>
      已完成 full 轨道种子操作的 session+agent 组合集合。
      避免重复执行 copyFile。
## 方法：withWriteLock(lockKey, fn)                (L31-L36)


### 作用

  为同一文件的并发写操作提供串行化保证。多个 fire-and-forget
  写入（来自同步 hook 的 .catch(() => {}) 调用）不会交错，
  确保 JSONL 文件中每行都是完整的 JSON 记录。

### 参数

  lockKey: string — 锁的唯一标识，实际使用中传入文件绝对路径。
  fn: () => Promise<void> — 需要串行执行的异步写操作。

### 返回值

  Promise<void> — 等待当前写操作（含之前排队的写操作）全部完成。

### 逐行逻辑


**L32**:
```typescript
const prev = this.writeLocks.get(lockKey) ?? Promise.resolve();
```
> 从 writeLocks Map 获取该文件当前排队的最后一个 Promise。
> 如果是首次写入（Map 中无此 key），?? 兜底为已 resolve 的 Promise，
> 表示前面没有排队任务。


**L33**:
```typescript
const next = prev.then(fn, fn);
```
> 将当前写操作 fn 链接到前一个 Promise 之后。
> then(fn, fn)：无论前一个操作成功还是失败，都执行 fn。
> 这确保即使前一次写入出错，后续写入仍然继续（不因一次失败阻塞整条链）。


**L34**:
```typescript
this.writeLocks.set(lockKey, next);
```
> 将新的 Promise 更新到 Map，后续到来的写操作会排在 next 之后。


**L35**:
```typescript
await next;
```
> 等待自身（含链上所有先前操作）完成后返回。


### 设计意图

  这是一个极简的异步互斥锁实现。不使用 Mutex 库或 OS 级文件锁，
  而是利用 Promise 链天然的串行特性。适合轻量级的追加写场景，
  尤其是从同步 hook 中 fire-and-forget 触发的多次写入竞态。
  失败容错设计（then(fn, fn)）保证了单次写入失败不会死锁后续操作。
## 构造函数：constructor(baseDir)                  (L38-L43)


### 作用

  初始化 DualSessionManager 实例，解析并设置会话历史的根目录。

### 参数

  baseDir: string = "~/.openclaw" — 历史文件根目录路径。
      支持 ~ 前缀（会展开为用户 HOME 目录）。

### 返回值

  DualSessionManager 实例。

### 逐行逻辑


**L40-L42**:
```typescript
this.baseDir = baseDir.startsWith("~")
```

             ? path.join(process.env.HOME || process.env.USERPROFILE || "~", baseDir.slice(2))
             : baseDir;
> 检查 baseDir 是否以 ~ 开头。
> 是：将 ~ 替换为 HOME 环境变量（Linux/macOS）或
> USERPROFILE（Windows），再拼接 ~ 之后的路径部分。
> baseDir.slice(2) 跳过 "~/"（包括斜杠），得到相对路径。
> 如果两个环境变量都不存在，兜底使用 "~" 字符串本身
> （此时 path.join 会产生一个含 ~ 的路径，可能在后续
> 文件操作中报错——属于极端边界情况）。
> 否：直接使用传入的绝对路径。

### 设计意图

  与 defaultPrivacyConfig.session.baseDir 的默认值 "~/.openclaw" 对齐。
  ~ 展开逻辑兼容 macOS/Linux（HOME）和 Windows（USERPROFILE）。
方法：persistMessage(sessionKey, message, agentId)
                                                 (L50-L62)

### 作用

  将一条消息持久化到会话历史。自动决定写入哪些轨道：
  - 所有消息都写入 full 轨道；
  - 非 Guard Agent 消息额外写入 clean 轨道。

### 参数

  sessionKey: string — 会话标识符。
  message: SessionMessage — 要持久化的消息。
  agentId: string = "main" — Agent 标识，默认 "main"。

### 返回值

  Promise<void> — 写入完成后 resolve。

### 逐行逻辑


**L56**:
```typescript
await this.writeToHistory(sessionKey, message, agentId, "full");
```
> 无条件写入 full 轨道。full 轨道是完整的、未经审查的历史。


**L59**:
```typescript
if (!this.isGuardAgentMessage(message)) {
```
> 调用 isGuardAgentMessage() 检查该消息是否属于 Guard Agent 交互。
> 判断逻辑：sessionKey 以 ":guard" 结尾/包含 ":guard:"，
> 或 content 中包含 "[guardclaw:guard]" / "[guard agent]" 标记。


**L60**:
```typescript
await this.writeToHistory(sessionKey, message, agentId, "clean");
```
> 非 Guard Agent 消息才写入 clean 轨道。
> 这确保 clean 轨道不包含任何 Guard 子会话交互，
> 可安全发送给云端模型。


### 设计意图

  实现"双轨写入"的核心入口。调用方（hooks.ts 中的 before_message_write）
  使用此方法处理 system / S1-user / 非本地路由 assistant 等普通消息。
  对于 S2/S3 等需要特殊处理的消息（如原文→full、脱敏→clean），
  hooks.ts 直接调用 writeToFull / writeToClean 来精确控制内容。
属性 + 方法：seededSessions / ensureFullTrackSeeded(...)
                                                 (L70-L100)

### 作用

  在首次向 full 轨道写入前，将已有的 clean 轨道内容复制为 full 轨道
  的初始内容。确保 full 轨道从会话开始就是完整的，不会缺少之前
  S1 阶段已写入 clean 轨道的消息。

### 参数

  sessionKey: string — 会话标识符。
  agentId: string — Agent 标识。

### 返回值

  Promise<void> — 种子操作完成后 resolve。

### 逐行逻辑


**L70**:
```typescript
private seededSessions = new Set<string>();
```
> 内存级缓存，记录已完成种子操作的 "sessionKey:agentId" 组合。
> 避免对同一会话重复执行 copyFile。


**L76**:
```typescript
const key = `${sessionKey}:${agentId}`;
```
> 组合 sessionKey 和 agentId 作为去重 key。


**L77**:
```typescript
if (this.seededSessions.has(key)) return;
```
> 如果已种子过，直接返回（幂等保护）。


**L79**:
```typescript
const fullPath = this.getHistoryPath(sessionKey, agentId, "full");
```


**L80**:
```typescript
if (fs.existsSync(fullPath)) {
```
> full 轨道文件已存在（可能是上次会话遗留或手动创建），
> 无需种子。标记已完成并返回。


**L85**:
```typescript
const cleanPath = this.getHistoryPath(sessionKey, agentId, "clean");
```


**L86**:
```typescript
if (!fs.existsSync(cleanPath)) {
```
> clean 轨道也不存在——全新会话，无内容可复制。标记并返回。


**L92**:
```typescript
const dir = path.dirname(fullPath);
```

**L93**:
```typescript
await fs.promises.mkdir(dir, { recursive: true });
```
> 确保 full 轨道文件的目录存在（递归创建）。


**L94**:
```typescript
await fs.promises.copyFile(cleanPath, fullPath);
```
> 将 clean 轨道文件原样复制为 full 轨道文件。
> 之后 writeToFull 的追加写入会在此基础上继续。


**L95**:
```typescript
console.log(`[GuardClaw] Seeded full track from clean track for ${sessionKey}`);
```
> 记录种子操作日志。


**L96-L98**:
```typescript
catch (err) → console.error(...)
```
> 种子失败不抛出异常——静默降级。
> 最坏情况：full 轨道缺少早期消息，但不影响后续写入。


**L99**:
```typescript
this.seededSessions.add(key);
```
> 无论成功或失败都标记为已完成，避免重复尝试。


### 设计意图

  解决"中途升级"问题：一个会话可能先以 S1 开始（只有 clean 轨道），
  然后检测到 S3 需要写入 full 轨道。此时 full 轨道如果从零开始，
  本地模型通过 loadHistoryDelta 看到的上下文会缺少早期对话。
  种子操作将 clean 轨道作为 full 轨道的起点，补齐历史。
## 方法：writeToFull(sessionKey, message, agentId)  (L107-L114)


### 作用

  仅向 full 轨道写入一条消息。首次写入时自动执行种子操作
  （从 clean 轨道复制初始内容）。

### 参数

  sessionKey: string — 会话标识符。
  message: SessionMessage — 要写入的消息。
  agentId: string = "main" — Agent 标识。

### 返回值

  Promise<void>

### 逐行逻辑


**L112**:
```typescript
await this.ensureFullTrackSeeded(sessionKey, agentId);
```
> 确保 full 轨道已种子。首次调用时执行 copyFile；
> 后续调用因 seededSessions 缓存命中而直接返回。


**L113**:
```typescript
await this.writeToHistory(sessionKey, message, agentId, "full");
```
> 委托给通用的 writeToHistory 执行实际的 JSONL 追加写入。


### 设计意图

  hooks.ts 中 tool_result_persist 和 before_message_write 在处理
  S3 / S2-local 场景时，需要将原始内容（含 PII）写入 full 轨道，
  同时将脱敏后的内容写入 clean 轨道。writeToFull 和 writeToClean
  作为一对独立接口，让调用方可以精确控制两条轨道的内容差异。
## 方法：writeToClean(sessionKey, message, agentId) (L119-L125)


### 作用

  仅向 clean 轨道写入一条消息。

### 参数

  sessionKey: string — 会话标识符。
  message: SessionMessage — 要写入的消息。
  agentId: string = "main" — Agent 标识。

### 返回值

  Promise<void>

### 逐行逻辑


**L124**:
```typescript
await this.writeToHistory(sessionKey, message, agentId, "clean");
```
> 直接委托给 writeToHistory 写入 clean 轨道。
> 不执行种子操作（clean 轨道是"原生"轨道，不需要从 full 复制）。


### 设计意图

  与 writeToFull 配对使用。调用方在 S3 场景中先 writeToFull 写原始内容，
  再 writeToClean 写 PII 脱敏后的内容或占位符 "🔒 [Private message]"。
方法：loadHistory(sessionKey, isCloudModel, agentId, limit)
                                                 (L132-L140)

### 作用

  根据模型类型加载对应轨道的会话历史。
  云端模型只能看到 clean 轨道；本地模型可以看到 full 轨道。

### 参数

  sessionKey: string — 会话标识符。
  isCloudModel: boolean — true=云端模型(加载clean)，false=本地模型(加载full)。
  agentId: string = "main" — Agent 标识。
  limit?: number — 可选的消息数量限制（取最新的 N 条）。

### 返回值

  Promise<SessionMessage[]> — 按时间顺序排列的消息数组。

### 逐行逻辑


**L138**:
```typescript
const historyType = isCloudModel ? "clean" : "full";
```
> 根据模型类型决定轨道。这是隐私隔离的核心路由逻辑：
> 云端模型永远不会通过此接口读到 Guard Agent 交互或原始 S3 内容。


**L139**:
```typescript
return await this.readHistory(sessionKey, agentId, historyType, limit);
```
> 委托给 readHistory 执行实际的 JSONL 文件读取和解析。


### 设计意图

  提供模型感知的历史加载接口。当前代码库中 hooks.ts 并未直接调用此方法
  （而是使用 loadHistoryDelta），但此方法作为公开 API 供外部模块或
  未来扩展使用。
## 方法：isGuardAgentMessage(message)              (L145-L159)


### 作用

  判断一条消息是否属于 Guard Agent 交互。
  Guard Agent 消息应仅存在于 full 轨道，不出现在 clean 轨道中。

### 参数

  message: SessionMessage — 待检查的消息。

### 返回值

  boolean — true 表示是 Guard Agent 消息。

### 逐行逻辑


**L146**:
```typescript
if (message.sessionKey && isGuardSessionKey(message.sessionKey)) {
```
> 首先检查消息自身携带的 sessionKey。
> isGuardSessionKey()（来自 guard-agent.ts）判断 sessionKey
> 是否以 ":guard" 结尾或包含 ":guard:"。
> 如果匹配，说明该消息来自 Guard 子会话。


**L150-L155**:
```typescript
const content = message.content;
```

             if (content.includes("[guardclaw:guard]") ||
                 content.includes("[guard agent]")) {
               return true;
             }
> 后备检测：扫描消息内容中的标记字符串。
> 这覆盖了 sessionKey 可能未设置但内容中带有 Guard 标记的情况
> （例如从旧版本迁移的历史消息）。

**L158**:
```typescript
return false;
```
> 两种检测方式均未命中，判定为非 Guard Agent 消息。


### 设计意图

  双重检测策略（sessionKey + 内容标记）提供了兼容性和鲁棒性。
  sessionKey 检测是主路径（快速、精确），内容检测是兜底。
方法：writeToHistory(sessionKey, message, agentId, historyType)
                                                 (L166-L192)

### 作用

  底层的通用历史写入方法。所有写入（persistMessage / writeToFull /
  writeToClean）最终都委托给此方法。
  使用 withWriteLock 串行化对同一文件的并发追加。

### 参数

  sessionKey: string — 会话标识符。
  message: SessionMessage — 要写入的消息。
  agentId: string — Agent 标识。
  historyType: "full" | "clean" — 目标轨道。

### 返回值

  Promise<void>

### 逐行逻辑


**L172**:
```typescript
const historyPath = this.getHistoryPath(sessionKey, agentId, historyType);
```
> 计算目标 JSONL 文件的绝对路径。
> 路径格式：{baseDir}/agents/{agentId}/sessions/{historyType}/{safeSessionKey}.jsonl


**L174**:
```typescript
await this.withWriteLock(historyPath, async () => {
```
> 以文件路径为锁 key，进入写锁。
> 确保同一文件的多次并发追加按顺序执行。


**L176-L177**:
```typescript
const dir = path.dirname(historyPath);
```

             await fs.promises.mkdir(dir, { recursive: true });
> 确保目录存在。recursive: true 意味着即使父目录不存在也会递归创建。
> 每次写入都检查（幂等操作），因为首次写入时目录可能尚不存在。

**L179-L182**:
```typescript
const line = JSON.stringify({
```

               ...message,
               timestamp: message.timestamp ?? Date.now(),
             });
> 将消息序列化为 JSON 字符串。
> message.timestamp ?? Date.now()：如果消息未携带时间戳，
> 自动填充当前时间。这确保每条记录都有时间信息，
> 便于后续的排序、去重和审计。

**L184**:
```typescript
await fs.promises.appendFile(historyPath, line + "\n", "utf-8");
```
> 以追加模式写入一行 JSON（JSONL 格式）。
> 追加写（appendFile）而非覆盖写（writeFile），保留历史记录。
> 行尾换行符 "\n" 确保下一条记录在新行开始。


**L185-L189**:
```typescript
catch (err) → console.error(...)
```
> 写入失败时仅打印错误日志，不抛出异常。
> 这是防御性设计：写历史失败不应阻断 Hook 的正常流程。


### 设计意图

  JSONL 格式的选择是关键设计决策：每次写入只追加一行，无需读取/解析/
  重写整个文件，写入开销 O(1)。这对 hook 中的 fire-and-forget 场景尤为
  重要——hook 是同步调用链的一部分，不能承受高延迟。
  withWriteLock 保证并发安全但不使用 OS 级文件锁，避免跨进程兼容性问题。
方法：readHistory(sessionKey, agentId, historyType, limit)
                                                 (L197-L238)

### 作用

  从 JSONL 历史文件中读取并解析消息列表。

### 参数

  sessionKey: string — 会话标识符。
  agentId: string — Agent 标识。
  historyType: "full" | "clean" — 读取哪条轨道。
  limit?: number — 可选，只返回最新的 N 条消息。

### 返回值

  Promise<SessionMessage[]> — 解析后的消息数组。文件不存在或解析失败时返回 []。

### 逐行逻辑


**L204**:
```typescript
const historyPath = this.getHistoryPath(sessionKey, agentId, historyType);
```
> 计算 JSONL 文件的绝对路径。


**L207**:
```typescript
if (!fs.existsSync(historyPath)) { return []; }
```
> 文件不存在则返回空数组。
> 使用同步 existsSync 而非 async access() 是因为这是快速的 stat 检查。


**L212**:
```typescript
const content = await fs.promises.readFile(historyPath, "utf-8");
```
> 一次性读取整个文件内容。


**L213**:
```typescript
const lines = content.trim().split("\n").filter(Boolean);
```
> trim() 去除首尾空白，split("\n") 按行分割，
> filter(Boolean) 过滤掉空行（由末尾换行符或意外的空行产生）。


**L215-L223**:
```typescript
const messages = lines.map((line) => {
```

               try {
                 return JSON.parse(line) as SessionMessage;
               } catch {
                 return null;
               }
             })
             .filter((msg): msg is SessionMessage => msg !== null);
> 逐行 JSON.parse。解析失败的行被静默跳过（返回 null 后过滤掉）。
> 这种容错设计确保单条记录损坏（如磁盘写入中断、JSON 不完整）
> 不会导致整个历史文件无法读取。
> 类型守卫 `msg is SessionMessage` 让 TypeScript 推断过滤后的数组类型。

**L226-L228**:
```typescript
if (limit && messages.length > limit) {
```

               return messages.slice(-limit);
             }
> 如果指定了 limit 且消息数超过限制，取末尾 N 条（最新的）。
> slice(-limit) 从数组末尾截取。

**L230**:
```typescript
return messages;
```
> 无 limit 时返回全部消息。


**L231-L237**:
```typescript
catch (err) → console.error(...) → return []
```
> 外层 catch 捕获 readFile 等 IO 错误，返回空数组降级。


### 设计意图

  一次性读取全文件 + 内存解析的方式简洁但在超大文件时有内存压力。
  当前设计假设会话历史文件在合理范围内（historyLimit 默认 20 条），
  生产场景可能需要流式 readline 读取以应对长会话。
方法：getHistoryPath(sessionKey, agentId, historyType)
                                                 (L243-L261)

### 作用

  根据会话标识、Agent ID 和轨道类型，计算 JSONL 历史文件的绝对路径。

### 参数

  sessionKey: string — 会话标识符（会被清理为文件名安全字符）。
  agentId: string — Agent 标识。
  historyType: "full" | "clean" — 轨道类型。

### 返回值

  string — 文件绝对路径。

### 逐行逻辑


**L249**:
```typescript
const safeSessionKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
```
> 将 sessionKey 中非法文件名字符替换为下划线。
> 只保留字母、数字、下划线和连字符。
> 防止 sessionKey 中的 / : . 等字符导致路径穿越或创建失败。


**L251**:
```typescript
const fileName = `${safeSessionKey}.jsonl`;
```
> 拼接文件名，扩展名为 .jsonl。


**L253-L260**:
```typescript
return path.join(
```

               this.baseDir, "agents", agentId, "sessions", historyType, fileName
             );
> 完整路径格式：
> {baseDir}/agents/{agentId}/sessions/{full|clean}/{safeSessionKey}.jsonl
> 例如：~/.openclaw/agents/main/sessions/full/abc_123.jsonl
> 目录层级设计：baseDir → agents → agentId → sessions → 轨道类型 → 文件

### 设计意图

  通过 agentId 分隔不同 Agent 的历史，通过 historyType 分隔 full/clean
  轨道。sessionKey 清理确保安全性。路径结构与 defaultPrivacyConfig.session
  中的配置保持一致。
方法：clearHistory(sessionKey, agentId, historyType)
                                                 (L266-L287)

### 作用

  删除指定会话的历史文件。可指定删除单条轨道或同时删除两条轨道。

### 参数

  sessionKey: string — 会话标识符。
  agentId: string = "main" — Agent 标识。
  historyType?: "full" | "clean" — 可选。指定则只删除该轨道；
      不指定则同时删除 full 和 clean 两条轨道。

### 返回值

  Promise<void>

### 逐行逻辑


**L271**:
```typescript
const types: Array<"full" | "clean"> = historyType ? [historyType] : ["full", "clean"];
```
> 如果指定了轨道类型，只处理该类型；否则两条都处理。


**L273-L286**:
```typescript
for (const type of types) {
```

               try {
                 const historyPath = this.getHistoryPath(...);
                 if (fs.existsSync(historyPath)) {
                   await fs.promises.unlink(historyPath);
                 }
               } catch (err) {
                 console.error(...);
               }
             }
> 遍历需要删除的轨道类型。
> 先用 existsSync 检查文件是否存在，存在则用 unlink 删除。
> 每个轨道独立 try-catch，一个轨道删除失败不影响另一个。

### 设计意图

  提供会话历史的清理能力。当前代码库中未发现直接调用此方法的地方
  （session_end hook 调用 clearSessionState 但不清除历史文件），
  预留给手动清理或未来的 session 过期机制使用。
方法：loadHistoryDelta(sessionKey, agentId, limit)
                                                 (L295-L315)

### 作用

  加载"仅存在于 full 轨道但不在 clean 轨道中"的消息（差集）。
  这些消息是 Guard Agent 交互和原始 S3 内容——正是本地模型需要
  用来重建完整对话上下文的部分。

### 参数

  sessionKey: string — 会话标识符。
  agentId: string = "main" — Agent 标识。
  limit?: number — 可选，只返回最新的 N 条差集消息。

### 返回值

  Promise<SessionMessage[]> — 差集消息数组。

### 逐行逻辑


**L300**:
```typescript
const full = await this.readHistory(sessionKey, agentId, "full");
```

**L301**:
```typescript
const clean = await this.readHistory(sessionKey, agentId, "clean");
```
> 分别读取 full 和 clean 两条轨道的完整历史。


**L303**:
```typescript
if (full.length === 0) return [];
```
> full 轨道为空则无差集可返回。


**L304**:
```typescript
if (clean.length === 0) return limit ? full.slice(-limit) : full;
```
> clean 轨道为空意味着所有消息都是 full 独有的
> （极端情况：所有消息都是 Guard Agent 交互）。
> 直接返回 full 的全部或截断后的内容。


**L306-L308**:
```typescript
const cleanSet = new Set(
```

               clean.map((m) => `${m.role}:${m.timestamp ?? ""}:${m.content.slice(0, 80)}`)
             );
> 将 clean 轨道的消息转为指纹集合，用于快速查找。
> 指纹由 role + timestamp + content 前 80 字符组成。
> content.slice(0, 80)：只取前 80 字符作为指纹。
> 这是性能和准确性的折中——避免对长消息做全文 hash，
> 80 字符足以区分绝大多数消息。

**L310-L312**:
```typescript
const delta = full.filter(
```

               (m) => !cleanSet.has(`${m.role}:${m.timestamp ?? ""}:${m.content.slice(0, 80)}`)
             );
> 从 full 中过滤出指纹不在 cleanSet 中的消息。
> 这就是"差集"——只存在于 full 中的消息。

**L314**:
```typescript
return limit && delta.length > limit ? delta.slice(-limit) : delta;
```
> 如果指定了 limit 且差集超过限制，取最新的 N 条。


### 设计意图

  这是双轨隐私隔离中最关键的方法之一。hooks.ts 的 before_prompt_build
  在 S3 / S2-local 场景下调用 loadHistoryDelta 获取差集，
  然后通过 formatAsContext 格式化后注入到本地模型的 prependContext 中。
  这样本地模型能看到之前被 "🔒 [Private message]" 占位符替换的原始内容，
  而云端模型永远看不到这些内容。

  注意：指纹匹配基于 content 前 80 字符，如果存在两条相同前缀但不同
  内容的消息（且 role 和 timestamp 也相同），可能产生误判。但实际场景中
  timestamp 的毫秒级精度使得碰撞概率极低。
## 静态方法：formatAsContext(messages, label)       (L321-L351)


### 作用

  将消息数组格式化为可读的对话上下文文本块，用于注入到
  本地模型的 prependContext 中。

### 参数

  messages: SessionMessage[] — 要格式化的消息列表。
  label?: string — 可选的标题标签。默认为
      "Full conversation history (original, authoritative)"。

### 返回值

  string — 格式化后的文本。消息为空时返回空字符串。

### 逐行逻辑


**L322**:
```typescript
if (messages.length === 0) return "";
```
> 空消息列表直接返回空字符串，不生成任何上下文。


**L324**:
```typescript
const header = label ?? "Full conversation history (original, authoritative)";
```
> 使用自定义标签或默认标签。


**L325-L328**:
```typescript
const lines = [
```

               `[${header}]`,
               `[NOTE: The conversation above may contain "🔒 [Private message]" ...]`,
             ];
> 构建输出的开头两行：
> 第一行：上下文标题。
> 第二行：向本地模型解释此上下文的性质——这是"权威源"，
> 主转录中的占位符应以此为准。

**L330-L346**:
```typescript
for (const msg of messages) { ... }
```
> 遍历每条消息，逐条格式化。


**L331-L335**:
```typescript
const roleLabel = msg.role === "user" ? "User" :
```

               msg.role === "assistant" ? "Assistant" :
               msg.role === "tool" ? `Tool${msg.toolName ? `(${msg.toolName})` : ""}` :
               "System";
> 将 role 转为人类可读的标签。
> tool 角色附加工具名称（如 "Tool(read_file)"）。

**L337-L339**:
```typescript
const ts = msg.timestamp
```

               ? ` [ts=${new Date(msg.timestamp).toISOString()}]`
               : "";
> 如果有时间戳，格式化为 ISO 字符串附加到角色标签后。
> 方便调试和对齐不同轨道的消息顺序。

**L341-L344**:
```typescript
const truncated = msg.content.length > 2000
```

               ? msg.content.slice(0, 2000) + "…(truncated)"
               : msg.content;
> 超过 2000 字符的消息内容截断，附加 "(truncated)" 标记。
> 防止 prependContext 注入过多内容导致 token 溢出。

**L346**:
```typescript
lines.push(`${roleLabel}${ts}: ${truncated}`);
```
> 将格式化后的消息行加入输出。


**L349**:
```typescript
lines.push("[End of private context]");
```
> 添加结束标记，明确上下文边界。


**L350**:
```typescript
return lines.join("\n");
```
> 用换行符拼接所有行，返回完整文本块。


### 设计意图

  作为静态方法不依赖实例状态，便于在 hooks.ts 的 loadDualTrackContext 中
  直接使用 DualSessionManager.formatAsContext(delta)。
  截断到 2000 字符是对 context window 的保护——historyLimit (默认 20 条)
  乘以 2000 字符 = 最多约 40K 字符，在本地模型的上下文窗口范围内。
## 方法：getHistoryStats(sessionKey, agentId)       (L356-L372)


### 作用

  获取指定会话的历史统计信息：full 消息数、clean 消息数和两者的差值。

### 参数

  sessionKey: string — 会话标识符。
  agentId: string = "main" — Agent 标识。

### 返回值

  Promise<{ fullCount: number; cleanCount: number; difference: number }>
  fullCount — full 轨道的消息条数。
  cleanCount — clean 轨道的消息条数。
  difference — fullCount - cleanCount，即差集的近似大小。

### 逐行逻辑


**L364**:
```typescript
const full = await this.readHistory(sessionKey, agentId, "full");
```

**L365**:
```typescript
const clean = await this.readHistory(sessionKey, agentId, "clean");
```
> 读取两条轨道的完整历史。


**L367-L371**:
```typescript
return { fullCount: full.length, cleanCount: clean.length,
```

               difference: full.length - clean.length };
> 计算并返回统计数据。difference 是条数差值（非精确差集大小，
> 因为 clean 中的消息内容可能与 full 不同——如脱敏后的版本）。

### 设计意图

  提供轻量级的会话状态查询，可用于 Dashboard UI 展示或调试。
  当前代码库中未发现直接调用此方法的地方，预留给未来的
  可观测性功能（如 dashboard 展示会话的隐私处理比例）。
## 模块级单例：getDefaultSessionManager(baseDir)    (L375-L383)


### 作用

  获取模块级的 DualSessionManager 单例。
  首次调用或传入新的 baseDir 时创建新实例。

### 参数

  baseDir?: string — 可选的历史文件根目录。
      传入时会（重新）创建实例。

### 返回值

  DualSessionManager — 单例实例。

### 逐行逻辑


**L376**:
```typescript
let defaultManager: DualSessionManager | null = null;
```
> 模块级变量，持有单例引用。初始为 null。


**L379**:
```typescript
if (!defaultManager || baseDir) {
```
> 两种情况会创建新实例：
> 1. defaultManager 为 null（首次调用）。
> 2. 传入了 baseDir（即使已有实例也重建，支持运行时切换目录）。


**L380**:
```typescript
defaultManager = new DualSessionManager(baseDir);
```
> 创建新实例。如果 baseDir 为 undefined，
> 构造函数使用默认值 "~/.openclaw"。


**L382**:
```typescript
return defaultManager;
```
> 返回单例。


### 设计意图

  hooks.ts 在 registerHooks 开头调用
  getDefaultSessionManager(sessionBaseDir) 初始化单例，
  后续所有 hook 通过 getDefaultSessionManager()（不传参）获取同一实例。
  单例模式确保 writeLocks Map 全局共享，写锁串行化在跨 hook 间有效。

  注意：当传入 baseDir 时，即使已存在实例也会重建。这意味着旧实例的
  writeLocks 和 seededSessions 会丢失。如果存在对旧实例的引用仍在
  执行写操作，可能出现竞态。但在实际使用中 baseDir 只在初始化时传入一次。
---

## Code Review — 代码审查


### Part A — Code 层面改动建议


#### 🟡 readHistory 全量读取可能导致内存问题


 现状（L212）：const content = await fs.promises.readFile(historyPath, "utf-8");
 问题：当会话历史很长（如数千条消息）时，一次性 readFile 会将整个
       文件内容加载到内存。虽然 historyLimit 默认 20 条，但 readHistory
       本身并不强制此限制——它读取全部内容后才 slice。
 建议：对于有 limit 参数的场景，可使用 readline 或自行从文件末尾
       向前读取 N 行（类似 tail），避免大文件的全量读取。


#### 🟢 loadHistoryDelta 指纹碰撞风险


 现状（L307）：content.slice(0, 80) 作为指纹的一部分
 问题：如果两条不同消息的 role、timestamp 和前 80 字符完全相同
       （虽然概率极低，但 timestamp 可能在毫秒精度下重合），
       会导致差集漏掉本应包含的消息。
 建议：可考虑使用 content 的 hash（如 murmurhash 或 md5 前 8 位）
       替代 slice(0, 80)，或在指纹中加入消息索引。
       当前实现在实践中几乎不会出问题，优先级低。


#### 🟢 getHistoryPath 中 existsSync 的混用


 现状（L80, L86, L207, L277）：多处使用 fs.existsSync 同步检查
 问题：在 async 方法中使用 sync API 会阻塞事件循环。
       虽然 existsSync 只是一个快速 stat，影响极小，但与 async
       代码风格不一致。
 建议：可改用 fs.promises.access().then(()=>true, ()=>false)，
       或在性能测试确认无影响后保持现状。优先级低。


#### 🟡 writeToHistory 每次写入都执行 mkdir


 现状（L177）：await fs.promises.mkdir(dir, { recursive: true });
 问题：每次写入都执行 mkdir。虽然 recursive: true 在目录已存在时
       是幂等的，但仍是一次不必要的系统调用。
 建议：维护一个 "已确认存在的目录" Set，只在首次写入时 mkdir。
       类似 seededSessions 的模式。


#### 🟢 writeLocks Map 永不清理


 现状（L25）：private writeLocks = new Map<string, Promise<void>>();
 问题：每个文件路径的 Promise 写入 Map 后永不删除。长时间运行的
       服务中，如果有大量不同 session 的历史文件，Map 会持续增长。
       虽然每个条目只是一个 Promise 引用，内存影响很小。
 建议：可在 clearHistory 时删除对应的 lock 条目，
       或使用 WeakRef + FinalizationRegistry（Node 14+）。


### Part B — 逻辑/设计层面改动建议


#### 🔴 getDefaultSessionManager 传入 baseDir 时的竞态风险


 现状（L379）：if (!defaultManager || baseDir) { defaultManager = new DualSessionManager(baseDir); }
 问题：当 baseDir 参数被传入时，即使已有实例也会重建。这会导致：
       a) 旧实例的 writeLocks 被丢弃——如果有正在执行的写操作，
          新实例的写锁无法感知它们，可能产生并发追加。
       b) seededSessions 被清空——已种子的 session 会重新种子。
 建议：要么禁止运行时更换 baseDir（只在初始化时创建一次），
       要么在重建时等待旧实例所有 writeLocks 完成。
       hooks.ts 中只在 registerHooks 开头调用一次
       getDefaultSessionManager(sessionBaseDir)，实际风险较低，
       但 API 设计上是一个隐患。


#### 🟡 ensureFullTrackSeeded 的 copyFile 与并发写入


 现状（L94）：await fs.promises.copyFile(cleanPath, fullPath);
 问题：copyFile 是一个非原子操作。如果在 copyFile 执行过程中，
       另一个 hook 同时向 cleanPath 追加内容，复制到 fullPath
       的内容可能不完整或包含追加的部分行。
       此外，ensureFullTrackSeeded 不在 withWriteLock 保护范围内，
       可能与紧接其后的 writeToHistory 产生竞态。
 建议：将 ensureFullTrackSeeded 整体放入 withWriteLock(fullPath, ...)
       保护范围内。或者使用 rename (移动) 代替 copy + 追加的模式。


#### 🟡 isGuardAgentMessage 的硬编码字符串检测


 现状（L151-L155）：检查 content 中是否包含 "[guardclaw:guard]" 或 "[guard agent]"
 问题：硬编码字符串检测脆弱——如果标记格式变更或用户消息中恰好
       包含这些字符串，会产生误判。与 guard-agent.ts 中
       isGuardSessionKey 的定义（检查 ":guard" 后缀）不完全对齐。
 建议：将标记字符串提取为 guard-agent.ts 中的导出常量，
       并在 isGuardAgentMessage 和 buildMainSessionPlaceholder 中复用。
       或完全依赖 sessionKey 判断，移除内容扫描（如果能确保所有
       Guard Agent 消息都携带正确的 sessionKey）。


#### 🟡 loadHistoryDelta 全量读取两条轨道


 现状（L300-L301）：分别读取 full 和 clean 的全部历史
 问题：即使调用方只需要最新 20 条差集（historyLimit 默认 20），
       也要先加载两条轨道的所有消息到内存，然后做差集再截断。
       对于长期会话，这是一个不必要的性能开销。
 建议：可先用 readHistory 的 limit 参数只读取尾部 N×2 条消息
       （预估差集比例后放大），减少读取量。或使用倒序读取优化。


#### 🟢 formatAsContext 的 2000 字符截断可能截断关键信息


 现状（L341-L344）：msg.content.length > 2000 时截断
 问题：对于包含代码块或结构化数据的消息，2000 字符截断可能
       在关键位置断开（如 JSON 中间），导致本地模型接收到
       不完整的上下文。
 建议：可考虑按 token 数而非字符数截断，或在截断点寻找
       自然断行处。当前 2000 字符对大多数场景足够，优先级低。


### 优先级总览


| 编号 | 优先级 | 标题                                      |
|------|--------|-------------------------------------------|
|  6   |  🔴    | getDefaultSessionManager 竞态风险          |
|  1   |  🟡    | readHistory 全量读取内存问题               |
|  4   |  🟡    | writeToHistory 每次 mkdir 冗余             |
|  7   |  🟡    | ensureFullTrackSeeded 的 copyFile 竞态     |
|  8   |  🟡    | isGuardAgentMessage 硬编码字符串           |
|  9   |  🟡    | loadHistoryDelta 全量读取性能              |
|  2   |  🟢    | 指纹碰撞风险                              |
|  3   |  🟢    | existsSync 与 async 不一致                 |
|  5   |  🟢    | writeLocks Map 永不清理                    |
|  10  |  🟢    | 2000 字符截断可能截断关键信息              |
