# utils.ts — 逐方法文档


 文件定位：GuardClaw 隐私路由系统的通用工具函数集
 所属模块：GuardClaw 隐私路由系统

 核心职责：
   提供路径规范化、路径模式匹配、参数中路径提取、敏感信息脱敏、
   受保护内存路径检测、以及 Provider 默认 Base URL 解析等底层工具函数。
   这些函数被 hooks.ts、rules.ts、privacy-proxy.ts、memory-isolation.ts
   等核心模块广泛调用，是 GuardClaw 隐私检测与脱敏管线的基础构件。

 术语说明：
   S1 = 无敏感内容，直接放行
   S2 = 中度敏感，走代理(proxy)或本地模型(local)
   S3 = 高度敏感，强制本地模型处理
   PII = 个人可识别信息 (Personally Identifiable Information)
   RedactionOptions = 脱敏选项，控制哪些 opt-in 规则生效
## 函数：normalizePath(path)                  (L10-L16)


### 作用

  将文件路径中的 `~` 前缀展开为用户主目录的绝对路径，
  用于后续路径比较时消除 `~/xxx` 与 `/home/user/xxx` 之间的差异。

### 参数

  path: string — 待规范化的文件路径

### 返回值

  string — 规范化后的路径。若以 `~/` 开头则替换为主目录；否则原样返回。

### 逐行逻辑


**L11**:
```typescript
if (path.startsWith("~/"))
```
> 仅处理以 `~/` 开头的路径，避免误触 `~user` 等其他 tilde 用法


**L12**:
```typescript
const home = process.env.HOME || process.env.USERPROFILE || "~";
```
> 跨平台获取主目录：Linux/macOS 用 HOME，Windows 用 USERPROFILE
> 若两者都未设置，回退到 `~`（保持原样，至少不会崩溃）


**L13**:
```typescript
return path.replace("~", home);
```
> 只替换第一个 `~`（String.replace 默认行为），将其换为实际主目录
> 注意：仅替换第一个匹配，不会影响路径中间可能出现的 `~` 字符


**L15**:
```typescript
return path;
```
> 非 `~/` 开头的路径直接原样返回


### 设计意图

  在 GuardClaw 系统中，配置文件和路径规则经常使用 `~/` 简写（如
  `~/.openclaw/agents/...`）。此函数将这种简写统一展开，确保路径
  比较（如 matchesPathPattern、isProtectedMemoryPath）时不因写法不同
  而遗漏匹配。
## 函数：matchesPathPattern(path, patterns)   (L21-L45)


### 作用

  判断给定路径是否匹配一组模式中的任意一个。支持三种匹配方式：
  精确匹配、目录前缀匹配、文件后缀通配符匹配。
  被 rules.ts 的 detectByRules 用于判断 tool 参数中的路径是否命中
  敏感路径规则。

### 参数

  path: string     — 待检查的文件路径
  patterns: string[] — 模式数组，每个模式可以是：
      - 完整路径（精确匹配）
      - 目录路径（前缀匹配，自动补 `/` 或 `\\`）
      - `*` 开头的后缀模式（如 `*.env`）

### 返回值

  boolean — 路径是否匹配至少一个模式

### 逐行逻辑


**L22**:
```typescript
const normalizedPath = normalizePath(path);
```
> 先规范化输入路径，展开 `~`


**L24**:
```typescript
for (const pattern of patterns)
```
> 遍历每个模式，只要有一个匹配即可返回 true


**L25**:
```typescript
const normalizedPattern = normalizePath(pattern);
```
> 模式本身也可能包含 `~`，同样需要展开


**L28**:
```typescript
if (normalizedPath === normalizedPattern)
```
> 第一优先级：精确匹配。如 `/home/user/.env` === `/home/user/.env`


**L33-L35**:
```typescript
if (normalizedPath.startsWith(normalizedPattern + "/") ||
```

               normalizedPath.startsWith(normalizedPattern + "\\"))
> 第二优先级：目录前缀匹配。模式作为目录前缀，加 `/`（Unix）或
> `\\`（Windows）来避免 `/home/user2` 误匹配 `/home/user`。
> 适用场景：配置中写 `~/.ssh`，需要匹配 `~/.ssh/id_rsa` 等子文件

