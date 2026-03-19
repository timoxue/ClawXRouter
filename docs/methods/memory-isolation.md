# memory-isolation.ts — 逐方法文档


 文件定位：内存隔离管理器（Memory Isolation Manager）
 所属模块：GuardClaw 隐私路由系统

 核心职责：管理双轨内存目录（memory / memory-full）以实现隐私隔离。
 Full Memory（MEMORY-FULL.md / memory-full/）包含所有上下文，供本地模型和
 审计使用；Clean Memory（MEMORY.md / memory/）排除 Guard Agent 内容并脱敏
 PII，供云端模型安全读取。该文件提供内存文件的读写、双轨同步（FULL→CLEAN）、
 Guard Agent 内容过滤以及 PII 脱敏的完整生命周期管理。

 术语说明：
   Full Memory  — 包含所有交互历史（含 Guard Agent 内容和原始 PII），
                  仅限本地模型访问
   Clean Memory — 过滤了 Guard Agent 段落并脱敏 PII 后的版本，
                  可安全暴露给云端模型
   Guard Section — 由 GUARD_SECTION_BEGIN/END HTML 注释标记包裹的
                   Guard Agent 生成的内容块
## 常量：GUARD_SECTION_BEGIN / GUARD_SECTION_END    (L15-L16)


Guard Agent 内容的定界标记，以 HTML 注释的形式嵌入 Markdown 文件。

  GUARD_SECTION_BEGIN = "<!-- guardclaw:guard-begin -->"
      标记一段 Guard Agent 生成内容的开始。

  GUARD_SECTION_END   = "<!-- guardclaw:guard-end -->"
      标记 Guard Agent 生成内容的结束。

filterGuardContent() 方法依赖这两个标记来识别并剥离
Guard Agent 内容，以防止其泄露到 Clean Memory 中。

hooks.ts 中的 syncMemoryWrite() 在写入 Guard 会话内存时，
会使用这两个标记包裹内容后写入 FULL 轨道（L1205-L1207）。
## 类：MemoryIsolationManager                      (L18-L401)


核心内存隔离管理器。维护 workspaceDir 下的双轨内存文件系统，
提供读、写、同步（FULL ↔ CLEAN）和初始化等操作。

字段说明：
  workspaceDir: string (private)
      工作空间根路径，默认 ~/.openclaw/workspace。
      所有内存文件相对于此路径存放。
## 构造函数：constructor(workspaceDir?)             (L21-L26)


### 作用

  初始化 MemoryIsolationManager 实例，设置工作空间目录。

### 参数

  workspaceDir: string — 工作空间路径，默认 "~/.openclaw/workspace"

### 返回值

  MemoryIsolationManager 实例

### 逐行逻辑


**L22-L25**:
```typescript
this.workspaceDir = workspaceDir.startsWith("~")
```

           ? path.join(process.env.HOME || process.env.USERPROFILE || "~", workspaceDir.slice(2))
           : workspaceDir;
> 判断路径是否以 ~ 开头（Unix home 目录缩写）。
> 若是，则用 process.env.HOME（Unix）或 process.env.USERPROFILE（Windows）展开。
> workspaceDir.slice(2) 去掉 "~/" 前缀，与 home 路径拼接。
> 三层 fallback：HOME → USERPROFILE → "~"（原样保留，最后手段）。
> 若路径不以 ~ 开头，则视为绝对路径直接使用。

### 设计意图

  支持跨平台的 home 目录展开，让用户可以在配置中使用 ~ 缩写而无需手动解析。
  与 DualSessionManager 的构造函数使用完全相同的展开逻辑。
## 函数：getMemoryDir(isCloudModel)                 (L31-L34)


### 作用

  根据模型类型返回对应的内存目录路径。

### 参数

  isCloudModel: boolean — true 表示云端模型，false 表示本地模型

### 返回值

  string — 完整的内存目录绝对路径

### 逐行逻辑


**L32**:
```typescript
const memoryType = isCloudModel ? "memory" : "memory-full";
```
> 云端模型使用 "memory" 目录（Clean），本地模型使用 "memory-full" 目录。
> 命名约定：无后缀 = 脱敏版，-full 后缀 = 完整版。


**L33**:
```typescript
return path.join(this.workspaceDir, memoryType);
```
> 与 workspaceDir 拼接得到绝对路径。
> 例如 ~/.openclaw/workspace/memory 或 ~/.openclaw/workspace/memory-full


### 设计意图

  统一的目录映射逻辑，被 getDailyMemoryPath()、syncDailyMemoryToClean()
  和 initializeDirectories() 复用，避免路径硬编码散落在各处。
