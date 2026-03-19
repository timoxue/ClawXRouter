# router-pipeline.ts — 逐方法文档


 文件定位：GuardClaw 路由管线（Router Pipeline）核心编排器
 所属模块：GuardClaw 隐私路由系统

 核心职责：
   实现多路由器的注册、配置、两阶段并行执行及加权合并决策。
   Pipeline 依据 EdgeClaw 的 checkpoint + detector 组合模型，将多个
   GuardClawRouter（privacy / token-saver / 自定义路由器）在指定检查点
   并行运行，取最高限制等级的决策（S3 > S2 > S1），并以权重决定同等级
   下的最终 action 和 target。支持快速路径短路（Phase 1 达到 S3/S2-local
   时跳过慢路由器），避免不必要的 LLM 调用开销。

 敏感等级体系：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理(proxy)或本地模型(local)
   S3 — 高度敏感，强制本地模型处理

 关键依赖：
   types.ts — Checkpoint, DetectionContext, GuardClawRouter,
              PipelineConfig, RouterDecision, RouterRegistration, maxLevel
   hooks.ts — 通过 getGlobalPipeline() 获取单例并调用 pipeline.run()
   routers/privacy.ts — 内置隐私路由器 (weight 默认 50，id="privacy")
   routers/token-saver.ts — 成本优化路由器 (weight 通常 < 50，id="token-saver")
   routers/configurable.ts — Dashboard 可配置路由器
## 类：RouterPipeline                              (L26-L278)


路由管线的核心类。管理路由器注册、配置、执行和决策合并。

实例字段说明：
  routers: Map<string, GuardClawRouter>
      路由器实例注册表，key 为路由器 id，value 为实现了
      GuardClawRouter 接口的对象。

  pipelineConfig: PipelineConfig
      管线配置，按 checkpoint 指定运行哪些路由器及顺序。
      类型为 { onUserMessage?: string[], onToolCallProposed?: string[],
      onToolCallExecuted?: string[] }。

  routerConfigs: Map<string, RouterRegistration>
      路由器注册元信息（enabled / type / weight / module / options）。
      与 routers Map 分开存储，使元信息可以先于实例加载。

  logger: { info, warn, error }
      日志接口，构造时可注入，默认降级到 console。
## 构造函数：constructor(logger?)                   (L32-L38)


### 作用

  初始化 RouterPipeline 实例，设置日志记录器。

### 参数

  logger?: { info, warn, error } — 可选的日志对象。
      若不传入，使用 console.log / console.warn / console.error 作为降级。

### 返回值

  RouterPipeline 实例。

### 逐行逻辑


**L33**:
```typescript
this.logger = logger ?? { ... };
```
> 使用空值合并运算符 ??：如果 logger 为 undefined/null，
> 则创建一个包含 info/warn/error 方法的默认对象，
> 分别映射到 console.log / console.warn / console.error。
> 这种模式使 Pipeline 在无框架环境（单元测试等）下也能正常运行。


### 设计意图

  通过依赖注入使日志行为可替换。在 hooks.ts 中通过 OpenClaw 的
  api.logger 注入真实的日志系统；在测试中可以注入 mock logger。
## 方法：register(router, registration?)            (L43-L49)


### 作用

  将一个路由器实例注册到管线中。如果已存在同 id 的路由器，则覆盖。

### 参数

  router: GuardClawRouter — 路由器实例，必须包含 id 和 detect() 方法。
  registration?: RouterRegistration — 可选的注册元信息
      (enabled / type / weight / module / options)。

### 返回值

  void

### 逐行逻辑


**L44**:
```typescript
this.routers.set(router.id, router);
```
> 将路由器实例存入 routers Map，key 为路由器自身的 id。
> Map.set 天然支持覆盖——如果已有同 id 路由器，直接替换。


**L45-L47**:
```typescript
if (registration) { this.routerConfigs.set(router.id, registration); }
```
> 若提供了 registration 参数，将其存入 routerConfigs Map。
> routerConfigs 与 routers 分离：配置元信息可以独立于实例存在，
> 方便 configure() 先行加载配置、后续再按需加载实例。


**L48**:
```typescript
this.logger.info(`[RouterPipeline] Registered router: ${router.id}`);
```
> 记录注册日志。使用模板字面量打印路由器 id，方便运行时排查。


### 设计意图

  提供简单的注册 API，同时分离"实例"与"元信息"。
  这样 configure() 可以先设置所有路由器的 enabled/weight 等配置，
  而 register() 在路由器实际实例化后再注入——两个操作解耦。
方法：loadCustomRouter(id, modulePath, registration?)
                                                 (L54-L67)

### 作用

  从指定的模块路径动态加载一个自定义路由器，并注册到管线中。

### 参数

  id: string — 路由器唯一标识符。
  modulePath: string — 自定义路由器模块的文件路径（ESM 动态 import）。
  registration?: RouterRegistration — 可选的注册元信息。

### 返回值

  Promise<void> — 异步操作，加载失败时不抛异常（内部 catch 并记日志）。

### 逐行逻辑


**L56**:
```typescript
const mod = await import(modulePath);
```
> 使用 ESM 动态 import() 加载外部模块。
> 这允许用户在 config 中指定任意 .js/.ts 模块路径，
> Pipeline 在运行时按需加载，无需编译期依赖。


