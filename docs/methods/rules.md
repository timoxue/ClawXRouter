# rules.ts — 逐方法文档


 文件定位：基于规则的敏感度检测器（Rule-based Sensitivity Detector）
 所属模块：GuardClaw 隐私路由系统

 核心职责：对用户消息、工具名称、工具参数、工具执行结果进行规则级别的
 敏感度检测。检测维度包括关键词匹配、正则表达式匹配、工具类型判定和
 参数路径分析，最终聚合所有命中结果取最高敏感等级返回 DetectionResult。

 敏感等级体系：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理(proxy)或本地模型(local)
   S3 — 高度敏感，强制本地模型处理
## 模块级常量与缓存                              (L12-L13)


PATTERN_CACHE_MAX: number = 500
    正则缓存的最大容量上限。当缓存中的 pattern 数量达到此值时，
    淘汰最早插入的条目（FIFO 策略，近似 LRU）。

patternCache: Map<string, RegExp>
    全局正则编译缓存。key 为原始 pattern 字符串，value 为编译后的 RegExp。
    避免同一 pattern 在高频调用中被反复 new RegExp()。

keywordRegexCache: Map<string, RegExp>         (L139)
    关键词正则缓存。与 patternCache 独立，专门缓存 getKeywordRegex()
    构造的带词边界的正则表达式。无容量上限（关键词数量通常远少于 patterns）。
## 函数：getOrCompileRegex(pattern)               (L15-L38)


### 作用

  将用户配置的正则字符串编译为 RegExp 对象，带缓存和容错。
  这是 checkPatterns() 的核心依赖，所有正则匹配都经过此函数。

### 参数

  pattern: string — 用户在配置中提供的正则表达式字符串。
                    可能包含 Python 风格内联标志 (?i)、(?s)、(?m) 等。

### 返回值

  RegExp | null — 编译成功返回 RegExp；非法正则返回 null。

### 逐行逻辑


**L16**:
```typescript
const cached = patternCache.get(pattern);
```
> 先查缓存。Map.get() 在 O(1) 时间内完成。


**L17**:
```typescript
if (cached) return cached;
```
> 命中缓存，直接返回，跳过后续所有编译逻辑。
> 这是热路径上最重要的优化——在高频调用中绝大多数 pattern 已缓存。


**L20**:
```typescript
let flags = "i";
```
> 默认使用大小写不敏感标志。
> 这是隐私检测的合理默认——用户配置 "password" 应同时匹配 "Password"。


**L21-L26**:
```typescript
const cleaned = pattern.replace(/^\(\?([gimsuy]+)\)/, ...)
```
> 用正则匹配 pattern 开头的 Python 风格内联标志 (?i)、(?gimsuy) 等。
> 正则 /^\(\?([gimsuy]+)\)/ 解释：
> ^ — 必须在字符串开头
> \(\? — 匹配字面量 "(?", 转义圆括号
> ([gimsuy]+) — 捕获组，匹配一个或多个合法的 JS 正则标志字符
> \) — 匹配闭合圆括号
> 替换回调 (_m, f: string) => { ... }：
> L22: flags = f.includes("i") ? "i" : "";
> 如果 Python 标志中包含 i，保留大小写不敏感；否则清空。
> L23: if (f.includes("s")) flags += "s";
> Python 的 (?s) 对应 JS 的 "s"（dotAll），使 . 匹配换行符。
> L24: if (f.includes("m")) flags += "m";
> Python 的 (?m) 对应 JS 的 "m"（multiline），使 ^/$ 匹配行首行尾。
> L25: return "";
> 将 (?flags) 前缀从 pattern 中移除，只保留实际正则体。


**L27**:
```typescript
const compiled = new RegExp(cleaned, flags);
```
> 用清理后的 pattern 和解析出的 flags 构造 RegExp。
> 如果 cleaned 不是合法正则，此处抛出 SyntaxError，被 L34 catch。


**L28-L31**:
```typescript
if (patternCache.size >= PATTERN_CACHE_MAX) { ... }
```
> 容量检查：如果缓存已满（≥500），淘汰最早插入的条目。
> L29: const firstKey = patternCache.keys().next().value;
> Map 保持插入顺序，keys().next() 取第一个（最早）的 key。
> L30: if (firstKey !== undefined) patternCache.delete(firstKey);
> 删除最老的条目。undefined 守卫防止在空 Map 时调用 delete。
> 这是一种简化的 FIFO 淘汰策略（非精确 LRU），但对配置驱动的
> pattern 集合足够有效——配置变动频率远低于缓存查找频率。


**L32**:
```typescript
patternCache.set(pattern, compiled);
```
> 将编译结果存入缓存。key 用原始 pattern（含可能的 Python 标志），
> 保证下次传入同一字符串时直接命中。


