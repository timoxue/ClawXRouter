# live-config.ts — 逐方法文档


 文件定位：运行时可变配置缓存（Live Config Cache）
 所属模块：GuardClaw 隐私路由系统

 核心职责：维护一份内存中的 PrivacyConfig 可变副本（liveConfig），
 供所有 hooks、router、dashboard 等模块在运行时读取最新配置。
 配置的更新来源有两个：
   1. Dashboard 保存 → updateLiveConfig()
   2. 文件监听器    → guardclaw.json 外部修改时自动热加载

 唯一无法热加载的字段是 proxyPort（端口已绑定，需重启生效）。

 该文件是整个 GuardClaw 插件的"配置中枢"——几乎所有运行时模块
 都通过 getLiveConfig() 获取最新配置，而不是保存自己的配置副本。

 敏感等级体系：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理(proxy)或本地模型(local)
   S3 — 高度敏感，强制本地模型处理
## 导入与模块级状态                              (L1-L17)


**L12**:
```typescript
import { readFileSync, watch, type FSWatcher } from "node:fs"
```
> readFileSync：同步读取 guardclaw.json 文件内容
> watch：监听文件变化事件（用于热加载）
> FSWatcher：watch 返回的文件监视器类型


**L13**:
```typescript
import type { PrivacyConfig } from "./types.js"
```
> PrivacyConfig 是 GuardClaw 的顶层隐私配置类型
> 包含 enabled / s2Policy / checkpoints / rules / localModel /
> guardAgent / session / localProviders / toolAllowlist /
> modelPricing / redaction 等全部配置字段


**L14**:
```typescript
import { defaultPrivacyConfig } from "./config-schema.js"
```
> defaultPrivacyConfig 是所有配置字段的默认值对象
> 包含 enabled=true, s2Policy="proxy", proxyPort=8403 等
> 在 mergeConfig() 中用作基底，与用户配置做浅合并


**L16**:
```typescript
let liveConfig: PrivacyConfig = { ...defaultPrivacyConfig } as PrivacyConfig
```
> 模块级可变变量，保存当前生效的配置快照
> 初始值为 defaultPrivacyConfig 的浅拷贝
> 全系统通过 getLiveConfig() 读取此变量
> 通过 initLiveConfig() / updateLiveConfig() / watchConfigFile() 三种途径更新


**L17**:
```typescript
let configWatcher: FSWatcher | null = null
```
> 保存文件监视器引用，用于防止重复创建 watcher
> watchConfigFile() 通过检查此变量判断是否已注册监听

## 函数：initLiveConfig(pluginConfig)            (L20-L23)


### 作用

  插件启动时，根据传入的 pluginConfig（来自 openclaw.json 解析结果）
  初始化 liveConfig。这是 liveConfig 生命周期的起点。

### 参数

  pluginConfig: Record<string, unknown> | undefined
      — 插件启动时传入的完整配置对象（含 privacy 键），
        可能为 undefined（首次启动无配置文件时）

### 返回值

  void — 无返回值，直接修改模块级变量 liveConfig

### 逐行逻辑


**L21**:
```typescript
const userConfig = (pluginConfig?.privacy ?? {}) as PrivacyConfig
```
> 从 pluginConfig 中提取 privacy 子对象
> 使用 ?. 安全访问——pluginConfig 可能为 undefined
> 使用 ?? {} 兜底——若 privacy 键不存在则用空对象
> as PrivacyConfig 类型断言，因为 pluginConfig 是 Record<string, unknown>


**L22**:
```typescript
liveConfig = mergeConfig(userConfig)
```
> 调用 mergeConfig() 将用户配置与 defaultPrivacyConfig 深度合并
> 合并结果赋值给模块级变量 liveConfig
> 这样即使用户只配置了部分字段，其余字段也有默认值


