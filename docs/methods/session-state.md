# session-state.ts — 逐方法文档


 文件定位：GuardClaw 会话隐私状态管理（内存级别）
 所属模块：GuardClaw 隐私路由系统

 核心职责：
 维护每个会话（session）的隐私敏感状态，包括当前轮次（turn）的敏感等级、
 历史最高等级、检测事件记录、待消费的检测结果暂存（pending detection），
 以及本地路由激活状态。所有状态都存储在进程内的 Map/Set 中，
 服务于 hooks.ts 中多个钩子之间的跨阶段数据传递。

 关键设计："Per-turn 语义"
   传统做法是"一旦检测到敏感，会话永久标记为 private"。
   本文件采用 per-turn 语义——隐私等级在每轮开始时重置为 S1，
   仅当前轮次检测到 S2/S3 时才标记为 private。
   highestLevel 仍然全生命周期累积，用于审计/统计。

 敏感等级体系：
   S1 — 无敏感内容，直接放行
   S2 — 中度敏感，走代理(proxy)或本地模型(local)
   S3 — 高度敏感，强制本地模型处理
## 模块级状态：三个内存存储                       (L13-L17)


sessionStates: Map<string, SessionPrivacyState>        (L13)
    核心状态表。以 sessionKey 为键，存储每个会话的隐私状态。
    SessionPrivacyState 包含：
      - sessionKey: string — 会话标识
      - isPrivate: boolean — 向后兼容字段（已被 currentTurnLevel 取代）
      - highestLevel: SensitivityLevel — 会话生命周期内检测到的最高等级（审计用）
      - currentTurnLevel: SensitivityLevel — 当前轮次的敏感等级（每轮重置）
      - detectionHistory: Array<{timestamp, level, checkpoint, reason?}>
          — 检测事件历史，最多保留 50 条

pendingDetections: Map<string, PendingDetection>       (L15)
    检测结果暂存区。before_model_resolve 阶段写入，
    before_prompt_build / before_message_write 阶段读取并消费。
    用于在不同钩子之间传递检测结果，因为各钩子是独立注册、
    依次触发的，无法直接共享局部变量。

activeLocalRouting: Set<string>                        (L17)
    记录当前轮次正在使用本地模型路由的会话。
    当 S3 被检测到时设置，下一轮 before_model_resolve 开始时清除。
    tool_result_persist 钩子据此决定是否跳过 PII 脱敏
    （本地路由的数据不离开本地环境，无需脱敏）。
## 类型：PendingDetection                         (L145-L151)


检测结果暂存的数据结构，用于 before_model_resolve 到
before_prompt_build / before_message_write 之间的跨阶段传递。

字段说明：
  level: SensitivityLevel
      检测到的敏感等级 ("S1" | "S2" | "S3")

  reason?: string
      检测原因说明（如 "S3 keyword: 身份证"）

  desensitized?: string
      S2 脱敏后的文本（由 desensitizeWithLocalModel 生成）。
      before_message_write 读取此字段替换原始消息内容。

  originalPrompt?: string
      原始用户输入。S3 场景下用于 Guard Agent 的完整上下文保留。

  timestamp: number
      暂存时间戳（Date.now()），用于判断暂存是否过期。
## 函数：markSessionAsPrivate(sessionKey, level)   (L31-L48)


### 作用

  将当前轮次标记为隐私状态（S2 或 S3 被检测到）。
  同时更新全生命周期的 highestLevel 用于审计。

### 参数

  sessionKey: string — 会话唯一标识符
  level: SensitivityLevel — 本次检测到的敏感等级

### 返回值

  void

### 逐行逻辑


**L32**:
```typescript
const existing = sessionStates.get(sessionKey);
```
> 尝试从内存 Map 中获取已存在的会话状态。
> 如果该 sessionKey 首次出现，existing 为 undefined。


**L34-L38**:
```typescript
if (existing) { ... }
```
> 会话已存在，做增量更新：


**L35**:
```typescript
existing.currentTurnLevel = getHigherLevel(existing.currentTurnLevel, level);
```
> 当前轮次等级取"已有值"和"新值"中的较高者。
> 例如：当前轮次已检测到 S2，现在又检测到 S3，
> getHigherLevel("S2", "S3") → "S3"。
> 这保证了同一轮次内多次检测取最严格结果。