**L33**:
```typescript
return compiled;
```
> 返回编译好的 RegExp。


**L34-L37**:
```typescript
catch (err) { console.warn(...); return null; }
```
> 捕获 SyntaxError（非法正则字符串）。
> 打印警告日志（含 pattern 内容和错误信息），方便用户调试配置。
> 返回 null——调用方（checkPatterns）会跳过此条规则。
> 关键设计：一条坏正则不会导致整个检测器崩溃。


### 设计意图

  1. 缓存避免热路径上的重复 RegExp 编译（μs 级优化在高并发下累积可观）。
  2. Python 标志兼容——配置文件可能由 Python 背景的开发者维护，
     或从 Python 版本迁移而来。
  3. 容错返回 null 而非抛异常，保证规则引擎的健壮性。
## 函数：detectByRules(context, config)           (L43-L126)


### 作用

  本文件的核心导出函数。对给定的检测上下文执行全维度规则检测，
  聚合所有命中结果，返回最终的 DetectionResult。
  被 hooks.ts 直接调用（S3 快速路径、before_tool_call、tool_result_persist）
  以及被 privacy router 间接调用（通过 detector.ts 的 detectSensitivityLevel）。

### 参数

  context: DetectionContext — 检测上下文，包含：
    checkpoint: "onUserMessage" | "onToolCallProposed" | "onToolCallExecuted"
    message?: string — 用户消息文本
    toolName?: string — 工具名称
    toolParams?: Record<string, unknown> — 工具参数
    toolResult?: unknown — 工具执行结果
    sessionKey?: string — 会话标识

  config: PrivacyConfig — 隐私配置，包含 rules.keywords、rules.patterns、
    rules.tools 等子配置。

### 返回值

  DetectionResult — 包含 level / levelNumeric / reason / detectorType / confidence。

### 逐行逻辑


**L47**:
```typescript
const levels: SensitivityLevel[] = [];
```
> 累积数组：收集各维度检测命中的敏感等级。
> 最终取最大值（maxLevel），实现"多维度投票取最严"策略。


**L48**:
```typescript
const reasons: string[] = [];
```
> 累积数组：收集所有命中原因，最终用 "; " 连接成完整说明。


#### 维度①：消息关键词检测 (L51-L58)


**L51**:
```typescript
if (context.message) {
```
> 只有消息存在时才检测。工具调用场景下 message 可能为 undefined。


**L52**:
```typescript
const keywordResult = checkKeywords(context.message, config);
```
> 调用 checkKeywords()，传入消息文本和完整 PrivacyConfig。
> checkKeywords 内部按 S3 → S2 的优先级逐词匹配，短路返回。


**L53-L57**:
```typescript
if (keywordResult.level !== "S1") { ... }
```
> 只有非 S1（即命中了某个关键词）才累积。
> levels.push(keywordResult.level)：记录命中等级。
> reasons.push(keywordResult.reason)：记录命中原因（如 "S3 keyword detected: 身份证"）。


#### 维度②：消息正则匹配 (L62-L69)


**L62**:
```typescript
if (context.message) {
```
> 同样的消息存在性守卫。与关键词检测并行——两者的结果都会累积。


**L63**:
```typescript
const patternResult = checkPatterns(context.message, config);
```
> 调用 checkPatterns()，对消息执行配置中的所有正则。
> checkPatterns 内部使用 getOrCompileRegex() 带缓存。


**L64-L68**:
```typescript
if (patternResult.level !== "S1") { ... }
```
> 逻辑与维度①完全对称。


#### 维度③：工具名称检测 (L73-L81)


**L73**:
```typescript
if (context.toolName) {
```
> 只在工具调用场景下执行（onToolCallProposed / onToolCallExecuted）。


**L74**:
```typescript
const toolResult = checkToolType(context.toolName, config);
```
> 调用 checkToolType()，将工具名与配置中的敏感工具列表匹配。
> 注意变量名 toolResult 与 context.toolResult 不同——前者是本次检测结果。


**L75-L79**:
```typescript
if (toolResult.level !== "S1") { ... }
```
> 同前，非 S1 时累积。


#### 维度④：工具参数路径检测 (L84-L92)


**L84**:
```typescript
if (context.toolParams) {
```
> 只在有工具参数时执行。


**L85**:
```typescript
const paramResult = checkToolParams(context.toolParams, config);
```
> 调用 checkToolParams()，从参数中提取路径，与敏感路径列表匹配。


**L86-L90**:
```typescript
if (paramResult.level !== "S1") { ... }
```
> 同前。


#### 维度⑤：工具结果内容检测 (L95-L113)


**L95**:
```typescript
if (context.toolResult) {
```
> 工具执行结果存在时检测（onToolCallExecuted checkpoint）。