**L57**:
```typescript
const router: GuardClawRouter = mod.default ?? mod;
```
> 优先取模块的默认导出 (mod.default)；如果没有默认导出，
> 则取模块本身 (mod) 作为路由器对象。
> 兼容 `export default router` 和 `export const detect = ...` 两种风格。


**L58-L61**:
```typescript
if (!router.detect || typeof router.detect !== "function") { ... return; }
```
> 验证导出的对象是否包含合法的 detect 函数。
> 如果缺少 detect 方法，记录错误日志并提前返回，不注册此路由器。
> 防止不合规的模块导致 run() 阶段运行时错误。


**L62**:
```typescript
router.id = id;
```
> 用传入的 id 覆盖路由器自带的 id。
> 这确保 Pipeline 层面的 id 与 config 中声明的一致，
> 即使模块自身硬编码了不同的 id。


**L63**:
```typescript
this.register(router, registration);
```
> 调用 register() 完成注册。复用已有逻辑（存 Map + 日志）。


**L64-L66**:
```typescript
catch (err) { this.logger.error(...) }
```
> 捕获 import 和验证过程中的所有异常。
> 仅记录错误日志，不向上抛——一个自定义路由器加载失败
> 不应影响其他路由器和整个管线的正常运行。


### 设计意图

  提供插件化扩展能力：用户可以在 config 中声明自定义路由器模块路径，
  Pipeline 动态加载。容错设计确保单个模块故障不影响全局。
## 方法：configure(config)                          (L72-L84)


### 作用

  从插件配置对象中批量加载路由器元信息和管线执行配置。

### 参数

  config: {
    routers?: Record<string, RouterRegistration | undefined>
        — 路由器注册元信息字典。
    pipeline?: PipelineConfig
        — 管线配置，指定每个 checkpoint 运行哪些路由器 id。
  }

### 返回值

  void

### 逐行逻辑


**L76-L79**:
```typescript
if (config.routers) { for (const [id, reg] of Object.entries(...)) { ... } }
```
> 遍历 routers 字典中的每一条注册记录。
> Object.entries 返回 [id, reg] 键值对数组。
> if (reg) 过滤掉值为 undefined 的条目（config 中某些 key 可能显式设为 undefined 以"删除"）。
> 将有效的 reg 存入 routerConfigs Map。


**L81-L83**:
```typescript
if (config.pipeline) { this.pipelineConfig = config.pipeline; }
```
> 如果提供了 pipeline 配置，整体替换当前 pipelineConfig。
> 不是合并而是覆盖——因为 PipelineConfig 的三个 checkpoint
> 数组是独立的，部分合并逻辑复杂且容易出错。


### 设计意图

  将"配置加载"与"实例注册"分离。configure() 仅存储元信息
  （enabled / weight / module 等），不触发实际的模块加载或实例化。
  后续 loadCustomRouters() 根据这些元信息按需加载。
## 方法：loadCustomRouters()                        (L89-L95)


### 作用

  遍历所有已配置的路由器元信息，加载尚未注册的自定义路由器模块。

### 参数

  无。

### 返回值

  Promise<void>

### 逐行逻辑


**L90**:
```typescript
for (const [id, reg] of this.routerConfigs) { ... }
```
> 遍历 routerConfigs Map 中的所有注册记录。
> 使用 Map 的迭代器，自动获取 [key, value] 对。


**L91**:
```typescript
if (reg.type === "custom" && reg.module && !this.routers.has(id)) { ... }
```
> 三个条件缺一不可：
> ① reg.type === "custom"：只有自定义类型需要动态加载，
> "builtin" 和 "configurable" 在初始化时已由代码直接注册。
> ② reg.module：必须指定了模块路径。
> ③ !this.routers.has(id)：避免重复加载——如果该 id 已注册，跳过。


**L92**:
```typescript
await this.loadCustomRouter(id, reg.module, reg);
```
> 调用 loadCustomRouter() 执行实际的动态 import + 注册。
> 使用 await 串行加载：一个模块加载完毕后再加载下一个。
> 串行是有意为之——避免大量并发 import 造成的文件系统压力。


### 设计意图

  作为 Pipeline 初始化的最后一步，将 configure() 中声明的自定义路由器
  按需实例化。分两步（先 configure 后 loadCustomRouters）的好处是：
  内置路由器可以在 configure 之前就 register，不受加载顺序影响。
## 方法：getRoutersForCheckpoint(checkpoint)        (L101-L108)


### 作用

  获取指定检查点应运行的路由器 id 列表（有序）。

### 参数

  checkpoint: Checkpoint — "onUserMessage" | "onToolCallProposed" | "onToolCallExecuted"

### 返回值

  string[] — 路由器 id 数组。
      若 pipelineConfig 中为该 checkpoint 配置了非空列表，返回配置值；
      否则回退到所有已注册路由器（按注册顺序）。

### 逐行逻辑


**L102**:
```typescript
const configured = this.pipelineConfig[checkpoint];
```
> 从 pipelineConfig 中按 checkpoint 名取对应的路由器列表。
> PipelineConfig 是 { onUserMessage?: string[], ... } 结构，
> 使用计算属性名访问（checkpoint 本身就是 key 字符串）。


**L103-L105**:
```typescript
if (configured && configured.length > 0) { return configured; }
```
> 如果配置存在且非空，直接返回。
> 同时检查 length > 0 是因为空数组 [] 在 JS 中为 truthy，
> 但语义上"空列表"等同于"未配置"——应回退到默认行为。