### 设计意图

  将配置初始化逻辑集中到一处，确保 liveConfig 总是通过 mergeConfig()
  生成——无论是初始化、热加载还是 Dashboard 更新，都走同一条合并路径，
  保证配置结构的完整性和一致性。
## 函数：watchConfigFile(configPath, logger)     (L29-L48)


### 作用

  监听指定的 guardclaw.json 文件，当文件被外部编辑时自动热加载配置。
  使用 300ms 防抖避免编辑器保存时的连续写入触发多次重载。

### 参数

  configPath: string — guardclaw.json 的完整文件路径
  logger: { info: (msg: string) => void } — 日志接口，仅需 info 方法

### 返回值

  void — 无返回值，副作用是注册文件监视器并更新 configWatcher

### 逐行逻辑


**L33**:
```typescript
if (configWatcher) return
```
> 幂等性守卫：如果已经注册了监听器，直接返回
> 防止重复调用创建多个 watcher（会导致多次触发 callback）


**L34**:
```typescript
let debounce: ReturnType<typeof setTimeout> | null = null
```
> 防抖计时器引用，初始为 null
> 类型使用 ReturnType<typeof setTimeout> 以兼容 Node.js 和浏览器环境


**L35**:
```typescript
try {
```
> 外层 try-catch：guardclaw.json 可能尚不存在（首次启动）
> 此时 watch() 会抛出 ENOENT 错误，catch 忽略之


**L36**:
```typescript
configWatcher = watch(configPath, () => {
```
> 调用 Node.js fs.watch() 监听文件变化事件
> 将返回的 FSWatcher 保存到 configWatcher
> 回调在文件每次变化时触发（可能短时间内多次触发）


**L37**:
```typescript
if (debounce) clearTimeout(debounce)
```
> 如果上一次的防抖计时器还未到期，先取消它
> 这是经典的"尾调用防抖"（trailing debounce）模式


**L38**:
```typescript
debounce = setTimeout(() => {
```
> 设置新的 300ms 延迟回调
> 只有最后一次文件变化事件 300ms 后才会真正执行加载


**L39**:
```typescript
try {
```
> 内层 try-catch：解析 JSON 可能失败
> 编辑器保存时可能产生"半写入"的中间状态文件


**L40**:
```typescript
const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
```
> 同步读取 guardclaw.json 文件内容并解析为 JSON
> 使用 readFileSync 而非 readFile——防抖已保证不会高频调用
> as Record<string, unknown> 类型断言用于后续安全访问


**L41**:
```typescript
const privacy = (raw.privacy ?? {}) as PrivacyConfig
```
> 从解析结果中提取 privacy 子对象
> ?? {} 兜底——文件可能没有 privacy 键


**L42**:
```typescript
liveConfig = mergeConfig(privacy)
```
> 与 initLiveConfig 走同一条合并路径
> 确保热加载后的配置结构与初始化一致


**L43**:
```typescript
logger.info("[GuardClaw] guardclaw.json changed — config hot-reloaded")
```
> 记录热加载成功日志
> 运维人员可通过此日志确认配置变更已生效


**L44**:
```typescript
} catch { /* ignore parse errors from partial writes */ }
```
> 忽略 JSON 解析错误——文件可能处于半写入状态
> 下一次完整写入时会再次触发并成功加载


**L45**:
```typescript
}, 300)
```
> 防抖窗口 300ms——在大多数编辑器的保存延迟内足够
> 太短则可能在半写入时读取，太长则用户感知延迟明显


**L47**:
```typescript
} catch { /* file may not exist yet — non-fatal */ }
```
> 外层 catch：文件不存在时 watch() 抛出的 ENOENT
> 这是非致命的——用户可能尚未创建 guardclaw.json
> 后续可通过 Dashboard 保存来创建该文件


### 设计意图

  实现"编辑即生效"的配置体验——用户在任何文本编辑器中修改
  guardclaw.json 后，GuardClaw 会自动拾取变更而无需重启服务。
  双层 try-catch 分别处理"文件不存在"和"JSON 解析失败"两种
  不同的错误场景，保证监听器的健壮性。防抖机制避免了编辑器
  保存时的多次无意义重载。