**L96-L98**:
```typescript
const resultText = typeof context.toolResult === "string"
```

             ? context.toolResult
             : JSON.stringify(context.toolResult);
> 类型归一化：将 toolResult 统一为字符串。
> 如果已经是 string，直接用；否则 JSON.stringify 序列化。
> 这样可以检测嵌套在 JSON 对象中的敏感信息。

**L99-L105**:
```typescript
const resultKeywordLevel = checkKeywords(resultText, config);
```
> 对工具结果执行关键词检测。
> L103: reasons.push(`Result: ${resultKeywordLevel.reason}`);
> 原因前加 "Result: " 前缀，区分是消息还是工具结果中命中的。


**L106-L112**:
```typescript
const resultPatternLevel = checkPatterns(resultText, config);
```
> 对工具结果执行正则检测。逻辑完全对称。


#### 结果聚合 (L115-L125)


**L116**:
```typescript
const finalLevel = levels.length > 0 ? maxLevel(...levels) : "S1";
```
> 如果有任何非 S1 命中，取最高等级。
> maxLevel() 内部将 S1/S2/S3 映射为 1/2/3，取 Math.max，再转回字符串。
> 如果所有维度都是 S1（levels 为空），最终等级为 S1。


**L117**:
```typescript
const finalReason = reasons.length > 0 ? reasons.join("; ") : undefined;
```
> 将所有命中原因用 "; " 连接成一个字符串。
> 例："S3 keyword detected: 身份证; S2 pattern matched: \d{18}"
> 如果无命中，reason 为 undefined。


**L119-L125**:
```typescript
return { level: finalLevel, levelNumeric: ..., reason: ..., detectorType: "ruleDetector", confidence: 1.0 };
```
> 构造最终 DetectionResult：
> - level: 聚合后的最终敏感等级
> - levelNumeric: 数值形式（1/2/3），方便比较运算
> levelToNumeric() 做 "S1"→1, "S2"→2, "S3"→3 的映射
> - reason: 聚合的命中原因
> - detectorType: "ruleDetector"——标识此结果来自规则检测器
> - confidence: 1.0——规则匹配是确定性的，没有概率判断
> 对比 configurable.ts 的 0.8 和 LLM 检测器的不确定性，
> rules 给出的是"硬编码"的高置信度


### 设计意图

  五维度并行检测 + 取最高等级，确保任何一个维度的命中都不会被忽略。
  消息内容（维度①②）和工具调用（维度③④⑤）分开检测，
  覆盖了 onUserMessage / onToolCallProposed / onToolCallExecuted 三个 checkpoint。
  confidence: 1.0 使得规则检测器在与 LLM 检测器竞争时始终胜出。
## 函数：getKeywordRegex(keyword)                  (L141-L155)


### 作用

  将关键词字符串转换为带智能词边界的正则表达式，带缓存。
  确保关键词作为"完整词"匹配，避免子串误匹配。
  例："token" 应匹配 "auth_token"，但不应匹配 "tokenize"。

### 参数

  keyword: string — 原始关键词字符串，如 "password"、".env"、"身份证"。

### 返回值

  RegExp — 编译好的带边界正则表达式。

### 逐行逻辑


**L142**:
```typescript
const cached = keywordRegexCache.get(keyword);
```
> 查缓存。keywordRegexCache 是模块级 Map，生命周期与进程相同。


**L143**:
```typescript
if (cached) return cached;
```
> 命中缓存直接返回。


**L145**:
```typescript
const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
```
> 正则特殊字符转义。例如 ".env" → "\\.env"。
> /[.*+?^${}()|[\]\\]/g 匹配所有正则元字符。
> "\\$&" 中 $& 是匹配到的字符，前面加 \\ 转义。
> 这一步确保关键词中的 "."、"*" 等字符按字面量匹配。


**L146**:
```typescript
let pattern: string;
```


**L147-L148**:
```typescript
if (keyword.startsWith(".")) {
```

               pattern = `${escaped}(?![a-zA-Z0-9])`;
> 以 "." 开头的关键词（文件扩展名，如 .env、.key、.pem）：
> - 不加前边界——"." 本身就是自然分隔符
> 例如 "file.env" 中 "." 就是 ".env" 的起始
> - 加后边界 (?![a-zA-Z0-9])——负向前瞻，确保 ".env" 后不跟字母数字
> 这样 ".envelope" 不会被 ".env" 匹配到

**L149-L151**:
```typescript
} else {
```

               pattern = `(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`;
