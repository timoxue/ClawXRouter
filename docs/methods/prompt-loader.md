# prompt-loader.ts — 逐方法文档


 文件定位：Prompt 模板加载器
 所属模块：GuardClaw 隐私路由系统

 核心职责：在运行时从 `extension/prompts/*.md` 文件加载 Prompt 模板，
 让用户可以通过编辑 Markdown 文件来自定义检测标准、Guard Agent 行为
 以及 PII 提取逻辑，无需修改代码。加载的内容带有内存缓存机制，
 Dashboard 写入新内容后自动失效缓存，下一次请求重新从磁盘读取。

 调用方一览：
   hooks.ts        — loadPrompt("guard-agent-system", ...)
   local-model.ts  — loadPrompt("detection-system", ...)
                     loadPromptWithVars("pii-extraction", ...)
   token-saver.ts  — loadPrompt("token-saver-judge", ...)
   stats-dashboard — readPromptFromDisk / writePrompt (Dashboard CRUD)
## 模块级导入与常量                              (L1-L36)


**L11**:
```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
```
> 引入 Node.js 同步文件系统 API。
> 选用同步版本是因为 prompt 加载发生在请求热路径的同步调用链中，
> 且有缓存兜底，只在首次命中时执行 I/O。


**L12**:
```typescript
import { resolve, dirname } from "node:path";
```
> resolve 用于将相对路径拼接为绝对路径。
> dirname 用于获取当前文件所在目录。


**L13**:
```typescript
import { fileURLToPath } from "node:url";
```
> ESM 没有 __filename / __dirname，需要手动从 import.meta.url 转换。


**L15-L16**:
```typescript
const __filename / __dirname
```
> ESM 环境下的经典 polyfill：
> fileURLToPath(import.meta.url) → 当前文件的绝对路径
> dirname(__filename) → 当前文件所在目录


**L33**:
```typescript
const PROMPTS_DIR = resolvePromptsDir();
```
> 模块加载时立即计算 prompts 目录的绝对路径并缓存到模块级常量。
> 后续所有函数直接使用此常量，避免重复路径解析。


**L36**:
```typescript
const cache = new Map<string, string>();
```
> 模块级缓存：key 是 prompt 名称（如 "detection-system"），
> value 是 prompt 内容字符串。
> 生命周期等于进程生命周期，由 invalidatePrompt() 手动失效。

## 函数：resolvePromptsDir()                     (L22-L31)


### 作用

  确定 prompts/ 目录的绝对路径。兼容从源码目录（src/）和
  编译输出目录（dist/src/）两种运行场景。

### 参数

  无

### 返回值

  string — prompts 目录的绝对路径。如果两个候选路径均不存在，
  返回第一个候选路径作为 fallback（后续函数会走 per-file fallback）。

### 逐行逻辑


**L23-L26**:
```typescript
const candidates = [
```

             resolve(__dirname, "../prompts"),
             resolve(__dirname, "../../prompts"),
           ];
> 定义两个候选路径：
> 候选 1：../prompts — 适用于从 src/ 运行（src/ → prompts/）
> 候选 2：../../prompts — 适用于从 dist/src/ 运行（dist/src/ → prompts/）
> 用 resolve() 确保生成绝对路径，不受 cwd 影响。

**L27-L29**:
```typescript
for (const dir of candidates) {
```

             if (existsSync(dir)) return dir;
           }
> 顺序遍历候选路径，返回第一个实际存在的目录。
> existsSync 是同步调用，只在模块初始化时执行一次，性能可接受。

**L30**:
```typescript
return candidates[0];
```
> 两个候选都不存在时的 fallback。
> 返回第一个候选路径（不存在的目录），后续 loadPrompt() 会
> 因为 existsSync(filePath) 为 false 而走 fallback 分支。
> 这种设计让错误处理延迟到具体的 prompt 加载时。


### 设计意图

  GuardClaw 可能以 ts-node 开发模式或 tsc 编译后运行，
  两种模式下 __dirname 不同。此函数用"候选路径 + 探测"模式
  屏蔽了这一差异，使 prompt 文件始终可以从正确的位置加载。
