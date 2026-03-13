# 系统性文献综述 Agent

系统性文献综述（Systematic Review）是学术界最严谨也最耗时的文献工作：PRISMA 流程、几千篇候选论文、逐篇筛选、数据提取、偏倚评估、证据综合。一个博士生做一篇 SR 要 3-6 个月。这个流程有一个完美的特性：前半段是高吞吐量的机械筛选，后半段才需要深度方法学推理。

Token-Saver 让小模型处理 "大海捞针" 的筛选阶段（几千篇论文的标题/摘要过滤），大模型专注在偏倚评估、异质性解释和证据等级评定这些需要方法学专业知识的环节。

## Pain Point

- PRISMA 流程要求从数千篇候选论文中系统筛选，记录每一步的纳入/排除理由
- 标题/摘要筛选是最大瓶颈：2,000-10,000 篇论文逐一过一遍
- 数据提取（样本量、干预措施、结局指标、效应值）是重复性结构化工作
- 但偏倚评估（RoB 2.0、ROBINS-I）需要深度理解方法学
- GRADE 证据评定需要综合多个维度推理
- 全流程用大模型：Token 成本 $100-300，且多数浪费在筛选上

## 工作原理

```
PRISMA 流程                  步骤   复杂度      模型          Token 消耗
──────────────────────────────────────────────────────────────────────────
Identification
├─ ① 检索式设计               1     MEDIUM      中等模型       █
├─ ② 多数据库检索执行          2     SIMPLE      小模型 💰     █
├─ ③ 去重（DOI/标题匹配）      3     SIMPLE      小模型 💰     █
│
Screening
├─ ④ 标题+摘要筛选             4     SIMPLE      小模型 💰     ████████████
│   (2000-5000 篇 × ~300 tok)                                 (Token 黑洞)
├─ ⑤ 全文筛选                  5     MEDIUM      中等模型       ████
│
Included
├─ ⑥ 数据提取（结构化表格）    6     SIMPLE      小模型 💰     ████
├─ ⑦ 偏倚风险评估              7     COMPLEX     大模型 🧠     ██
│   (RoB 2.0 / ROBINS-I)
├─ ⑧ 效应量计算 + 森林图数据   8     MEDIUM      中等模型       ██
│
Synthesis
├─ ⑨ 异质性分析                9     COMPLEX     大模型 🧠     █
│   (I² 高怎么解释？)
├─ ⑩ 亚组分析 + 敏感性分析     10    COMPLEX     大模型 🧠     █
├─ ⑪ GRADE 证据等级评定        11    REASONING   大模型 🧠     █
│
Reporting
├─ ⑫ PRISMA 流程图生成         12    SIMPLE      小模型 💰     █
├─ ⑬ 综述正文撰写              13    REASONING   大模型 🧠     ██
└─ ⑭ 参考文献格式化            14    SIMPLE      小模型 💰     █
```

### Token 消耗对比

| 阶段 | 论文数 | 全量 Claude Opus | Token-Saver | 节省 |
|------|--------|-----------------|-------------|------|
| 标题+摘要筛选 | 3,000 篇 | ~$45-90 | ~$1.5-4.5 | **~95%** |
| 数据提取 | 50 篇 | ~$15-30 | ~$0.5-1.5 | **~95%** |
| 偏倚+综合+写作 | — | ~$10-20 | ~$10-20 | 0%（必须大模型） |
| **全流程** | — | **$70-140** | **$12-26** | **~80%** |

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
          "ttlSeconds": 7200
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

### 启动系统性综述

```text
帮我做一个系统性文献综述，主题：
"机器学习方法在早期阿尔茨海默病诊断中的应用"

按 PRISMA 2020 流程执行：

1. Identification：
   - 在 PubMed、Scopus、Web of Science 检索
   - 时间范围 2020-2026
   - 关键词：(Alzheimer* OR AD) AND (machine learning OR deep learning OR CNN OR transformer) AND (early diagnosis OR early detection OR MCI)

2. Screening：
   - 纳入标准：使用神经影像数据（MRI/PET）+ ML 方法 + 报告了诊断准确率
   - 排除标准：纯综述、会议摘要、非英文、样本量 < 50

3. Data Extraction：
   - 每篇提取：作者、年份、数据集、样本量、方法、影像模态、准确率/AUC/灵敏度/特异度

4. Quality Assessment：
   - 使用 QUADAS-2 工具评估诊断研究偏倚

5. Synthesis：
   - 按方法分组：传统 ML vs CNN vs Transformer
   - 按影像模态分组：结构 MRI vs 功能 MRI vs PET
   - 识别性能最佳的方法组合
   - GRADE 评定证据强度
```

### 筛选质量抽检

```text
小模型已经完成了 3,200 篇论文的标题+摘要筛选。
请对筛选结果做 10% 抽检（随机抽 320 篇），评估纳入/排除判断的准确率。
如果准确率 < 90%，分析错误模式并调整筛选标准。
```

### 偏倚评估深入讨论

```text
论文 #23 (Chen et al. 2024) 的 QUADAS-2 评估中：
- Patient Selection 域存疑：文章说 "consecutive patients" 但没报告排除人数
- Index Test 域存疑：阈值似乎是在训练集上选的
- Flow and Timing：MRI 和临床诊断间隔未报告

这篇论文的整体偏倚风险应该判定为什么级别？
对纳入 meta-analysis 有什么影响？
```

## 关键洞察

- **步骤④是 Token 省钱的核心战场**：3,000 篇 × 300 Token ≈ 900K Token 输入，每篇只需输出 "Include/Exclude + 一句理由"。小模型的二分类能力完全够用
- **Quality Gate 机制**：让大模型抽检 10% 的小模型筛选结果。如果准确率 > 90%，信任小模型结果；如果 < 90%，要么调整 Prompt 要么改用中等模型
- **数据提取是结构化任务**：输出固定 schema 的 JSON（作者、样本量、方法、指标），小模型在这种 "填表" 任务上和大模型差距不大
- **偏倚评估需要方法学知识**：RoB 2.0 的 "是否使用了恰当的随机化方法" 需要理解统计学原理和研究设计，这是大模型的领域
- **GRADE 是最高级别推理**：需要综合风险偏倚、不一致性、间接性、不精确性、发表偏倚五个维度评定证据等级，并给出升级/降级理由
- **缓存利用率高**：同一批论文的筛选 Prompt 结构高度相似，cache 命中率可达 30-50%

## 相关链接

- [PRISMA 2020 声明](http://www.prisma-statement.org/)
- [Cochrane Handbook for Systematic Reviews](https://training.cochrane.org/handbook)
- [RoB 2.0 工具](https://www.riskofbias.info/welcome/rob-2-0-tool)
- [GRADE 工作组](https://www.gradeworkinggroup.org/)
- [Semantic Scholar API](https://api.semanticscholar.org/)
- [PubMed API (E-utilities)](https://www.ncbi.nlm.nih.gov/books/NBK25501/)