> 普通关键词（如 "password"、"token"、"身份证"）：
> - 前边界 (?<![a-zA-Z0-9])：负向后顾，前面不能是字母或数字
> 使 "auth_token" 中的 "token" 能匹配（"_" 不是 alphanumeric）
> 但 "betokenize" 不匹配（"e" 是 alphanumeric）
> - 后边界 (?![a-zA-Z0-9])：负向前瞻，后面不能是字母或数字
> 使 "token" 不匹配 "tokenize"（"i" 是 alphanumeric）
> 注意：这里用 [a-zA-Z0-9] 而非 \w，因为 \w 包含下划线 _，
> 会导致 "auth_token" 中的 "token" 无法匹配。

**L152**:
```typescript
const re = new RegExp(pattern, "i");
```
> 构造正则，"i" 大小写不敏感。
> 因为 escaped 已经对特殊字符做了转义，此处不会抛出 SyntaxError。


**L153**:
```typescript
keywordRegexCache.set(keyword, re);
```
> 存入缓存。注意此缓存无容量上限——关键词来自配置，
> 通常几十到几百个，不会有内存问题。


**L154**:
```typescript
return re;
```


### 设计意图

  词边界策略是隐私检测的关键——过于宽松会导致大量误报（如 "pass" 匹配
  "bypass"），过于严格会导致漏报（如 "auth_token" 中的 "token" 匹配不到）。
  使用 [a-zA-Z0-9] 而非 \b 或 \w 是经过权衡的选择：
  - \b 依赖 Unicode 词边界，对中文关键词不友好
  - \w 包含下划线，导致 "auth_token" 等常见命名模式匹配失败
  - [a-zA-Z0-9] 在英文和中文场景下都表现良好
## 函数：checkKeywords(text, config)               (L160-L187)


### 作用

  检查文本中是否包含配置的敏感关键词，按 S3 → S2 优先级返回。

### 参数

  text: string — 待检测文本。
  config: PrivacyConfig — 完整隐私配置。

### 返回值

  { level: SensitivityLevel; reason?: string }
  命中关键词返回 S2/S3 + 原因；全部未命中返回 S1。

### 逐行逻辑


**L165**:
```typescript
const s3Keywords = config.rules?.keywords?.S3 ?? [];
```
> 安全取出 S3 关键词数组。三层可选链保护：
> - config.rules 可能 undefined（未配置 rules 段）
> - config.rules.keywords 可能 undefined（未配置 keywords 段）
> - config.rules.keywords.S3 可能 undefined（未配置 S3 列表）
> 任一层为 undefined，?? [] 兜底为空数组，for-of 不报错。


**L166-L172**:
```typescript
for (const keyword of s3Keywords) { ... return S3 ... }
```
> 遍历 S3 关键词。S3 优先检查——一旦命中最高级别，立即短路返回。
> L167: if (getKeywordRegex(keyword).test(text))
> 通过 getKeywordRegex() 获取带词边界的正则并执行匹配。
> L168-L171: return { level: "S3", reason: `S3 keyword detected: ${keyword}` };
> 命中 S3，携带命中的关键词作为原因。


**L176**:
```typescript
const s2Keywords = config.rules?.keywords?.S2 ?? [];
```
> 只有所有 S3 关键词都未命中时，才进入 S2 检查。


**L177-L183**:
```typescript
for (const keyword of s2Keywords) { ... return S2 ... }
```
> 逻辑与 S3 对称，命中时返回 S2。


**L186**:
```typescript
return { level: "S1" };
```
> 所有关键词都未命中，返回安全等级。不携带 reason。


### 设计意图

  短路优化：S3 → S2 → S1 的优先级序列。一旦命中高级别，
  不再浪费时间检查低级别的关键词。
  reason 字符串包含具体的关键词内容，方便审计和调试。
## 函数：checkPatterns(text, config)               (L192-L221)


### 作用

  使用正则表达式检查文本中是否包含敏感内容。
  与 checkKeywords 互补——keywords 处理简单的词匹配，
  patterns 处理复杂模式（如 SSN 格式 \b\d{3}-\d{2}-\d{4}\b）。

### 参数

  text: string — 待检测文本。
  config: PrivacyConfig — 完整隐私配置。

### 返回值

  { level: SensitivityLevel; reason?: string }

### 逐行逻辑


**L197**:
```typescript
const s3Patterns = config.rules?.patterns?.S3 ?? [];
```
> 取 S3 正则列表，防御链同 checkKeywords。


**L198-L205**:
```typescript
for (const pattern of s3Patterns) { ... }
```
> L199: const regex = getOrCompileRegex(pattern);
> 通过 getOrCompileRegex() 编译正则，带缓存和 Python 标志兼容。
> 如果 pattern 非法，返回 null。
> L200: if (regex && regex.test(text))
> regex 不为 null 且匹配成功。
> 短路：双重条件，null regex 被安全跳过。
> L201-L204: return { level: "S3", reason: `S3 pattern matched: ${pattern}` };


