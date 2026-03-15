# 科研辅助流水线

做科研最烦的事：花两周读 200 篇论文初筛出 30 篇相关的，花三天手动提取表格数据，花半天把截图里的公式敲成 LaTeX — 然后才能开始真正需要思考的工作：识别 Research Gap 和设计实验。

前面那些机械性工作消耗了 80% 的时间和 Token，但只需要 20% 的智能。Token-Saver 让小模型搞定体力活，大模型专注在需要创造性推理的环节。

## Pain Point

- 文献检索结果动辄几百篇，初筛是纯体力活但 Token 消耗巨大
- 论文元信息提取（作者、方法、数据集、指标）是结构化任务，不需要深度推理
- 公式 OCR → LaTeX 转写是模式匹配任务
- 但 Research Gap 识别、实验设计需要跨论文的深度推理 — 这才是大模型的价值所在
- 全流程用 Claude Opus 跑一遍，Token 费用可达 $50-100+

## 工作原理

```
步骤                              复杂度       模型              Token 消耗
──────────────────────────────────────────────────────────────────────────────
① 关键词/布尔检索式生成           MEDIUM       中等模型           低
② 数据库 API 检索执行             SIMPLE       小模型 💰          低
③ 标题+摘要初筛（纳入/排除）      SIMPLE       小模型 💰          ████████ 极高
④ 论文元信息提取                  SIMPLE       小模型 💰          ████ 高
   (作者/年份/方法/数据集/指标)
⑤ 公式截图 → LaTeX 转写          SIMPLE       小模型 💰          ██ 中
⑥ 论文方法论摘要                  MEDIUM       中等模型           ███ 中
⑦ 文献综合：现有方法分类图谱       COMPLEX      大模型 🧠          ██ 中
⑧ Research Gap 识别               REASONING    大模型 🧠          █ 低
   "三个主要方向各自的局限性？
    有没有交叉的空白地带？"
⑨ 研究问题提炼                    REASONING    大模型 🧠          █ 低
⑩ 实验方案设计                    REASONING    大模型 🧠          █ 低
   "验证 X 假设，对照实验怎么设计？
    样本量怎么定？"
⑪ 参考文献格式化                  SIMPLE       小模型 💰          ██ 中
```

**核心省钱点**：步骤③ 处理 200-500 篇论文的标题+摘要，每篇约 300 Token 输入，总计 60K-150K Token。小模型 vs 大模型可差 10-30 倍价格。

### Token 消耗估算

| 方案 | 步骤③ 成本 | 全流程成本 | 省钱比例 |
|------|-----------|-----------|---------|
| 全部 Claude Opus | ~$15-30 | ~$50-80 | — |
| Token-Saver 分级 | ~$0.5-1.5 | ~$10-20 | **~75%** |

## GuardClaw 配置

```json
{
  "routers": {
    "token-saver": {
      "enabled": true,
      "type": "builtin",
      "weight": 30,
      "options": {
        "tiers": {
          "SIMPLE": { "provider": "ollama", "model": "qwen2.5:7b" },
          "MEDIUM": { "provider": "ollama", "model": "qwen2.5:14b" },
          "COMPLEX": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" },
          "REASONING": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" }
        },
        "cache": {
          "enabled": true,
          "ttlSeconds": 3600
        }
      }
    }
  },
  "pipeline": {
    "onUserMessage": ["token-saver"]
  }
}
```

## Prompt 示例

### 完整科研辅助流程

```text
我在研究 "基于 Transformer 的时间序列预测方法"。帮我做一个完整的文献调研。

第一阶段 — 文献收集与筛选：
1. 在 Semantic Scholar / arXiv 上检索 2022-2026 年的相关论文
2. 初筛标准：
   - 纳入：提出新架构 or 在标准数据集上有实验对比
   - 排除：纯应用类（只用现成模型做某个领域预测）
3. 每篇提取：标题、作者、年份、方法名称、使用的数据集、关键指标（MSE/MAE）

第二阶段 — 深度分析：
4. 按技术路线分类：
   - Channel-Independent vs Channel-Dependent
   - Patching 策略
   - Frequency Domain 方法
5. 识别 Research Gap：
   - 这三个方向各自的局限性是什么？
   - 有没有交叉的空白地带？
   - 哪些理论基础还不够扎实？

第三阶段 — 实验设计：
6. 我想验证 "结合频域分解和 Patching 可以提升长序列预测" 这个假设。
   帮我设计：
   - 对照实验方案
   - 基线模型选择
   - 数据集选择
   - 评估指标
   - 建议的样本量/训练配置
```