## 函数：getMemoryFilePath(isCloudModel)            (L39-L47)


### 作用

  根据模型类型返回长期记忆文件（MEMORY.md 或 MEMORY-FULL.md）的路径。

### 参数

  isCloudModel: boolean — true 返回 MEMORY.md 路径，false 返回 MEMORY-FULL.md 路径

### 返回值

  string — 长期记忆文件的绝对路径

### 逐行逻辑


**L40-L42**:
```typescript
if (isCloudModel) { return path.join(this.workspaceDir, "MEMORY.md"); }
```
> 云端模型使用标准 MEMORY.md — 经过 Guard 段落过滤和 PII 脱敏。


**L44-L46**:
```typescript
return path.join(this.workspaceDir, "MEMORY-FULL.md");
```
> 本地模型使用 MEMORY-FULL.md — 包含全部原始内容。


### 设计意图

  与 getMemoryDir() 配合，分别处理长期记忆文件和每日记忆目录两种存储粒度。
  hooks.ts 中的 memory_get 路由会检查 shouldUseFullMemoryTrack() 来决定
  是否将 MEMORY.md 的请求重定向到 MEMORY-FULL.md（L501-L509）。
## 函数：getDailyMemoryPath(isCloudModel, date?)    (L52-L57)


### 作用

  根据模型类型和日期返回每日记忆文件的路径。

### 参数

  isCloudModel: boolean — 决定目录（memory/ vs memory-full/）
  date?: Date — 可选的日期，默认为当天

### 返回值

  string — 每日记忆文件的绝对路径，格式如 .../memory/2026-03-18.md

### 逐行逻辑


**L53**:
```typescript
const memoryDir = this.getMemoryDir(isCloudModel);
```
> 复用 getMemoryDir() 获取基础目录。


**L54**:
```typescript
const today = date ?? new Date();
```
> 若未传入 date 则使用当前日期。


**L55**:
```typescript
const dateStr = today.toISOString().split("T")[0];
```
> 将 Date 转为 ISO 字符串（如 "2026-03-18T10:30:00.000Z"），
> 取 "T" 前面的部分得到 "YYYY-MM-DD" 格式。


**L56**:
```typescript
return path.join(memoryDir, `${dateStr}.md`);
```
> 拼接为完整的每日记忆文件路径。


### 设计意图

  每日记忆文件按日期分片存储，便于增量同步和历史回溯。
  注意：toISOString() 使用 UTC 时区，可能导致本地时间跨日时
  文件名与用户直觉不一致（例如 UTC+8 时区的 0:00-8:00 会归入前一天）。
## 函数：writeMemory(content, isCloudModel, options?) (L62-L85)


### 作用

  写入或追加内容到指定的内存文件。

### 参数

  content: string — 要写入的内容
  isCloudModel: boolean — 决定写入 Clean 还是 Full 轨道
  options?: { append?: boolean; daily?: boolean }
      append — 是否追加模式（true）还是覆盖写入（false/默认）
      daily — 是否写入每日文件（true）还是长期文件（false/默认）

### 返回值

  Promise<void>

### 逐行逻辑


**L68-L70**:
```typescript
const filePath = options?.daily
```

             ? this.getDailyMemoryPath(isCloudModel)
             : this.getMemoryFilePath(isCloudModel);
> 根据 daily 选项选择每日文件路径或长期文件路径。

**L73-L74**:
```typescript
const dir = path.dirname(filePath);
```

           await fs.promises.mkdir(dir, { recursive: true });
> 确保目标目录存在。recursive: true 相当于 mkdir -p，
> 如果目录已存在不会报错。

**L77-L81**:
```typescript
if (options?.append) { appendFile(...) } else { writeFile(...) }
```
> append 模式用 appendFile 追加内容，否则用 writeFile 覆盖写入。
> 两者都指定 "utf-8" 编码。


**L82-L84**:
```typescript
catch (err) { console.error(...) }
```
> 写入失败静默记录错误，不抛出异常。
> 避免内存写入失败导致主流程中断。


### 设计意图

  通用的内存写入方法，同时支持长期和每日两种粒度、覆盖和追加两种模式。
  错误处理采用 "log and swallow" 策略——内存写入是辅助功能，不应阻断
  核心隐私路由流程。
## 函数：readMemory(isCloudModel, options?)          (L90-L108)


### 作用

  读取指定的内存文件内容。

### 参数

  isCloudModel: boolean — 决定读取 Clean 还是 Full 轨道
  options?: { daily?: boolean; date?: Date }
      daily — 读取每日文件还是长期文件
      date — 指定日期（仅 daily=true 时生效）