## 函数：getLiveConfig()                         (L51-L53)


### 作用

  返回当前内存中的 liveConfig 对象——这是整个 GuardClaw 系统
  在运行时获取隐私配置的唯一入口。

### 参数

  无参数

### 返回值

  PrivacyConfig — 当前生效的完整隐私配置对象
  注意：返回的是引用（非拷贝），调用方不应直接修改其字段

### 逐行逻辑


**L52**:
```typescript
return liveConfig
```
> 直接返回模块级变量 liveConfig 的引用
> 无任何拷贝或冻结——追求零开销的热路径读取
> 调用方包括 hooks.ts（约 20 处）、stats-dashboard.ts、
> privacy-proxy.ts、token-stats.ts 等


### 设计意图

  作为中央配置读取点，避免各模块各自缓存配置副本导致不一致。
  所有模块每次需要配置时都调用 getLiveConfig()，确保读到的
  永远是最新的值。这是一种"单一事实来源"（Single Source of Truth）
  模式的简洁实现。
## 函数：updateLiveConfig(patch)                 (L56-L58)


### 作用

  接收来自 Dashboard 保存操作的配置补丁，将其合并到 liveConfig 中。
  这是 Dashboard → 运行时配置同步的关键桥梁。

### 参数

  patch: Partial<PrivacyConfig> — 部分配置补丁
      仅包含 Dashboard 表单中用户修改过的字段

### 返回值

  void — 无返回值，直接更新模块级变量 liveConfig

### 逐行逻辑


**L57**:
```typescript
liveConfig = mergeConfig({ ...liveConfig, ...patch })
```
> 先将 patch 浅覆盖到当前 liveConfig 上
> 再通过 mergeConfig() 与 defaultPrivacyConfig 做深度合并
> 这个顺序很重要：{ ...liveConfig, ...patch } 保证 patch 优先
> 外层 mergeConfig() 保证所有嵌套对象都有默认值兜底
> 最终结果赋值给 liveConfig，整个过程是原子替换（引用替换）


### 设计意图

  支持增量更新——Dashboard 不需要发送完整配置，只发送变更部分。
  合并策略保证：
    1. 用户未修改的字段保留当前值（而非退回默认值）
    2. 嵌套对象（如 rules.keywords）不会因浅合并丢失子字段
    3. 与 initLiveConfig() / watchConfigFile() 共享 mergeConfig()，
       合并行为全局一致
## 函数：mergeConfig(userConfig)                 (L60-L86)


### 作用

  将用户提供的 PrivacyConfig 与 defaultPrivacyConfig 做两层深度合并，
  生成一个结构完整的配置对象。这是整个 live-config 模块的核心合并引擎。

### 参数

  userConfig: PrivacyConfig — 用户侧配置（来自初始化、热加载或 Dashboard）

### 返回值

  PrivacyConfig — 合并后的完整配置对象
  保证所有顶层和关键嵌套字段都存在（至少有默认值）

### 逐行逻辑


**L61-L62**:
```typescript
return { ...defaultPrivacyConfig, ...userConfig,
```
> 第一层：顶层字段的浅合并
> defaultPrivacyConfig 提供所有字段的默认值
> userConfig 中存在的字段覆盖默认值
> 但对于嵌套对象（checkpoints, rules 等），浅合并会导致
> userConfig 的子对象整个替换 default 的子对象
> 因此下面逐个嵌套对象做第二层合并


**L64**:
```typescript
checkpoints: { ...defaultPrivacyConfig.checkpoints, ...userConfig.checkpoints }
```
> 合并 checkpoint 配置（onUserMessage / onToolCallProposed / onToolCallExecuted）
> 用户可以只覆盖一个 checkpoint 而不影响其他


