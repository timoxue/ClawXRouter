# guard-agent.ts — 逐方法文档


 文件定位：Guard Agent 配置管理与会话识别工具集
 所属模块：GuardClaw 隐私路由系统

 核心职责：为 S3（高度敏感）消息的本地处理提供基础设施。
 当检测到 S3 内容时，resolve_model hook 将消息重定向到 guard 子会话，
 本模块提供：Guard Agent 配置解析与验证、guard 子会话 key 的识别、
 云端会话占位消息的生成、以及 provider 是否本地的判断。

 敏感等级体系：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理(proxy)或本地模型(local)
   S3 — 高度敏感，强制本地模型处理

 Guard Agent — 一个专门处理 S3 敏感请求的本地 AI 子代理，
   只能使用本地模型（如 ollama, vllm 等），确保数据不离开用户设备。
## 导入说明                                      (L14)


  PrivacyConfig — 来自 types.ts，隐私配置的顶层类型，包含
      guardAgent / localModel / localProviders 等字段。

  SensitivityLevel — 来自 types.ts，字面量联合类型
      "S1" | "S2" | "S3"，标识敏感等级。
## 函数：isGuardAgentConfigured(config)           (L19-L25)


### 作用

  检查 Guard Agent 是否被完整配置。只有 id、model、workspace
  三个字段都存在时才视为"已配置"。

### 参数

  config: PrivacyConfig — 隐私配置对象

### 返回值

  boolean — true 表示 Guard Agent 可用；false 表示缺失必要配置

### 逐行逻辑


**L20-L24**:
```typescript
return Boolean(config.guardAgent?.id && config.guardAgent?.model && config.guardAgent?.workspace)
```
> 使用可选链 `?.` 安全访问可能不存在的 guardAgent 对象。
> 三个字段通过 `&&` 短路求值：任一为 undefined / null / ""
> 都会导致整体为 falsy。
> 外层 Boolean() 确保返回严格的 boolean 而非 truthy/falsy 值。
> 注意：空字符串 "" 也会被视为 falsy，这是有意为之——
> 空 id/model/workspace 等同于未配置。


### 设计意图

  作为 getGuardAgentConfig 的前置守卫。在系统多处需要快速判断
  "Guard Agent 能否使用"，比如 hooks.ts 中的 resolve_model 回调。
  将三字段校验抽为独立函数，避免调用侧重复编写相同条件。
## 函数：getGuardAgentConfig(config)              (L34-L59)


### 作用

  从 PrivacyConfig 中解析 Guard Agent 的完整配置，包括将
  "provider/model" 格式的 model 字符串拆分为 provider 和 modelName。
  若配置不完整则返回 null。

### 参数

  config: PrivacyConfig — 隐私配置对象

### 返回值

  { id: string; model: string; workspace: string; provider: string; modelName: string } | null
  — 解析后的 Guard Agent 配置对象，或 null（配置不完整时）。
    id:        Guard Agent 标识符（默认 "guard"）
    model:     原始 model 字符串（含 provider 前缀）
    workspace: Guard Agent 工作目录
    provider:  推理服务提供方（如 "ollama"、"vllm"）
    modelName: 去掉 provider 前缀后的纯模型名

### 逐行逻辑


**L41**:
```typescript
if (!isGuardAgentConfigured(config)) { return null; }
```
> 前置校验：id / model / workspace 任一缺失则直接返回 null。
> 调用自身模块的 isGuardAgentConfigured 复用校验逻辑。


**L45**:
```typescript
const fullModel = config.guardAgent?.model ?? "ollama/openbmb/minicpm4.1"
```
> 获取完整 model 字符串。虽然 isGuardAgentConfigured 已确认
> model 存在，但 TypeScript 不能缩窄可选链类型，
> 故仍使用 `??` 提供安全回退值。
> 默认值 "ollama/openbmb/minicpm4.1" 与 defaultPrivacyConfig 一致。


**L46**:
```typescript
const firstSlash = fullModel.indexOf("/")
```
> 查找第一个 "/" 的位置，用于分割 provider 和 modelName。
> 使用 indexOf 而非 split 是因为 model 名本身可能包含 "/"
> （如 "ollama/openbmb/minicpm4.1" 中 modelName 为 "openbmb/minicpm4.1"）。


