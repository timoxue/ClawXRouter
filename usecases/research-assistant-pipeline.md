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