**L107**:
```typescript
return [...this.routers.keys()];
```
> 回退逻辑：返回所有已注册路由器的 id。
> 使用展开运算符将 Map 的 keys() 迭代器转为数组。
> 顺序取决于 Map 的插入顺序——即 register() 的调用顺序。


### 设计意图

  提供"约定优于配置"的体验：如果用户未在 pipeline 配置中指定
  某个 checkpoint 的路由器列表，默认运行全部已注册路由器。
  这使得注册新路由器后无需额外配置即可生效。
## 方法（私有）：isRouterEnabled(id)                (L113-L116)


### 作用

  检查指定路由器是否在配置中被启用。

### 参数

  id: string — 路由器标识符。

### 返回值

  boolean — 如果未配置或 enabled 字段不为 false，返回 true（默认启用）。

### 逐行逻辑


**L114**:
```typescript
const reg = this.routerConfigs.get(id);
```
> 从 routerConfigs Map 中获取注册元信息。
> 如果该 id 没有对应的 registration（例如用代码 register() 但
> 未传 registration），reg 为 undefined。


**L115**:
```typescript
return reg?.enabled !== false;
```
> 可选链 reg?.enabled：如果 reg 为 undefined，结果为 undefined。
> undefined !== false 为 true → 默认启用。
> 只有显式设置 enabled: false 时才返回 false → 禁用。
> 这种"默认启用"语义确保注册即生效，无需额外 enabled: true。


### 设计意图

  安全默认值——路由器注册后默认参与管线执行。
  用户可通过配置 enabled: false 在不移除注册的情况下临时禁用。
## 方法：getRouterWeight(id)                        (L121-L123)


### 作用

  获取路由器的合并权重值。

### 参数

  id: string — 路由器标识符。

### 返回值

  number — 权重值（0-100）。若未配置，默认 50。

### 逐行逻辑


**L122**:
```typescript
return this.routerConfigs.get(id)?.weight ?? 50;
```
> 链式取值：routerConfigs.get(id) → reg 对象 → .weight 字段。
> 任何环节为 undefined 时，?? 50 兜底返回默认权重。
> 50 是中间值：safety 路由器（privacy）通常使用 >= 50 的高权重，
> 优化路由器（token-saver）使用 < 50 的低权重。


### 设计意图

  权重决定两个层面的行为：
  ① run() 中的 Phase 1/2 分组边界（weight >= 50 为 fast，< 50 为 slow）。
  ② mergeDecisionsWeighted() 中同等级决策的优先级——高权重优先。
  默认 50 意味着未配置权重的路由器归入 fast 组并享有中等优先级。
## 方法：run(checkpoint, context, pluginConfig)     (L140-L207)


### 作用

  在指定检查点执行路由管线。采用两阶段并行执行 + 短路优化策略：
  Phase 1 运行高权重（fast）路由器；若结果已确定高限制等级则跳过
  Phase 2 的低权重（slow）路由器。

### 参数

  checkpoint: Checkpoint — "onUserMessage" | "onToolCallProposed" | "onToolCallExecuted"
  context: DetectionContext — 检测上下文，含 message / toolName / toolParams 等。
  pluginConfig: Record<string, unknown> — 完整插件配置，传递给每个路由器的 detect()。

### 返回值

  Promise<RouterDecision> — 合并后的最终路由决策。包含 level / action /
      target / reason / confidence / routerId 等字段。

### 逐行逻辑


**L145**:
```typescript
const routerIds = this.getRoutersForCheckpoint(checkpoint);
```
> 获取该 checkpoint 应运行的路由器列表。
> 结果取决于 pipelineConfig 或回退到全部注册路由器。


**L147-L149**:
```typescript
if (routerIds.length === 0) { return { level: "S1", ... }; }
```
> 如果没有路由器需要运行（空管线），返回最低限制等级 S1 passthrough。
> reason: "No routers configured" 便于调试。


**L151-L153**:
```typescript
type Entry = { id, weight, router }; const fast/slow: Entry[] = [];
```
> 声明本地类型 Entry 和两个分组数组。
> fast 存放 weight >= 50 的路由器，slow 存放 weight < 50 的。


**L155-L164**:
```typescript
for (const id of routerIds) { ... }
```
> 遍历路由器列表，按条件过滤和分组：


**L156**:
```typescript
if (!this.isRouterEnabled(id)) continue;
```
> 跳过被禁用（enabled: false）的路由器。


**L157-L160**:
```typescript
const router = this.routers.get(id); if (!router) { warn + continue; }
```
> 获取路由器实例。如果 id 在 pipelineConfig 中声明但未注册
> （例如 loadCustomRouter 失败），打印警告并跳过。


**L162-L163**:
```typescript
const weight = this.getRouterWeight(id);
```

             (weight >= 50 ? fast : slow).push({ id, weight, router });
> 获取权重并按 50 阈值分入 fast 或 slow 组。
> 使用三元表达式简洁地选择目标数组。

**L166-L168**:
```typescript
if (fast.length === 0 && slow.length === 0) { return S1 passthrough; }
```
> 所有路由器都被禁用或未注册——返回默认 S1。
> reason: "No enabled routers" 区别于上方的 "No routers configured"。


**L171**:
```typescript
const fastResults = await this.runGroup(fast, context, pluginConfig);
```
> 并行执行所有 fast 路由器（内部用 Promise.allSettled）。
> 返回 WeightedDecision[] — 每个决策附带权重。