**L47**:
```typescript
const defaultProvider = config.localModel?.provider ?? "ollama"
```
> 当 model 字符串不含 "/" 时的 provider 回退链：
> 优先使用 localModel.provider 配置，最终回退 "ollama"。


**L48-L50**:
```typescript
const [provider, modelName] = firstSlash >= 0
```

             ? [fullModel.slice(0, firstSlash), fullModel.slice(firstSlash + 1)]
             : [defaultProvider, fullModel]
> 三元运算拆分 provider 和 modelName：
> - 若 "/" 存在 (firstSlash >= 0)：斜杠前为 provider，斜杠后为 modelName
> 例："ollama/openbmb/minicpm4.1" → provider="ollama", modelName="openbmb/minicpm4.1"
> - 若不存在 (firstSlash < 0)：整个字符串作为 modelName，
> provider 使用 defaultProvider（来自 localModel.provider 或 "ollama"）
> 例："minicpm4.1" → provider="ollama", modelName="minicpm4.1"
> 使用 slice 而非 split("/", 2) 确保 modelName 中的 "/" 被保留。

**L52-L58**:
```typescript
return { id, model, workspace, provider, modelName }
```
> 构建返回对象。每个字段都用 `??` 提供安全回退：
> id:        config.guardAgent?.id ?? "guard"
> model:     fullModel（已包含 provider 前缀）
> workspace: config.guardAgent?.workspace ?? "~/.openclaw/workspace-guard"
> provider:  从 model 字符串解析得到
> modelName: 从 model 字符串解析得到
> 注意 id 和 workspace 的回退值与 defaultPrivacyConfig 中一致。


### 设计意图

  Guard Agent 的 model 字段采用 "provider/model" 格式，是系统全局的模型引用约定。
  本函数是该约定的唯一解析点：所有路由器（privacy.ts、configurable.ts）和
  hooks.ts 都通过调用本函数获取解析后的 provider + modelName，
  避免各处重复实现字符串拆分逻辑。
  返回 null 的设计允许调用方安全降级（如 hooks.ts 中 guardCfg?.provider ?? defaultProvider）。
## 函数：isGuardSessionKey(sessionKey)            (L64-L66)


### 作用

  判断一个会话 key 是否属于 guard 子会话。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  boolean — true 表示是 guard 子会话

### 逐行逻辑


**L65**:
```typescript
return sessionKey.endsWith(":guard") || sessionKey.includes(":guard:")
```
> 两种匹配模式：
> 1. endsWith(":guard") — 匹配 "{parentKey}:guard" 格式，
> 即直接的 guard 子会话（最常见的场景）。
> 2. includes(":guard:") — 匹配 "{parentKey}:guard:{suffix}" 格式，
> 即 guard 子会话的嵌套子会话（如 guard 子会话中再创建的子会话）。
> 使用 `||` 短路：endsWith 先检查（更常见），不匹配再检查 includes。


### 设计意图

  Guard 子会话的 key 通过在父会话 key 后追加 ":guard" 后缀生成。
  系统多处需要识别 guard 子会话以决定行为：
  - hooks.ts: 决定是否使用 full-memory-track（guard 会话可读完整历史）
  - hooks.ts: resolve_model 中识别 guard 会话并覆盖 provider/model
  - hooks.ts: 文件访问守卫中跳过对 guard 会话的限制
  - session-manager.ts: 判断消息是否来自 guard agent
  两种模式覆盖了 guard 子会话可能出现的所有嵌套层级。
函数：buildMainSessionPlaceholder(level, reason?, timestamp?)
                                               (L75-L81)

### 作用

  为主（云端可见的）会话历史生成占位消息。当一条消息被重定向到
  guard 子会话时，主会话中需要放一条占位消息，让云端模型知道
  "有东西被私密处理了"，但不泄露实际的敏感内容。

### 参数

  level:     SensitivityLevel — 敏感等级（"S2" 或 "S3"）
  reason?:   string          — 可选的检测原因（如 "keyword: 密码"）
  timestamp?: number         — 可选的时间戳（毫秒）