**L65-L71**:
```typescript
rules: { keywords: {...}, patterns: {...}, tools: { S2: {...}, S3: {...} } }
```
> rules 是三层嵌套结构，需要分别合并 keywords / patterns / tools
> tools 更深一层，S2 和 S3 各自独立合并
> 使用 ?. 安全访问——userConfig.rules 可能为 undefined
> defaultPrivacyConfig.rules?.keywords 理论上总是存在的
> （defaultPrivacyConfig 中定义了空数组兜底）


**L73**:
```typescript
localModel: { ...defaultPrivacyConfig.localModel, ...userConfig.localModel }
```
> 合并本地模型配置（enabled / type / model / endpoint / apiKey）
> 用户可以只修改 endpoint 而保留其他默认值


**L74**:
```typescript
guardAgent: { ...defaultPrivacyConfig.guardAgent, ...userConfig.guardAgent }
```
> 合并 Guard Agent 配置（id / workspace / model）


**L75**:
```typescript
session: { ...defaultPrivacyConfig.session, ...userConfig.session }
```
> 合并 session 配置（isolateGuardHistory / baseDir / injectDualHistory / historyLimit）


**L76-L79**:
```typescript
localProviders: [ ...defaultPrivacyConfig.localProviders, ...(userConfig.localProviders ?? []) ]
```
> localProviders 是数组类型，合并策略为拼接（concat）而非覆盖
> 这意味着用户自定义的 provider 会追加到内置列表之后
> 使用 ?? [] 防止 userConfig.localProviders 为 undefined 时展开报错
> ⚠ 注意：defaultPrivacyConfig.localProviders 默认为空数组
> 所以目前实质上等同于直接使用 userConfig 的值
> 但如果将来默认列表中增加内置项，拼接逻辑会导致重复


**L80-L83**:
```typescript
modelPricing: { ...defaultPrivacyConfig.modelPricing, ...userConfig.modelPricing }
```
> 合并模型定价表（Record<string, { inputPer1M, outputPer1M }>）
> 浅合并：用户可以覆盖某个模型的定价或添加新模型
> 但无法只修改某个模型的 inputPer1M 而保留 outputPer1M
> （因为是按模型名称键的浅合并，值对象会被整个替换）


**L84**:
```typescript
redaction: { ...defaultPrivacyConfig.redaction, ...userConfig.redaction }
```
> 合并 PII 脱敏规则开关（internalIp / email / envVar / creditCard 等）
> 用户可以逐项开启/关闭单个脱敏规则


**L85**:
```typescript
} as PrivacyConfig
```
> 最终的类型断言——因为展开运算符生成的类型可能不精确


### 设计意图

  mergeConfig 是整个 live-config 模块的核心函数，被其他三个导出函数
  （initLiveConfig / watchConfigFile / updateLiveConfig）共同调用。
  其设计目标是：
    1. 保证配置完整性——即使用户只配置了一个字段，其余字段都有默认值
    2. 支持嵌套覆盖——用户可以精确到 rules.keywords.S3 级别修改
    3. 避免深拷贝开销——只在需要的层级做浅合并

  选择手动逐字段合并而非通用 deepMerge 的原因：
    - PrivacyConfig 的嵌套结构是固定的，手动合并更可控
    - 不同字段的合并策略不同（对象用展开，数组用拼接）
    - 通用 deepMerge 对数组的处理通常不符合预期
---

## Code Review — 代码审查

## Part A — Code 层面改动建议


#### 🟡 localProviders 数组拼接可能产生重复项


 现状（L76-L79）：
   localProviders: [
     ...defaultPrivacyConfig.localProviders,
     ...(userConfig.localProviders ?? []),
   ]

 问题：当通过 updateLiveConfig() 多次更新时，
   { ...liveConfig, ...patch } 产生的 userConfig 已经包含了
   之前拼接进去的 defaultPrivacyConfig.localProviders 内容。
   每次 update 都会再次拼接一遍 default，导致重复。
   当前 defaultPrivacyConfig.localProviders 为空数组 []，
   所以暂时不会触发 bug，但未来一旦添加默认值就会暴露。

 建议：对拼接结果去重：
   localProviders: [...new Set([
     ...defaultPrivacyConfig.localProviders,
     ...(userConfig.localProviders ?? []),
   ])]