### 返回值

  Promise<string> — 文件内容；文件不存在或读取失败返回空字符串

### 逐行逻辑


**L95-L97**:
```typescript
const filePath = options?.daily
```

             ? this.getDailyMemoryPath(isCloudModel, options.date)
             : this.getMemoryFilePath(isCloudModel);
> 与 writeMemory 对称的路径选择逻辑。

**L99-L101**:
```typescript
if (!fs.existsSync(filePath)) { return ""; }
```
> 文件不存在时直接返回空字符串，避免 readFile 抛异常。
> 使用同步 existsSync 而非 access() — 在这里可接受，因为
> readMemory 后续的 readFile 本身就是异步的。


**L103**:
```typescript
return await fs.promises.readFile(filePath, "utf-8");
```
> 读取文件全部内容为 UTF-8 字符串返回。


**L105-L107**:
```typescript
catch (err) { console.error(...); return ""; }
```
> 读取失败返回空字符串，同样不中断调用方流程。


### 设计意图

  与 writeMemory 对称的读取方法。返回空字符串而非 null/throw，
  简化调用方的空值检查。被 mergeCleanIntoFull() 和 syncMemoryToClean() 使用。
## 函数：mergeCleanIntoFull(options?)               (L116-L156)


### 作用

  将 Clean Memory 中的新增行合并到 Full Memory 中，确保 FULL 始终是 CLEAN
  的超集。云端模型可能直接写入 MEMORY.md，此步骤在同步前捕获这些新增内容。

### 参数

  options?: { daily?: boolean; date?: Date } — 传递给 readMemory/writeMemory

### 返回值

  Promise<number> — 合并的新行数；无新内容或失败返回 0

### 逐行逻辑


**L118**:
```typescript
const cleanContent = await this.readMemory(true, options);
```
> 读取 Clean 轨道（MEMORY.md）的内容。


**L119**:
```typescript
const fullContent = await this.readMemory(false, options);
```
> 读取 Full 轨道（MEMORY-FULL.md）的内容。


**L121-L123**:
```typescript
if (!cleanContent.trim()) { return 0; }
```
> Clean 为空则无需合并，直接返回。


**L126-L131**:
```typescript
const fullLines = new Set(fullContent.split("\n").map(l => l.trim()).filter(Boolean));
```
> 将 Full 内容按行拆分，trim 后去空行，构建 Set 用于去重查询。
> 使用 trimmed 行作为 key，忽略前后空白差异。


**L136-L141**:
```typescript
for (const line of cleanContent.split("\n")) { ... }
```
> 遍历 Clean 的每一行，筛选出在 Full 中不存在的新行。
> 额外排除包含 "[REDACTED:" 的行——这些是之前同步时
> 产生的脱敏标记，不是真实内容，不应回写到 Full。


**L143-L145**:
```typescript
if (newLines.length === 0) { return 0; }
```
> 无新行则无需写入。


