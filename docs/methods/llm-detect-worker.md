# llm-detect-worker.ts — 逐方法文档


 文件定位：LLM 检测 Worker 线程入口
 所属模块：GuardClaw 隐私路由系统

 核心职责：作为 synckit Worker 线程的运行入口，在独立线程中
 执行异步的 LLM 本地模型敏感度检测。主线程通过 synckit 的
 createSyncFn 调用此 Worker，将异步的 detectByLocalModel
 转化为同步调用，从而在 hooks 的同步上下文中获取 LLM 检测结果。

 运行机制：
   synckit 是一个 npm 库，利用 Node.js Worker Threads +
   Atomics.wait 实现"在主线程同步等待 Worker 线程完成异步
   操作"的能力。此文件是 Worker 端的代码，配对的主线程端
   在 sync-detect.ts 中通过 createSyncFn 创建。

 调用链：
   hooks.ts (tool_result_persist 钩子)
```
```
     └→ sync-detect.ts :: syncDetectByLocalModel()  ← 主线程同步调用
          └→ synckit Worker Thread
               └→ llm-detect-worker.ts :: runAsWorker(…)  ← 本文件
                    └→ local-model.ts :: detectByLocalModel()
                         └→ callChatCompletion() → 本地 LLM API
```


 敏感等级体系：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理(proxy)或本地模型(local)
   S3 — 高度敏感，强制本地模型处理
## 导入说明                                        (L1-L3)


**L1**:
```typescript
import { runAsWorker } from "synckit";
```
> 从 synckit 库导入 runAsWorker 函数。
> runAsWorker 是 synckit 的 Worker 端 API，接收一个
> 异步函数作为参数，将其注册为 Worker 线程的执行体。
> 当主线程通过 createSyncFn 创建的同步代理函数被调用时，
> synckit 在后台启动此 Worker 线程，运行此处注册的异步
> 函数，并通过 SharedArrayBuffer + Atomics.wait 将结果
> 同步返回给主线程。


**L2**:
```typescript
import { detectByLocalModel } from "./local-model.js";
```
> 从 local-model.ts 导入核心检测函数 detectByLocalModel。
> 该函数功能：
> 1. 检查 config.localModel.enabled，未启用则返回 S1
> 2. 调用 buildDetectionMessages() 构建 system/user prompt
> 3. 调用 callLocalModel() 通过配置的 provider 协议
> (openai-compatible / ollama-native / custom) 发送请求
> 4. 调用 parseModelResponse() 解析 LLM 返回的 JSON
> 5. 返回 DetectionResult { level, levelNumeric, reason,
> detectorType, confidence }
> 6. 异常时降级返回 S1 + confidence: 0


**L3**:
```typescript
import type { DetectionContext, DetectionResult, PrivacyConfig } from "./types.js";
```
> 类型导入（编译后不生成 JS 代码）。
> - DetectionContext: 检测上下文，含 checkpoint / message /
> toolName / toolParams / toolResult / sessionKey 等字段
> - DetectionResult: 检测结果，含 level(S1/S2/S3) /
> levelNumeric(1/2/3) / reason / detectorType / confidence
> - PrivacyConfig: 隐私配置顶层对象，含 enabled / localModel /
> rules / checkpoints / guardAgent / session 等

## 函数：runAsWorker(async callback)               (L5-L7)


### 作用

  注册一个异步回调函数作为 Worker 线程的执行体。当主线程
  （sync-detect.ts）通过 createSyncFn 创建的同步代理函数被
  调用时，synckit 框架会在此 Worker 线程中执行该回调，传入
  主线程提供的参数，并将 Promise 解析后的返回值同步返回给
  主线程。

### 参数

  context: DetectionContext — 检测上下文对象，由主线程的
      syncDetectByLocalModel() 传入。包含待检测的消息内容
      (message)、工具名称(toolName)、工具参数(toolParams)、
      工具返回值(toolResult)、检测点(checkpoint)等。
  config: PrivacyConfig — 隐私配置对象，包含本地模型的
      endpoint / model / type / apiKey 等配置项。

### 返回值

  Promise<DetectionResult> — 敏感度检测结果。
  - level: "S1" | "S2" | "S3" — 敏感等级
  - levelNumeric: 1 | 2 | 3 — 数值形式等级
  - reason: string — 检测原因说明
  - detectorType: "localModelDetector" — 检测器类型标识
  - confidence: number — 置信度 (0-1)

### 逐行逻辑


**L5**:
```typescript
runAsWorker(async (context: DetectionContext, config: PrivacyConfig): Promise<DetectionResult> => {
```
> 调用 synckit 的 runAsWorker，传入一个 async 箭头函数。
> 该函数签名声明接收两个参数（context, config）并返回
> Promise<DetectionResult>。
> runAsWorker 内部会：
> 1. 监听来自主线程的 message 事件
> 2. 收到消息后，将参数传给此回调
> 3. await 回调的结果
> 4. 将结果通过 SharedArrayBuffer 写回主线程
> 5. 通过 Atomics.notify 唤醒主线程的 Atomics.wait


**L6**:
```typescript
return await detectByLocalModel(context, config);
```
> 将 context 和 config 原封不动地传给 detectByLocalModel。
> detectByLocalModel 是真正执行 LLM 推理的函数，内部：
> - 若 config.localModel?.enabled 为 false → 直接返回 S1
> - 否则构建 prompt → 调用本地模型 API → 解析结果
> - 异常降级为 S1 + confidence: 0
> await 确保在 Worker 线程中等待异步操作完成后再返回。
> 这里直接 return await，因为 runAsWorker 要求回调返回
> Promise，await 在这里等价于直接 return Promise，但
> 加了 await 能让 try-catch（若有）正确捕获异步异常。


**L7**:
```typescript
});
```
> 箭头函数和 runAsWorker 调用结束。
> 此文件在被 Worker 线程加载后，runAsWorker 即刻执行，
> 注册好回调后 Worker 进入等待状态，直到主线程发来参数。


### 设计意图

  此文件是整个"同步 LLM 检测"架构的关键枢纽。问题背景：
  Cursor/OpenClaw 的 hook 系统（如 tool_result_persist）要求
  同步返回结果，但 LLM 推理是异步操作（需要网络请求到本地
  模型服务）。synckit 通过 Worker Thread + Atomics.wait 桥接
  了这个同步/异步鸿沟：
    - 主线程 (sync-detect.ts): createSyncFn → Atomics.wait 阻塞
    - Worker 线程 (本文件): runAsWorker → async 执行 → 结果写回

  设计上刻意保持此文件极简（仅 7 行），所有检测逻辑封装在
  local-model.ts 中。这样做的好处：
    1. Worker 入口职责单一，不承担任何业务逻辑
    2. detectByLocalModel 可以被其他地方独立调用（如 detector.ts
       中的异步检测流程），保持代码复用
    3. Worker 线程的序列化/反序列化开销最小化 — 只传递
       DetectionContext 和 PrivacyConfig 两个 JSON 可序列化对象
## 配对文件说明：sync-detect.ts（主线程端）


 sync-detect.ts 是本文件的"另一半"，负责主线程端的逻辑：

 1. 通过 fileURLToPath(new URL("./llm-detect-worker.ts", import.meta.url))
    计算本文件的绝对路径

 2. createSyncFn(workerPath, { timeout: 20_000, tsRunner: "node" })
    创建同步代理函数，配置 20 秒超时

 3. 导出 syncDetectByLocalModel(context, config)
    调用代理函数，超时或异常时降级返回 S1

 hooks.ts 在 tool_result_persist 钩子中调用
 syncDetectByLocalModel，实现：
   "规则检测覆盖关键词/正则，但无法捕获语义级别的敏感内容，
    synckit 阻塞主线程等待 LLM 推理结果（20s 超时），让我们
    在钩子返回前就能使用 LLM 的检测结果。"
---

## Code Review — 代码审查


### Part A — Code 层面改动建议


#### 🟢 显式类型标注 runAsWorker 泛型


 现状（L5）：runAsWorker(async (context: DetectionContext, config: PrivacyConfig): ...
 问题：runAsWorker 本身是泛型函数，但此处依赖参数上的类型标注
      而非泛型参数。虽然 TypeScript 能推断，但显式泛型可以
      增强可读性和 IDE 跳转能力。
 建议：
      runAsWorker<(context: DetectionContext, config: PrivacyConfig) => Promise<DetectionResult>>(
        async (context, config) => { ... }
      );
      不过这属于风格偏好，影响极小。


### Part B — 逻辑/设计层面改动建议


#### 🟡 Worker 内无异常兜底，超时是唯一保护


 现状（L5-L7）：Worker 回调直接 return await detectByLocalModel(...)，
      没有 try-catch。
 问题：虽然 detectByLocalModel 内部有 try-catch（local-model.ts L320-L330），
      但如果 Worker 线程在初始化阶段（如 import 失败）或 synckit
      序列化阶段抛出异常，主线程的 sync-detect.ts 只能依赖 20s
      超时才能恢复。超时期间主线程完全阻塞（Atomics.wait）。
 建议：在 Worker 内加一层防御性 try-catch，确保任何异常都能
      以 S1 降级结果快速返回，而非等到超时：

      runAsWorker(async (context: DetectionContext, config: PrivacyConfig): Promise<DetectionResult> => {
        try {
          return await detectByLocalModel(context, config);
        } catch (err) {
          return {
            level: "S1", levelNumeric: 1,
            reason: `Worker error: ${String(err)}`,
            detectorType: "localModelDetector", confidence: 0,
          };
        }
      });


#### 🟡 Worker 线程与 detector.ts 的功能重叠


 现状：detector.ts（L113-L114）异步调用 detectByLocalModel，
      本文件通过 synckit Worker 同步调用同一函数。
 问题：存在两条调用路径到达 detectByLocalModel：
        路径 A: detector.ts → detectByLocalModel() (异步)
        路径 B: hooks.ts → syncDetectByLocalModel() → Worker → detectByLocalModel() (同步)
      两条路径可能对同一消息重复执行 LLM 推理（浪费 token +
      增加延迟），除非上层调用方做了互斥。hooks.ts L720 的条件
      "ruleCheck.level !== 'S3'" 提供了部分短路，但并不防止
      detector.ts 的异步路径也执行 LLM 检测。
 建议：确认上层是否存在去重机制。如果两条路径在同一请求中
      可能同时触发，考虑：
      a) 在 hooks.ts 中复用 detector.ts 的异步结果（缓存 key=消息 hash）
      b) 或在 detector.ts 中跳过 LLM 检测（如果 hooks 已同步检测过）


#### 🟢 tsRunner: "node" 配置与 .ts 扩展名的兼容性


 现状（sync-detect.ts L32）：{ timeout: 20_000, tsRunner: "node" }
      且 workerPath 指向 .ts 文件。
 问题：tsRunner: "node" 意味着直接用 Node.js 运行 Worker。
      如果运行环境不支持 .ts 文件直接执行（如未配置
      --loader tsx 或 ts-node），Worker 会启动失败。
      目前依赖 OpenClaw 的运行环境已配置好 TS 支持，但这是
      一个隐含假设。
 建议：在 README 或配置文档中注明此依赖；或者 workerPath
      指向编译后的 .js 文件以提高兼容性。


### 优先级总览


| 优先级 | ID | 标题                                    |
|--------|----|----------------------------------------|
| 🟡     |  2 | Worker 内无异常兜底，超时是唯一保护       |
| 🟡     |  3 | Worker 线程与 detector.ts 的功能重叠      |
| 🟢     |  1 | 显式类型标注 runAsWorker 泛型            |
| 🟢     |  4 | tsRunner 配置与 .ts 扩展名的兼容性        |