**L39**:
```typescript
if (pattern.startsWith("*") && normalizedPath.endsWith(pattern.slice(1)))
```
> 第三优先级：通配符后缀匹配。注意这里用的是原始 pattern（未规范化），
> 因为 `*` 开头的模式不是路径，不应做 `~` 展开。
> `pattern.slice(1)` 取 `*` 之后的后缀，如 `*.env` → `.env`
> 适用场景：配置中写 `*.pem`，匹配所有以 `.pem` 结尾的文件


**L44**:
```typescript
return false;
```
> 所有模式都未命中，返回 false


### 设计意图

  提供一个轻量级的路径匹配能力，不依赖 glob 库。三种匹配模式覆盖了
  GuardClaw 配置中最常见的路径规则写法：精确路径、目录通配、扩展名通配。
  被 rules.ts 中的 tool 路径检测直接调用，用于判断工具操作的目标路径
  是否属于 S2/S3 敏感路径列表。
## 函数：extractPathsFromParams(params)       (L50-L80)


### 作用

  从工具调用的参数对象中提取所有文件系统路径。分三步：
    1. 从常见路径键名中提取直接路径值
    2. 从命令字符串中正则提取嵌入的路径
    3. 递归处理嵌套对象
  被 rules.ts（路径敏感检测）和 hooks.ts（受保护路径拦截）调用。

### 参数

  params: Record<string, unknown> — 工具调用参数，键值对形式

### 返回值

  string[] — 提取到的所有路径字符串的数组（可能为空）

### 逐行逻辑


**L51**:
```typescript
const paths: string[] = [];
```
> 收集结果的数组


**L54**:
```typescript
const pathKeys = ["path", "file", "filepath", "filename", "dir", "directory", "target", "source"];
```
> 预定义的常见路径参数名列表——覆盖主流 AI 工具调用（如 read_file、
> write_file）使用的字段名


**L56-L61**:
```typescript
for (const key of pathKeys) { ... }
```
> 遍历预定义键名，若参数中存在且为非空字符串，加入结果
> `typeof value === "string" && value.trim()` 双重校验：类型安全 + 排除空白


**L64**:
```typescript
const commandKeys = ["command", "cmd", "script"];
```
> 命令类参数名——这些值是 shell 命令字符串，内部可能嵌入文件路径


**L65-L70**:
```typescript
for (const key of commandKeys) { ... paths.push(...extractPathsFromCommand(value)); }
```
> 对命令字符串调用 extractPathsFromCommand 正则提取嵌入路径
> 适用场景：`{ command: "cat /etc/passwd | grep root" }` →
> 提取出 `/etc/passwd`


**L73-L77**:
```typescript
for (const value of Object.values(params)) { ... }
```
> 递归处理嵌套对象（排除数组）。某些工具调用参数可能有嵌套结构，
> 如 `{ options: { path: "/secret/file" } }`。
> `!Array.isArray(value)` 避免对数组元素进行错误的键值提取


**L79**:
```typescript
return paths;
```
> 返回所有提取到的路径


### 设计意图

  AI 工具调用的参数格式多变，路径可能出现在不同键名下，也可能嵌入在
  命令字符串中。此函数通过"预定义键名 + 命令正则 + 递归遍历"三层策略
  尽可能全面地提取路径，为下游的路径敏感检测和受保护路径拦截提供输入。
## 函数：extractPathsFromCommand(command)     (L86-L90)


### 作用

  从 shell 命令字符串中用正则提取文件系统路径。识别绝对路径（/开头）
  和主目录相对路径（~/开头）。
  仅被 extractPathsFromParams 内部调用。

### 参数

  command: string — shell 命令字符串

### 返回值

  string[] — 提取到的路径数组，无匹配时返回空数组

### 逐行逻辑


**L87**:
```typescript
const pathRegex = /(?:\/[\w.\-]+(?:\/[\w.\-]*)*|~\/[\w.\-]+(?:\/[\w.\-]*)*)/g;
```
> 正则匹配两类路径：
> 1. `/[\w.\-]+` 开头的绝对路径（如 `/etc/passwd`、`/home/user/.ssh`）
> 2. `~/[\w.\-]+` 开头的主目录路径（如 `~/Documents/secret.txt`）
> 每段路径分量允许字母数字、点、连字符；`g` 标志全局匹配多个路径
> 局限：不支持含空格的路径、不支持 Windows 驱动器路径（C:\...）


**L88**:
```typescript
const matches = command.match(pathRegex);
```
> 全局匹配，返回所有匹配结果的数组