**L148**:
```typescript
const appendBlock = `\n\n## Cloud Session Additions\n${newLines.join("\n")}\n`;
```
> 将新行包裹在 "## Cloud Session Additions" 标题下，
> 附加到 Full 内容末尾，便于审计追踪来源。


**L149**:
```typescript
await this.writeMemory(fullContent + appendBlock, false, options);
```
> 将合并后的完整内容覆盖写入 Full 轨道。
> 注意：这里是覆盖写入（非 append），因为 fullContent 已包含原有内容。


**L151**:
```typescript
return newLines.length;
```
> 返回新增行数供调用方日志使用。


**L152-L155**:
```typescript
catch (err) { console.error(...); return 0; }
```
> 合并失败不中断主流程。


### 设计意图

  解决"云端模型直接写入 MEMORY.md 时 FULL 可能遗漏这些新增内容"的问题。
  在 syncMemoryToClean() 的第一步调用，确保 FULL 是最完整的记录，
  后续从 FULL 过滤/脱敏到 CLEAN 时不会丢失云端模型的写入。
  使用逐行去重（Set 查找 O(1)）而非整文件比较，性能可接受。
## 函数：syncMemoryToClean(privacyConfig?)          (L172-L197)


### 作用

  长期记忆同步：从 MEMORY-FULL.md 同步到 MEMORY.md。
  四步流程：
    1. mergeCleanIntoFull — 捕获云端模型对 MEMORY.md 的新增
    2. 读取 FULL（现已包含所有内容）
    3. filterGuardContent — 过滤 Guard Agent 段落
    4. redactContent — PII 脱敏（本地模型优先，regex 兜底）
    5. 将结果写回 MEMORY.md

### 参数

  privacyConfig?: PrivacyConfig — 传递给 redactContent 控制脱敏行为

### 返回值

  Promise<void>

### 逐行逻辑


**L175**:
```typescript
await this.mergeCleanIntoFull();
```
> Step 0：合并云端新增到 FULL，确保不遗漏。


**L178**:
```typescript
const fullMemory = await this.readMemory(false);
```
> 读取合并后的 FULL 内容。


**L180-L182**:
```typescript
if (!fullMemory) { return; }
```
> FULL 为空则无需同步。


**L185**:
```typescript
const guardStripped = this.filterGuardContent(fullMemory);
```
> Phase 1：移除 GUARD_SECTION_BEGIN/END 标记之间的 Guard Agent 内容。


**L188**:
```typescript
const cleanMemory = await this.redactContent(guardStripped, privacyConfig);
```
> Phase 2：对过滤后的文本进行 PII 脱敏。
> 优先使用本地模型脱敏，不可用时 fallback 到 regex 规则。


**L191**:
```typescript
await this.writeMemory(cleanMemory, true);
```
> 覆盖写入 MEMORY.md（isCloudModel=true → Clean 轨道）。


**L193-L196**:
```typescript
catch (err) { console.error(...) }
```
> 同步失败不中断主流程。


### 设计意图

  这是核心的 FULL → CLEAN 同步流程。由 hooks.ts 在以下时机调用：
  - session_end（Hook 7, L887）
  - after_compaction（Hook 8, L906）
  - before_reset（Hook 10, L940）
  通过 syncAllMemoryToClean() 间接调用，确保长期记忆和每日记忆都被同步。
## 函数：syncDailyMemoryToClean(privacyConfig?)    (L203-L263)


### 作用

  批量同步所有每日记忆文件：memory-full/*.md → memory/*.md。
  每个文件经历：合并云端新增 → Guard 段落过滤 → PII 脱敏。

### 参数

  privacyConfig?: PrivacyConfig — 传递给 redactContent

### 返回值

  Promise<number> — 成功同步的文件数

### 逐行逻辑


**L206-L207**:
```typescript
const fullDir = this.getMemoryDir(false);
```

             const cleanDir = this.getMemoryDir(true);
> 获取两个轨道的目录路径。

**L209-L211**:
```typescript
if (!fs.existsSync(fullDir)) { return 0; }
```
> Full 目录不存在则无文件可同步。


**L213**:
```typescript
await fs.promises.mkdir(cleanDir, { recursive: true });
```
> 确保 Clean 目录存在（Full 目录已确认存在）。


**L216-L222**:
```typescript
const fullFiles = ...; const cleanFiles = ...; const allFiles = [...new Set(...)];
```
> 分别收集两个目录中的 .md 文件名，合并去重。
> 需要合并两个目录是因为云端模型可能直接写入 memory/ 目录，
> 产生 Full 目录中没有对应文件的情况。
> L216 的 fs.existsSync(fullDir) 已在 L209 检查过，这里的
> 重复检查是多余的（但无害）。


**L224-L252**:
```typescript
for (const file of allFiles) { ... }
```
> 逐文件执行同步流程：


**L230**:
```typescript
await this.mergeDailyFile(fullPath, cleanPath);
```
> Step 0：将 Clean 中独有的行合并到 Full（与 mergeCleanIntoFull 同理）。
> 使用直接文件路径而非 Date 对象，避免时区转换问题。


**L232-L235**:
```typescript
const fullContent = fs.existsSync(fullPath) ? readFile(...) : "";
```
> 重新读取 Full 内容（合并后可能有新增）。
> 文件可能不存在（仅 Clean 有文件时 mergeDailyFile 会创建，
> 但若 cleanContent 为空则不会创建）。


**L237-L238**:
```typescript
if (!fullContent.trim()) { continue; }
```
> 内容为空跳过此文件。


**L241**:
```typescript
const guardStripped = this.filterGuardContent(fullContent);
```
> Phase 1：过滤 Guard Agent 段落。


**L244**:
```typescript
const cleanContent = await this.redactContent(guardStripped, privacyConfig);
```
> Phase 2：PII 脱敏。


**L247**:
```typescript
await fs.promises.writeFile(cleanPath, cleanContent, "utf-8");
```
> 直接写入文件（不经过 writeMemory()），因为已有完整的绝对路径。


**L248**:
```typescript
synced++;
```
> 计数成功同步的文件。


**L249-L251**:
```typescript
catch (fileErr) { console.error(...) }
```
> 单个文件失败不影响其他文件的同步。


**L254-L258**:
```typescript
if (synced > 0) { console.log(...) }
```
> 仅在有实际同步时输出日志。


### 设计意图

  与 syncMemoryToClean() 配对，处理每日粒度的记忆文件。两者由
  syncAllMemoryToClean() 串联调用。逐文件独立错误处理确保一个
  损坏的每日文件不会阻断其余文件的同步。
## 函数：syncAllMemoryToClean(privacyConfig?)       (L268-L271)


### 作用

  一次性同步所有内存：长期记忆 + 全部每日文件。

### 参数

  privacyConfig?: PrivacyConfig — 传递给子方法

### 返回值

  Promise<void>

### 逐行逻辑


**L269**:
```typescript
await this.syncMemoryToClean(privacyConfig);
```
> 先同步长期记忆文件（MEMORY-FULL.md → MEMORY.md）。


**L270**:
```typescript
await this.syncDailyMemoryToClean(privacyConfig);
```
> 再同步所有每日记忆文件。


### 设计意图

  对外暴露的便捷方法，hooks.ts 中 session_end / after_compaction /
  before_reset 三个 hook 都调用此方法完成全量同步。
  顺序执行（先长期后每日），避免并发写入冲突。
## 函数：redactContentPublic(text, privacyConfig?)  (L277-L279)


### 作用

  PII 脱敏的公共别名，供同步流程之外的调用方使用。

### 参数

  text: string — 要脱敏的文本
  privacyConfig?: PrivacyConfig — 控制脱敏行为

### 返回值

  Promise<string> — 脱敏后的文本

### 逐行逻辑


**L278**:
```typescript
return this.redactContent(text, privacyConfig);
```
> 直接委托给 private 方法 redactContent()。


### 设计意图

  redactContent() 是 private 方法，但 hooks.ts 中的 syncMemoryWrite()
  helper（L1212）需要对内存写入内容进行 PII 脱敏。此 public 别名
  打破了封装但提供了受控的访问入口，避免暴露全部内部方法。
函数：redactContent(text, privacyConfig?)        (L284-L303)
                                                 [private]

### 作用

  共享的 PII 脱敏逻辑：优先使用本地模型，不可用时 fallback 到 regex 规则。

### 参数

  text: string — 要脱敏的文本
  privacyConfig?: PrivacyConfig — 若提供则尝试本地模型脱敏

### 返回值

  Promise<string> — 脱敏后的文本

### 逐行逻辑


**L285**:
```typescript
const redactionOpts = privacyConfig?.redaction;
```
> 提取 RedactionOptions（控制 email / chinesePhone 等可选规则开关）。


**L286**:
```typescript
if (privacyConfig) {
```
> 有配置时才尝试本地模型脱敏。


**L287**:
```typescript
const { desensitized, wasModelUsed } = await desensitizeWithLocalModel(text, privacyConfig);
```
> 调用 local-model.ts 的两步脱敏：
> Step 1: 本地模型识别 PII 项（JSON 数组）
> Step 2: 编程替换为 [REDACTED:xxx] 标记
> wasModelUsed=true 表示模型成功参与，false 表示模型不可用。


**L289-L291**:
```typescript
if (wasModelUsed && desensitized !== text) { return desensitized; }
```
> 模型成功且确实做了修改——使用模型脱敏结果。
> 双重检查 desensitized !== text 防止模型返回原文不变时
> 跳过 regex 兜底（模型可能漏检）。


**L294-L298**:
```typescript
console.log(...); return redactSensitiveInfo(text, redactionOpts);
```
> Fallback：模型不可用或返回原文，使用 utils.ts 的 regex 规则脱敏。
> 日志区分 "returned unchanged"（模型正常但未检出 PII）和
> "unavailable"（模型不可达）两种情况。


**L301-L302**:
```typescript
console.log(...); return redactSensitiveInfo(text, redactionOpts);
```
> 无 privacyConfig 时直接走 regex 规则。
> 注意：此处 redactionOpts 始终为 undefined（因为 privacyConfig 为空），
> 意味着所有 opt-in 的脱敏规则（email, chinesePhone 等）都不会生效，
> 仅默认的 always-on 规则（SSH key, API key, AWS key, DB connection,
> 快递单号, 门禁码）会执行。


### 设计意图

  两层脱敏策略体现了"本地模型优先 + regex 兜底"的设计原则。
  本地模型能理解语义（如 "我家在朝阳区xxx"），regex 只能匹配固定格式。
  但 regex 更可靠（不依赖外部服务），所以作为 fallback 确保最低保护。
函数：mergeDailyFile(fullPath, cleanPath)        (L309-L354)
                                                 [private]

### 作用

  将单个每日 Clean 文件的独有行合并到对应的 Full 文件中。
  直接操作文件路径，无需 Date 转换，规避时区问题。

### 参数

  fullPath: string — Full 轨道每日文件的绝对路径
  cleanPath: string — Clean 轨道每日文件的绝对路径

### 返回值

  Promise<void>

### 逐行逻辑


**L311-L313**:
```typescript
if (!fs.existsSync(cleanPath)) { return; }
```
> Clean 文件不存在则无内容可合并。


**L315-L317**:
```typescript
const cleanContent = ...; if (!cleanContent.trim()) { return; }
```
> 读取 Clean 内容，为空则跳过。


**L320-L322**:
```typescript
const fullContent = fs.existsSync(fullPath) ? readFile(...) : "";
```
> Full 文件可能不存在（首次同步时），此时视为空内容。


**L324-L329**:
```typescript
const fullLines = new Set(fullContent.split("\n").map(...).filter(Boolean));
```
> 构建 Full 内容的行级去重 Set，与 mergeCleanIntoFull 完全相同的逻辑。


**L331-L337**:
```typescript
for (const line of cleanContent.split("\n")) { ... }
```
> 遍历 Clean 行，筛选 Full 中不存在且非 [REDACTED:] 标记的新行。


**L339-L341**:
```typescript
if (newLines.length === 0) { return; }
```
> 无新行则无需写入。


**L344**:
```typescript
await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
```
> 确保 Full 文件的父目录存在（首次同步时可能不存在 memory-full/ 目录）。


**L346-L347**:
```typescript
const appendBlock = ...; await fs.promises.writeFile(fullPath, fullContent + appendBlock, "utf-8");
```
> 同 mergeCleanIntoFull，在 "## Cloud Session Additions" 标题下
> 追加新行，覆盖写入 Full 文件。


**L348-L350**:
```typescript
console.log(...)
```
> 日志包含文件名（path.basename），便于排查具体哪个日期文件被同步。


**L351-L353**:
```typescript
catch (err) { console.error(...) }
```
> 单文件失败不影响调用方继续处理其他文件。


### 设计意图

  mergeCleanIntoFull 的每日版本。与其共享完全相同的去重和合并逻辑，
  但直接操作文件路径而非通过 readMemory/writeMemory 抽象层，
  避免了在 syncDailyMemoryToClean 循环中频繁的路径计算。
  代码与 mergeCleanIntoFull 高度重复——详见 Code Review §DRY。
函数：filterGuardContent(content)                (L362-L382)
                                                 [private]

### 作用

  从记忆文本中过滤掉 Guard Agent 生成的内容段落。
  使用 GUARD_SECTION_BEGIN / GUARD_SECTION_END HTML 注释标记
  来定界 Guard 段落。

### 参数

  content: string — 原始记忆文本

### 返回值

  string — 过滤后的文本

### 逐行逻辑


**L363**:
```typescript
const lines = content.split("\n");
```
> 按行拆分文本，逐行扫描。


**L364**:
```typescript
const filtered: string[] = [];
```
> 收集过滤后的行。


**L365**:
```typescript
let inGuardSection = false;
```
> 状态标志：当前是否在 Guard 段落内。


**L367-L379**:
```typescript
for (const line of lines) { ... }
```
> 逐行遍历：


**L368-L370**:
```typescript
if (line.trim() === GUARD_SECTION_BEGIN) { inGuardSection = true; continue; }
```
> 遇到开始标记——进入 Guard 段落，跳过此行（标记本身不输出）。


**L372-L374**:
```typescript
if (line.trim() === GUARD_SECTION_END) { inGuardSection = false; continue; }
```
> 遇到结束标记——退出 Guard 段落，跳过此行。


**L376-L378**:
```typescript
if (!inGuardSection) { filtered.push(line); }
```
> 不在 Guard 段落内的行正常保留。


**L381**:
```typescript
return filtered.join("\n");
```
> 将过滤后的行重新拼接为文本。


### 设计意图

  简洁的状态机实现，O(n) 扫描。仅依赖显式标记，不做启发式内容猜测。
  注释提到"Falls back to the legacy heuristic"但实际代码未实现
  legacy fallback——如果内容在标记引入之前写入，Guard 内容将不会被过滤。
  这是一个 comment-code mismatch（详见 Code Review）。
## 函数：initializeDirectories()                    (L387-L399)


### 作用

  确保 memory/ 和 memory-full/ 两个目录都存在。

### 参数

  无

### 返回值

  Promise<void>

### 逐行逻辑


**L389-L390**:
```typescript
const fullDir = this.getMemoryDir(false);
```

             const cleanDir = this.getMemoryDir(true);
> 获取两个轨道的目录路径。

**L392-L393**:
```typescript
await fs.promises.mkdir(fullDir, { recursive: true });
```

             await fs.promises.mkdir(cleanDir, { recursive: true });
> 递归创建目录。已存在则 no-op。

**L395**:
```typescript
console.log("[GuardClaw] Memory directories initialized");
```
> 确认日志。


**L397-L398**:
```typescript
catch (err) { console.error(...) }
```
> 初始化失败记录错误但不抛出。


### 设计意图

  在 hooks.ts 的 registerHooks() 启动阶段调用（L118-L121），
  确保后续读写操作不会因目录缺失而失败。
## 模块级变量：defaultMemoryManager                  (L404)


单例缓存，保存全局唯一的 MemoryIsolationManager 实例。
初始为 null，由 getDefaultMemoryManager() 惰性初始化。
## 函数：getDefaultMemoryManager(workspaceDir?)      (L406-L411)


### 作用

  获取或创建全局单例的 MemoryIsolationManager。

### 参数

  workspaceDir?: string — 可选的工作空间路径

### 返回值

  MemoryIsolationManager — 全局单例实例

### 逐行逻辑


**L407**:
```typescript
if (!defaultMemoryManager || workspaceDir) {
```
> 两种情况重新创建实例：
> 1. 尚未初始化（null）
> 2. 传入了新的 workspaceDir（需要切换工作空间）


**L408**:
```typescript
defaultMemoryManager = new MemoryIsolationManager(workspaceDir);
```
> 创建新实例并缓存。
> 注意：当传入 workspaceDir 时会无条件覆盖现有实例，
> 即使新旧路径相同也会重建——可优化但影响不大。


**L410**:
```typescript
return defaultMemoryManager;
```
> 返回单例。


### 设计意图

  与 session-manager.ts 的 getDefaultSessionManager() 使用完全相同的
  单例模式。hooks.ts 在 registerHooks() 中调用（L118）初始化，
  后续各 hook 通过 getDefaultMemoryManager() 获取同一实例。
##


## Part A — Code 层面改动建议


#### 🟡 mergeCleanIntoFull 与 mergeDailyFile 的高度重复


 现状（L116-L156 & L309-L354）：
   两个方法包含几乎完全相同的逻辑：按行拆分 → Set 去重 → 排除 [REDACTED:]
   → 拼接 appendBlock → 写入。唯一差异是输入来源（readMemory() vs 文件路径）
   和日志消息。

 问题：
   违反 DRY 原则。修改去重逻辑（如需要额外排除某种标记）时需要同步修改
   两处，遗漏将导致行为不一致。

 建议：
   提取私有方法 mergeContent(cleanContent: string, fullContent: string): string[]
   返回新增行列表，mergeCleanIntoFull 和 mergeDailyFile 只负责 I/O 和日志。


#### 🟢 syncDailyMemoryToClean 中 fullDir 的重复 existsSync 检查


 现状（L209 & L216）：
   L209 已检查 !fs.existsSync(fullDir) 并提前返回，
   L216 又对同一 fullDir 做了一次 existsSync 检查（在三元运算中）。

 问题：
   冗余检查。L216 的 existsSync 永远为 true（否则 L209 已返回）。
   代码可读性受损，读者需确认两者的关系。

 建议：
   L216 可简化为 const fullFiles = (await fs.promises.readdir(fullDir)).filter(...);


#### 🟢 getDailyMemoryPath 的 UTC 时区问题


 现状（L55）：
   today.toISOString().split("T")[0] 使用 UTC 时区。

 问题：
   UTC+8 时区的用户在本地 00:00-08:00 之间操作时，文件名会归入前一天。
   例如北京时间 2026-03-18 02:00 会生成 "2026-03-17.md"。
   这不是 bug（行为确定），但可能令用户困惑。

 建议：
   若需本地时区一致性，可改用：
   const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
   或在文档中明确说明使用 UTC 日期。


#### 🟢 redactContent 中 redactionOpts 在无 config 时的冗余声明


 现状（L285 & L302）：
   L285 声明 const redactionOpts = privacyConfig?.redaction;
   L302 在 privacyConfig 为 undefined 的分支中调用
   redactSensitiveInfo(text, redactionOpts) — 此时 redactionOpts 必为 undefined。

 问题：
   语义上正确但容易误导——读者可能认为 redactionOpts 在这个分支有值。

 建议：
   L302 改为 return redactSensitiveInfo(text); 明确传达"无配置"语义。


## Part B — 逻辑/设计层面改动建议


#### 🔴 filterGuardContent 注释声称有 legacy heuristic fallback 但代码未实现


 现状（L356-L361, JSDoc）：
   注释说 "Falls back to the legacy heuristic for content written before
   markers were introduced."
   但实际代码（L362-L382）只实现了基于标记的过滤，没有任何 heuristic fallback。

 问题：
   Comment-Code Mismatch。如果存在标记引入前写入的 Guard 内容，它们将原样
   保留在 CLEAN 轨道，泄露 Guard Agent 的交互历史给云端模型。
   这取决于是否有实际的 pre-marker 数据存在——如果这是新系统则影响为零。

 建议：
   方案 A：如果不需要 legacy 支持，删除注释中的 fallback 说明。
   方案 B：如果需要，实现基于内容特征的启发式过滤（如检测
   "[guardclaw:guard]" 或 "[guard agent]" 标记——与 session-manager.ts
   的 isGuardAgentMessage() L151-L155 保持一致）。


#### 🟡 syncMemoryToClean 与 syncDailyMemoryToClean 的并发安全性


 现状（L269-L270）：
   syncAllMemoryToClean 顺序调用两个 sync 方法，但这两个方法本身
   没有互斥锁。如果 session_end 和 after_compaction 几乎同时触发，
   两个 syncAllMemoryToClean 调用会并发运行。

 问题：
   并发的 mergeCleanIntoFull + writeMemory 可能导致 race condition：
   两个调用都读取旧的 fullContent，各自追加 appendBlock，后写入的覆盖
   先写入的结果，导致行丢失。
   DualSessionManager 有 withWriteLock（L31-L36）但 MemoryIsolationManager 没有。

 建议：
   为 syncAllMemoryToClean（或至少 writeMemory）添加互斥锁（类似
   DualSessionManager 的 withWriteLock 模式），或在调用层（hooks.ts）
   使用防抖/串行化队列。


#### 🟡 与 DualSessionManager 的功能重叠


 现状：
   MemoryIsolationManager 管理 MEMORY.md / MEMORY-FULL.md（长期 + 每日记忆）。
   DualSessionManager 管理 sessions/full/ / sessions/clean/（会话历史）。
   两者有相似的概念（full/clean 双轨、构造函数的 ~ 展开、单例模式）
   但完全独立实现。

 问题：
   不是 bug，但概念重叠增加了维护成本。两个管理器的同步逻辑
   （内存 vs 会话历史）可能在未来需要一致地修改。

 建议：
   中期考虑抽象出一个 DualTrackStore 基类/接口，统一路径管理、
   写入锁和同步逻辑，MemoryIsolationManager 和 DualSessionManager
   各自实现具体的过滤/脱敏策略。


#### 🟡 getDefaultMemoryManager 不使用 hooks.ts 传入的 workspaceDir


 现状（hooks.ts L118）：
   const memoryManager = getDefaultMemoryManager();
   调用时未传入 workspaceDir，使用默认值 "~/.openclaw/workspace"。
   但 hooks.ts L149 缓存了 ctx.workspaceDir，用于 syncMemoryWrite()。

 问题：
   如果实际 workspaceDir 不是默认值（用户通过 guardAgent.workspace
   配置了自定义路径），MemoryIsolationManager 仍使用默认路径，
   导致内存文件写到错误位置。

 建议：
   在 registerHooks() 中从 privacyConfig.guardAgent?.workspace 读取
   workspaceDir 并传入 getDefaultMemoryManager(workspaceDir)。


## 优先级总览


| # | 优先级 | 标题                                           |
|---|--------|------------------------------------------------|
| 5 |  🔴   | filterGuardContent 注释与代码不一致              |
| 1 |  🟡   | mergeCleanIntoFull 与 mergeDailyFile 代码重复    |
| 6 |  🟡   | sync 方法缺少并发互斥锁                          |
| 7 |  🟡   | MemoryIsolationManager 与 DualSessionManager 重叠 |
| 8 |  🟡   | getDefaultMemoryManager 未使用实际 workspaceDir   |
| 2 |  🟢   | syncDailyMemoryToClean 中冗余的 existsSync       |
| 3 |  🟢   | getDailyMemoryPath UTC 时区问题                  |
| 4 |  🟢   | redactContent 无 config 分支的 redactionOpts 冗余 |
