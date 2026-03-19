# sync-detect.ts — 逐方法文档


 文件定位：异步 LLM 检测的同步包装层（主线程端）
 所属模块：GuardClaw 隐私路由系统

 核心职责：利用 synckit 库（Worker Thread + Atomics.wait）将
 异步的 detectByLocalModel 函数包装为同步调用，使
 tool_result_persist 等同步 hook 能在返回前获取 LLM 级别的
 敏感度检测结果。超时或异常时优雅降级返回 S1（安全放行）。

 调用链：
   hooks.ts (tool_result_persist 钩子，L720-L724)
```
```
     └→ sync-detect.ts :: syncDetectByLocalModel()  ← 主线程同步调用
          └→ getSyncDetect() — 延迟初始化 synckit 代理函数
               └→ synckit Worker Thread (Atomics.wait 阻塞)
                    └→ llm-detect-worker.ts :: runAsWorker(…)
                         └→ local-model.ts :: detectByLocalModel()
                              └→ callChatCompletion() → 本地 LLM API
```


 配对文件：llm-detect-worker.ts（Worker 线程端）

 敏感等级体系：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理(proxy)或本地模型(local)
   S3 — 高度敏感，强制本地模型处理
## 导入说明                                        (L12-L14)


**L12**:
```typescript
import { createSyncFn } from "synckit";
```
> 从 synckit 库导入 createSyncFn 工厂函数。
> createSyncFn 接受一个 Worker 脚本路径和选项对象，返回
> 一个"看起来同步"的函数。调用该函数时，synckit 在后台
> 启动 Worker 线程执行异步操作，主线程通过
> SharedArrayBuffer + Atomics.wait 阻塞等待结果返回。
> 这是整个"同步 LLM 检测"机制的基石库。


**L13**:
```typescript
import { fileURLToPath } from "node:url";
```
> Node.js 内置模块，将 file:// URL 转为文件系统绝对路径。
> ESM 模块中 __dirname 不可用，需要通过 import.meta.url
> + fileURLToPath 计算当前文件所在目录，进而定位同目录下
> 的 Worker 脚本。


**L14**:
```typescript
import type { DetectionContext, DetectionResult, PrivacyConfig } from "./types.js";
```
> 纯类型导入（编译后不生成 JS 代码）。
> - DetectionContext: 检测上下文，含 checkpoint / message /
> toolName / toolParams / toolResult / sessionKey / dryRun 等
> - DetectionResult: 检测结果，含 level(S1/S2/S3) /
> levelNumeric(1/2/3) / reason / detectorType / confidence
> - PrivacyConfig: 隐私配置顶层对象，含 enabled / localModel /
> rules / checkpoints / guardAgent / session 等

## 常量：FALLBACK_S1                               (L16-L22)


### 作用

  当同步 LLM 检测因超时或异常失败时，作为安全降级返回值。
  遵循 GuardClaw 的"fail-open"策略 — 检测失败不阻塞请求，
  而是放行（S1），避免因 LLM 服务不可用而中断用户操作。

### 字段说明

  level: "S1"
      降级为最低敏感等级，表示"安全放行"
  levelNumeric: 1
      S1 的数值形式，与 level 保持一致
  reason: "LLM sync detection unavailable"
      标记此结果来自降级路径而非真实检测，便于日志排查
  detectorType: "localModelDetector"
      保持检测器类型标识为 localModelDetector，因为这是
      LLM 检测路径的降级结果（而非 ruleDetector 的结果）
  confidence: 0
      置信度为 0，表示此结果无实际检测支撑。hooks.ts L726
      会比较 llmResult.levelNumeric > ruleCheck.levelNumeric，
      S1 + confidence:0 不会覆盖规则检测的结果

### 逐行逻辑


**L16-L22**:
```typescript
const FALLBACK_S1: DetectionResult = { ... }
```
> 定义模块级常量，类型标注为 DetectionResult 确保
> 字段完整性（level / levelNumeric / reason /
> detectorType / confidence 全部具备）。
> 作为 const 常量在模块加载时初始化一次，多次
> 降级调用复用同一对象，避免重复分配。


### 设计意图

  将降级值提取为模块级常量有两个目的：
  1. 语义清晰 — 读代码时一眼看出降级行为
  2. 复用安全 — DetectionResult 是只读使用，无需每次 new
## 常量：workerPath                                   (L24)


### 作用

  计算 Worker 脚本 (llm-detect-worker.ts) 的文件系统绝对路径，
  供 createSyncFn 定位 Worker 入口。

### 逐行逻辑


**L24**:
```typescript
const workerPath = fileURLToPath(new URL("./llm-detect-worker.ts", import.meta.url));
```
> 分解为三步：
> 1. import.meta.url — 获取当前模块的 file:// URL
> 例如 "file:///path/to/guardclaw/src/sync-detect.ts"
> 2. new URL("./llm-detect-worker.ts", import.meta.url)
> 以当前模块 URL 为基准，解析相对路径 Worker 脚本，
> 得到 "file:///path/to/guardclaw/src/llm-detect-worker.ts"
> 3. fileURLToPath(...) — 将 file:// URL 转为操作系统路径
> 例如 "/path/to/guardclaw/src/llm-detect-worker.ts"
> 为何不用 __dirname + path.join？因为 ESM 模块中
> __dirname 不存在，必须通过 import.meta.url 计算。
> 这是 ESM 中定位同目录文件的标准模式。


### 设计意图

  Worker 路径在模块加载时一次性计算并缓存为常量。
  synckit 需要 Worker 脚本的绝对路径来启动 Worker Thread，
  此处用 import.meta.url 保证路径计算与部署位置无关。
## 模块变量：_syncDetect                              (L26)


### 作用

  缓存由 createSyncFn 创建的同步代理函数实例，实现延迟初始化
  (lazy init) + 单例模式。避免每次调用 syncDetectByLocalModel
  都重新创建 Worker，因为 Worker 线程的创建开销较大。

### 逐行逻辑


**L26**:
```typescript
let _syncDetect: ((context: DetectionContext, config: PrivacyConfig) => DetectionResult) | null = null;
```
> 类型声明为"函数签名 | null"。
> 函数签名 (context, config) => DetectionResult 反映了
> synckit 代理函数的外观 — 虽然底层是异步 Worker 执行，
> 但暴露给调用方的是同步返回 DetectionResult 的函数。
> 初始值 null 表示尚未创建，交给 getSyncDetect() 延迟初始化。


### 设计意图

  模块级私有变量 + 延迟初始化的经典模式。好处：
  1. 如果 syncDetectByLocalModel 从未被调用，Worker 永远不会启动
  2. 首次调用后缓存实例，后续调用零开销复用
  3. 类型声明为 | null 提供编译期安全检查
## 函数：getSyncDetect()                           (L28-L36)


### 作用

  延迟初始化并返回 synckit 同步代理函数。首次调用时创建
  Worker 代理，后续调用直接返回缓存实例（单例模式）。

### 参数

  无参数。

### 返回值

  (context: DetectionContext, config: PrivacyConfig) => DetectionResult
  — 一个看起来同步的函数，内部通过 Worker Thread +
  Atomics.wait 阻塞执行异步 LLM 检测。调用时主线程会被
  阻塞直到 Worker 返回结果或超时（20 秒）。

### 逐行逻辑


**L29**:
```typescript
if (!_syncDetect) {
```
> 检查缓存变量是否已初始化。首次调用时 _syncDetect 为
> null，进入创建分支；后续调用直接跳过。


**L30-L33**:
```typescript
_syncDetect = createSyncFn<...>(workerPath, { timeout: 20_000, tsRunner: "node" });
```
> 调用 synckit 的 createSyncFn 工厂函数，参数说明：
> 参数 1: workerPath
> Worker 脚本的绝对路径（llm-detect-worker.ts）。
> synckit 会用 new Worker(workerPath) 启动线程。
> 参数 2: { timeout: 20_000, tsRunner: "node" }
> - timeout: 20_000 (20 秒)
> 主线程 Atomics.wait 的最大等待时间。若 Worker
> 在 20 秒内未返回结果，synckit 抛出超时异常。
> 20 秒设定考虑：本地模型推理（endpoint 通常在
> localhost）一般 2-10 秒完成，20 秒留出足够余量
> 应对冷启动或高负载场景。
> - tsRunner: "node"
> 告诉 synckit 直接用 Node.js 执行 Worker（而非
> 通过 ts-node / tsx 等 TS runner）。前提是运行
> 环境已配置好 .ts 文件的加载支持（如 --loader tsx）。
> 泛型参数 <(context: DetectionContext, config: PrivacyConfig) => DetectionResult>
> 为返回的代理函数提供类型签名，使调用方获得完整的
> TypeScript 类型推断。


**L35**:
```typescript
return _syncDetect;
```
> 返回缓存的（或刚创建的）同步代理函数。


### 设计意图

  延迟初始化 + 单例的目的：
  1. 避免模块加载时就启动 Worker（createSyncFn 开销不小）
  2. 如果从未触发 tool_result_persist hook 中的 LLM 检测条件
     （如 localModel.enabled=false 或 ruleCheck.level 已是 S3），
     则 Worker 永远不会被创建，节省资源
  3. 首次调用后缓存实例，后续调用 O(1) 开销

  独立函数而非内联在 syncDetectByLocalModel 中的原因：
  职责分离 — getSyncDetect 只管初始化，syncDetectByLocalModel
  只管调用和异常处理。
## 函数：syncDetectByLocalModel(context, config)   (L38-L48)


### 作用

  本文件唯一的导出函数，是 hooks.ts 的调用入口。将异步 LLM
  敏感度检测包装为同步调用：通过 synckit Worker Thread 阻塞
  主线程等待 LLM 推理结果，超时或异常时优雅降级返回 S1。

  调用方 hooks.ts L720-L724 的使用场景：
    tool_result_persist 钩子中，规则检测已运行且结果非 S3，
    需要 LLM 语义检测来捕获规则遗漏的敏感内容。由于钩子
    要求同步返回，无法直接 await detectByLocalModel，因此
    通过本函数的 synckit 机制实现同步阻塞。

### 参数

  context: DetectionContext — 检测上下文对象。
      hooks.ts 传入的典型值：
      {
        checkpoint: "onToolCallExecuted",
        toolName: ctx.toolName,      // 工具名称
        toolResult: textContent,     // 工具返回的文本内容
        sessionKey: sessionKey,      // 会话标识
      }
      注意：此处不传 message 字段，因为检测对象是工具返回值
      而非用户消息。

  config: PrivacyConfig — 已合并默认值的隐私配置对象。
      hooks.ts 在调用前已通过 mergeWithDefaults 合并，
      保证 localModel.enabled / endpoint / model 等字段有值。

### 返回值

  DetectionResult — 敏感度检测结果。
  - 正常路径: Worker 线程内 detectByLocalModel 的真实结果
    (level 可能是 S1/S2/S3，confidence 通常 0.6-0.8)
  - 降级路径: FALLBACK_S1 常量
    (level="S1", confidence=0, reason="LLM sync detection unavailable")

  hooks.ts L726 对结果的消费方式：
    if (llmResult.level !== "S1" && llmResult.levelNumeric > ruleCheck.levelNumeric)
    即仅当 LLM 检测到比规则更高的敏感级别时才采纳。FALLBACK_S1
    (S1, confidence=0) 永远不会覆盖规则检测结果。

### 逐行逻辑


**L42**:
```typescript
try {
```
> 外层 try-catch 包裹整个同步调用，捕获 synckit 可能
> 抛出的所有异常：超时异常、Worker 初始化失败、序列化
> 错误、Worker 内部未捕获异常等。


**L43**:
```typescript
return getSyncDetect()(context, config);
```
> 分解为两步：
> 1. getSyncDetect() — 获取（或延迟创建）synckit 同步代理函数
> 2. ()(context, config) — 立即调用该代理函数
> 调用代理函数时的执行流程：
> a. synckit 将 context 和 config 序列化为 JSON
> b. 通过 SharedArrayBuffer 传递给 Worker 线程
> c. Worker 线程 (llm-detect-worker.ts) 收到参数，
> 调用 detectByLocalModel(context, config)
> d. detectByLocalModel 构建 prompt → 调用本地 LLM API
> → 解析响应 → 返回 DetectionResult
> e. Worker 将结果写入 SharedArrayBuffer
> f. Atomics.notify 唤醒主线程
> g. 主线程从 SharedArrayBuffer 反序列化结果并返回
> 整个过程对调用方透明 — 就像调用了一个普通同步函数。
> 主线程在 Atomics.wait 期间完全阻塞，不处理事件循环。


**L44**:
```typescript
} catch (err) {
```
> 捕获所有异常。常见场景：
> - synckit 超时 (20 秒内 Worker 未返回)
> - Worker 启动失败 (tsRunner 配置不匹配、文件不存在)
> - Worker 内部异常 (detectByLocalModel 的异常未被其
> 内部 catch 捕获的极端情况)
> - 参数序列化/反序列化失败


**L45**:
```typescript
console.warn("[GuardClaw] syncDetect fallback to S1:", (err as Error)?.message?.slice(0, 120));
```
> 使用 console.warn（非 error）记录降级信息。
> 选择 warn 而非 error 的原因：超时降级是预期行为（fail-open），
> 不属于系统错误，只需提醒运维关注。
> (err as Error)?.message?.slice(0, 120)
> 防御性链式操作：
> - as Error: err 可能不是 Error 实例（如字符串异常）
> - ?.: 安全导航，err 为 null/undefined 时不报错
> - .slice(0, 120): 截断错误信息防止日志过长
> （synckit 超时异常的 message 通常较短，但 LLM
> 错误可能包含完整响应体）


**L46**:
```typescript
return FALLBACK_S1;
```
> 返回预定义的安全降级值。
> FALLBACK_S1 = { level: "S1", levelNumeric: 1,
> reason: "LLM sync detection unavailable",
> detectorType: "localModelDetector", confidence: 0 }
> 降级为 S1 遵循 GuardClaw 的 fail-open 策略：
> LLM 检测是规则检测的补充层，失败时不应阻断请求。
> hooks.ts 的规则检测结果仍然有效，LLM 降级只意味着
> 失去了语义级别的额外保护。


### 设计意图

  本函数是"同步 LLM 检测"架构中面向调用方的唯一接口。
  设计上刻意保持极简：获取代理 → 调用 → 异常降级。

  为什么需要同步包装而不直接在 hooks.ts 中 await？
  OpenClaw/Cursor 的 tool_result_persist hook 是同步回调，
  不支持 async/await。但 LLM 推理必然是异步操作（HTTP 请求
  到本地模型服务）。synckit 通过 Worker Thread + Atomics.wait
  桥接了同步/异步鸿沟：
    - 主线程: Atomics.wait 阻塞 → 看起来是同步
    - Worker 线程: async/await 正常执行 → 实际是异步

  20 秒超时的权衡：
  - 太短: 本地模型冷启动或排队时可能超时，导致频繁降级
  - 太长: 主线程阻塞过久影响用户体验
  - 20 秒: 本地模型推理通常 2-10 秒，冷启动可能 10-15 秒，
    20 秒覆盖绝大多数场景
## 文件整体架构总结


 本文件仅 48 行，但承担了 GuardClaw 同步 LLM 检测机制的
 主线程端全部逻辑。结构极为精简：

| 组件 | 描述 |
| --- | --- |
| `FALLBACK_S1` (常量) | 降级返回值，fail-open 策略的安全网 |
| `workerPath` (常量) | ESM 环境下定位 Worker 脚本的标准方式 |
| `_syncDetect` (模块私有变量) | synckit 代理函数的缓存槽位 |
| `getSyncDetect()` (内部函数) | 延迟初始化 + 单例，管理 synckit 代理函数生命周期 |
| `syncDetectByLocalModel()` (导出函数) | 唯一公开接口，调用 + 异常处理 + 降级 |
 与配对文件 llm-detect-worker.ts 的分工：
   本文件 = 主线程端（创建代理 + 调用 + 异常降级）
   Worker = Worker 线程端（接收参数 + 执行异步检测 + 返回结果）
---

## Code Review — 代码审查


### Part A — Code 层面改动建议


#### 🟡 FALLBACK_S1 对象可被外部修改


 现状（L16-L22）：const FALLBACK_S1: DetectionResult = { ... }
 问题：const 只保证变量绑定不可变，对象本身的属性仍可被
      外部代码修改（如 hooks.ts 拿到返回值后误写
      result.level = "S3"）。虽然当前调用方未修改，但这是
      一个潜在的防御性缺陷 — 一旦被修改，后续所有降级返回
      都会受影响。
 建议：使用 Object.freeze 或 as const 满足不可变约束：

      const FALLBACK_S1: DetectionResult = Object.freeze({
        level: "S1",
        levelNumeric: 1,
        reason: "LLM sync detection unavailable",
        detectorType: "localModelDetector",
        confidence: 0,
      });

      或者在 catch 中返回展开副本 return { ...FALLBACK_S1 }
      来避免共享引用问题。


#### 🟢 getSyncDetect 可使用 nullish 合并简化


 现状（L28-L36）：if (!_syncDetect) { _syncDetect = createSyncFn(...); } return _syncDetect;
 问题：经典的延迟初始化模式，完全正确，但可以更简洁。
 建议：
      function getSyncDetect() {
        return (_syncDetect ??= createSyncFn<...>(workerPath, { timeout: 20_000, tsRunner: "node" }));
      }
      使用 ??= 逻辑空值赋值运算符，一行完成初始化 + 返回。
      纯风格偏好，影响极小。


### Part B — 逻辑/设计层面改动建议


#### 🔴 FALLBACK_S1 共享引用 — 调用方可能污染降级值


 现状（L46）：return FALLBACK_S1;
 问题：每次降级都返回同一个对象引用。hooks.ts L726-L735
      对结果做了条件判断但未修改字段，目前安全。然而如果
      未来有调用方对返回值做 mutation（如添加自定义字段），
      会影响所有后续降级返回。
      对比 detector.ts 的做法：每次都返回一个新的字面量对象
      (L39-L45, L137-L144)，不存在共享引用问题。
 建议：在 catch 中返回新对象副本：

      return {
        level: "S1",
        levelNumeric: 1,
        reason: "LLM sync detection unavailable",
        detectorType: "localModelDetector",
        confidence: 0,
      };

      或保留常量但使用 Object.freeze（见建议 1）。


#### 🟡 Worker 创建失败时无法重试


 现状（L29-L34）：getSyncDetect 创建 Worker 代理后永久缓存。
 问题：如果 createSyncFn 在首次调用时因临时原因失败（如
      Worker 文件暂时不可读），异常会冒泡到 syncDetectByLocalModel
      的 catch，返回 FALLBACK_S1。但 _syncDetect 仍为 null，
      下次调用会再次尝试 createSyncFn — 这其实是好行为。
      然而，如果 createSyncFn 成功创建但底层 Worker 线程
      已经 dead（如 OOM），缓存的代理函数会持续失败，每次
      都要等 20 秒超时。
 建议：考虑在连续超时 N 次后重置 _syncDetect = null，
      触发 Worker 重新创建：

      let _failCount = 0;
      const MAX_CONSECUTIVE_FAILURES = 3;

      export function syncDetectByLocalModel(...): DetectionResult {
        try {
          const result = getSyncDetect()(context, config);
          _failCount = 0;
          return result;
        } catch (err) {
          _failCount++;
          if (_failCount >= MAX_CONSECUTIVE_FAILURES) {
            _syncDetect = null; // force re-creation
            _failCount = 0;
          }
          console.warn(...);
          return FALLBACK_S1;
        }
      }


#### 🟡 与 detector.ts 异步路径的潜在重复 LLM 调用


 现状：detector.ts L113-L114 的异步路径在 onUserMessage 检查点
      调用 detectByLocalModel。hooks.ts L720-L724 在
      onToolCallExecuted 检查点通过本文件同步调用同一函数。
 问题：两条路径的检查点不同（onUserMessage vs onToolCallExecuted），
      检测内容也不同（用户消息 vs 工具返回值），所以不是真正的
      重复。但如果未来有人在 hooks.ts 的其他检查点也调用
      syncDetectByLocalModel 且检测相同内容，就会产生冗余 LLM
      调用（浪费 token + 增加延迟）。
 建议：在文件头的 JSDoc 注释中明确说明本函数的设计场景：
      "仅用于 tool_result_persist 等同步 hook 中的
       onToolCallExecuted 检测，onUserMessage 检测走 detector.ts
       的异步路径。" 防止误用导致重复调用。


#### 🟡 未检查 config.localModel.enabled


 现状（L38-L48）：syncDetectByLocalModel 直接调用 getSyncDetect()，
      不检查 config.localModel?.enabled。
 问题：虽然 hooks.ts L720 在调用前已判断
      privacyConfig.localModel?.enabled，但 syncDetectByLocalModel
      作为导出函数，其他调用方可能不做此检查。此时 Worker 会
      被创建并启动，detectByLocalModel 内部虽然会检查 enabled
      并返回 S1，但已经浪费了 Worker 启动和通信的开销。
      对比 detector.ts 的行为：主函数 detectSensitivityLevel
      L38 就检查了 enabled 状态。
 建议：在函数入口添加快速路径：

      export function syncDetectByLocalModel(
        context: DetectionContext,
        config: PrivacyConfig,
      ): DetectionResult {
        if (!config.localModel?.enabled) return FALLBACK_S1;
        try { ... }
      }


#### 🟢 日志格式与 detector.ts 不一致


 现状（L45）：console.warn("[GuardClaw] syncDetect fallback to S1:", ...)
 问题：detector.ts L125 使用 console.error("[GuardClaw] Detector ... failed:", err)，
      local-model.ts L322 使用 console.error("[GuardClaw] Local model detection failed:", err)。
      本文件使用 console.warn 且格式略有不同。虽然 warn vs error
      的选择是有意义的（降级 vs 错误），但日志前缀格式不统一
      给运维过滤带来不便。
 建议：统一使用结构化日志格式，如：
      console.warn("[GuardClaw:sync-detect] Fallback to S1:", ...)
      各模块用 [GuardClaw:<module>] 前缀区分。


### 优先级总览


| 优先级 | ID | 标题                                    |
|--------|----|----------------------------------------|
| 🔴     |  3 | FALLBACK_S1 共享引用 — 调用方可能污染降级值 |
| 🟡     |  1 | FALLBACK_S1 对象可被外部修改              |
| 🟡     |  4 | Worker 创建失败时无法重试                 |
| 🟡     |  5 | 与 detector.ts 异步路径的潜在重复 LLM 调用 |
| 🟡     |  6 | 未检查 config.localModel.enabled          |
| 🟢     |  2 | getSyncDetect 可使用 nullish 合并简化      |
| 🟢     |  7 | 日志格式与 detector.ts 不一致              |