**L89**:
```typescript
return matches ?? [];
```
> `??` 空值合并：match 返回 null 时转为空数组，避免调用方处理 null


### 设计意图

  作为 extractPathsFromParams 的辅助函数，专门处理命令字符串中嵌入的路径。
  使用简单正则而非完整 shell 解析，在"快速、低开销"和"覆盖面"之间取得平衡。
  该函数未导出（private），仅供内部使用。
## 函数：redactSensitiveInfo(text, opts?)     (L103-L239)


### 作用

  对文本进行综合性敏感信息脱敏（redaction）。采用两阶段策略：
    Phase 1 — 模式匹配：已知格式的敏感数据（SSH 密钥、API key、AWS 密钥、
              数据库连接串、内网 IP、邮箱、环境变量、信用卡号、中国手机号、
              身份证号、快递单号、门禁码、中文地址）
    Phase 2 — 上下文匹配：关键词 + 连接词 + 值的组合模式（如
              "password is abc123"、"API_KEY=xxx"）

  被 hooks.ts（多个 hook 点脱敏 tool 结果和 assistant 回复）、
  privacy-proxy.ts（S2 代理转发前脱敏）、memory-isolation.ts（记忆同步脱敏）
  广泛调用，是 GuardClaw 隐私保护的核心脱敏引擎。

### 参数

  text: string — 待脱敏的原始文本
  opts?: RedactionOptions — 可选的脱敏选项，控制 opt-in 规则：
      internalIp?: boolean   — 内网 IP（10.x/172.16-31.x/192.168.x）
      email?: boolean        — 邮箱地址
      envVar?: boolean       — .env 格式的环境变量行
      creditCard?: boolean   — 信用卡号（13-19 位数字）
      chinesePhone?: boolean — 中国手机号（1[3-9]x 11 位）
      chineseId?: boolean    — 中国身份证号（18 位 / 17+X）
      chineseAddress?: boolean — 中文地址（省/市/区/路/号等）
      pin?: boolean          — PIN 码上下文规则

### 返回值

  string — 脱敏后的文本，敏感部分替换为 [REDACTED:TYPE] 标记

### 逐行逻辑


**L104**:
```typescript
let redacted = text;
```
> 创建可变副本，后续所有替换操作在此变量上链式执行


#### Phase 1: 模式匹配脱敏（始终启用，低误报）


**L109-L112**:
```typescript
redacted = redacted.replace(/-----BEGIN ... PRIVATE KEY-----/g, ...)
```
> 匹配 SSH/TLS 私钥块。支持 RSA、EC、DSA、OPENSSH 等前缀。
> `[\s\S]*?` 非贪婪匹配密钥内容（包含换行）。
> 替换为 [REDACTED:PRIVATE_KEY]


**L115**:
```typescript
redacted = redacted.replace(/\b(?:sk|key|token)-[A-Za-z0-9]{16,}\b/g, ...)
```
> 匹配常见 API key 格式：sk-xxx、key-xxx、token-xxx
> 要求至少 16 个字母数字字符，`\b` 边界防止部分匹配
> 替换为 [REDACTED:KEY]


**L118**:
```typescript
redacted = redacted.replace(/AKIA[0-9A-Z]{16}/g, ...)
```
> 匹配 AWS Access Key ID，固定以 AKIA 开头后接 16 位大写字母数字
> 替换为 [REDACTED:AWS_KEY]


**L121-L124**:
```typescript
redacted = redacted.replace(/(?:mysql|postgres|...):\/\/[^\s"']+/gi, ...)
```
> 匹配数据库连接串 URI。支持 mysql、postgres、postgresql、mongodb、
> redis、amqp 协议前缀。`[^\s"']+` 匹配到空白或引号为止。
> `gi` 大小写不敏感。替换为 [REDACTED:DB_CONNECTION]


#### Phase 1a: Opt-in 模式规则（默认关闭，避免误报）


**L128-L133**:
```typescript
if (opts?.internalIp) { ... }
```
> 匹配 RFC 1918 内网 IP：10.x.x.x、172.16-31.x.x、192.168.x.x
> 替换为 [REDACTED:INTERNAL_IP]。默认关闭因为日志中常含内网 IP。