**L36**:
```typescript
existing.highestLevel = getHigherLevel(existing.highestLevel, level);
```
> 全生命周期最高等级同样取较高者。
> 此字段只升不降，用于审计统计。


**L37**:
```typescript
existing.isPrivate = existing.currentTurnLevel !== "S1";
```
> 更新向后兼容的 isPrivate 布尔值。
> 只要 currentTurnLevel 不是 S1，就视为 private。
> 注意：types.ts 中标记 isPrivate 为 @deprecated，
> 实际判断应使用 currentTurnLevel。


**L38-L47**:
```typescript
else { ... }
```
> 会话首次出现，创建全新的 SessionPrivacyState：


**L39**:
```typescript
const isPrivate = level === "S2" || level === "S3";
```
> 判断初始状态是否为 private。


**L40-L47**:
```typescript
sessionStates.set(sessionKey, { ... });
```
> 构造完整状态对象并写入 Map：
> - sessionKey: 原样存储
> - isPrivate: 初始 private 标志
> - highestLevel: 初始值即为传入的 level
> - currentTurnLevel: 初始值即为传入的 level
> - detectionHistory: 空数组（检测历史由 recordDetection 单独写入）


### 设计意图

  与 trackSessionLevel 的区别：markSessionAsPrivate 同时设置
  isPrivate = true（影响 hooks.ts 中 isSessionMarkedPrivate 的判断），
  用于 S2 场景下需要根据 s2Policy 决定走 proxy 还是 local。
  trackSessionLevel 则不设 isPrivate，用于 S3 场景——
  S3 的物理隔离由 activeLocalRouting 控制，不依赖 isPrivate。
## 函数：isSessionMarkedPrivate(sessionKey)        (L53-L57)


### 作用

  检查当前轮次是否被标记为隐私状态（S2 或 S3）。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  boolean — true 表示当前轮次存在敏感内容

### 逐行逻辑


**L54**:
```typescript
const state = sessionStates.get(sessionKey);
```
> 从 Map 中查找会话状态。


**L55**:
```typescript
if (!state) return false;
```
> 会话不存在（从未被标记过），视为安全。


**L56**:
```typescript
return state.currentTurnLevel !== "S1";
```
> 基于 per-turn 语义：只看当前轮次等级，不看 highestLevel。
> 如果上一轮是 S3 但本轮已 reset，此处返回 false。


### 设计意图

  hooks.ts 中多处使用此函数决定是否启用隐私处理逻辑：
  - shouldUseFullMemoryTrack() 判断是否使用完整记忆轨道
  - before_message_write 判断是否需要双轨历史持久化
  - session_end 判断会话类型用于日志标记
  注意：此函数不依赖 isPrivate 字段，而是直接检查 currentTurnLevel，
  与 per-turn 语义一致。
## 函数：resetTurnLevel(sessionKey)                (L63-L69)


### 作用

  将当前轮次的隐私等级重置为 S1（安全）。
  在每个新用户轮次的 before_model_resolve 钩子开头调用。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  void

### 逐行逻辑


**L64**:
```typescript
const existing = sessionStates.get(sessionKey);
```
> 查找已有状态。


**L65-L68**:
```typescript
if (existing) { ... }
```
> 只有状态存在时才操作；不存在则什么都不做
> （不存在意味着该会话从未触发过敏感检测，不需要重置）。


**L66**:
```typescript
existing.currentTurnLevel = "S1";
```
> 将当前轮次等级重置为 S1。
> 这是 per-turn 语义的核心：每轮重新从 S1 开始判断。


**L67**:
```typescript
existing.isPrivate = false;
```
> 同步重置向后兼容字段。
> 注意：highestLevel 不被重置——它是全生命周期的审计值。


### 设计意图

  实现"per-turn 语义"的关键函数。hooks.ts 中 before_model_resolve
  的开头三连调用顺序为：
    1. clearActiveLocalRouting(sessionKey) — 清除上轮的本地路由标记
    2. resetTurnLevel(sessionKey)          — 重置轮次等级
    3. consumeDetection(sessionKey)        — 清除上轮未消费的暂存
  确保每轮从"干净"状态开始检测。