## 函数：loadPrompt(name, fallback)              (L44-L65)


### 作用

  从 `prompts/{name}.md` 加载 prompt 模板。如果文件不存在或读取
  失败，则返回调用方提供的 fallback 字符串。结果会被缓存，同一
  prompt 在进程生命周期内只读一次磁盘。

### 参数

  name: string     — prompt 文件名（不含 .md 后缀），
                      如 "detection-system"、"guard-agent-system"
  fallback: string — 文件缺失/异常时使用的默认 prompt 内容。
                      通常由调用方用 const 常量定义（如 DEFAULT_DETECTION_SYSTEM_PROMPT）。

### 返回值

  string — prompt 内容。优先级：缓存 > 磁盘文件 > fallback。

### 逐行逻辑


**L45**:
```typescript
const cached = cache.get(name);
```
> 先查内存缓存。


**L46**:
```typescript
if (cached !== undefined) return cached;
```
> 命中缓存直接返回，避免磁盘 I/O。
> 注意用 !== undefined 而非 truthy 检查，
> 这样即使缓存了空字符串也能正确命中。


**L48**:
```typescript
const filePath = resolve(PROMPTS_DIR, `${name}.md`);
```
> 拼接出 prompt 文件的绝对路径。
> 例如 name="detection-system" →
> "/path/to/guardclaw/prompts/detection-system.md"


**L49**:
```typescript
let content: string;
```
> 声明 content 变量，稍后在 try 块中赋值。


**L51-L61**:
```typescript
try { ... } catch { ... }
```
> 外层 try-catch 捕获所有文件系统异常（权限不足、编码错误等）。


**L52**:
```typescript
if (existsSync(filePath)) {
```
> 先检查文件是否存在，避免 readFileSync 抛出 ENOENT 异常。


**L53**:
```typescript
content = readFileSync(filePath, "utf-8").trim();
```
> 同步读取文件内容，指定 UTF-8 编码。
> .trim() 去除首尾空白，防止 prompt 拼接时出现多余换行。


**L54**:
```typescript
console.log(`[GuardClaw] Loaded custom prompt: prompts/${name}.md`);
```
> 成功加载自定义 prompt 时输出日志，方便用户确认自定义文件生效。


**L55-L57**:
```typescript
} else { content = fallback; }
```
> 文件不存在时，使用调用方提供的 fallback 默认内容。
> 不输出日志（文件不存在是正常情况——用户未自定义）。


**L58-L60**:
```typescript
} catch { content = fallback; }
```
> 捕获到异常（如权限不足）时，输出 warn 日志并降级到 fallback。
> 使用 catch {} 而非 catch (e) {}，因为不需要错误对象的具体信息。


**L63**:
```typescript
cache.set(name, content);
```
> 无论来源（磁盘/fallback），都写入缓存。
> 即使是 fallback 也缓存，避免每次请求都触发 existsSync + readFileSync。


**L64**:
```typescript
return content;
```
> 返回最终的 prompt 内容。


### 设计意图

  这是整个模块的核心函数。采用"缓存 → 磁盘 → 默认"三级 fallback 链，
  保证即使 prompt 文件缺失或损坏，系统也不会崩溃，而是退化到代码内
  嵌的默认 prompt。调用方只需关心 (名称, 默认值)，完全不感知文件路径。
## 函数：loadPromptWithVars(name, fallback, vars) (L70-L80)


### 作用

  在 loadPrompt() 基础上增加模板变量替换功能。
  将 prompt 中的 `{{PLACEHOLDER}}` 标记替换为实际值。

### 参数

  name: string                  — prompt 文件名（不含 .md）。
  fallback: string              — 默认 prompt 内容。
  vars: Record<string, string>  — 替换映射表，key 为占位符名，value 为替换内容。
                                  例如 { CONTENT: "some text" } 会将
                                  {{CONTENT}} 替换为 "some text"。

### 返回值

  string — 变量替换后的 prompt 内容。

### 逐行逻辑