**L209**:
```typescript
const s2Patterns = config.rules?.patterns?.S2 ?? [];
```

**L210-L217**:
```typescript
（S2 正则检查，逻辑与 S3 完全对称）
```


**L220**:
```typescript
return { level: "S1" };
```
> 所有正则都未匹配，返回安全等级。


### 与 configurable.ts 中 checkPatterns 的关键区别

  本函数使用 getOrCompileRegex() 带缓存编译——每个 pattern 只编译一次。
  configurable.ts (L74) 每次调用都 new RegExp(pat, "i")，无缓存。
  这是代码库内部的一个不一致点（见 Code Review A2）。

### 设计意图

  缓存编译 + 容错返回 null 的组合，既保证性能又保证健壮性。
  与 checkKeywords 的分工：keywords 用于简单词汇，patterns 用于
  需要复杂匹配逻辑的场景（数据格式、多词组合等）。
## 函数：toolNameContainsSegment(name, segment)    (L228-L232)


### 作用

  检查工具名称 name 中是否包含 segment 作为完整的"段"。
  段由工具命名中常见的分隔符（"."、"_"、"-"）界定。
  防止子串误匹配，例如：
  - "pseudocode_generator" 不应匹配 "sudo"
  - "powershell" 不应匹配 "shell"

### 参数

  name: string — 实际工具名称（如 "bash_command"、"file.read"）。
  segment: string — 配置中的敏感工具段（如 "bash"、"sudo"）。

### 返回值

  boolean — name 中包含 segment 作为完整段则为 true。

### 逐行逻辑


**L229**:
```typescript
const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
```
> 对 segment 做正则特殊字符转义。


**L230**:
```typescript
const re = new RegExp(`(?:^|[._\\-])${escaped}(?:$|[._\\-])`, "i");
```
> 构造正则：
> (?:^|[._\-])  — 前边界：字符串开头 或 分隔符（.  _  -）
> ${escaped}     — 转义后的 segment
> (?:$|[._\-])  — 后边界：字符串结尾 或 分隔符
> "i"            — 大小写不敏感
> 例：segment = "bash"
> 正则 = /(?:^|[._\-])bash(?:$|[._\-])/i
> "bash_command" → "bash" 后跟 "_" → ✓ 匹配
> "git.bash"     → "." 后跟 "bash"，再到行尾 → ✓ 匹配
> "bashrc"       → "bash" 后跟 "r"（非分隔符）→ ✗ 不匹配


**L231**:
```typescript
return re.test(name);
```
> 执行匹配并返回结果。


### 设计意图

  工具命名通常使用 "."、"_"、"-" 作为分隔符（如 file.read、bash_command、
  code-interpreter）。使用这些字符作为段边界，比简单的 includes()
  精确得多，大幅降低了误报率。
  注意：此函数未做缓存——工具名称的组合空间较大，缓存收益有限。
## 函数：checkToolType(toolName, config)           (L237-L268)


### 作用

  检查工具名称是否匹配配置中的敏感工具列表。
  使用精确匹配 + 段匹配两种策略。

### 参数

  toolName: string — 实际调用的工具名称。
  config: PrivacyConfig — 隐私配置。

### 返回值

  { level: SensitivityLevel; reason?: string }

### 逐行逻辑


**L241**:
```typescript
const normalizedTool = toolName.toLowerCase();
```
> 统一为小写，后续所有比较都在小写空间进行。


**L244**:
```typescript
const s3Tools = config.rules?.tools?.S3?.tools ?? [];
```
> 取 S3 敏感工具列表。四层可选链：
> config.rules → tools → S3 → tools（最后一个 tools 是工具名数组）。


**L245-L252**:
```typescript
for (const tool of s3Tools) { ... }
```
> L246: const pattern = tool.toLowerCase();
> 配置中的工具名也转小写。
> L247: if (normalizedTool === pattern || toolNameContainsSegment(normalizedTool, pattern))
> 两种匹配策略：
> 1. 精确匹配：工具名完全等于配置值（如 "sudo" === "sudo"）
> 2. 段匹配：工具名中包含配置值作为完整段
> （如 "bash_command" 包含段 "bash"）
> 精确匹配 || 短路：先做 O(1) 的字符串比较，避免不必要的正则。
> L248-L251: return { level: "S3", reason: `S3 tool detected: ${toolName}` };
> reason 中用原始 toolName（保留大小写），方便排查。


**L256**:
```typescript
const s2Tools = config.rules?.tools?.S2?.tools ?? [];
```

**L257-L264**:
```typescript
（S2 工具检查，逻辑完全对称）
```


**L267**:
```typescript
return { level: "S1" };
```


