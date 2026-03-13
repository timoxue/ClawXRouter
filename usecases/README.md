# Awesome EdgeClaw Use Cases

> 利用 GuardClaw 隐私路由 + Token-Saver 成本优化的真实场景集合。
>
> 核心理念：**不是所有任务都需要最强模型** — 敏感部分留在本地，简单部分走便宜模型，只有真正需要推理能力的才上云端大模型。

## 路由策略速查

```
S1 (Safe)      → 云端大模型（Claude、GPT-4 等）—— 全力推理
S2 (Sensitive) → 隐私代理脱敏后转发云端，或本地模型处理
S3 (Private)   → 纯本地模型（Ollama、vLLM 等）—— 数据不出本机
Token-Saver    → LLM-as-Judge 判断任务复杂度，简单任务走便宜模型
```

---

## Use Cases — 隐私路由驱动

数据敏感是核心矛盾：需要大模型的智能，但不能把数据发出去。

| Use Case | 描述 | 路由策略 |
|----------|------|----------|
| [代码安全审查](code-review-token-masking.md) | 自动检测并遮蔽硬编码 Token 后再送云端 Review | Rule 检测 → S3 本地确认 → S2 脱敏 → S1 审查 |
| [家庭群聊总结](family-chat-summary.md) | 对家庭群聊天记录去标识化后生成结构化摘要 | S3 本地解析+匿名化 → S1 云端总结 |
| [密码/Token 保险箱](credential-vault.md) | 凭据全程本地存取，云端仅提供安全策略建议 | S3 全隔离存取 + S1 通用安全咨询 |
| [隐私数据分析（财报/病历）](privacy-aware-data-analysis.md) | 本地 SQL 取数+脱敏，云端产出深度分析报告 | S3 本地取数脱敏 → S1 分析洞察 → S3 本地还原 |
| [简历/求职优化](resume-optimizer.md) | 本地剥离 PII，云端优化措辞和 ATS 关键词 | S3 本地匿名化 → S1 写作优化 → S3 本地还原 |

## Use Cases — Token-Saver 驱动

多步 Agent 流水线：60-80% 步骤是机械性的，小模型搞定体力活，大模型专注推理。

| Use Case | 描述 | 步骤分布 | 预估省钱 |
|----------|------|----------|----------|
| [科研辅助流水线](research-assistant-pipeline.md) | 小模型文献初筛+元信息提取，大模型 Research Gap 分析 | 11 步，5 SIMPLE | ~75% |
| [系统性文献综述](systematic-literature-review.md) | PRISMA 全流程：小模型筛选数千篇论文，大模型做偏倚评估和 GRADE 评定 | 14 步，6 SIMPLE | ~80% |
| [专利地图+技术空白识别](patent-landscape-analysis.md) | 小模型批量处理专利文本，大模型识别技术空白和设计规避方案 | 12 步，6 SIMPLE | ~85-88% |

## Use Cases — 混合型（隐私 + Token-Saver）

既有敏感数据，又有大量机械步骤 — 两种路由策略同时生效。

| Use Case | 描述 | 隐私策略 | Token-Saver 策略 | 预估省钱 |
|----------|------|----------|------------------|----------|
| [SOC 告警分析](soc-alert-analysis.md) | 小模型批量解析告警+脱敏内网信息，大模型做攻击链推理 | 内网 IP/主机名 S2 脱敏 | 告警解析/分类 SIMPLE | ~60-70% |
| [合规审计自动化](compliance-audit.md) | 小模型解析数百份文档，大模型做违规推理和风险评定 | 客户 PII/合同细节 S2/S3 | 文档解析/条款提取 SIMPLE | ~80-85% |

---

## 快速开始

1. 安装 GuardClaw 插件
2. 配置本地推理后端（推荐 Ollama + `qwen2.5:7b`）
3. 复制对应 use case 的配置到 `~/.openclaw/guardclaw.json`
4. 用给出的 Prompt 开始使用

### 推荐本地模型配置

| 用途 | 推荐模型 | 显存需求 |
|------|---------|---------|
| SIMPLE 任务 | `qwen2.5:3b` | ~4 GB |
| MEDIUM 任务 / Guard Agent | `qwen2.5:7b` | ~6 GB |
| 需要中文理解的脱敏 | `qwen2.5:14b` | ~12 GB |
| 公式 OCR | `qwen2.5-vl:7b` | ~8 GB |

---

## 贡献指南

- 每个 use case 一个 markdown 文件
- 需包含：Pain Point、工作原理（含步骤复杂度标注）、GuardClaw 配置、Prompt 示例、关键洞察
- 优先提交你实际测试过的场景
- 隐私驱动场景请说明 S1/S2/S3 级别判断依据
- Token-Saver 场景请标注每步复杂度（SIMPLE/MEDIUM/COMPLEX/REASONING）和省钱估算