**L75**:
```typescript
let prompt = loadPrompt(name, fallback);
```
> 调用 loadPrompt 获取原始模板内容（带缓存）。


**L76-L78**:
```typescript
for (const [key, value] of Object.entries(vars)) {
```

             prompt = prompt.replaceAll(`{{${key}}}`, value);
           }
> 遍历 vars 中每对 key-value。
> 使用 replaceAll（非 replace）确保同一占位符出现多次时全部替换。
> 模板语法：双花括号 {{KEY}}，简洁且不易与 Markdown 语法冲突。

**L79**:
```typescript
return prompt;
```
> 返回替换完成的 prompt 字符串。


### 设计意图

  将模板变量替换与 prompt 加载解耦。loadPrompt 专注读取和缓存，
  loadPromptWithVars 在其之上做文本替换。
  目前调用方只有 local-model.ts 的 PII 提取功能使用此函数，
  用 {{CONTENT}} 注入待提取的文本片段。
## 函数：invalidatePrompt(name)                  (L83-L85)


### 作用

  从缓存中删除指定 prompt，使下一次 loadPrompt() 重新从磁盘读取。

### 参数

  name: string — 要失效的 prompt 名称（与 loadPrompt 的 name 对应）。

### 返回值

  void — 无返回值。

### 逐行逻辑


**L84**:
```typescript
cache.delete(name);
```
> 从 Map 中删除该 key。
> 如果 key 不存在，delete() 不抛错也不返回 false，安全无副作用。


### 设计意图

  缓存失效的最小粒度操作。Dashboard 通过 writePrompt() 写入新内容后
  自动调用此函数，确保后续请求使用最新的 prompt。
  设计为单个 prompt 粒度失效（非全量清空），减少不必要的磁盘重读。
## 函数：writePrompt(name, content)              (L91-L96)


### 作用

  将 prompt 内容写入 `prompts/{name}.md` 文件，并失效其缓存。
  供 Dashboard 的 "保存 prompt" 功能调用。

### 参数

  name: string    — prompt 文件名（不含 .md）。
  content: string — 要写入的 prompt 内容。

### 返回值

  void — 无返回值。写入失败时抛出异常，由调用方处理。

### 逐行逻辑


**L92**:
```typescript
mkdirSync(PROMPTS_DIR, { recursive: true });
```
> 确保 prompts 目录存在。recursive: true 意味着即使目录已存在也不报错，
> 类似 mkdir -p。在目录已存在的常见场景下开销极小。


**L93**:
```typescript
const filePath = resolve(PROMPTS_DIR, `${name}.md`);
```
> 拼接目标文件绝对路径。


**L94**:
```typescript
writeFileSync(filePath, content, "utf-8");
```
> 同步写入文件，覆盖已有内容。
> 使用 UTF-8 编码与 readFileSync 保持一致。


**L95**:
```typescript
invalidatePrompt(name);
```
> 写入后立即失效缓存，确保下一次 loadPrompt() 读取最新内容。
> 注意这里不是直接更新缓存（cache.set），而是删除缓存让下次读取时
> 重新从磁盘加载。这保证了"磁盘文件 = 唯一真相来源"的设计原则。


### 设计意图

  提供完整的写入 + 缓存失效原子操作。Dashboard 调用此函数后，
  后续请求（loadPrompt）会自动使用新内容，无需重启进程。
  mkdirSync 的 defensive 调用确保即使 prompts 目录被意外删除，
  写入操作也能成功恢复目录。
## 函数：readPromptFromDisk(name)                (L102-L110)


### 作用

  直接从磁盘读取 prompt 文件内容，完全绕过缓存。
  如果文件不存在或不可读，返回 null。

### 参数

  name: string — prompt 文件名（不含 .md）。

### 返回值

  string | null — 文件内容（trim 后），文件不存在/读取失败返回 null。
  与 loadPrompt 的区别：loadPrompt 在文件缺失时返回 fallback，
  此函数返回 null 让调用方明确区分"未自定义"和"有自定义"。

### 逐行逻辑