### 设计意图

  双重匹配策略（精确 + 段匹配）在灵活性和精确度之间取得平衡。
  用户只需配置 "bash" 就能匹配 "bash_command"、"bash.exec" 等变体，
  同时不会误匹配 "bashrc" 或 "pseudobash"。
## 函数：checkToolParams(params, config)           (L273-L326)


### 作用

  从工具参数中提取文件路径，检查是否命中配置的敏感路径或
  已知的敏感文件扩展名。这是工具调用场景下的最后一道规则防线。

### 参数

  params: Record<string, unknown> — 工具调用的参数对象。
  config: PrivacyConfig — 隐私配置。

### 返回值

  { level: SensitivityLevel; reason?: string }

### 逐行逻辑


**L277**:
```typescript
const paths = extractPathsFromParams(params);
```
> 调用 utils.ts 的 extractPathsFromParams()：
> 1. 从 params 中提取 path/file/filepath/filename/dir/directory/target/source 等键的值
> 2. 从 command/cmd/script 键中用正则提取嵌入的文件路径
> 3. 递归处理嵌套对象
> 返回所有提取到的路径字符串数组。


**L279-L281**:
```typescript
if (paths.length === 0) { return { level: "S1" }; }
```
> 未提取到任何路径，无需检测，直接返回安全。


#### 配置路径检测 (L284-L303)


**L284**:
```typescript
const s3Paths = config.rules?.tools?.S3?.paths ?? [];
```
> 取 S3 敏感路径列表。


**L285-L291**:
```typescript
for (const path of paths) {
```

               if (matchesPathPattern(path, s3Paths)) { ... return S3 ... }
> matchesPathPattern()（utils.ts）支持三种匹配模式：
> 1. 精确匹配（路径完全相等）
> 2. 前缀匹配（目录路径，如 ~/.ssh/ 匹配 ~/.ssh/id_rsa）
> 3. 后缀匹配（文件扩展名通配，如 *.pem 匹配 server.pem）
> 路径在匹配前会经过 normalizePath() 展开 ~ 为 $HOME。

**L295-L303**:
```typescript
S2 路径检测，逻辑与 S3 对称。
```


#### 硬编码敏感扩展名检测 (L306-L323)


**L306**:
```typescript
for (const path of paths) {
```
> 遍历所有提取到的路径。


**L307**:
```typescript
const lowerPath = path.toLowerCase();
```
> 统一为小写比较。


**L308-L316**:
```typescript
if (lowerPath.endsWith(".pem") || ... || lowerPath.includes("id_ed25519"))
```
> 硬编码检测以下敏感文件类型：
> - .pem — PEM 编码的证书/密钥文件
> - .key — 私钥文件
> - .p12 — PKCS#12 证书存储
> - .pfx — 个人信息交换文件（同 .p12）
> - id_rsa — RSA SSH 私钥
> - id_dsa — DSA SSH 私钥
> - id_ecdsa — ECDSA SSH 私钥
> - id_ed25519 — Ed25519 SSH 私钥
> 使用 endsWith 检查扩展名，includes 检查文件名片段。
> 这些是加密相关文件的通用命名约定。


**L317-L322**:
```typescript
return { level: "S3", reason: `Sensitive file extension detected: ${path}` };
```
> 命中任一硬编码规则，直接返回 S3（最高级别）。
> 这些文件包含私钥/证书，泄露后果严重，因此固定为 S3。


**L325**:
```typescript
return { level: "S1" };
```
> 所有路径都未命中任何规则，返回安全。


### 设计意图

  分为两层检测：
  1. 配置驱动（s3Paths / s2Paths）——管理员按需求自定义敏感路径。
  2. 硬编码（.pem / .key / id_rsa 等）——密码学文件是普遍共识的敏感资源，
     不依赖配置就应默认保护。
  硬编码规则直接返回 S3 而非 S2，因为私钥/证书泄露是不可逆的安全事件。

## Part A — Code 层面改动建议