### 返回值

  string — 格式化的占位消息字符串
  示例："🔒 [Private message — processed locally (keyword: 密码)] [ts=2026-03-18T...]"

### 逐行逻辑


**L76**:
```typescript
const emoji = level === "S3" ? "🔒" : "🔑"
```
> S3 使用 🔒（锁定、完全私密）；其他（S2）使用 🔑（有钥匙、部分敏感）。
> 视觉上快速区分敏感等级。


**L77**:
```typescript
const levelLabel = level === "S3" ? "Private" : "Sensitive"
```
> S3 标注为 "Private"（私密），S2 标注为 "Sensitive"（敏感）。
> 这是给云端模型看的英文标签，帮助模型理解上下文。


**L78**:
```typescript
const reasonSuffix = reason ? ` (${reason})` : ""
```
> 如果提供了 reason，追加括号包裹的原因说明。
> 无 reason 时返回空字符串，不影响输出格式。


**L79**:
```typescript
const tsSuffix = timestamp ? ` [ts=${new Date(timestamp).toISOString()}]` : ""
```
> 如果提供了时间戳，转为 ISO 8601 格式追加。
> 用途：在回顾历史时定位消息的确切时间。
> new Date(timestamp).toISOString() 将毫秒时间戳转为
> "2026-03-18T12:00:00.000Z" 格式。


**L80**:
```typescript
return `${emoji} [${levelLabel} message — processed locally${reasonSuffix}]${tsSuffix}`
```
> 模板字符串组装最终占位消息。
> 核心措辞 "processed locally" 告知云端模型此消息已本地处理，
> 不要尝试回忆或推测其内容。


### 设计意图

  双轨会话架构（dual-track session）的关键组件：
  - 完整轨（full-track）：仅本地可见，包含所有真实消息
  - 清洁轨（clean-track）：云端可见，敏感消息被此占位符替代
  占位消息需要足够信息让云端模型维持对话连贯性（知道"有消息被处理了"），
  同时绝对不泄露任何敏感内容。
  hooks.ts 中 onAssistantChunk 和 beforeSendToModel 回调都调用此函数。
## 常量：BUILTIN_LOCAL_PROVIDERS                  (L83-L86)


  内置本地推理 provider 列表（模块私有，不导出）：
    "ollama", "llama.cpp", "localai", "llamafile", "lmstudio",
    "vllm", "mlx", "sglang", "tgi", "koboldcpp", "tabbyapi", "nitro"

  这些是已知的本地推理后端。任何属于此列表的 provider
  都被视为"安全的本地 provider"，允许用于 S3 路由。
  列表覆盖了主流的本地推理服务：
  - ollama / llama.cpp / llamafile / lmstudio — 消费级本地推理
  - vllm / sglang / tgi — 高性能推理服务器
  - localai / mlx / koboldcpp / tabbyapi / nitro — 其他本地方案
## 函数：isLocalProvider(provider, extraProviders?) (L94-L99)


### 作用

  验证一个 provider 名称是否为本地（非云端）provider。
  用于确保 guard 子会话只使用本地模型，不会将 S3 数据发到云端。

### 参数

  provider:       string   — provider 名称（如 "ollama"、"openai"）
  extraProviders?: string[] — 用户额外配置的本地 provider 列表
                              （来自 PrivacyConfig.localProviders）

### 返回值

  boolean — true 表示是本地 provider，可安全用于 S3；false 表示可能是云端

### 逐行逻辑


**L95**:
```typescript
const lower = provider.toLowerCase()
```
> 统一转小写进行不区分大小写的比较。
> 用户配置可能写 "Ollama" 或 "VLLM"，需要容错。


**L96**:
```typescript
if (BUILTIN_LOCAL_PROVIDERS.includes(lower)) return true
```
> 先检查内置列表。includes 进行线性扫描，
> 列表仅 12 项，性能开销可忽略。


**L97**:
```typescript
if (extraProviders?.some((p) => p.toLowerCase() === lower)) return true
```
> 再检查用户配置的额外 provider 列表。
> `?.some()` 安全处理 extraProviders 为 undefined 的情况。
> 对每个元素也做 toLowerCase() 确保不区分大小写。


