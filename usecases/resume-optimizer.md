# 简历/求职信优化

每个人都写过简历，每份简历都包含你的全套 PII — 真名、手机号、邮箱、家庭住址、教育经历、工作单位。让 AI 帮你优化简历措辞和排版？你等于把完整的个人档案发给了云端。

GuardClaw 在本地剥离个人信息，只让云端大模型看到匿名化的工作内容描述，优化后再在本地还原。云端只知道 "某个人在某家公司做了 X 事情取得了 Y 结果"。

## Pain Point

- 简历包含最密集的 PII：姓名 + 电话 + 邮箱 + 地址 + 教育 + 雇主 + 薪资
- 简历优化需要大模型的写作能力（措辞、量化成果、ATS 关键词优化）
- 但优化措辞完全不需要知道你叫什么、住哪里、在哪家公司
- 云端服务无法保证你的简历不被存储或用于训练

## 工作原理

```
原始简历
│  张三 | 138xxxx1234 | zhangsan@email.com
│  北京市朝阳区xxx小区
│  ABC科技有限公司 — 高级工程师
│  负责公司核心交易系统重构...
         │
         ▼
[S3 本地 Guard Agent]
│  ① PII 提取并映射：
│     张三 → [CANDIDATE]
│     138xxxx1234 → [PHONE]
│     zhangsan@email.com → [EMAIL]
│     北京市朝阳区xxx小区 → [ADDRESS]
│     ABC科技有限公司 → [COMPANY-1]
│  ② 保留工作内容描述（这是需要优化的部分）
│  ③ 输出匿名简历
         │
         ▼ 匿名简历
[S1 云端大模型]
│  ④ 措辞优化：
│     "负责系统重构" → "主导核心交易系统架构升级，
│      处理日均 500 万笔交易，系统延迟降低 40%"
│  ⑤ ATS 关键词注入（根据目标 JD）
│  ⑥ 格式和结构建议
│  ⑦ Cover Letter 生成
         │
         ▼ 优化后的匿名简历
[S3 本地 Guard Agent]
│  ⑧ 占位符还原：[COMPANY-1] → ABC科技有限公司
│  ⑨ 保存完整简历到本地
```

### 模型分工

| 阶段 | 模型 | 敏感级别 | 说明 |
|------|------|----------|------|
| PII 提取 + 匿名化 | 本地小模型 | S3 | NER + 映射表 |
| 工作内容优化 | 云端大模型 | S1 | 只看匿名化的成果描述 |
| ATS 关键词优化 | 云端大模型 | S1 | 根据目标 JD 对齐 |
| Cover Letter | 云端大模型 | S1 | 匿名的经历 + 目标公司 |
| 占位符还原 | 本地小模型 | S3 | 映射表反向替换 |

## GuardClaw 配置

```json
{
  "privacy": {
    "enabled": true,
    "s2Policy": "local",
    "rules": {
      "keywords": {
        "S3": ["简历", "resume", "CV", "求职", "应聘"],
        "S2": ["工作经历", "教育背景", "项目经验"]
      },
      "patterns": {
        "S3": [
          "1[3-9]\\d{9}",
          "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
          "\\d{17}[0-9Xx]"
        ]
      },
      "tools": {
        "S3": {
          "paths": ["**/resume/**", "**/cv/**", "**/*简历*"]
        }
      }
    },
    "localModel": {
      "enabled": true,
      "type": "openai-compatible",
      "provider": "ollama",
      "model": "qwen2.5:7b",
      "endpoint": "http://localhost:11434/v1"
    },
    "guardAgent": {
      "model": "ollama/qwen2.5:7b",
      "workspace": "~/.openclaw/guard-workspace"
    }
  }
}
```

## Prompt 示例

### 简历优化

```text
帮我优化简历，目标岗位是字节跳动的高级后端工程师。

我的简历在 ~/Documents/resume/张三-简历-2026.pdf
目标 JD 在 ~/Documents/resume/bytedance-jd.txt

要求：
1. 用 STAR 法则优化每段工作经历的描述
2. 量化所有成果（加入数字）
3. 根据 JD 优化关键词（ATS 友好）
4. 提出简历结构的改进建议
5. 帮我写一封配套的 Cover Letter
```

### 针对性修改

```text
面试官反馈说我的简历 "看不出技术深度"。
帮我把第二段工作经历的技术细节展开，突出架构设计能力。
```

## 关键洞察

- **匿名化不影响优化质量**：云端模型需要优化的是 "做了什么、怎么做的、结果如何"，不需要知道你叫什么名字在哪家公司
- **Cover Letter 的特殊处理**：目标公司名可以发给云端（这是公开信息），但你的个人信息仍然匿名
- **多版本管理**：不同目标岗位的简历可以在本地维护多个版本，云端模型帮优化每个版本的措辞侧重点
- **JD 匹配度评分**：云端模型可以给匿名简历 vs JD 打一个匹配度分数，作为迭代优化的指标
- **Dual-Track Memory**：`MEMORY-FULL.md` 记录 "张三在 ABC 公司主导了交易系统重构"，`MEMORY.md` 只记录 "[CANDIDATE] 有分布式系统架构经验"

## 相关链接

- [ATS 关键词优化指南](https://www.jobscan.co/)
- [STAR 法则](https://en.wikipedia.org/wiki/Situation,_task,_action,_result)