#### 🔴 getOrCompileRegex() 未导出，configurable.ts 无法复用


 现状（L15）：
   function getOrCompileRegex(pattern: string): RegExp | null {
   该函数没有 export 关键字。

 问题：
   configurable.ts 的 checkPatterns()（L74）每次调用都 new RegExp(pat, "i")，
   无缓存。这是因为 getOrCompileRegex() 是 rules.ts 的私有函数，
   configurable.ts 无法 import 它。
   - 性能差距：如果有 20 条正则且每秒 100 次 detect()，
     configurable.ts 每秒构造 2000 个 RegExp 对象，
     而 rules.ts 只在首次调用时构造 20 个。
   - 同一代码库中同一检测逻辑的不同性能特征是不一致的。

 建议：
   将 getOrCompileRegex() 导出：

     export function getOrCompileRegex(pattern: string): RegExp | null {

   然后 configurable.ts 可以 import 复用：

     import { getOrCompileRegex } from "../rules.js";

   或者将正则缓存逻辑提取到 utils.ts 中作为公共基础设施。


#### 🟡 toolNameContainsSegment() 每次调用都构造新 RegExp


 现状（L229-L231）：
   每次调用 checkToolType() 时，对每个配置的工具名都会执行
   new RegExp(`(?:^|[._\\-])${escaped}(?:$|[._\\-])`, "i")。

 问题：
   与 getOrCompileRegex() 和 getKeywordRegex() 的缓存设计不一致。
   虽然工具名列表通常较短（5-20 个），性能影响不大，
   但在一致性和可维护性层面应当保持统一。

 建议：
   为 toolNameContainsSegment 增加缓存：

     const toolSegmentCache = new Map<string, RegExp>();
     function toolNameContainsSegment(name: string, segment: string): boolean {
       let re = toolSegmentCache.get(segment);
       if (!re) {
         const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
         re = new RegExp(`(?:^|[._\\-])${escaped}(?:$|[._\\-])`, "i");
         toolSegmentCache.set(segment, re);
       }
       return re.test(name);
     }


#### 🟡 checkToolParams 中硬编码的扩展名列表应提取为常量


 现状（L308-L316）：
   硬编码的 .pem / .key / .p12 / .pfx / id_rsa / id_dsa / id_ecdsa / id_ed25519
   以一连串 if 条件嵌入在函数体中。

 问题：
   - 可读性差：8 个条件在单个 if 中。
   - 可扩展性差：新增敏感扩展名需要修改函数体。
   - 无法被外部工具（如 Dashboard 配置校验）复用。

 建议：

   const SENSITIVE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
   const SENSITIVE_PATH_SEGMENTS = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

   for (const path of paths) {
     const lowerPath = path.toLowerCase();
     if (SENSITIVE_EXTENSIONS.some(ext => lowerPath.endsWith(ext)) ||
         SENSITIVE_PATH_SEGMENTS.some(seg => lowerPath.includes(seg))) {
       return { level: "S3", reason: `Sensitive file extension detected: ${path}` };
     }
   }


#### 🟢 detectByRules 维度⑤中变量名 resultKeywordLevel 不准确


 现状（L99, L106）：
   const resultKeywordLevel = checkKeywords(resultText, config);
   const resultPatternLevel = checkPatterns(resultText, config);

 问题：
   变量名以 "Level" 结尾，但实际类型是 { level, reason? }，不是单纯的 level。
   同时 "resultKeywordLevel" 容易与 context.toolResult 混淆。

 建议统一命名风格（与维度①②③④一致）：
   const resultKeywordCheck = checkKeywords(resultText, config);
   const resultPatternCheck = checkPatterns(resultText, config);
## Part B — 逻辑/设计层面改动建议


#### 🔴 hooks.ts 中 S3 快速路径直接调用 detectByRules，

     但只传 message，未传 toolName / toolParams

 现状（hooks.ts L159-L161）：
   const rulePreCheck = detectByRules(
     { checkpoint: "onUserMessage", message: msgStr, sessionKey },
     privacyConfig,
   );

 对比 detectByRules 内部（L73-L92）：
   它会检查 context.toolName 和 context.toolParams，
   但 hooks.ts 的快速路径只传了 message。

 问题：
   在 onUserMessage checkpoint，toolName / toolParams 确实不可用，
   所以目前不构成 bug。但代码没有文档说明为什么只传 message，
   未来维护者可能会误以为漏传了字段。

 建议：
   在 hooks.ts 的快速路径处添加注释说明。或者在 detectByRules 的
   JSDoc 中明确说明各 checkpoint 下哪些字段是预期存在的。


#### 🟡 checkToolParams 硬编码的扩展名与 config.rules.keywords 可能重复


 现状：
   L308-L316 硬编码了 .pem / .key 等扩展名作为 S3。
   同时用户可以在 config.rules.keywords.S3 中配置 ".pem"、".key"。

 问题：
   - 如果用户在 keywords.S2 中配置了 ".key"（想降低为 S2），
     但硬编码规则仍会将其提升为 S3。
   - 用户没有办法覆盖或关闭这些硬编码规则。

 建议（两种策略选一）：

   策略 A — 将硬编码规则变为可配置的默认值：
     在 defaultPrivacyConfig.rules.tools.S3.paths 中加入这些扩展名，
     用户可以通过配置覆盖。移除 checkToolParams 中的硬编码块。

   策略 B — 保留硬编码但加 override 机制：
     新增 config.rules.tools.allowedExtensions 白名单，
     硬编码检测前先查白名单。


#### 🟡 detectByRules 的维度⑤对 toolResult 同时做关键词和正则检测，

     但不做工具名称和参数路径检测

 现状：
   维度⑤（L95-L113）只对 toolResult 的文本内容执行 checkKeywords + checkPatterns。
   不调用 checkToolType 或 checkToolParams。

 分析：
   这个设计是合理的——toolResult 是工具执行后的返回内容，
   不是工具名称或参数。对内容做关键词/正则检测是正确的维度。
   但值得注意的是，如果工具返回的内容中包含文件路径（如 ls 命令输出），
   这些路径不会被 checkToolParams 检测到。

 建议：
   如果需要覆盖此场景，可以在维度⑤中增加对 resultText 的路径提取和检测：

     // 可选：从工具结果中提取路径并检测
     const resultPaths = resultText.match(/(?:\/[\w.\-]+(?:\/[\w.\-]*)*)/g);
     if (resultPaths) {
       for (const p of resultPaths) {
         if (matchesPathPattern(p, s3Paths)) { ... }
       }
     }

   但这可能带来较高的误报率，需要权衡。


#### 🟡 getKeywordRegex 的词边界策略对 CJK 混合文本有局限


 现状（L150）：
   pattern = `(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`;

 问题：
   [a-zA-Z0-9] 只检查 ASCII 字母和数字。对于中英混合文本，
   中文字符（\u4e00-\u9fa5）既不是 a-zA-Z 也不是 0-9，
   因此中文关键词"密码"会匹配"修改密码策略"中的"密码"（正确），
   但纯英文关键词 "pass" 如果跟在中文字符后面（如 "输入pass"），
   也会被匹配到——这通常是正确行为。

   然而，如果关键词是半角字符混合的技术术语（如 "API_KEY"），
   下划线 _ 不在 [a-zA-Z0-9] 中，所以 "MY_API_KEY_VALUE" 中的
   "API_KEY" 会被匹配——这是期望行为。

 结论：
   当前实现对大多数场景是正确的，此条为低优先级的边界情况提醒。


#### 🟢 detectByRules 与 privacy.ts 的调用链在 confidence 处理上不一致


 现状：
   detectByRules() 返回 confidence: 1.0（L124）。
   privacy.ts 的 detectionToDecision() 没有设置 confidence 字段。
   configurable.ts 的 detect() 返回 confidence: 0.8（L219）。

 问题：
   router-pipeline.ts 的 mergeDecisionsWeighted()（L365-L368）
   使用加权平均计算最终 confidence：
     items.reduce((s, i) => s + (i.decision.confidence ?? 0.5) * i.weight, 0) / totalWeight

   privacy router 未设 confidence，会回退到 0.5（?? 0.5），
   而 rules 检测器返回的 1.0 在中间层（detector.ts → privacy.ts）
   可能被丢失或覆盖。

 建议：
   privacy.ts 的 detectionToDecision() 应传递或设置 confidence：

     return {
       level: "S3",
       action: "redirect",
       target: { ... },
       reason,
       confidence: 1.0,  // 规则检测的确定性
     };


#### 🟢 patternCache 的 FIFO 淘汰在极端场景下可能导致"缓存抖动"


 现状（L28-L31）：
   当缓存满时，删除最早插入的条目（FIFO）。

 问题：
   如果配置中正好有 500 条正则，缓存恰好装满。此时如果有一条新正则
   （如 Dashboard 动态添加的规则），会淘汰最老的条目。但如果被淘汰的
   条目很快又被查询，就会发生缓存抖动（频繁编译→淘汰→再编译）。

   不过实际场景中：
   - 配置变动频率很低（手动配置或 Dashboard 操作）
   - 500 的容量对绝大多数部署足够
   - FIFO 与 LRU 在低变动场景下行为几乎一致

 建议：
   当前实现可接受。如果未来需要优化，可以改用真正的 LRU：
   在每次 get() 命中时将条目移到 Map 末尾（delete + set）。
## Review 优先级总览


 🔴 高优先级（应尽快修复）
 A1. getOrCompileRegex() 未导出 → 导出供 configurable.ts 复用
 B1. hooks.ts 快速路径缺少上下文说明 → 添加注释/文档

 🟡 中优先级（建议在下个迭代处理）
 A2. toolNameContainsSegment 无缓存 → 增加正则缓存
 A3. 硬编码扩展名列表 → 提取为常量
 B2. 硬编码扩展名无法被用户覆盖 → 改为可配置默认值
 B3. toolResult 不做路径检测 → 评估是否需要增加
 B4. 词边界策略的 CJK 边界情况 → 评估并记录

 🟢 低优先级（锦上添花）
 A4. 变量名 resultKeywordLevel 不准确 → 重命名
 B5. privacy.ts 不传递 confidence → 传递/设置
 B6. FIFO 缓存淘汰策略 → 可选改为 LRU