**L173-L177**:
```typescript
for (const r of fastResults) { this.logger.info(...); }
```
> 逐条记录 Phase 1 结果日志（level / action / reason / target）。
> 使用 .trim() 去除末尾多余空格。


**L179-L184**:
```typescript
const mustShortCircuit = fastResults.some((r) => { ... });
```
> 短路判断核心逻辑：
> L180: S1 或 passthrough → 不触发短路（完全无限制）。
> L182: S2 + target.provider === "guardclaw-privacy" → 不触发短路。
> 这是 S2-proxy 路径：数据仍会发到云端（经脱敏），
> Phase 2 的 token-saver 仍可优化模型选择——所以不应跳过。
> L183: 其他情况（S3 / S2-local / block / redirect 非 proxy）→ true，
> 表示已确定需要本地处理或阻断，无需再运行慢路由器。


**L186-L195**:
```typescript
if (mustShortCircuit || slow.length === 0) { ... }
```
> 两种情况直接返回 Phase 1 结果：
> ① 满足短路条件：S3/S2-local 等高限制已确定。
> ② 没有 slow 路由器需要运行。
> L187-L190: 短路且存在被跳过的 slow 路由器时，记录日志。
> L192: mergeDecisionsWeighted(fastResults) 合并 Phase 1 决策。
> L193: logFinalDecision() 记录最终决策日志。


**L198**:
```typescript
const slowResults = await this.runGroup(slow, context, pluginConfig);
```
> Phase 2：并行执行所有 slow 路由器。
> 只有 Phase 1 全 S1 或 S2-proxy 时才会到达此处。


**L199-L203**:
```typescript
for (const r of slowResults) { this.logger.info(...); }
```
> 逐条记录 Phase 2 结果日志。格式与 Phase 1 一致。


**L204**:
```typescript
const merged = mergeDecisionsWeighted([...fastResults, ...slowResults]);
```
> 将两个阶段的所有决策合并。展开运算符创建新数组，
> mergeDecisionsWeighted 基于级别 + 权重 + action 优先级完成合并。


**L205-L206**:
```typescript
this.logFinalDecision(checkpoint, merged); return merged;
```
> 记录最终决策并返回。


### 设计意图

  两阶段短路设计是性能优化的核心：
  - Phase 1 运行 privacy 等规则/快速路由器（通常 < 10ms）。
  - Phase 2 运行 token-saver 等需要 LLM 调用的慢路由器（~200ms+）。
  - 当 Phase 1 已确定 S3/S2-local 时，跳过 Phase 2 可节省一次 LLM 调用。
  - 但 S2-proxy 不短路，因为 token-saver 的模型选择对代理转发仍有价值
    （proxy 脱敏后转发到云端，选择更便宜的模型可以降低成本）。
方法（私有）：runGroup(group, context, pluginConfig)
                                                 (L209-L241)

### 作用

  并行执行一组路由器，收集并返回成功的决策结果（附带权重）。

### 参数

  group: Array<{ id, weight, router }> — 要执行的路由器组。
  context: DetectionContext — 检测上下文。
  pluginConfig: Record<string, unknown> — 完整插件配置。

### 返回值

  Promise<WeightedDecision[]> — 成功的决策数组，失败的路由器会被跳过
      并记录错误日志。

### 逐行逻辑


**L214-L221**:
```typescript
const tasks = group.map(({ id, weight, router }) => ({ ... }));
```
> 为每个路由器创建一个 task 对象，包含 id、weight 和 promise。


**L217**:
```typescript
promise: router.detect(context, pluginConfig).then((d) => { d.routerId = id; return d; })
```
> 调用每个路由器的 detect() 方法。
> .then() 在决策返回后给 decision.routerId 赋值为路由器 id。
> 这确保合并时可以追溯每个决策来自哪个路由器。
> 注意：这里直接修改了 d 对象（副作用），不是创建新对象。


**L223**:
```typescript
const settled = await Promise.allSettled(tasks.map((t) => t.promise));
```
> Promise.allSettled 并行执行所有 detect() 调用。
> 与 Promise.all 不同，allSettled 永远不会 reject——
> 即使某个路由器抛异常，其他路由器的结果仍然可用。
> 这对容错至关重要：一个路由器的 LLM 调用超时不应阻塞整个管线。


**L226-L238**:
```typescript
for (let i = 0; i < settled.length; i++) { ... }
```
> 遍历 settled 结果，按索引与 tasks 数组对应。


**L229**:
```typescript
if (result.status === "fulfilled") { ... }
```
> 成功的决策：
> L231-L232: 构造日志字符串（reason / target 信息）。
> L233: 输出结构化日志：[GuardClaw] [checkpoint] routerId: level action target reason
> L234: 将 { decision, weight } 推入 results 数组。


**L235-L237**:
```typescript
else { this.logger.error(...) }
```
> 失败的路由器：记录错误日志（包含路由器 id 和错误信息），
> 但不向 results 推入任何内容——该路由器的决策被忽略。


### 设计意图

  核心设计选择：
  ① Promise.allSettled 而非 Promise.all → 容错优先，单点故障不影响全局。
  ② routerId 赋值在 .then() 中 → 确保即使路由器自身未设 routerId，
     管线层面也能正确追溯决策来源。
  ③ 日志包含 checkpoint → 便于在多 checkpoint 并发场景中关联日志。