## 函数：getCurrentTurnLevel(sessionKey)           (L74-L76)


### 作用

  获取当前轮次的敏感等级。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  SensitivityLevel — 当前轮次等级，未知会话默认 "S1"

### 逐行逻辑


**L75**:
```typescript
return sessionStates.get(sessionKey)?.currentTurnLevel ?? "S1";
```
> 链式可选访问：
> - .get(sessionKey)：查找会话，可能返回 undefined
> - ?.currentTurnLevel：安全取字段
> - ?? "S1"：未知会话默认安全
> 整行是一个简洁的"查找 → 取值 → 兜底"链。


### 设计意图

  轻量级只读查询，不创建状态。调用方无需判断会话是否存在。
## 函数：getSessionHighestLevel(sessionKey)        (L81-L83)


### 作用

  获取会话全生命周期内检测到的最高敏感等级（审计用）。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  SensitivityLevel — 历史最高等级，未知会话默认 "S1"

### 逐行逻辑


**L82**:
```typescript
return sessionStates.get(sessionKey)?.highestLevel ?? "S1";
```
> 与 getCurrentTurnLevel 结构完全对称，读取的是 highestLevel。
> highestLevel 由 markSessionAsPrivate / trackSessionLevel 递增，
> 从不被 resetTurnLevel 重置。


### 设计意图

  供 token-stats.ts 中的 getSessionHighestLevel() 调用，
  用于将 token 消耗归类到对应的敏感等级统计桶中。
  全生命周期最高等级可回答"这个会话是否曾经处理过高敏感内容"。
函数：recordDetection(sessionKey, level,        (L90-L119)
       checkpoint, reason?)

### 作用

  将一次检测事件追加到会话的 detectionHistory 数组中。

### 参数

  sessionKey: string — 会话标识符
  level: SensitivityLevel — 本次检测结果等级
  checkpoint: Checkpoint — 检测发生的时机
      ("onUserMessage" | "onToolCallProposed" | "onToolCallExecuted")
  reason?: string — 可选的检测原因描述

### 返回值

  void

### 逐行逻辑


**L96**:
```typescript
let state = sessionStates.get(sessionKey);
```
> 注意使用 let 而非 const——下面可能需要重新赋值。


**L98-L107**:
```typescript
if (!state) { state = { ... }; sessionStates.set(sessionKey, state); }
```
> 如果会话状态不存在，先创建一个默认状态再记录。
> 初始值：isPrivate=false, highestLevel="S1", currentTurnLevel="S1"。
> 这保证了 recordDetection 可以在 markSessionAsPrivate 之前被调用，
> 不会因为状态不存在而丢失检测记录。


**L109-L114**:
```typescript
state.detectionHistory.push({ ... });
```
> 追加检测事件：
> - timestamp: Date.now() — 毫秒级时间戳
> - level: 检测等级
> - checkpoint: 发生位置
> - reason: 可选描述
> 注意：此函数 **不** 更新 currentTurnLevel 或 highestLevel，
> 仅做记录。等级更新由 markSessionAsPrivate / trackSessionLevel 负责。


**L116-L118**:
```typescript
if (state.detectionHistory.length > 50) {
```

               state.detectionHistory = state.detectionHistory.slice(-50);
             }
> 滑动窗口裁剪：只保留最近 50 条检测记录。
> slice(-50) 取数组末尾 50 个元素，丢弃最旧的记录。
> 防止长时间运行的会话累积过多内存。

### 设计意图

  检测记录与等级更新解耦。hooks.ts 中的典型调用模式：
    recordDetection(sessionKey, "S3", "onUserMessage", reason);
    trackSessionLevel(sessionKey, "S3");
    setActiveLocalRouting(sessionKey);
  记录是审计性质的，不影响路由决策。50 条上限是内存保护措施。
## 函数：clearSessionState(sessionKey)             (L127-L131)


### 作用

  彻底清除一个会话的所有内存状态。
  在会话结束（session_end 钩子）时调用。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  void

### 逐行逻辑


