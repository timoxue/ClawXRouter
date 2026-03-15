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

| Use Case | 描述 | 路由策略 | 期待结果 |
|----------|------|----------|---------|
| [代码安全审查](code-review-token-masking.md) | 自动检测并遮蔽硬编码 Token 后再送云端 Review | Rule → S3 确认 → S2 脱敏 → S1 审查 | 凭据零泄露，审查质量不降 |
| [家庭群聊总结](family-chat-summary.md) | 对家庭群聊天记录去标识化后生成结构化摘要 | S3 解析+匿名化 → S1 总结 | PII 留本地，摘要质量损失 ≤10% |
| [密码/Token 保险箱](credential-vault.md) | 凭据全程本地存取，云端仅提供安全策略建议 | S3 全隔离 + S1 安全咨询 | 凭据零云端暴露 |
| [隐私数据分析（财报/病历）](privacy-aware-data-analysis.md) | 本地 SQL 取数+脱敏，云端产出深度分析报告 | S3 脱敏 → S1 分析 → S3 还原 | 数据零泄露，分析质量损失 ≤15% |
| [简历/求职优化](resume-optimizer.md) | 本地剥离 PII，云端优化措辞和 ATS 关键词 | S3 匿名化 → S1 优化 → S3 还原 | PII 零泄露，写作优化质量不降 |

## Use Cases — Token-Saver 驱动

多步 Agent 流水线：60-80% 步骤是机械性的，小模型搞定体力活，大模型专注推理。

| Use Case | 描述 | 步骤分布 | 预估省钱 | 期待结果 |
|----------|------|----------|----------|---------|
| [科研辅助流水线](research-assistant-pipeline.md) | 小模型文献初筛+元信息提取，大模型 Research Gap 分析 | 11 步，5 SIMPLE | ~75% | 初筛准确率 ≥90%，推理质量无损 |
| [系统性文献综述](systematic-literature-review.md) | PRISMA 全流程：小模型筛选数千篇论文，大模型做偏倚评估和 GRADE 评定 | 14 步，6 SIMPLE | ~80% | 筛选召回率 ≥90%，方法学无损 |
| [专利地图+技术空白识别](patent-landscape-analysis.md) | 小模型批量处理专利文本，大模型识别技术空白和设计规避方案 | 12 步，6 SIMPLE | ~85-88% | 元信息提取 ≥98%，战略分析无损 |

## Use Cases — 混合型（隐私 + Token-Saver）

既有敏感数据，又有大量机械步骤 — 两种路由策略同时生效。

| Use Case | 描述 | 隐私策略 | Token-Saver 策略 | 预估省钱 | 期待结果 |
|----------|------|----------|------------------|----------|---------|
| [SOC 告警分析](soc-alert-analysis.md) | 小模型批量解析告警+脱敏内网信息，大模型做攻击链推理 | 内网 IP/主机名 S2 脱敏 | 告警解析/分类 SIMPLE | ~60-70% | 内网零泄露，攻击链推理无损 |
| [合规审计自动化](compliance-audit.md) | 小模型解析数百份文档，大模型做违规推理和风险评定 | 客户 PII/合同细节 S2/S3 | 文档解析/条款提取 SIMPLE | ~80-85% | PII 零泄露，合规推理无损 |

---

## 实测验证汇总（2026-03-15，v2 — 含 Token-Saver 模型路由验证）

> **测试环境**：OpenClaw Gateway + GuardClaw 插件，隐私检测 + Judge 均为 `gemini-2.5-flash`（via yeysai.com）
>
> **Token-Saver tiers**：SIMPLE → `gemini-2.5-flash` | MEDIUM → `gemini-2.5-pro` | COMPLEX → `gemini-3.1-pro-preview` | REASONING → `claude-sonnet-4-5-20250929`
>
> **关键修复**：本轮测试修复了 Pipeline 合并逻辑（Privacy S1 passthrough 不再覆盖 Token-Saver redirect），确保 Token-Saver 路由**实际生效**。

### 隐私路由测试

| 测试场景 | 输入敏感信息 | 检测结果 | 最终路由 | 实际模型 | 耗时 | 状态 |
|---------|------------|---------|---------|---------|------|------|
| 代码安全审查 | AKIA Key、sk-live Key、ghp_ Token、明文密码、Slack Token | S3（Rule + LLM 双重确认） | Guard agent | `gemini-2.5-flash` | 11.0s | ✅ |
| 家庭群聊总结 | 银行卡号、身份证号、手机号、医疗信息、API 密钥 | S3（LLM 识别全部 5 类 PII） | Guard agent | `gemini-2.5-flash` | 6.8s | ✅ |
| SOC 告警分析 | 内网 IP（10.1.x.x）、主机名（DC-SRV-01） | S2（正则精确匹配内网段） | Privacy proxy | `guardclaw-privacy` | 32.6s | ✅ |
| 无隐私问题 | "HTTP 403 与 401 的区别" | S1 passthrough | Token-Saver 接管 | `gemini-2.5-flash`(SIMPLE) | 6.8s | ✅ |