### 公式提取

```text
帮我把这篇论文（附件 PDF）中所有的数学公式提取成 LaTeX 格式。
按出现顺序编号，注明在论文哪一节。
```

### Research Gap 深入探讨

```text
基于我们之前的文献调研结果，我发现大多数方法都在 ETTh1/ETTm1 上评测。

1. 这些数据集有什么局限性？
2. 有没有更能体现方法差异的 challenging benchmark？
3. 如果我提出一个新的评测协议，应该包含哪些维度？
```

## 期待结果与效果预估

> **一句话**：省约 75% Token 费用，前端筛选/提取准确率仍达 90%+，后端推理质量无损。

### 成本对比（基于 200 篇论文的完整调研）

| 步骤 | 全量大模型 | Token-Saver 分级 | 节省 |
|------|-----------|-----------------|------|
| ③ 标题+摘要初筛（200 篇） | ~$15-30 | ~$0.5-1.5（SIMPLE） | **~95%** |
| ④ 元信息提取 | ~$5-10 | ~$0.2-0.5（SIMPLE） | **~95%** |
| ⑤ 公式 OCR | ~$3-5 | ~$0.3-0.8（SIMPLE） | **~85%** |
| ⑧⑨⑩ 推理型步骤 | ~$10-20 | ~$10-20（REASONING，不变） | 0% |
| **全流程** | **~$50-80** | **~$12-25** | **~70-75%** |

### 质量影响预估

| 步骤 | SIMPLE 模型准确率 | vs 大模型 | Quality Gate |
|------|-----------------|---------|--------------|
| 标题+摘要初筛 | 88-93% | 大模型 95%+ | 10% 抽检，< 90% 则调整 Prompt 重跑 |
| 元信息提取（JSON） | ≥ 97% | 大模型 99% | 格式校验 + 字段完整性检查 |
| 公式 OCR → LaTeX | ~90-95% | 大模型 97%+ | LaTeX 编译校验 |
| Research Gap 识别 | — | **仍用大模型** | 质量无损 |
| 实验设计 | — | **仍用大模型** | 质量无损 |

**关键指标**：初筛的 Recall（召回率）比 Precision 更重要 — 宁可多纳入几篇不相关的，也不能漏掉真正相关的论文。SIMPLE 模型的 Recall 预估 ≥ 92%。

### 吞吐量对比

| 模型 | 200 篇初筛耗时 | 元信息提取耗时 |
|------|--------------|-------------|
| SIMPLE（gemini-2.5-flash） | ~2-5 分钟 | ~3-8 分钟 |
| 全量大模型（claude-sonnet-4.5） | ~5-15 分钟 | ~8-20 分钟 |

SIMPLE 模型不仅便宜，吞吐量也更高。

### 风险与局限

- 初筛误排除（false negative）：Quality Gate 抽检 10% 可发现系统性遗漏
- 元信息提取的特殊格式（如多作者、复合方法名）可能被小模型截断
- 公式 OCR 的复杂嵌套公式（如多行对齐的方程组）可能出错
- **降级策略**：如果 Quality Gate 失败率 > 10%，该步骤自动升级到 MEDIUM 模型

## 实测验证（2026-03-15 v2 — Pipeline 修复后，Token-Saver 路由已验证生效）

> 测试环境：OpenClaw Gateway + GuardClaw 插件，Judge 模型 `gemini-2.5-flash`（via yeysai.com）
>
> Token-Saver tiers: SIMPLE → `gemini-2.5-flash` | MEDIUM → `gemini-2.5-pro` | COMPLEX → `gemini-3.1-pro-preview` | REASONING → `claude-sonnet-4-5-20250929`
>
> **关键修复**：本轮修复了 Pipeline 合并逻辑，确保 Token-Saver 的 `redirect` 在 Privacy S1 passthrough 时实际生效（有 `model overridden` 日志实证）。

### Token-Saver 分级测试（Gateway 日志验证）

**测试 1：REASONING 级别 — 数学证明（模拟多论文综合推理）**

输入：`请严格证明以下命题：对于任意正整数 n，如果 2^n - 1 是素数（梅森素数），则 n 本身必须是素数。`

Gateway 日志：
```
[GuardClaw] [TokenSaver] tier=REASONING → redirect to yeysai-gemini/claude-sonnet-4-5-20250929
[GuardClaw] [onUserMessage] ▶ Final: S1 redirect → yeysai-gemini/claude-sonnet-4-5-20250929 (tier=REASONING)
[agent/embedded] [hooks] model overridden to claude-sonnet-4-5-20250929
```