## 方法（私有）：logFinalDecision(checkpoint, d)    (L243-L248)


### 作用

  记录管线最终决策的结构化日志。S1 用 info 级别，非 S1 用 warn 级别。

### 参数

  checkpoint: Checkpoint — 当前检查点名称。
  d: RouterDecision — 最终合并后的路由决策。

### 返回值

  void

### 逐行逻辑


**L244**:
```typescript
const targetStr = d.target ? ` → ${d.target.provider}/${d.target.model}` : "";
```
> 构造 target 字符串。有 target 时格式为 " → provider/model"，无则空。


**L245**:
```typescript
const reasonStr = d.reason ? ` (${d.reason})` : "";
```
> 构造 reason 字符串。有理由时用括号包裹，无则空。


**L246**:
```typescript
const log = d.level === "S1" ? this.logger.info : this.logger.warn;
```
> 根据敏感等级选择日志级别：S1（安全）用 info，S2/S3 用 warn。
> 这使运维人员可以通过日志级别快速过滤出需要关注的敏感决策。


**L247**:
```typescript
log.call(this.logger, `[GuardClaw] [${checkpoint}] ▶ Final: ${d.level} ...`);
```
> 使用 .call(this.logger, ...) 确保 this 绑定正确。
> 因为 log 变量是从 this.logger 上提取的方法引用，
> 直接调用 log(...) 会丢失 this 上下文。
> ▶ 符号作为视觉标记，在日志流中快速定位最终决策行。


### 设计意图

  统一最终决策的日志格式，便于 grep/搜索。
  S1 用 info（正常流量，大量出现）；S2/S3 用 warn（需关注，少量出现）。
## 方法：runSingle(id, context, pluginConfig)       (L253-L263)


### 作用

  运行单个路由器（用于 Dashboard 或测试场景下的逐路由器调试）。
  强制以 dryRun 模式执行，不影响实际会话状态。

### 参数

  id: string — 目标路由器的标识符。
  context: DetectionContext — 检测上下文。
  pluginConfig: Record<string, unknown> — 完整插件配置。

### 返回值

  Promise<RouterDecision | null> — 路由决策；若路由器未注册则返回 null。

### 逐行逻辑


**L258**:
```typescript
const router = this.routers.get(id);
```
> 从注册表中查找路由器实例。


**L259**:
```typescript
if (!router) return null;
```
> 未注册则直接返回 null，不抛异常。
> 调用方（Dashboard API）据此显示"路由器不存在"。


**L260**:
```typescript
const decision = await router.detect({ ...context, dryRun: true }, pluginConfig);
```
> 调用 detect()，但展开 context 并强制设置 dryRun: true。
> dryRun 的语义（见 types.ts L143）：路由器应跳过 `enabled` 检查，
> 即即使该路由器配置为 enabled: false，也能返回检测结果。
> 这对 Dashboard 上的"测试此路由器"功能至关重要。


**L261**:
```typescript
decision.routerId = id;
```
> 与 runGroup 一样，确保决策包含路由器 id。


**L262**:
```typescript
return decision;
```


### 设计意图

  为 Dashboard / 测试提供隔离的单路由器执行入口。
  dryRun 模式确保：
  ① 被禁用的路由器也能被测试。
  ② 不会触发会话状态变更（markSessionAsPrivate 等）。
## 方法：listRouters()                              (L268-L270)


### 作用

  返回所有已注册路由器的 id 列表。

### 参数

  无。

### 返回值

  string[] — 路由器 id 数组，顺序为注册顺序。

### 逐行逻辑


**L269**:
```typescript
return [...this.routers.keys()];
```
> 使用展开运算符将 Map.keys() 迭代器转为数组。
> 顺序保证：Map 按插入顺序迭代。


### 设计意图

  为 Dashboard / 管理 API 提供已注册路由器的枚举能力。
## 方法：hasRouter(id)                              (L275-L277)


### 作用

  检查指定 id 的路由器是否已注册。

### 参数

  id: string — 路由器标识符。

### 返回值

  boolean — 是否已注册。

### 逐行逻辑


**L276**:
```typescript
return this.routers.has(id);
```
> 直接委托给 Map.has()。O(1) 查找。


### 设计意图

  简单的查询 API，供 hooks.ts 等编排层在注册新路由器前检查去重。
## 类型：WeightedDecision                           (L280)


{ decision: RouterDecision; weight: number }

将路由决策与其来源路由器的权重打包在一起。
仅在 router-pipeline.ts 内部使用，不导出。
作为 runGroup() 和 mergeDecisionsWeighted() 之间的数据传输结构。
## 常量：ACTION_PRIORITY                            (L282-L287)


Record<string, number>，定义 RouterAction 的严重程度排序：
  block: 4      — 最严格，完全阻断
  redirect: 3   — 次严格，重定向到其他模型
  transform: 2  — 变换内容后转发
  passthrough: 1 — 最宽松，不干预

用于 mergeDecisionsWeighted() 中当权重相同时的 tie-breaking。
数值越高表示越严格 → 安全优先（safety-first）原则。
## 函数：mergeDecisionsWeighted(items)              (L300-L379)


### 作用

  合并多个路由器的加权决策为单一最终决策。
  策略：最高安全等级优先 → 同等级下高权重优先 → 同权重下严格 action 优先
  → 加权平均 confidence。