**L135-L137**:
```typescript
if (opts?.email) { ... }
```
> 匹配邮箱地址格式。替换为 [REDACTED:EMAIL]。
> 默认关闭因为代码注释、配置示例中常含无害邮箱。


**L139-L144**:
```typescript
if (opts?.envVar) { ... }
```
> 匹配 `export? KEY=VALUE` 格式的环境变量行（多行模式 `m`）。
> 要求键名至少 2 个大写字母/下划线。替换为 [REDACTED:ENV_VAR]。
> 默认关闭因为代码中常见此格式但不一定是敏感值。


**L146-L151**:
```typescript
if (opts?.creditCard) { ... }
```
> 匹配信用卡号格式：4 组数字，分隔符可以是空格或连字符。
> 替换为 [REDACTED:CARD_NUMBER]。默认关闭因为纯数字序列误报率高。


#### Phase 1b: 中国 PII 模式（opt-in）


**L155-L157**:
```typescript
if (opts?.chinesePhone) { ... }
```
> 匹配中国手机号：1[3-9] 开头的 11 位数字。
> `(?<!\d)` 和 `(?!\d)` 负向断言确保前后不是数字，防止从更长数字
> 序列中误截。替换为 [REDACTED:PHONE]。


**L159-L161**:
```typescript
if (opts?.chineseId) { ... }
```
> 匹配中国身份证号：17 位数字 + 1 位数字或 X/x。
> 同样用前后负向断言防止误截。替换为 [REDACTED:ID]。


**L164-L167**:
```typescript
快递单号脱敏（始终启用）
```
> 匹配"快递单号"/"运单号"/"取件码" + 冒号/空格 + 6-20 位字母数字。
> 关键词门控大幅降低误报，因此 always-on。替换为 [REDACTED:DELIVERY]。


**L170-L173**:
```typescript
门禁码脱敏（始终启用）
```
> 匹配"门禁码"/"门禁密码"/"门锁密码"/"开门密码" + 冒号/空格 + 3-12
> 位字母数字或 #*。关键词门控，always-on。替换为 [REDACTED:ACCESS_CODE]。


**L175-L180**:
```typescript
if (opts?.chineseAddress) { ... }
```
> 匹配中文地址：2+ 个中文字符 + 行政区划后缀（省/市/区/县/路/号/楼等）
> + 可选的数字和中文字符。替换为 [REDACTED:ADDRESS]。
> 默认关闭因为地址格式多变，正则难以完美覆盖而不产生误报。


#### Phase 2: 上下文匹配脱敏


**L193**:
```typescript
const STRICT_CONNECT = ...
```
> 严格连接模式：要求关键词和值之间有动词（is/are/was/were）或
> 分隔符（=/:）。用于宽泛关键词如 "credit card"，降低误报。


**L194**:
```typescript
const LOOSE_CONNECT = ...
```
> 宽松连接模式：除了严格模式的条件外，还接受单纯空格连接。
> 用于凭据类关键词如 "password"，因为下一个词很可能就是密码值。


**L196-L225**:
```typescript
const contextualRules: Array<{ pattern: RegExp; label: string }> = [...]
```
> 定义 7 条上下文脱敏规则：
> - password/passwd/pwd/passcode → LOOSE → [REDACTED:PASSWORD]
> - credit card/card number      → STRICT → [REDACTED:CARD]
> - api_key/access_key/SECRET_KEY → LOOSE → [REDACTED:API_KEY]
> - secret                        → STRICT → [REDACTED:SECRET]
> - token/bearer/auth_token       → LOOSE → [REDACTED:TOKEN]
> - credential/cred              → LOOSE → [REDACTED:CREDENTIAL]
> - ssn/social security          → STRICT → [REDACTED:SSN]
> 每条规则的正则都捕获值部分 `([^\s"']{2,})`——至少 2 字符的非空白非引号


**L227-L232**:
```typescript
if (opts?.pin) { contextualRules.push(...) }
```
> PIN 码规则默认关闭（opt-in），因为 "pin" 是极常见的英文单词，
> 开启后误报率高。使用 STRICT 连接模式进一步降低误报。


**L234-L236**:
```typescript
for (const rule of contextualRules) { redacted = redacted.replace(...) }
```
> 依次应用所有上下文规则。replace 的第二个参数使用模板字符串
> `[REDACTED:${rule.label}]`，将关键词+连接词+值整体替换为标记。


**L238**:
```typescript
return redacted;
```
> 返回经过 Phase 1 + Phase 2 全部脱敏后的文本