| 指标 | 结果 |
|------|------|
| Judge 判定 | **REASONING** ✅ |
| 路由到 | `claude-sonnet-4-5-20250929` |
| `model overridden` | ✅ **已确认** |
| 耗时 | 11.7s |
| 响应长度 | 1,132 字 |
| 响应质量 | 完整的反证法证明 + LaTeX 公式 + 逆命题讨论 |

**测试 2：SIMPLE 级别 — 概念解释**

输入：`JSON 和 YAML 的区别是什么？用一段话说明。`

Gateway 日志：
```
[GuardClaw] [TokenSaver] tier=SIMPLE → redirect to yeysai-gemini/gemini-2.5-flash
[GuardClaw] [onUserMessage] ▶ Final: S1 redirect → yeysai-gemini/gemini-2.5-flash (tier=SIMPLE)
[agent/embedded] [hooks] model overridden to gemini-2.5-flash
```

| 指标 | 结果 |
|------|------|
| Judge 判定 | **SIMPLE** ✅ |
| 路由到 | `gemini-2.5-flash` |
| `model overridden` | ✅ **已确认** |
| 耗时 | 6.4s |
| 响应长度 | 122 字 |
| 响应质量 | 精炼一段话概括两者核心差异 |

### 成本对比验证

| 步骤类型 | 模型 | 参考价格 | 实际路由 |
|---------|------|---------|---------|
| 初筛/提取（SIMPLE） | gemini-2.5-flash | ~$0.15/M input | ✅ `model overridden to gemini-2.5-flash` |
| Research Gap（REASONING） | claude-sonnet-4-5-20250929 | ~$3/M input | ✅ `model overridden to claude-sonnet-4-5-20250929` |
| **SIMPLE vs REASONING 成本比** | | **~1:20** | 符合预估 |

### 四级分类完整验证（Gateway `model overridden` 日志实证）

| 输入 | Judge 判定 | 路由模型 | `model overridden` 日志 | 耗时 | 响应字数 |
|------|-----------|---------|------------------------|------|---------|
| "JSON 和 YAML 的区别？" | **SIMPLE** | `gemini-2.5-flash` | ✅ 已确认 | 6.4s | 122 |
| "分析这段函数的 bug" | **MEDIUM** | `gemini-2.5-pro` | ✅ 已确认 | 19.7s | 1,252 |
| "设计百万并发消息推送架构" | **COMPLEX** | `gemini-3.1-pro-preview` | ✅ 已确认 | 72.2s | 4,213 |
| "证明梅森素数 n 必须为素数" | **REASONING** | `claude-sonnet-4-5-20250929` | ✅ 已确认 | 11.7s | 1,132 |

### 验证结论

- ✅ "什么是 X" 类简单问题正确判定为 SIMPLE → 便宜模型（**有日志实证**）
- ✅ "严格数学证明" 正确判定为 REASONING → 最强模型（**有日志实证**）
- ✅ 四个 tier 全部由 Gateway `model overridden` 日志确认**实际生效**
- ✅ 响应质量：SIMPLE 精炼简洁（122 字），REASONING 有深度（LaTeX 证明）
- ✅ 成本差异 ~20 倍，与文档预估的 ~75% 节省一致

## 关键洞察

- **步骤③是 Token 黑洞**：200 篇论文 × 300 Token/篇 = 60K Token 的输入，但只需要输出 "纳入/排除" 一个词。用小模型做这种 "大输入小输出" 任务性价比极高
- **Quality Gate**：可以让大模型对小模型初筛的结果做 10% 抽检，如果准确率 < 90% 则调整阈值重跑
- **元信息提取是结构化任务**：输出 JSON 格式的作者/方法/指标，小模型完全够用
- **LaTeX 转写**：视觉类小模型（如 Qwen-VL）就能很好地完成公式 OCR → LaTeX
- **大模型的价值在后半段**：Research Gap 和实验设计需要"跨论文推理" — 综合理解 30+ 篇论文的优劣势并发现没人做过的方向，这是小模型做不到的
- **缓存策略**：同一个检索式的初筛结果可以缓存（TTL 1h），避免重复判断

## 相关链接

- [Semantic Scholar API](https://api.semanticscholar.org/)
- [arXiv API](https://arxiv.org/help/api)
- [Qwen2.5-VL (公式 OCR)](https://github.com/QwenLM/Qwen2.5-VL)
- [GuardClaw Token-Saver 文档](../guardclaw/docs/GuardClaw-技术报告.md)