**L98**:
```typescript
return false
```
> 不在任何已知本地列表中，视为云端 provider。
> 采用"白名单"策略：只有明确列出的才算本地，
> 未知 provider 默认视为不安全（不能用于 S3）。


### 设计意图

  S3 安全约束的执行点：确保高度敏感数据只发往本地推理服务。
  内置列表 + 用户扩展的双层设计兼顾开箱即用和灵活性。
  白名单策略是安全优先的选择——未知 provider 宁可误判为云端，
  也不能冒风险将 S3 数据发往不受信的后端。
  注意：此函数目前在 guard-agent.ts 中导出但在源码中未找到实际调用点，
  可能用于外部插件或未来的配置验证。
---

## Code Review — 代码审查

## Part A — Code 层面改动建议


#### 🟡 getGuardAgentConfig 的 `??` 回退值与 isGuardAgentConfigured 的语义矛盾


 现状（L41-L45）：
   isGuardAgentConfigured 校验 id / model / workspace 三字段皆非空后，
   getGuardAgentConfig 内部仍使用 `config.guardAgent?.model ?? "ollama/openbmb/minicpm4.1"`
   和 `config.guardAgent?.id ?? "guard"` 等回退值。
 问题：既然已通过校验，这些字段必然存在，回退值永远不会触发。
   这不是 bug，但掩盖了类型系统无法缩窄可选链的问题，
   也让读者困惑"回退值究竟会不会被用到"。
 建议：使用非空断言 `!` 或在 isGuardAgentConfigured 中使用类型守卫
   （type predicate）来缩窄类型：
   ```typescript
   export function isGuardAgentConfigured(
     config: PrivacyConfig
   ): config is PrivacyConfig & {
     guardAgent: { id: string; model: string; workspace: string }
   } { ... }
   ```

   这样后续代码无需 `??` 回退，类型安全性更强。


#### 🟢 BUILTIN_LOCAL_PROVIDERS 可换用 Set 提高查找效率


 现状（L83-L86 + L96）：
   使用 Array.includes() 进行线性搜索。
 问题：目前列表仅 12 项，性能影响可忽略，但如果未来列表扩大
   或 isLocalProvider 在高频路径上调用，线性搜索不是最优。
 建议：改用 `Set`：
   ```typescript
   const BUILTIN_LOCAL_PROVIDERS = new Set([
     "ollama", "llama.cpp", "localai", ...
   ]);
   // L96: if (BUILTIN_LOCAL_PROVIDERS.has(lower)) return true;
   ```


#### 🟢 isLocalProvider 中 extraProviders 可预处理为小写 Set


 现状（L97）：
   `extraProviders?.some((p) => p.toLowerCase() === lower)`
   每次调用都对 extraProviders 中每个元素做 toLowerCase()。
 问题：如果同一 config 下多次调用 isLocalProvider（不同 provider），
   extraProviders 的 toLowerCase() 会重复执行。
 建议：若在热路径上使用，可由调用方预处理一次：
   ```typescript
   const localSet = new Set([
     ...BUILTIN_LOCAL_PROVIDERS,
     ...(extraProviders ?? []).map(p => p.toLowerCase())
   ]);
   ```

   当前文件作为工具集，调用频次不高，优先级很低。
## Part B — 逻辑/设计层面改动建议


#### 🔴 getGuardAgentConfig 的回退模型值在 config 不完整时可能与 defaultPrivacyConfig 不同步


 现状（L45）：
   `config.guardAgent?.model ?? "ollama/openbmb/minicpm4.1"` 硬编码了回退值。
   而 defaultPrivacyConfig（config-schema.ts L189）的 guardAgent.model 也是
   "ollama/openbmb/minicpm4.1"。
 问题：如果未来 defaultPrivacyConfig 中修改默认模型但忘记同步此处，
   会导致两处默认值不一致。同样的问题存在于 L53 的 id 回退 "guard"
   和 L55 的 workspace 回退 "~/.openclaw/workspace-guard"。
 建议：直接引用 defaultPrivacyConfig：
   ```typescript
   import { defaultPrivacyConfig } from "./config-schema.js";
   const fullModel = config.guardAgent?.model
     ?? defaultPrivacyConfig.guardAgent.model;
   ```

   或者在调用前先做 privacy.ts 风格的 config 合并
   （`{ ...defaultPrivacyConfig.guardAgent, ...config.guardAgent }`），
   这样所有回退值自然来自 defaultPrivacyConfig。