### 设计意图

  两阶段设计的核心思路：Phase 1 靠格式特征（密钥块、URI scheme、固定前缀）
  精确打击低误报目标，Phase 2 靠语义上下文（关键词 + 连接词）捕获自然语言
  中暴露的敏感信息。Opt-in 机制通过 RedactionOptions 让用户按需开启高误报
  规则，在安全性与可用性之间取得平衡。中国 PII 规则（手机号、身份证、
  快递单号、门禁码、地址）体现了系统对中文用户场景的专门适配。
  此函数是 S2 脱敏转发（privacy-proxy.ts）和记忆同步脱敏
  （memory-isolation.ts）的最终执行者。
## 函数：isProtectedMemoryPath(filePath, baseDir?)  (L244-L273)


### 作用

  判断给定文件路径是否属于受保护的记忆/历史目录。云端模型不应访问这些
  路径（包含未脱敏的完整对话历史），仅本地模型/Guard Agent 可以读取。
  被 hooks.ts 的 onToolCallProposed 钩子调用，用于拦截云端模型对
  完整历史的读取请求。

### 参数

  filePath: string — 待检查的文件路径
  baseDir: string  — 基础目录，默认 `~/.openclaw`

### 返回值

  boolean — true 表示该路径是受保护的，云端模型不应访问

### 逐行逻辑


**L245**:
```typescript
const normalizedFile = normalizePath(filePath);
```
> 规范化输入路径，展开 `~`


**L246**:
```typescript
const normalizedBase = normalizePath(baseDir);
```
> 规范化基础目录，默认 `~/.openclaw` → `/home/user/.openclaw`


**L247**:
```typescript
const escapedBase = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
```
> 对基础目录进行正则转义。因为后续要用它构造正则表达式，路径中的
> `.`、`/` 等特殊字符需要转义防止被正则引擎误解。


**L250-L254**:
```typescript
const protectedPaths = [...]
```
> 定义三类受保护路径模式（正则字符串）：
> 1. `${base}/agents/<agentId>/sessions/full` — agent 完整会话历史
> 2. `${base}/<name>/MEMORY-FULL.md`         — 完整未脱敏记忆文件
> 3. `${base}/<name>/memory-full`             — 完整记忆目录


**L256-L261**:
```typescript
for (const regexStr of protectedPaths) { ... regex.test(normalizedFile) }
```
> 将每个模式构造为正则（以 `^` 锚定开头），测试输入路径是否匹配
> 匹配任一模式即返回 true


**L264-L269**:
```typescript
if (normalizedFile.includes(...) || normalizedFile.endsWith(...))
```
> 兜底检查：用字符串包含/结尾检测更宽泛的 "full" 历史路径模式
> 三个条件：
> - 包含 `/sessions/full/` — 会话完整记录的子路径
> - 包含 `/memory-full/`   — 完整记忆的子路径
> - 以 `/MEMORY-FULL.md` 结尾 — 完整记忆文件本身
> 此兜底覆盖 baseDir 配置不匹配或非标准安装路径的情况


**L272**:
```typescript
return false;
```
> 不属于受保护路径


### 设计意图

  GuardClaw 的记忆系统维护两条轨道：full（完整未脱敏）和 clean（已脱敏）。
  S2-proxy 模式下数据会送往云端，因此必须阻止云端模型读取 full 轨道的数据。
  此函数实现了这一访问控制的路径级判断。两层检测（正则 + 字符串包含）是
  防御性编程：正则匹配精确但依赖 baseDir 配置正确，字符串包含更宽泛作为
  安全网。在 hooks.ts 中，若此函数返回 true，工具调用会被直接 block 并
  返回拒绝原因给用户。
## 函数：resolveDefaultBaseUrl(provider, api?)  (L278-L289)


### 作用

  根据 Provider 名称和 API 类型推断其默认 Base URL。当用户配置中未显式
  指定 baseUrl 时，用此函数填充默认值。被 hooks.ts 在 stash 原始 Provider
  信息时调用。

### 参数

  provider: string — Provider 名称（如 "google"、"anthropic"、"openai"）
  api?: string     — API 类型标识（如 "anthropic-messages"、"google"）

### 返回值

  string — 推断出的默认 Base URL

### 逐行逻辑