**L128**:
```typescript
sessionStates.delete(sessionKey);
```
> 从主状态表中移除。


**L129**:
```typescript
activeLocalRouting.delete(sessionKey);
```
> 从本地路由激活集合中移除。


**L130**:
```typescript
pendingDetections.delete(sessionKey);
```
> 从待消费检测暂存中移除。
> 三个存储全部清理，确保无内存泄漏。


### 设计意图

  内存管理的关键出口。hooks.ts 中 session_end 钩子调用：
    await memMgr.syncAllMemoryToClean(privacyConfig);
    clearSessionState(sessionKey);  // ← 清理完记忆后释放状态
  如果不清理，长运行的进程会随着会话数量增长而泄漏内存。
## 函数：getAllSessionStates()                     (L136-L138)


### 作用

  返回所有活跃会话状态的快照（浅拷贝）。

### 参数

  无

### 返回值

  Map<string, SessionPrivacyState> — 当前所有会话状态的副本

### 逐行逻辑


**L137**:
```typescript
return new Map(sessionStates);
```
> 使用 Map 拷贝构造函数创建浅拷贝。
> 调用方拿到的是独立的 Map 实例，修改不会影响内部状态。
> 注意：值对象（SessionPrivacyState）本身是引用共享的，
> 调用方如果修改值对象的属性仍会影响原始数据——
> 这里只做了一层浅拷贝。


### 设计意图

  供 stats-dashboard.ts 的监控 API 使用。Dashboard 需要展示
  当前所有活跃会话的隐私状态，但不应该直接持有内部 Map 的引用。
  浅拷贝是性能和安全的折中。
## 函数：stashDetection(sessionKey, detection)     (L153-L155)


### 作用

  将一个检测结果暂存到 pendingDetections，供后续钩子阶段读取。

### 参数

  sessionKey: string — 会话标识符
  detection: PendingDetection — 包含 level / reason / desensitized / originalPrompt / timestamp

### 返回值

  void

### 逐行逻辑


**L154**:
```typescript
pendingDetections.set(sessionKey, detection);
```
> 直接覆盖写入。
> 同一轮次内如果多次 stash（如 S2 脱敏失败升级为 S3），
> 后写入的覆盖先写入的——最终消费的是最新状态。


### 设计意图

  hooks.ts 中 before_model_resolve 产生检测结果后，
  需要将结果传递给 before_prompt_build（注入提示词）
  和 before_message_write（替换/脱敏消息内容）。
  由于各钩子是独立注册的函数，无法通过闭包或参数传递，
  因此使用模块级 Map 作为跨阶段通信通道。
## 函数：getPendingDetection(sessionKey)           (L157-L159)


### 作用

  读取（不消费）暂存的检测结果。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  PendingDetection | undefined — 暂存结果，无暂存时返回 undefined

### 逐行逻辑


**L158**:
```typescript
return pendingDetections.get(sessionKey);
```
> 纯读取，不删除。允许多个钩子阶段读取同一暂存。


### 设计意图

  before_prompt_build 使用此函数读取检测结果但不消费，
  因为后续 before_message_write 也需要读取。
  消费（删除）由 consumeDetection 负责。
## 函数：consumeDetection(sessionKey)              (L161-L165)


### 作用

  读取并删除暂存的检测结果（一次性消费）。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  PendingDetection | undefined — 被消费的暂存结果

### 逐行逻辑


**L162**:
```typescript
const d = pendingDetections.get(sessionKey);
```
> 先读取暂存值。


**L163**:
```typescript
pendingDetections.delete(sessionKey);
```
> 立即从 Map 中删除，确保不会被重复消费。
> 即使 d 为 undefined（无暂存），delete 也是安全的（静默无操作）。


**L164**:
```typescript
return d;
```
> 返回读取到的值（可能是 undefined）。


### 设计意图

  before_message_write 中使用此函数获取并清除暂存：
    - S3: consumeDetection → 替换消息为占位符 "🔒 [Private content]"
    - S2: consumeDetection → 替换消息为脱敏后的文本
  消费后暂存被清除，防止下一轮误读上一轮的残留数据。
  resetTurnLevel 开头也会调用 consumeDetection 做双重保险。