### Token-Saver 分级测试（Gateway 日志验证）

> 以下每行均有 Gateway 日志 `model overridden to <model>` 实证。

| 输入 | Judge 判定 | 路由模型 | `model overridden` 日志 | 耗时 | 响应字数 | 状态 |
|------|-----------|---------|------------------------|------|---------|------|
| "JSON 和 YAML 的区别？" | **SIMPLE** | `gemini-2.5-flash` | `model overridden to gemini-2.5-flash` | 6.4s | 122 | ✅ |
| "分析这段函数的 bug" | **MEDIUM** | `gemini-2.5-pro` | `model overridden to gemini-2.5-pro` | 19.7s | 1,252 | ✅ |
| "设计百万并发消息推送架构" | **COMPLEX** | `gemini-3.1-pro-preview` | `model overridden to gemini-3.1-pro-preview` | 72.2s | 4,213 | ✅ |
| "证明梅森素数 n 必须为素数" | **REASONING** | `claude-sonnet-4-5-20250929` | `model overridden to claude-sonnet-4-5-20250929` | 11.7s | 1,132 | ✅ |

### 混合场景测试（Privacy vs Token-Saver 优先级）

| 输入 | Privacy 判定 | Token-Saver 判定 | 最终决策 | 解释 |
|------|-------------|-----------------|---------|------|
| "我的身份证号 310101...，哪个省？" | **S2**（身份证号 PII） | SIMPLE | **S2 Privacy 胜** | PII 存在时隐私优先 |
| "对比 Transformer/Mamba/RWKV 复杂度" | S1（无 PII） | **REASONING** | **Token-Saver 胜** → `claude-sonnet-4-5-20250929` | 无 PII 时 Token-Saver 路由生效 |

### 关键发现与迭代

1. **Pipeline 合并逻辑 Bug（本轮修复）**：Privacy 的 S1 passthrough（权重 90）按旧逻辑会覆盖 Token-Saver 的 S1 redirect（权重 50），导致 Token-Saver 路由形同虚设。修复后，**S1 passthrough 被视为"无意见"**，Token-Saver 的 redirect 得以生效
2. **Judge maxTokens 不足（上轮修复）**：原始 `maxTokens: 20` 导致 Gemini 2.5 Flash 的思考模式消耗完 token 预算，输出被截断。修复为 `maxTokens: 1024`
3. **模型名称不匹配**：yeysai.com 上的模型 ID 为 `gemini-3.1-pro-preview`（非 `gemini-3-pro`）和 `claude-sonnet-4-5-20250929`（非 `claude-sonnet-4-5-20250514`）。已更正
4. **配置双源问题（上轮修复）**：`openclaw.json` 和 `guardclaw.json` 的 tiers 配置不一致，已同步修正

### 成本差异验证（基于 yeysai.com 实际定价）

| Tier | 模型 | 参考价格 (input/M) | 与 SIMPLE 的倍数 | 本轮实测响应 |
|------|------|-------------------|-----------------|-------------|
| SIMPLE | `gemini-2.5-flash` | ~$0.15 | 1x | 122 字 / 6.4s |
| MEDIUM | `gemini-2.5-pro` | ~$1.25 | ~8x | 1,252 字 / 19.7s |
| COMPLEX | `gemini-3.1-pro-preview` | ~$2.50 | ~17x | 4,213 字 / 72.2s |
| REASONING | `claude-sonnet-4-5-20250929` | ~$3.00 | ~20x | 1,132 字 / 11.7s |

SIMPLE 与 REASONING 成本差异 **~20 倍**，Token-Saver 的省钱效果由 Gateway 日志中的 `model overridden` 完整验证。

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
- 需包含：Pain Point、工作原理（含步骤复杂度标注）、GuardClaw 配置、Prompt 示例、**期待结果与效果预估**、关键洞察
- 优先提交你实际测试过的场景
- 隐私驱动场景请说明 S1/S2/S3 级别判断依据
- Token-Saver 场景请标注每步复杂度（SIMPLE/MEDIUM/COMPLEX/REASONING）和省钱估算