### 参数

  items: WeightedDecision[] — 所有路由器的决策及权重。

### 返回值

  RouterDecision — 合并后的最终决策。

### 逐行逻辑


**L301-L303**:
```typescript
if (items.length === 0) { return S1 passthrough; }
```
> 空数组保护：没有任何决策时返回最低限制。
> reason: "No decisions" 区别于其他 S1 场景。


**L305-L307**:
```typescript
if (items.length === 1) { return items[0].decision; }
```
> 单一决策快速路径：直接返回，无需合并计算。
> 避免不必要的排序和加权平均开销。


**L309-L310**:
```typescript
const levels = items.map(...); const winningLevel = maxLevel(...levels);
```
> 提取所有决策的 level，调用 maxLevel() 求最高等级。
> maxLevel 来自 types.ts，内部将 S1/S2/S3 映射为 1/2/3 取 max。
> 这体现了 "safety-first" 原则：只要有一个路由器说 S3，最终就是 S3。


**L312**:
```typescript
const atWinningLevel = items.filter((i) => i.decision.level === winningLevel);
```
> 过滤出所有与最高等级一致的决策。
> 只有这些决策参与后续的 action/target 选择。
> 低等级决策的 action/target 被忽略（它们的 reason 仍会被收集）。


**L314-L320**:
```typescript
atWinningLevel.sort((a, b) => { ... });
```
> 双重排序：
> L315: 主排序：权重降序 (b.weight - a.weight)。高权重路由器优先。
> L316-L319: 次排序：ACTION_PRIORITY 降序。
> 当权重相同时，更严格的 action 优先（block > redirect > transform > passthrough）。
> ?? 0 防御未知 action 类型。


**L322**:
```typescript
let winner = atWinningLevel[0].decision;
```
> 排序后第一个元素即为"赢家"——权重最高且 action 最严格的决策。
> 使用 let 而非 const：后续两个特殊逻辑可能会替换 winner。


**L328-L335**:
```typescript
S1 passthrough + redirect 候选逻辑
```
> 当最高等级为 S1 且赢家的 action 是 passthrough 时：
> 检查是否有其他同为 S1 但 action 为 redirect 的决策（含 target）。
> 典型场景：privacy 路由器 S1 passthrough（"无安全问题"），
> 但 token-saver 路由器 S1 redirect（"选择更便宜的模型"）。
> passthrough 在 S1 语义上是"无意见"而非"我坚持用默认"，
> 所以应尊重 redirect 请求。
> 这是对权重排序的一个语义修正：passthrough 虽然赢了权重，
> 但它"主动让位"给有实质性路由建议的 redirect。


**L340-L358**:
```typescript
S2-proxy + token-saver 模型选择逻辑
```
> 当最高等级为 S2 且赢家 target 是 guardclaw-privacy（proxy 路径）
> 且 target.model 为空时：
> L345-L350: 查找是否有 S1 级别的 redirect 决策带有 model（典型来自 token-saver）。
> L351-L357: 如果找到，将 token-saver 选择的 model 注入到 proxy target 中。
> 这实现了"隐私保护 + 成本优化"的组合：
> - privacy 路由器负责检测敏感度 → S2-proxy
> - token-saver 负责选择最优模型 → redirect to cheaper model
> - 合并后：经 proxy 脱敏转发到 token-saver 选择的廉价模型。
> L355: reason 合并两个路由器的 reason，用 ";" 连接。
> .filter(Boolean) 过滤掉 undefined/空字符串。


**L360-L362**:
```typescript
const allReasons = items.filter(...).map(...);
```
> 收集所有非 S1 决策的 reason，格式化为 "[routerId:wWeight] reason"。
> S1 决策的 reason 被排除——它们通常是"无敏感内容"，信息价值低。
> 包含 routerId 和 weight 便于追溯每条 reason 的来源和权重。


**L364-L368**:
```typescript
加权平均 confidence 计算
```
> L364: totalWeight = 所有路由器权重之和。
> L366: 对每个决策的 confidence 乘以其 weight 求和，除以 totalWeight。
> decision.confidence ?? 0.5：未设置 confidence 的决策默认 0.5。
> totalWeight > 0 的保护防止除以零（虽然在 items 非空时不可能为 0）。


**L370-L378**:
```typescript
return { level, action, target, ... };
```
> 构造并返回最终决策对象：
> level: 最高安全等级。
> action: 赢家的 action（经过 S1-redirect 修正和 S2-proxy 合并）。
> target: 赢家的 target（可能包含 token-saver 注入的 model）。
> transformedContent: 赢家的变换内容（如果 action 为 transform）。
> reason: 优先使用 allReasons（多路由器原因汇总）；
> 如果没有非 S1 原因，回退到 winner.reason。
> confidence: 加权平均置信度。
> routerId: 赢家的路由器 id。


### 设计意图

  合并算法体现了三个核心原则：
  ① Safety-first：最高限制等级无条件胜出。
  ② Weight-based tie-breaking：同等级下权重决定优先级。
  ③ 语义修正：S1-passthrough "让位" 给 S1-redirect；
     S2-proxy 吸收 S1-redirect 的 model 选择。
  这使得安全路由器和优化路由器能协同工作：
  安全决策不被优化降级，优化建议在安全允许时生效。
全局单例管理：globalPipeline / setGlobalPipeline /
              getGlobalPipeline                  (L382-L390)