**L103**:
```typescript
const filePath = resolve(PROMPTS_DIR, `${name}.md`);
```
> 拼接绝对路径。


**L104-L108**:
```typescript
try {
```

               if (existsSync(filePath)) {
                 return readFileSync(filePath, "utf-8").trim();
               }
             } catch { /* file unreadable */ }
> 结构与 loadPrompt 的读取逻辑类似，但更精简：
> 文件存在则读取并返回（trim 去除首尾空白）。
> 文件不存在或读取异常时静默跳过（catch 空块）。
> catch 空块是有意为之——调用方通过 null 处理缺失场景。

**L109**:
```typescript
return null;
```
> 默认返回 null，表示"磁盘上没有自定义文件"。


### 设计意图

  专为 Dashboard 的 "查看 prompt" API 设计（stats-dashboard.ts L229）。
  Dashboard 需要区分三种状态：
    1. 用户已自定义（返回自定义内容）
    2. 用户未自定义（返回 null → 前端展示默认内容）
    3. 文件异常（也返回 null → 前端展示默认内容）
  这种 null 语义让 Dashboard 能正确显示"是否已自定义"的标识。
  不走缓存是因为 Dashboard 需要展示磁盘实际状态，而缓存可能已经
  包含了 fallback 值（loadPrompt 会把 fallback 也缓存）。


### Part A — Code 层面改动建议


#### 🟡 writePrompt 写入后不更新缓存，依赖下次读取重建


 现状（L94-L95）：writeFileSync 写入文件后，调用 invalidatePrompt
     删除缓存，下一次 loadPrompt 会重新从磁盘读取。
 问题：在写入和下次读取之间存在一个"缓存为空"的窗口期。
     如果在高并发场景下，多个请求同时 loadPrompt，可能会重复
     执行 readFileSync。虽然最终结果正确，但有不必要的磁盘 I/O。
 建议：writePrompt 写入后直接更新缓存而非仅删除：
     ```
     cache.set(name, content);
     ```

     这样 invalidatePrompt 可以省略，下次 loadPrompt 直接命中缓存。
     若要保持"磁盘为唯一真相"的设计哲学，当前实现也可接受。


#### 🟢 loadPrompt 的 fallback 也被缓存，可能掩盖后续添加的文件


 现状（L63）：cache.set(name, content) 在 content 来自 fallback 时
     也会执行，即"文件不存在"的结果也被缓存。
 问题：如果用户在进程运行期间手动将 prompt 文件放入 prompts/ 目录
     （不通过 Dashboard / writePrompt），loadPrompt 不会读到新文件，
     因为缓存已经存储了 fallback 值。
 建议：可以选择只在文件实际存在时缓存，fallback 不缓存：
     ```
     if (content !== fallback) cache.set(name, content);
     ```

     但这会导致每次调用都执行 existsSync，需权衡性能与灵活性。
     当前设计假设 prompt 变更只通过 Dashboard（writePrompt）进行，
     若此假设成立则无需改动。


#### 🟢 resolvePromptsDir 缺少日志/警告


 现状（L30）：两个候选路径都不存在时，静默返回 candidates[0]。
 问题：如果部署配置错误导致 prompts 目录缺失，用户不会收到任何提示，
     只会发现所有 prompt 都是默认值，排查困难。
 建议：在 fallback 分支添加一行 console.warn：
     ```
     console.warn("[GuardClaw] prompts/ directory not found, using defaults");
     ```


#### 🟢 catch 块未使用错误参数


 现状（L58, L108）：catch {} 不绑定错误对象。
 问题：L58 的 console.warn 输出了固定文本但不含错误详情（如 EACCES、
     EISDIR 等），在排查问题时信息不足。L108 完全静默。
 建议：至少在 L58 捕获错误并输出：
     ```
     catch (err) {
       console.warn(`[GuardClaw] Failed to read prompts/${name}.md:`, err);
       content = fallback;
     }
     ```


### Part B — 逻辑/设计层面改动建议