#### 🟡 modelPricing 值对象的浅合并粒度不足


 现状（L80-L83）：
   modelPricing: {
     ...defaultPrivacyConfig.modelPricing,
     ...userConfig.modelPricing,
   }

 问题：如果用户只想修改 "gpt-4o" 的 inputPer1M 而不变动
   outputPer1M，当前的浅合并会用用户的 { inputPer1M: 2 }
   整个替换默认的 { inputPer1M: 2.5, outputPer1M: 10 }，
   导致 outputPer1M 丢失变成 undefined。

 建议：对 modelPricing 做键级别的深合并：
   const mergedPricing: Record<string, { inputPer1M?: number; outputPer1M?: number }> = {};
   for (const key of new Set([
     ...Object.keys(defaultPrivacyConfig.modelPricing ?? {}),
     ...Object.keys(userConfig.modelPricing ?? {}),
   ])) {
     mergedPricing[key] = {
       ...defaultPrivacyConfig.modelPricing?.[key],
       ...userConfig.modelPricing?.[key],
     };
   }


#### 🟢 getLiveConfig() 返回可变引用——缺乏防御性


 现状（L52）：return liveConfig

 问题：任何调用方都可以直接修改返回对象的字段
   （如 config.enabled = false），导致全局状态被意外篡改。
   当前 hooks.ts 中约 20 处调用都是只读使用，但没有编译期保障。

 建议：返回类型改为 Readonly<PrivacyConfig>，或在开发模式下
   使用 Object.freeze() 做运行时防御。考虑到热路径性能要求，
   至少可以将返回类型标注为 Readonly 来获得编译期检查：
   export function getLiveConfig(): Readonly<PrivacyConfig> { ... }


#### 🟢 configWatcher 未提供清理/关闭机制


 现状（L17, L33-L47）：configWatcher 创建后无处关闭

 问题：插件卸载或进程优雅退出时，FSWatcher 可能阻止 Node.js
   进程退出（watch 持有事件循环引用）。

 建议：导出 stopWatchingConfig() 函数：
   export function stopWatchingConfig(): void {
     configWatcher?.close();
     configWatcher = null;
   }
   在插件 destroy/cleanup 钩子中调用。
## Part B — 逻辑/设计层面改动建议


#### 🔴 mergeConfig 缺少 routers / pipeline / toolAllowlist 字段合并


 现状（L60-L86）：mergeConfig 手动列举了 checkpoints / rules /
   localModel / guardAgent / session / localProviders / modelPricing /
   redaction 八个嵌套字段的合并逻辑。

 问题：PrivacyConfig 类型中还定义了 toolAllowlist（string[]）、
   且 defaultPrivacyConfig（config-schema.ts L219-L226）中还包含
   routers 和 pipeline 两个嵌套对象，但 mergeConfig 都没有对应
   的合并逻辑。

   - routers：浅合并 { ...defaultPrivacyConfig, ...userConfig }
     会导致用户 routers 整个替换默认的 { privacy: { enabled: true } }。
     如果用户只添加了一个新 router 而没有显式包含 privacy router，
     privacy router 的配置就丢失了。
   - pipeline：同理，用户只配置 onUserMessage 时，
     onToolCallProposed / onToolCallExecuted 会丢失。
   - toolAllowlist：数组类型，当前依赖顶层浅合并（整个替换），
     行为上是正确的（allowlist 应该完全由用户控制），但与
     localProviders 的拼接策略不一致，可能引起混淆。

 建议：
   routers: {
     ...defaultPrivacyConfig.routers,
     ...userConfig.routers,
   },
   pipeline: {
     ...defaultPrivacyConfig.pipeline,
     ...userConfig.pipeline,
   },