**L279**:
```typescript
const p = provider.toLowerCase();
```
> 统一为小写进行比较，消除大小写差异


**L280**:
```typescript
const a = (api ?? "").toLowerCase();
```
> api 可能为 undefined，用 `??` 默认为空字符串后再转小写


**L281-L283**:
```typescript
if (p === "google" || p.includes("gemini") || p.includes("vertex") || ...)
```
> Google 系判断：Provider 名含 google/gemini/vertex，或 API 类型含
> google/gemini。匹配成功返回 Gemini API v1beta 端点。
> 覆盖了 "google"、"gemini-pro"、"vertex-ai" 等多种写法。


**L285-L286**:
```typescript
if (p === "anthropic" || a === "anthropic-messages")
```
> Anthropic 判断：Provider 名为 anthropic，或 API 类型为
> anthropic-messages。返回 Anthropic API 端点。


**L288**:
```typescript
return "https://api.openai.com/v1";
```
> 默认回退：其他所有 Provider 都假定为 OpenAI 兼容格式。
> 这是合理的默认值，因为大量第三方模型都使用 OpenAI 兼容 API。


### 设计意图

  在 S2 脱敏代理场景下，hooks.ts 需要知道原始 Provider 的 Base URL 以便
  将脱敏后的请求转发到正确的云端。此函数将 Provider 识别逻辑集中在一处，
  避免在 hooks.ts 中散落多处条件判断。三级判断（Google → Anthropic →
  OpenAI 默认）覆盖了主流 LLM Provider，且以 OpenAI 兼容格式作为安全回退。
---

## Code Review — 代码审查


### Part A — Code 层面改动建议


#### 🟡 normalizePath 不处理相对路径和尾部斜杠


 现状（L10-L16）：仅处理 `~/` 前缀展开，不做 path.resolve 或尾部斜杠清理。
 问题：`/home/user/dir/` 和 `/home/user/dir` 在 matchesPathPattern 中
       精确匹配时会不一致。同时，相对路径（如 `./config`）不会被解析为
       绝对路径，可能导致匹配遗漏。
 建议：考虑使用 `path.resolve()` 规范化路径，并去除尾部斜杠：
       ```
       import * as path from "node:path";
       export function normalizePath(p: string): string {
         if (p.startsWith("~/")) {
           const home = process.env.HOME || process.env.USERPROFILE || "~";
           p = p.replace("~", home);
         }
         return path.resolve(p).replace(/\/+$/, "");
       }
       ```


#### 🟢 extractPathsFromCommand 正则不支持含空格和引号路径


 现状（L87）：正则 `/(?:\/[\w.\-]+...)/g` 只匹配由字母数字、点、连字符
       组成的路径分量。
 问题：含空格的路径（如 `/Users/John Doe/Documents`）和引号包裹的路径
       （如 `cat "/tmp/my file.txt"`）无法被提取。
 建议：增加对引号包裹路径的支持：
       ```
       /(?:["'])(\/[^"']+)(?:["'])|(?:\/[\w.\-]+(?:\/[\w.\-]*)*|~\/[\w.\-]+(?:\/[\w.\-]*)*)/g
       ```

       不过需注意复杂度与误报的权衡。

#### 🟡 redactSensitiveInfo 每次调用都重新构造 Phase 2 正则


 现状（L196-L225）：每次调用 redactSensitiveInfo 时都会 `new RegExp(...)` 创建
       7-8 个上下文规则正则对象。
 问题：此函数在 hooks.ts 中每个 tool 结果和 assistant 回复都会调用，
       高频场景下重复创建正则对象造成不必要的 GC 压力。对比 rules.ts
       使用了 patternCache 缓存编译好的正则。
 建议：将不依赖 opts 的 contextualRules 提取为模块级常量（只编译一次），
       仅 pin 规则根据 opts 动态追加：
       ```
       const BASE_CONTEXTUAL_RULES: Array<{ pattern: RegExp; label: string }> = [
         { pattern: /(?:password|passwd|pwd|passcode).../, label: "PASSWORD" },
         // ...其余 6 条
       ];

       export function redactSensitiveInfo(text: string, opts?: RedactionOptions): string {
         // ...Phase 1 不变...
         const rules = opts?.pin
           ? [...BASE_CONTEXTUAL_RULES, PIN_RULE]
           : BASE_CONTEXTUAL_RULES;
         for (const rule of rules) { ... }
       }
       ```


