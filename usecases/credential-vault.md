# 密码/Token 安全保险箱

你让 AI 助手帮你管理开发环境、部署服务、配置 API — 不可避免地会接触到密码、Token、SSH Key。这些凭据是绝对不能发给云端模型的，哪怕是 "帮我把这个 API Key 存到 1Password" 这种请求，消息本身就包含了 Key。

这个 use case 让 GuardClaw 把所有凭据操作完全限制在本地 Guard Agent 内，云端大模型只负责提供安全策略建议和最佳实践 — 它永远看不到你的任何一个密码。

## Pain Point

- AI 助手操作中经常需要接触凭据（配置数据库、部署、设置 CI/CD）
- "帮我把这个 Token 存起来" — 你发出的消息本身就包含了 Token
- 云端模型的对话历史可能被存储、可能用于训练
- 即使用 1Password/Vault 等工具，调用过程中的中间值（明文密码）仍会经过模型

## 工作原理

```
用户："帮我把新的 AWS Access Key 存到安全的地方"
         │
         ▼
[GuardClaw Rule Detector]
│ 检测到 "key"、"password"、"token" 关键词
│ + 匹配到 AKIA 模式 → S3
         │
         ▼
[S3 → 全程本地 Guard Agent]
│
│  ① 接收凭据明文（本地内存，不落盘到 clean session）
│  ② 调用本地 1Password CLI / pass / Vault 存储
│  ③ 生成凭据引用标识（不是凭据本身）
│  ④ 更新 MEMORY-FULL.md："AWS prod key 存储于 1Password vault 'DevOps'"
│  ⑤ 更新 MEMORY.md（脱敏版）："AWS prod 凭据已安全存储"
│
         ▼
如果用户追问 "这个 Key 的权限是不是太大了？"
         │
         ▼
[GuardClaw 判断]
│ "权限分析" → 通用安全知识 → S1
│ 不涉及凭据本身 → 可以上云
         │
         ▼
[S1 云端大模型]
│ "你的 AWS IAM 策略建议：遵循最小权限原则，
│  建议为不同服务创建独立的 IAM Role……"
```

### 模型分工

| 阶段 | 模型 | 敏感级别 | 说明 |
|------|------|----------|------|
| 凭据检测 | Rule Detector | S3 | 正则匹配 + 关键词触发 |
| 凭据存储/检索/轮换 | 本地 Guard Agent | S3 | 明文凭据只在本地内存中 |
| 密码强度检查 | 本地小模型 | S3 | 检查长度、复杂度（不发给云端） |
| 安全策略建议 | 云端大模型 | S1 | IAM 最佳实践、轮换策略等通用知识 |
| 泄露检测建议 | 云端大模型 | S1 | "如何检测 Key 是否已泄露" 的通用方法 |

## GuardClaw 配置

```json
{
  "privacy": {
    "enabled": true,
    "s2Policy": "local",
    "rules": {
      "keywords": {
        "S3": [
          "password", "passwd", "secret", "private_key", "ssh_key",
          "credentials", "api_key", "access_key", "secret_key",
          "密码", "令牌", "密钥", "口令"
        ]
      },
      "patterns": {
        "S3": [
          "sk-[a-zA-Z0-9]{20,}",
          "ghp_[a-zA-Z0-9]{36}",
          "AKIA[0-9A-Z]{16}",
          "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
          "xox[bsrap]-[a-zA-Z0-9-]+",
          "glpat-[a-zA-Z0-9_-]{20}",
          "npm_[a-zA-Z0-9]{36}"
        ]
      },
      "tools": {
        "S3": {
          "tools": ["read_file", "write_file"],
          "paths": [
            "**/.env", "**/.env.*", "**/secrets.*",
            "**/*credential*", "**/*password*",
            "**/.ssh/**", "**/.gnupg/**"
          ]
        }
      }
    },
    "localModel": {
      "enabled": true,
      "type": "openai-compatible",
      "provider": "ollama",
      "model": "qwen2.5:3b",
      "endpoint": "http://localhost:11434/v1"
    },
    "guardAgent": {
      "model": "ollama/qwen2.5:7b",
      "workspace": "~/.openclaw/guard-workspace"
    },
    "session": {
      "isolateGuardHistory": true
    }
  }
}
```