#### 🟡 writePrompt 写入内容未做 trim，但 loadPrompt/readPromptFromDisk 读取时 trim


 现状（L94 vs L53, L106）：writeFileSync 写入的是原始 content，
     而 readFileSync 读取后会 .trim()。
 问题：写入和读取之间存在不对称。如果 Dashboard 传入带尾部换行的
     content，写入后立即 readPromptFromDisk 读取，得到的是 trim
     后的版本，与写入的内容不一致。虽然通常无害，但在 prompt
     内容做 hash 比对（如判断是否已修改）时可能产生误判。
 建议：在 writePrompt 中也 trim，保持写入/读取对称：
     ```
     writeFileSync(filePath, content.trim(), "utf-8");
     ```

     或者在 readFileSync 时不 trim，由调用方决定是否需要。


#### 🔴 缺少路径遍历（Path Traversal）防护


 现状（L48, L93, L103）：name 参数直接拼入 resolve() 构建文件路径。
 问题：如果调用方传入 name = "../../etc/passwd"，resolve() 会生成
     prompts 目录之外的路径，可能导致任意文件读取（loadPrompt /
     readPromptFromDisk）或任意文件写入（writePrompt）。
     当前场景中 name 由代码常量控制（"detection-system"、
     "guard-agent-system" 等），但 Dashboard API（stats-dashboard.ts
     L253）接受 body.name 作为输入——虽然 Dashboard 有白名单校验
     （EDITABLE_PROMPTS），但 prompt-loader 自身没有防御。
 建议：在 loadPrompt / writePrompt / readPromptFromDisk 中添加
     路径校验：
     ```
     const filePath = resolve(PROMPTS_DIR, `${name}.md`);
     if (!filePath.startsWith(PROMPTS_DIR)) {
       throw new Error(`Invalid prompt name: ${name}`);
     }
     ```

     作为纵深防御，即使调用方已做白名单校验，底层模块也应自保。


#### 🟡 无"热重载"机制——需手动通过 Dashboard 触发缓存失效


 现状：缓存失效只在 writePrompt（L95）时触发。
 问题：如果用户直接编辑 prompts/*.md 文件（不通过 Dashboard），
     修改不会生效，直到进程重启。对于开发调试场景不太友好。
 建议：可选方案——
     (a) 使用 fs.watchFile / chokidar 监听 prompts 目录变更，
         自动 invalidate。开销不大（只有几个文件），但增加复杂度。
     (b) 提供 invalidateAll() 导出函数，让 CLI/API 可以手动触发。
     (c) 在 loadPrompt 中加入 TTL（如 5 分钟），过期后重新读取。
     当前设计对生产环境已足够（所有变更通过 Dashboard），
     但开发体验可以优化。


#### 🟡 与 sibling 模块（config-schema.ts / live-config.ts）的设计不一致


 现状：prompt-loader 使用自己的 Map 缓存，失效策略由 invalidatePrompt 控制。
 问题：live-config.ts 使用不同的缓存机制（getLiveConfig / updateLiveConfig），
     config-schema.ts 的 defaultPrivacyConfig 是静态常量无缓存。
     三种配置性数据用三种不同的缓存/加载模式，增加了维护的认知负担。
 建议：中长期可考虑统一为一个"配置加载器"抽象，统一管理缓存失效。
     但当前模块规模不大，分散管理的实际问题有限，标记为中优先级。


### 优先级总览


| 优先级 | 编号 | 标题 |
| --- | --- | --- |
| 🔴 高 | 6 | 缺少路径遍历（Path Traversal）防护 |
| 🟡 中 | 1 | writePrompt 写入后不更新缓存 |
| 🟡 中 | 5 | write 不 trim 但 read 做 trim 的不对称 |
| 🟡 中 | 7 | 无热重载机制 |
| 🟡 中 | 8 | 与 sibling 模块缓存设计不一致 |
| 🟢 低 | 2 | fallback 也缓存可能掩盖新增文件 |
| 🟢 低 | 3 | resolvePromptsDir 无日志 |
| 🟢 低 | 4 | catch 块缺少错误详情 |