## 函数：trackSessionLevel(sessionKey, level)      (L181-L195)


### 作用

  更新会话的审计等级和当前轮次等级，但 **不** 将会话标记为
  permanently private（不设 isPrivate = true）。

### 参数

  sessionKey: string — 会话标识符
  level: SensitivityLevel — 检测到的敏感等级

### 返回值

  void

### 逐行逻辑


**L183**:
```typescript
const existing = sessionStates.get(sessionKey);
```
> 查找已有状态。


**L183-L185**:
```typescript
if (existing) { ... }
```
> 状态已存在时做增量更新：


**L184**:
```typescript
existing.highestLevel = getHigherLevel(existing.highestLevel, level);
```
> 更新审计最高等级（只升不降）。


**L185**:
```typescript
existing.currentTurnLevel = getHigherLevel(existing.currentTurnLevel, level);
```
> 更新当前轮次等级。
> **关键差异**：不设 existing.isPrivate = true。


**L186-L194**:
```typescript
else { ... }
```
> 状态不存在时创建新记录：


**L188**:
```typescript
isPrivate: false,
```
> 注意：即使 level 是 S3，isPrivate 也是 false。
> 这是与 markSessionAsPrivate 的本质区别。


### 设计意图

  专为 S3 场景设计。当 S3 被检测到时，消息被路由到
  Guard Agent（物理隔离的会话/工作区），S3 数据完全不进入
  主会话的上下文窗口。因此主会话不需要被标记为 "private"——
  它看到的只是占位符 "🔒 [Private content]"。

  hooks.ts 中的典型使用：
    trackSessionLevel(sessionKey, "S3");     // 审计记录
    setActiveLocalRouting(sessionKey);        // 激活本地路由
  两者配合实现 S3 的物理隔离，而不依赖 isPrivate 标志。

  对比 markSessionAsPrivate 用于 S2 场景：
    markSessionAsPrivate(sessionKey, "S2");   // 设 isPrivate=true
  S2 数据可能经过脱敏后仍在主会话中流转（proxy 模式），
  因此需要 isPrivate 标志来触发内存轨道选择等逻辑。
## 函数：setActiveLocalRouting(sessionKey)         (L204-L206)


### 作用

  将会话标记为"当前轮次正在使用本地模型路由"。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  void

### 逐行逻辑


**L205**:
```typescript
activeLocalRouting.add(sessionKey);
```
> 将 sessionKey 加入 Set。
> Set 保证幂等——重复 add 同一 key 无副作用。


### 设计意图

  S3 检测到后立即调用。hooks.ts 中后续钩子据此判断：
  - shouldUseFullMemoryTrack() → true：使用完整记忆轨道
  - tool_result_persist → 跳过 PII 脱敏（本地数据不离开环境）
  - before_tool_call → 跳过文件访问守卫（本地模型可信）
  - before_message_write → 将本地模型响应写入完整轨道
## 函数：clearActiveLocalRouting(sessionKey)       (L208-L210)


### 作用

  清除会话的本地路由激活标记。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  void

### 逐行逻辑


**L209**:
```typescript
activeLocalRouting.delete(sessionKey);
```
> 从 Set 中移除。不存在时静默无操作。


### 设计意图

  在每轮 before_model_resolve 开头调用（与 resetTurnLevel 配合），
  确保上一轮的 S3 本地路由状态不会泄漏到本轮。
  本轮如果再次检测到 S3，会重新调用 setActiveLocalRouting。
## 函数：isActiveLocalRouting(sessionKey)          (L212-L214)


### 作用

  查询会话当前轮次是否正在使用本地模型路由。

### 参数

  sessionKey: string — 会话标识符

### 返回值

  boolean — true 表示当前轮次是 S3 本地路由

### 逐行逻辑


**L213**:
```typescript
return activeLocalRouting.has(sessionKey);
```
> Set.has() 查询，O(1) 时间复杂度。


### 设计意图

  hooks.ts 中是使用最频繁的查询之一（出现 8+ 次）：
  - shouldUseFullMemoryTrack: 决定记忆轨道
  - before_tool_call: 决定是否跳过安全检查
  - after_tool_call: 决定是否将工具结果写入完整轨道
  - before_message_write: 决定助手响应的脱敏处理
  O(1) 查询性能对请求关键路径至关重要。
