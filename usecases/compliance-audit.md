# 合规审计自动化

金融机构、医疗机构每季度做一次合规审计：数百份文档要逐一对照几十条监管要求。审计师花 70% 时间在 "把文档翻一遍、找到关键条款" 这种体力活上。但这些文档里遍布客户姓名、交易金额、合同细节 — 全是商业机密和个人信息。

Token-Saver 让小模型处理海量文档的解析和条款提取，大模型专注在灰色地带的合规推理和风险判断。隐私路由确保客户信息和商业秘密始终在本地。

## Pain Point

- 审计涉及数百份文档（合同、政策、邮件、交易记录、会议纪要）
- 90% 的工作是机械性的：分类、提取关键条款、对照 checklist
- 但文档中包含客户 PII、交易金额、内部决策过程等高度敏感信息
- 真正需要专业判断的是灰色地带："这个操作算不算违规？"
- 外部审计师访问原始文档本身就需要严格的数据控制

## 工作原理

```
步骤                              复杂度     模型          敏感级别   说明
──────────────────────────────────────────────────────────────────────────────
① 文档收集 + 格式统一             SIMPLE     小模型 💰     S2        PDF/Word/Excel → Markdown
   (数百份文档，Token 消耗最大)
② 文档分类                        SIMPLE     小模型 💰     S2        合同/政策/通信/记录
③ 关键条款提取                    SIMPLE     小模型 💰     S2        日期、金额、当事人、期限
④ 合规检查清单逐项匹配            MEDIUM     中等模型       S2        条款 vs 监管要求一一对照
⑤ 时间线重建                      MEDIUM     中等模型       S2        多文档事件排序
⑥ 脱敏 + 摘要生成                 MEDIUM     本地模型       S3→S1    去除 PII，保留业务逻辑
   ─────────────────────────── 以下脱敏后交给云端大模型 ───────────
⑦ 违规风险点识别                  COMPLEX    大模型 🧠     S1        灰色地带的合规推理
⑧ 跨文档矛盾检测                  COMPLEX    大模型 🧠     S1        A 文档说 X，B 文档说 Y
⑨ 风险等级评定 + 整改建议          REASONING  大模型 🧠     S1        权衡业务影响与合规成本
⑩ 审计报告生成                    MEDIUM     中等模型       S2        结构化模板 + 本地还原细节
```

### 成本估算

| 文档量 | 全量大模型 | Token-Saver | 节省 |
|--------|-----------|-------------|------|
| 100 份文档 | ~$80-150 | ~$15-30 | **~80%** |
| 500 份文档 | ~$400-700 | ~$60-120 | **~85%** |

步骤①③是 Token 消耗的绝对大头：大量文档的全文解析+条款提取。

## GuardClaw 配置

```json
{
  "privacy": {
    "enabled": true,
    "s2Policy": "proxy",
    "rules": {
      "keywords": {
        "S3": ["身份证", "社保", "银行卡", "密码", "SSN", "信用卡"],
        "S2": [
          "合同", "客户", "甲方", "乙方", "交易", "金额",
          "contract", "client", "transaction", "amount"
        ]
      },
      "patterns": {
        "S3": [
          "\\d{17}[0-9Xx]",
          "\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}"
        ],
        "S2": [
          "(?i)(contract|agreement)[-_]?\\w{6,}",
          "(?i)¥[\\d,]+\\.?\\d*|\\$[\\d,]+\\.?\\d*"
        ]
      },
      "tools": {
        "S3": {
          "paths": ["**/audit/**", "**/compliance/**", "**/contracts/**"]
        }
      }
    },
    "localModel": {
      "enabled": true,
      "type": "openai-compatible",
      "provider": "ollama",
      "model": "qwen2.5:7b",
      "endpoint": "http://localhost:11434/v1"
    }
  },
  "routers": {
    "token-saver": {
      "enabled": true,
      "type": "builtin",
      "weight": 30,
      "options": {
        "tiers": {
          "SIMPLE": { "provider": "ollama", "model": "qwen2.5:3b" },
          "MEDIUM": { "provider": "ollama", "model": "qwen2.5:14b" },
          "COMPLEX": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" },
          "REASONING": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" }
        }
      }
    },
    "privacy": {
      "enabled": true,
      "type": "builtin",
      "weight": 80
    }
  }
}
```

## Prompt 示例

### 季度合规审计

```text
帮我做 2025 Q4 的内部合规审计。

文档目录：~/audit/2025-Q4/
包含：
- contracts/ — 本季度新签和续签合同
- policies/ — 更新过的内部政策
- communications/ — 涉及合规讨论的邮件往来
- transactions/ — 大额交易记录
- minutes/ — 合规委员会会议纪要

监管要求 checklist：~/audit/regulatory-checklist-2025.md

工作流程：
1. 所有文档分类并提取关键条款
2. 逐一对照 checklist，标记 ✅ 通过 / ⚠️ 需关注 / ❌ 违规
3. 重建本季度关键事件时间线
4. 识别可能的违规点和灰色地带
5. 检测文档间的矛盾（比如政策写了 A，实际操作记录显示 B）
6. 按风险等级排序所有发现，生成整改建议
7. 输出正式审计报告
```

### 特定问题深挖

```text
审计发现合同 #2025-Q4-0037 的审批流程缺少合规部门签字，
但会议纪要显示合规部门口头同意了。

这种情况在监管层面算不算合规？我们需要补什么手续？
```

## 关键洞察

- **文档解析是最大成本项**：500 份文档 × 平均 5,000 Token/份 = 2.5M Token 的输入。步骤①单独就能占全流程 60%+ 的 Token
- **Privacy 权重高于 Token-Saver**：即使某步骤被 Token-Saver 判定为 SIMPLE 可上云，Privacy Router 仍会检查内容并拦截含 PII 的部分
- **灰色地带是大模型的核心价值**："口头同意但没签字算不算合规？" — 这种推理需要理解法规精神和商业实践的交叉，小模型做不到
- **矛盾检测跨越文档边界**：需要把 A 文档第 3 条和 B 文档第 7 段放在一起推理是否矛盾，这是 COMPLEX 任务
- **审计报告的最终还原**：云端产出的报告用脱敏占位符，本地 Agent 最终还原为包含真实合同号和金额的正式版本

## 相关链接

- [SOX 合规指南](https://www.sarbanes-oxley-101.com/)
- [PCI DSS](https://www.pcisecuritystandards.org/)
- [GuardClaw 技术报告](../guardclaw/docs/GuardClaw-技术报告.md)