#### 🔴 与 privacy.ts / configurable.ts 的行为不一致：config 合并


 现状：
   privacy.ts（L78-L96）的 getPrivacyConfig 会将 defaultPrivacyConfig 与
   用户配置进行深度合并（包括 guardAgent 字段）。
   configurable.ts 中也有类似的合并逻辑。
   但 guard-agent.ts 中的函数直接读取 config.guardAgent，不做合并。
 问题：
   如果调用方传入未合并的原始 config（如直接从 pluginConfig.privacy 取），
   guard-agent.ts 中的回退链（`??`）虽然能应对缺失字段，但行为与
   经过 getPrivacyConfig 合并后的 config 可能不同。
   实际上，调用方（hooks.ts）在某些地方使用的是 getLiveConfig()
   返回的原始 config，并非经过 privacy.ts 合并的版本。
 建议：
   要么在 guard-agent.ts 入口做一次防御性合并：
   ```typescript
   const guardAgent = { ...defaultPrivacyConfig.guardAgent, ...config.guardAgent };
   ```

   要么确保所有调用方都传入已合并的 config（文档约定）。


#### 🟡 isLocalProvider 已导出但在当前仓库中无调用点


 现状（L94-L99）：
   isLocalProvider 被 export，但在 hooks.ts、privacy.ts、configurable.ts
   等文件中均未导入或调用。
 问题：可能是预留 API 或已被重构移除引用但遗忘清理。
   无调用点意味着没有测试覆盖，行为正确性无法保证。
 建议：
   - 如果是预留功能：添加 JSDoc 说明 `@reserved` 或 `@internal`
   - 如果是遗留代码：确认后移除
   - 如果应当使用：在 hooks.ts 的 resolve_model 回调中加入验证逻辑，
     确保路由到的 provider 确实是本地 provider，防止配置错误导致
     S3 数据意外发送到云端。这是一个安全加固的好机会。


#### 🟡 buildMainSessionPlaceholder 中 S1 场景未处理


 现状（L76-L77）：
   `level === "S3" ? ... : ...` — 只区分 S3 和非 S3。
   当传入 "S1" 时也会生成占位消息（emoji=🔑, label="Sensitive"），
   但 S1 不应该产生占位消息（S1 消息不需要本地处理）。
 问题：函数签名接受 SensitivityLevel（包含 "S1"），但 S1 的占位消息
   在语义上是错误的。虽然调用方（hooks.ts L807, L863）都只传 "S3"，
   但类型系统允许错误调用。
 建议：
   - 收窄参数类型：`level: "S2" | "S3"`
   - 或在函数开头加入断言：
     ```typescript
     if (level === "S1") throw new Error("S1 should not generate a placeholder");
     ```


#### 🟢 isGuardSessionKey 缺少空字符串 / edge case 处理


 现状（L65）：
   直接在输入字符串上调用 endsWith / includes。
 问题：传入空字符串 "" 时返回 false（正确行为），
   但如果传入 ":guard"（无父 key 前缀），仍返回 true。
   这可能在测试或非标准场景下导致意外。
 建议：如果需要严格校验，可加入 `sessionKey.length > ":guard".length`
   的前提条件。优先级很低，目前不影响生产行为。
## 优先级总览


| 优先级 | ID | 标题 |
| --- | --- | --- |
| 🔴 高 | 4 | 回退值与 defaultPrivacyConfig 硬编码不同步 |
| 🔴 高 | 5 | 与 privacy.ts 的 config 合并行为不一致 |
| 🟡 中 | 1 | `??` 回退值与 isGuardAgentConfigured 语义矛盾 |
| 🟡 中 | 6 | isLocalProvider 无调用点 |
| 🟡 中 | 7 | buildMainSessionPlaceholder 对 S1 无防护 |
| 🟢 低 | 2 | BUILTIN_LOCAL_PROVIDERS 可改用 Set |
| 🟢 低 | 3 | extraProviders 重复 toLowerCase |
| 🟢 低 | 8 | isGuardSessionKey 边界情况 |