## 函数：getHigherLevel(a, b)                      (L218-L221)


### 作用

  比较两个敏感等级，返回较高者。
  内部辅助函数，不导出。

### 参数

  a: SensitivityLevel — 等级 A
  b: SensitivityLevel — 等级 B

### 返回值

  SensitivityLevel — a 和 b 中较高的那个

### 逐行逻辑


**L219**:
```typescript
const order = { S1: 1, S2: 2, S3: 3 };
```
> 定义等级到数值的映射。
> 每次调用都会创建这个字面量对象——代价极低（V8 内联优化），
> 但如果追求极致可以提到模块级常量。


**L220**:
```typescript
return order[a] >= order[b] ? a : b;
```
> 比较数值大小，返回原始字符串等级。
> >= 意味着"相等时返回 a"（左操作数优先）。
> 实际上等级相同时返回哪个无所谓，因为值一样。


### 设计意图

  与 types.ts 中的 maxLevel() 功能类似，但实现更轻量：
  - maxLevel 支持变长参数 (...levels)，内部通过 map + Math.max + numericToLevel
  - getHigherLevel 只比较两个值，用对象字面量直接映射
  session-state.ts 选择自有实现可能是为了避免对 types.ts 的循环依赖，
  或者是因为双值比较场景不需要 maxLevel 的通用性。
  但两者之间存在功能重复，参见 Code Review C1。

## Part A — Code 层面改动建议


#### 🟡 getHigherLevel 与 types.ts 的 maxLevel 功能重复


 现状（L218-L221）：
   session-state.ts 自行实现了 getHigherLevel()，
   每次调用都创建 { S1: 1, S2: 2, S3: 3 } 对象。

 对比（types.ts L248-L253）：
   maxLevel(...levels) 使用 levelToNumeric + Math.max + numericToLevel，
   可处理任意数量的等级。

 问题：
   功能完全重复。session-state.ts 已经 import type 了 SensitivityLevel，
   理论上可以直接 import maxLevel。

 建议：
   将 getHigherLevel(a, b) 替换为 maxLevel(a, b)。
   两者在双参数场景下行为完全等价。
   如果有性能顾虑（maxLevel 多一次 map + Math.max），
   可以在 types.ts 中同时导出一个 higherLevel(a, b) 二参数版本。


#### 🟡 markSessionAsPrivate 和 trackSessionLevel 的创建新状态逻辑重复


 现状：
   markSessionAsPrivate（L38-L47）和 trackSessionLevel（L186-L194）
   以及 recordDetection（L98-L107）都有独立的"创建默认状态"代码块，
   三处构造的 SessionPrivacyState 结构相同。

 建议提取辅助函数：

   function getOrCreateState(sessionKey: string): SessionPrivacyState {
     let state = sessionStates.get(sessionKey);
     if (!state) {
       state = {
         sessionKey,
         isPrivate: false,
         highestLevel: "S1",
         currentTurnLevel: "S1",
         detectionHistory: [],
       };
       sessionStates.set(sessionKey, state);
     }
     return state;
   }

   markSessionAsPrivate、trackSessionLevel、recordDetection 都可以
   简化为 const state = getOrCreateState(sessionKey); 然后直接操作。


#### 🟢 recordDetection 的滑动窗口裁剪可以优化


 现状（L116-L118）：
   if (state.detectionHistory.length > 50) {
     state.detectionHistory = state.detectionHistory.slice(-50);
   }

 问题：
   每次超过 50 条都会创建新数组。在高频检测场景下，
   第 51 次开始每次 push 后都会触发 slice。

 建议（环形缓冲）：
   如果性能敏感，可以改用环形缓冲策略：超过阈值时一次性
   裁剪到 25 条，减少裁剪频率。

   const MAX_HISTORY = 50;
   const TRIM_TO = 25;
   if (state.detectionHistory.length > MAX_HISTORY) {
     state.detectionHistory = state.detectionHistory.slice(-TRIM_TO);
   }

   不过当前 50 条的场景下性能影响极小，属于锦上添花。