### 作用

  提供模块级单例模式：一个全局 RouterPipeline 实例，
  在插件初始化时设置（setGlobalPipeline），
  在 hooks.ts 等处获取（getGlobalPipeline）。
## 函数：setGlobalPipeline(pipeline)                (L384-L386)


### 作用

  设置全局 RouterPipeline 单例。

### 参数

  pipeline: RouterPipeline — 要设为全局的管线实例。

### 返回值

  void

### 逐行逻辑


**L385**:
```typescript
globalPipeline = pipeline;
```
> 直接赋值模块级变量。无保护——允许重复调用覆盖。
> 这在热重载场景下是期望行为（config 变更后重新初始化管线）。


### 设计意图

  采用模块级单例而非 class static，因为 RouterPipeline 需要在
  插件生命周期中由外部创建（带 logger 注入），而非自行实例化。
## 函数：getGlobalPipeline()                        (L388-L390)


### 作用

  获取全局 RouterPipeline 单例。

### 参数

  无。

### 返回值

  RouterPipeline | null — 若尚未初始化则返回 null。

### 逐行逻辑


**L389**:
```typescript
return globalPipeline;
```
> 直接返回模块级变量。调用方（hooks.ts L184-L186）需判空：
> if (!pipeline) { logger.warn("not initialized"); return; }


### 设计意图

  返回 null 而非抛异常——插件加载顺序可能导致 hooks 注册先于
  pipeline 初始化，此时返回 null 使 hook 优雅跳过而非崩溃。
## Code Review

## Part A — Code 层面改动建议


#### 🟡 runGroup 中 routerId 赋值的副作用


 现状（L217-L219）：
   router.detect(context, pluginConfig).then((d) => {
     d.routerId = id;
     return d;
   })
   直接修改了路由器返回的 decision 对象。

 问题：
   如果路由器内部缓存或复用了 decision 对象（如 token-saver 的
   buildDecision 每次创建新对象所以当前安全），未来新增的路由器
   如果返回缓存的决策对象，routerId 会被意外覆盖。

 建议：
   改为创建新对象：
     .then((d) => ({ ...d, routerId: id }))
   消除副作用，对现有代码无 breaking change。


#### 🟢 logFinalDecision 中 log.call 的必要性


 现状（L246-L247）：
   const log = d.level === "S1" ? this.logger.info : this.logger.warn;
   log.call(this.logger, ...);

 问题：
   提取方法引用后需要 .call() 绑定 this——这在 console 对象上
   是必要的（Chrome 中 console.log 丢失 this 会报错），但对于
   注入的 logger 对象（如 OpenClaw 的 api.logger），通常方法
   已经是 bound function 或箭头函数。

 建议（低优先级）：
   保留 .call() 是安全的做法（防御性编程）。
   或改用条件调用：
     if (d.level === "S1") this.logger.info(msg);
     else this.logger.warn(msg);
   更清晰直观。


#### 🟢 ACTION_PRIORITY 类型安全


 现状（L282-L287）：
   const ACTION_PRIORITY: Record<string, number> = { block: 4, ... };

 问题：
   key 类型为 string，但实际上只接受 RouterAction 的四个值。
   这意味着 ACTION_PRIORITY["typo"] 不会有编译错误。

 建议：
   改为 Record<RouterAction, number>：
     const ACTION_PRIORITY: Record<RouterAction, number> = { ... };
   增强类型检查，确保所有 RouterAction 都有对应值。


#### 🟢 run() 中 Phase 1 日志与 runGroup 内部日志重复


 现状（L173-L177 和 L233）：
   run() 中 for 循环逐条打印 fastResults 的日志，
   但 runGroup() 内部（L233）已经对每个成功决策打印了一条日志。

 问题：
   每个决策被打印两次（runGroup 内一次 + run 外一次），
   格式略有不同，增加日志噪音。

 建议：
   统一日志位置。要么只在 runGroup 中打印（推荐——靠近数据源），
   要么只在 run() 中打印（需要从 runGroup 中删除日志）。
   选择后删除另一处，减少日志体积约 50%。


#### 🟡 mergeDecisionsWeighted 中 S1-redirect 覆盖逻辑未考虑 weight


 现状（L328-L335）：
   当 winningLevel === "S1" 且 winner 是 passthrough 时，
   .find() 取第一个 action === "redirect" 的候选。
   但 atWinningLevel 已排序（weight 降序），所以第一个 redirect
   候选可能不是权重最高的 redirect。

 问题：
   实际上因为 atWinningLevel 已按 weight 降序 + action 降序排列，
   passthrough 赢家说明所有 redirect 的 weight 都低于或等于它。
   .find() 从头开始搜索——找到的第一个 redirect 已是 weight 最高的。
   所以当前逻辑是正确的，但缺乏注释说明这个隐含前提。

 建议：
   添加注释说明"atWinningLevel 已按 weight 降序排列，
   所以 .find() 返回的是权重最高的 redirect 候选"。
## Part B — 逻辑/设计层面改动建议