#### 🟢 isProtectedMemoryPath 每次调用重新编译正则


 现状（L256-L261）：每次调用都对 protectedPaths 数组中的字符串执行
       `new RegExp(...)` 构建正则。
 问题：由于 baseDir 默认值几乎不变（`~/.openclaw`），绝大多数调用
       使用相同参数，重复编译浪费。
 建议：当 baseDir 使用默认值时，缓存编译好的正则数组；或使用
       与 rules.ts 相同的 patternCache 策略。

### Part B — 逻辑/设计层面改动建议


#### 🔴 redactSensitiveInfo 的 Phase 2 上下文规则会吞掉关键词本身


 现状（L234-L236）：`redacted.replace(rule.pattern, `[REDACTED:${rule.label}]`)`
       将整个匹配（包括关键词+连接词+值）替换为标记。
 问题：替换后原始的关键词信息丢失。例如 "my password is abc123" 变成
       "my [REDACTED:PASSWORD]"，而非 "my password is [REDACTED:PASSWORD]"。
       这可能影响下游对脱敏文本的理解——尤其在 S2 代理场景中，云端模型
       收到的文本会失去"这里原来是密码"的语义上下文。
 建议：修改替换逻辑，仅替换捕获组（值部分），保留关键词和连接词：
       ```
       redacted = redacted.replace(rule.pattern,
         (match, value) => match.replace(value, `[REDACTED:${rule.label}]`)
       );
       ```


#### 🟡 defaultPrivacyConfig.redaction 全部为 false 但 always-on 规则的存在导致行为不对称


 现状：config-schema.ts（L203-L212）中 `redaction` 所有字段默认 false，
       但 utils.ts 中 SSH 密钥、API key、AWS 密钥、DB 连接串、快递单号、
       门禁码是 always-on 规则（不受 opts 控制）。
 问题：用户看到配置中全是 false 可能以为脱敏完全关闭，但实际上 always-on
       规则始终生效。这是设计意图但缺乏文档说明，容易导致用户困惑。
 建议：在 config-schema.ts 的 redaction 字段上增加注释说明 always-on
       规则不受此配置控制；或者增加一个顶层 `redactionEnabled` 开关来
       统一控制全部规则。

#### 🟡 matchesPathPattern 的通配符匹配仅支持 `*` 前缀


 现状（L39）：仅匹配 `*` 开头的模式（如 `*.env`）。
 问题：不支持中间通配符（如 `/home/*/secret`）或双星号目录通配
       （如 `**/.ssh`）。config-schema.ts 中 tools.S2.paths / S3.paths
       字段用户可能期望更丰富的 glob 语法支持。
 建议：如果需要更丰富的匹配，可以引入 `minimatch` 或 `picomatch` 等
       轻量 glob 库；或在文档中明确说明当前仅支持三种匹配模式。

#### 🟢 resolveDefaultBaseUrl 缺少对 DeepSeek / 国产模型的识别


 现状（L278-L289）：仅识别 Google/Gemini、Anthropic，其余回退为 OpenAI。
 问题：defaultPrivacyConfig.modelPricing 中包含 deepseek-chat（L201），
       但 resolveDefaultBaseUrl 没有 DeepSeek 的判断分支。DeepSeek 的
       API 端点为 `https://api.deepseek.com`，与 OpenAI 不完全相同。
       虽然 DeepSeek 兼容 OpenAI 格式，但 base URL 不同。
 建议：增加 DeepSeek 分支：
       ```
       if (p === "deepseek" || p.includes("deepseek")) {
         return "https://api.deepseek.com";
       }
       ```


### 优先级总览


| # | 级别 | 标题                                      |
|---|------|-------------------------------------------|
| 5 | 🔴   | Phase 2 上下文规则吞掉关键词本身            |
| 1 | 🟡   | normalizePath 不处理相对路径和尾部斜杠      |
| 3 | 🟡   | Phase 2 正则每次调用重复构造                |
| 6 | 🟡   | always-on 规则与 redaction 配置的不对称     |
| 7 | 🟡   | 通配符匹配仅支持 `*` 前缀                   |
| 2 | 🟢   | 命令路径提取不支持含空格/引号路径            |
| 4 | 🟢   | isProtectedMemoryPath 每次重编译正则        |
| 8 | 🟢   | resolveDefaultBaseUrl 缺少 DeepSeek 识别   |