#### 🟢 getAllSessionStates 返回浅拷贝，值对象仍可被外部修改


 现状（L137）：
   return new Map(sessionStates);

 问题：
   调用方（stats-dashboard.ts）拿到的 Map 是新实例，
   但 Map 的值是 SessionPrivacyState 的原始引用。
   如果 Dashboard 代码意外修改了某个值对象的属性，
   会影响内部状态。

 建议：
   如果 Dashboard 只读展示，当前浅拷贝足够。
   如果需要更强隔离：

   return new Map(
     Array.from(sessionStates, ([k, v]) => [k, { ...v, detectionHistory: [...v.detectionHistory] }])
   );

   代价是性能略高，需权衡。
## Part B — 逻辑/设计层面改动建议


#### 🔴 markSessionAsPrivate vs trackSessionLevel 语义差异

     不直观，容易误用

 现状：
   markSessionAsPrivate — 设 isPrivate=true + 更新两个 level
   trackSessionLevel    — 只更新两个 level，不设 isPrivate

 hooks.ts 中的使用模式：
   S2 场景 → markSessionAsPrivate(sessionKey, "S2")
   S3 场景 → trackSessionLevel(sessionKey, "S3") + setActiveLocalRouting(sessionKey)

 问题：
   两个函数名看起来都像是"标记会话为某个等级"，但行为差异隐藏在
   isPrivate 字段是否被设置。新开发者很容易在 S3 场景下误用
   markSessionAsPrivate，或在 S2 场景下误用 trackSessionLevel。
   JSDoc 注释虽然解释了区别，但函数名本身不够自描述。

 建议（重命名使意图更明确）：
   markSessionAsPrivate → markTurnAsPrivate
       含义：标记当前轮次为 private（S2 proxy/local 场景）
   trackSessionLevel → recordAuditLevel
       含义：只记录审计等级，不改变 private 状态（S3 物理隔离场景）

   或者合并为一个函数，通过参数控制行为：
   function updateSessionLevel(sessionKey, level, options?: { markPrivate?: boolean }) { ... }


#### 🔴 pendingDetections 无 TTL/过期清理机制


 现状：
   stashDetection 写入 pendingDetections，
   consumeDetection 读取并删除。
   如果某个钩子未触发（如异常中断），暂存永远不会被消费。

 虽然 resetTurnLevel 开头会调用 consumeDetection 做清理，
 但如果会话在 before_model_resolve 之前就异常退出
 （如进程重启、连接断开），暂存会一直留在内存中。

 问题：
   PendingDetection 包含 originalPrompt（完整用户输入），
   长期残留意味着敏感数据可能在内存中停留超出预期。

 建议：
   1. 利用 PendingDetection.timestamp 字段（已存在！），
      在 getPendingDetection / consumeDetection 中添加过期判断：

      const MAX_PENDING_AGE_MS = 60_000; // 1 分钟
      const d = pendingDetections.get(sessionKey);
      if (d && Date.now() - d.timestamp > MAX_PENDING_AGE_MS) {
        pendingDetections.delete(sessionKey);
        return undefined;
      }

   2. 或定期（如每 5 分钟）扫描 pendingDetections 清理过期条目。


#### 🟡 isSessionMarkedPrivate 的判断逻辑与 isPrivate 字段不一致


 现状（L56）：
   return state.currentTurnLevel !== "S1";

 SessionPrivacyState 有 isPrivate 字段，但 isSessionMarkedPrivate
 不读它，而是直接判断 currentTurnLevel。

 问题：
   - trackSessionLevel 会更新 currentTurnLevel 为 S3，
     但不设 isPrivate。
   - 这意味着 isSessionMarkedPrivate 在 S3 场景下也会返回 true，
     即使 isPrivate === false。
   - hooks.ts L78 shouldUseFullMemoryTrack 中
     isSessionMarkedPrivate 的返回值会导致 S3 场景走 S2 的
     s2Policy 判断逻辑——但 S3 已经被 isActiveLocalRouting
     在前面短路返回了 true，所以实际运行时不会出 bug。
   - 但代码的语义不清晰：isSessionMarkedPrivate 的名字暗示
     它与 markSessionAsPrivate 对应，但实际上 trackSessionLevel
     的结果也会让它返回 true。

 建议：
   方案 A（推荐）：改名为 isTurnSensitive()，
     更准确地反映"当前轮次是否有敏感内容"的语义。
   方案 B：改为读取 isPrivate 字段，
     return state.isPrivate === true;
     但这需要确认所有调用方的期望语义。