#### 🔴 文件监听与 Dashboard 保存的竞争条件


 现状：stats-dashboard.ts 的保存流程：
   1. updateLiveConfig(body.privacy)       → 更新内存
   2. writeFileSync(guardclaw.json, ...)   → 写入磁盘
   而 watchConfigFile 监听 guardclaw.json 变化后也会触发重载。

 问题：Dashboard 保存时，步骤 1 已将 liveConfig 更新为最新值，
   但步骤 2 写入磁盘后触发 watcher，300ms 后又会从磁盘读取并
   重新 mergeConfig() 覆盖 liveConfig。如果这期间又有一次
   updateLiveConfig() 调用（如用户快速连续保存），可能导致
   后续的 updateLiveConfig 被 watcher 的延迟回调覆盖。

   时序示例：
     T=0ms   updateLiveConfig(patchA)  → liveConfig = A
     T=10ms  writeFileSync(patchA)     → 触发 watcher
     T=100ms updateLiveConfig(patchB)  → liveConfig = B
     T=310ms watcher callback fires    → 从磁盘读取 patchA → liveConfig = A ← 回退!

 建议：在 updateLiveConfig / watchConfigFile 中添加"跳过下一次
   watcher 触发"的标志位：
   let skipNextWatch = false;
   在 updateLiveConfig 后设 skipNextWatch = true，
   watcher 回调开头检查并重置该标志。


#### 🟡 initLiveConfig / watchConfigFile 的调用方仅在 index.ts


 现状：整个代码库中只有 guardclaw/index.ts 调用了 initLiveConfig
   和 watchConfigFile（L355-L356）。

 问题：这两个函数是导出的公共 API，但缺乏使用文档和调用顺序约束。
   如果调用方先调用 watchConfigFile 再调用 initLiveConfig，
   watcher 的回调可能在 initLiveConfig 之前触发，导致配置
   短暂处于"默认值"状态。当前 index.ts 的调用顺序是正确的
   （先 init 后 watch），但这是隐式约定而非强制约束。

 建议：考虑将 watchConfigFile 的调用内联到 initLiveConfig 中，
   提供单一入口：
   export function initLiveConfig(
     pluginConfig: Record<string, unknown> | undefined,
     options?: { configPath?: string; logger?: ... }
   ): void { ... }
   这样调用方不可能搞错顺序。


#### 🟡 watchConfigFile 的错误未上报


 现状（L44, L47）：两个 catch 块都是空的 / 仅有注释

 问题：
   - 外层 catch（L47）：文件不存在时静默忽略，合理；但如果是
     权限不足等其他错误，也会被忽略，运维人员无从排查。
   - 内层 catch（L44）：JSON 解析失败时静默忽略。如果用户的
     guardclaw.json 长期存在语法错误，他不会收到任何反馈。

 建议：至少在内层 catch 中通过 logger.info 或 logger.warn 输出
   一行日志，告知用户配置文件解析失败：
   catch (err) {
     logger.info(`[GuardClaw] guardclaw.json parse error — skipping reload`);
   }
   （需要将 logger 传入或通过闭包捕获）
## 优先级总览


| 优先 | 标题 |
| --- | --- |
| 🔴 5 | mergeConfig 缺少 routers/pipeline 字段合并 |
| 🔴 6 | 文件监听与 Dashboard 保存的竞争条件 |
| 🟡 1 | localProviders 数组拼接可能产生重复项 |
| 🟡 2 | modelPricing 值对象的浅合并粒度不足 |
| 🟡 7 | initLiveConfig / watchConfigFile 调用顺序隐式 |
| 🟡 8 | watchConfigFile 的错误未上报 |
| 🟢 3 | getLiveConfig() 返回可变引用缺乏防御性 |
| 🟢 4 | configWatcher 未提供清理/关闭机制 |