#### 🔴 run() 中 fast/slow 分组阈值 50 与 defaultPrivacyConfig 不一致


 现状（L163）：
   (weight >= 50 ? fast : slow).push(...)
   阈值 50 硬编码在 run() 方法中。

 现状（config-schema.ts L219-L221）：
   defaultPrivacyConfig.routers = { privacy: { enabled: true, type: "builtin" } }
   privacy 路由器注册时未设置 weight → getRouterWeight() 返回默认 50。

 现状（token-saver.ts）：
   token-saver 也未在 defaultPrivacyConfig 中配置 weight。
   如果用户注册 token-saver 但不配置 weight，它也默认 50 → 归入 fast 组。

 问题：
   token-saver 是"慢路由器"（需要 LLM 调用），设计上应归入 slow 组
   以便被 Phase 1 短路跳过。但默认 weight 50 使其归入 fast 组，
   导致短路优化失效——每次 run() 都会执行 token-saver 的 LLM 调用。
   run() 的注释（L129-L131）说 "slow routers (weight < 50)"，
   但 defaultPrivacyConfig 没有为 token-saver 设置 weight < 50。

 建议：
   在 defaultPrivacyConfig.routers 中为 token-saver 设置默认 weight:
     "token-saver": { enabled: false, type: "builtin", weight: 30 }
   或在 token-saver 注册逻辑中硬编码低权重。
   确保 Phase 1/2 的分组语义与注释一致。


#### 🟡 privacy.ts 合并 defaultPrivacyConfig 但 configurable.ts 不合并


 现状（privacy.ts L78-L96）：
   getPrivacyConfig() 显式展开合并 defaultPrivacyConfig 的各层嵌套字段。

 现状（configurable.ts L47-L49）：
   getPrivacyConfig() 直接返回 pluginConfig.privacy as PrivacyConfig，
   不合并默认值。

 问题：
   如果用户配置中缺少某些 PrivacyConfig 字段（如 s2Policy / localModel），
   configurable.ts 的 resolveTargetForLevel() 在 L146 处取
   pCfg.s2Policy ?? "proxy"，虽然有 ?? 兜底，但 localModel 的嵌套字段
   （provider / model / endpoint）不会得到 defaultPrivacyConfig 的默认值，
   可能导致 target 中 provider 为 undefined。

 建议：
   在 configurable.ts 中也使用与 privacy.ts 相同的深度合并逻辑，
   或提取公共 getPrivacyConfigMerged() 函数供所有路由器共享。


#### 🟡 mergeDecisionsWeighted 的 S2-proxy + model 合并仅查找 S1 级别


 现状（L345-L350）：
   const modelHint = items.find(
     (i) => i.decision.level === "S1" && ... && i.decision.target?.model
   );
   仅在 items 中查找 level === "S1" 的 redirect 决策。

 问题：
   如果 token-saver 在某些场景下返回 S2 级别的 redirect（虽然目前
   token-saver 总是返回 S1），则 model 提示不会被采纳。
   此外，如果有多个路由器提供 model hint，只取第一个
   （.find() 不保证是权重最高的）。

 建议：
   当前设计在 token-saver 始终返回 S1 的前提下是正确的。
   建议添加注释说明此假设，或放宽为
   i.decision.level !== winningLevel（取非胜出级别的 model hint）。


#### 🟡 runGroup 中缺少路由器执行超时


 现状（L223）：
   const settled = await Promise.allSettled(tasks.map(t => t.promise));
   无超时控制。

 问题：
   如果某个路由器的 detect() 中 LLM 调用挂起（如 Ollama 进程卡死），
   Promise.allSettled 会无限等待，阻塞整个管线。
   兄弟文件 token-saver.ts 的 detect() 内部也没有超时机制。
   hooks.ts 调用 pipeline.run() 时也无外层超时。

 建议：
   为每个路由器的 promise 包装 timeout：
     const withTimeout = (p, ms) => Promise.race([
       p, new Promise((_, reject) => setTimeout(() => reject("timeout"), ms))
     ]);
   默认超时可设为 15-30 秒，并在 RouterRegistration 中添加
   可选的 timeoutMs 字段供每个路由器自定义。


#### 🟢 globalPipeline 单例缺少清理接口


 现状（L382-L390）：
   setGlobalPipeline() 设置单例，getGlobalPipeline() 获取单例。
   没有 clearGlobalPipeline() 或 resetGlobalPipeline() 函数。

 问题：
   在单元测试中，测试间需要清理全局状态以避免相互干扰。
   目前只能调用 setGlobalPipeline(new RouterPipeline()) 来"重置"，
   但无法将其设为 null（类型不允许传 null）。

 建议：
   添加 clearGlobalPipeline()：
     export function clearGlobalPipeline(): void { globalPipeline = null; }
   供测试 teardown 使用。
## 优先级总览


| ID | 级别 | 标题 |
| --- | --- | --- |
| 6 | 🔴 | fast/slow 分组阈值与 token-saver 默认 |
| weight 不一致，短路优化可能失效 |  |  |
| 1 | 🟡 | runGroup 中 routerId 赋值的副作用 |
| 5 | 🟡 | S1-redirect 覆盖逻辑隐含前提缺注释 |
| 7 | 🟡 | configurable.ts 未合并 defaultPrivacyConfig |
| 8 | 🟡 | S2-proxy model 合并仅查找 S1 级别 |
| 9 | 🟡 | runGroup 缺少路由器执行超时 |
| 2 | 🟢 | logFinalDecision 中 log.call 的清晰度 |
| 3 | 🟢 | ACTION_PRIORITY key 类型安全 |
| 4 | 🟢 | Phase 1 日志与 runGroup 日志重复 |
| 10 | 🟢 | 全局单例缺少清理接口 |