#### 🟡 clearSessionState 不清理 DualSessionManager 的内存


 现状（L127-L131）：
   clearSessionState 清理了 sessionStates、activeLocalRouting、
   pendingDetections 三个 Map/Set，但不清理：
   - DualSessionManager 中的 writeLocks Map
   - DualSessionManager 中的 seededSessions Set

 问题：
   DualSessionManager 是另一个模块（session-manager.ts），
   session-state.ts 不负责它的清理。
   但 hooks.ts session_end 中的调用顺序是：
     await memMgr.syncAllMemoryToClean(privacyConfig);
     clearSessionState(sessionKey);
   没有调用 sessionManager.clearHistory(sessionKey)。
   长运行进程中 seededSessions 和 writeLocks 会无限增长。

 建议：
   在 hooks.ts session_end 中补充 DualSessionManager 的清理，
   或在 clearSessionState 中接受可选的 cleanup 回调。


#### 🟡 所有状态存储无并发保护


 现状：
   sessionStates / pendingDetections / activeLocalRouting
   都是普通的 Map / Set，无锁机制。

 问题：
   Node.js 单线程事件循环下，同步代码不会有竞态。
   但如果未来引入 Worker Threads 或多进程部署，
   这些共享状态就会出问题。
   目前最可能的竞态场景：同一 session 的两个并发请求
   （如用户快速连续发送消息），两个 before_model_resolve
   都执行 resetTurnLevel → 检测 → markSessionAsPrivate，
   可能导致第一个请求的 stashDetection 被第二个覆盖。

 建议：
   - 短期：文档中明确标注"本模块假设单线程执行"。
   - 长期：为 stash/consume 引入轮次 ID 关联，
     避免跨轮次覆盖。


#### 🟢 detectionHistory 只在 recordDetection 中写入，

     但 markSessionAsPrivate 创建新状态时不回填

 现状：
   hooks.ts 的调用顺序通常是：
     recordDetection(sessionKey, "S3", "onUserMessage", reason);  // 写历史
     trackSessionLevel(sessionKey, "S3");                          // 更新等级

   但如果调用顺序反过来（先 markSessionAsPrivate 再 recordDetection），
   且 sessionKey 是首次出现，markSessionAsPrivate 会创建状态
   （detectionHistory: []），随后 recordDetection 正常追加——没有问题。

   但如果只调用 markSessionAsPrivate 而忘记调用 recordDetection
   （如 L282 markSessionAsPrivate 之后没有紧跟 recordDetection），
   检测历史就会缺少该事件。

 影响较低，因为 hooks.ts 目前的调用模式都包含了 recordDetection。
 但作为防御性编程，可以考虑在 markSessionAsPrivate 内部
 自动追加一条 detectionHistory。
## Review 优先级总览


 🔴 高优先级（应尽快修复）
 B1. markSessionAsPrivate vs trackSessionLevel 命名不直观 → 重命名或合并
 B2. pendingDetections 无 TTL 过期清理 → 利用 timestamp 做过期判断

 🟡 中优先级（建议在下个迭代处理）
 A1. getHigherLevel 与 types.ts maxLevel 功能重复 → 复用 maxLevel
 A2. 三处创建默认状态逻辑重复 → 提取 getOrCreateState 辅助
 B3. isSessionMarkedPrivate 语义与名字不匹配 → 改名或改逻辑
 B4. clearSessionState 不清理 DualSessionManager 内存 → 补充清理
 B5. 共享状态无并发保护 → 文档标注 + 引入轮次 ID

 🟢 低优先级（锦上添花）
 A3. recordDetection 滑动窗口可优化裁剪频率
 A4. getAllSessionStates 浅拷贝可改为深拷贝
 B6. markSessionAsPrivate 不自动记录检测历史