## Prompt 示例

### 存储新凭据

```text
我刚生成了新的 GitHub Personal Access Token，帮我存到安全的地方。
Token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
用途：CI/CD pipeline 用的，只需要 repo 和 packages 权限。
```

### 凭据轮换提醒

```text
帮我检查一下我所有存储的 API Key，哪些超过 90 天没轮换了？
列出来并按风险等级排序。
```

### 安全策略咨询（这个会走云端）

```text
我们团队有 12 个微服务，每个都需要访问数据库和消息队列。
推荐一个 Secret 管理方案？Vault vs AWS Secrets Manager vs 1Password 怎么选？
```

## 期待结果与效果预估

> **一句话**：凭据零云端暴露 — 所有密码/Token/Key 的存取操作完全在本地完成，云端模型只提供通用安全策略建议。

### 隐私保护效果

| 检测层 | 覆盖范围 | 预估拦截率 |
|--------|---------|-----------|
| 关键词触发 | "password"、"secret"、"密码"、"密钥" 等 20+ 关键词 | ≥ 98% 的显式凭据操作 |
| 正则模式 | `sk-`、`ghp_`、`AKIA`、`-----BEGIN`、`glpat-`、`npm_` | ≥ 95% 的标准格式 Token |
| 路径拦截 | `.env`、`.ssh/`、`.aws/`、`credentials` 等 | 100%（路径匹配是确定性的） |

**残余风险**：用户在纯文本对话中提到凭据但未触发关键词（如 "帮我记一下这个字符串 sk-abc..."），正则仍能匹配模式。真正的漏洞是无前缀的自定义凭据。

### 质量影响预估

| 维度 | 影响程度 | 说明 |
|------|---------|------|
| 凭据存储/检索 | **无影响** | 全程本地 Guard Agent 完成 |
| 凭据轮换提醒 | **无影响** | 本地检查 Last Modified |
| 安全策略建议 | **无损** | 云端回答 "IAM 最佳实践" 不需要看到具体 Key |
| 针对性的权限分析 | **略降（~15%）** | 云端不知道 Key 的具体 scope，建议偏泛化 |

### 成本对比

| 方案 | 凭据操作 | 安全咨询 | 总计 |
|------|---------|---------|------|
| 纯云端（无 GuardClaw） | ~$0.01/次（消息含 Key） | ~$0.05/次 | ~$0.06/次 |
| GuardClaw 混合 | ~$0.005/次（本地 LLM） | ~$0.05/次（不变） | ~$0.055/次 |

成本几乎无差异。核心收益是**安全性**，不是省钱。

### 延迟影响

- 凭据检测 + 路由决策：< 1s（关键词/正则为主）
- 本地 Guard Agent 存储操作：~1-3s
- **对用户体验无感知影响**

### 风险与局限

- `isolateGuardHistory` 配置错误可能导致凭据信息混入主 session
- Guard Agent 本地模型如果理解力不足，可能在存储到 1Password/Vault 时出错
- 如果用户将凭据写在普通对话中且未触发任何关键词/模式，则无法拦截（极端边缘情况）

## 关键洞察

- **S3 的 `isolateGuardHistory: true` 是关键**：凭据操作的对话历史不会混入主 session，云端模型永远看不到之前存过什么 Key
- **MEMORY-FULL.md 记录凭据元数据**（"AWS prod key 在 1Password DevOps vault，2026-03-01 创建"），但不记录凭据本身
- **MEMORY.md 只记录存在性**（"AWS prod 凭据已配置"），云端模型知道你有这个凭据但看不到内容
- **文件访问控制**：`.env`、`.ssh/` 等路径被标记为 S3，云端模型的 `read_file` 调用会被拦截
- **凭据轮换可以自动化**：本地 Agent 定期检查 1Password 的 Last Modified，过期的自动提醒

## 相关链接

- [1Password CLI](https://developer.1password.com/docs/cli/)
- [HashiCorp Vault](https://www.vaultproject.io/)
- [pass - the standard unix password manager](https://www.passwordstore.org/)
