# 代码安全审查：自动 Token Masking + Cloud Review

你让 AI 帮你 review 代码，但代码里散落着硬编码的 API Key、数据库密码、JWT Secret。直接发给云端模型？相当于把钥匙交给了陌生人。手动脱敏？文件太多根本不现实。

这个 use case 用 GuardClaw 在 review 前自动检测并遮蔽敏感 Token，脱敏后的代码发给云端大模型做深度审查，敏感信息始终不离开本机。

## Pain Point

- 代码中硬编码的 API Key、数据库连接串、OAuth Secret 是最常见的安全事故源头
- 云端 Code Review（不论人工还是 AI）都意味着这些凭据被发送到外部服务
- 手动搜索替换不靠谱：格式多样（环境变量赋值、JSON 配置、字符串拼接），容易遗漏
- 现有的 Secret Scanning 工具（TruffleHog 等）只能报告，不能在 Review 流程中自动脱敏

## 工作原理

```
代码文件 ─→ [GuardClaw Rule Detector] ─→ 检测到 Token/Key 模式
                                              │
                      ┌───────────────────────┘
                      ▼
             [Local Model Detector] ─→ 确认 + 提取具体位置
                      │
                      ▼
           [Privacy Proxy 脱敏] ─→ sk-abc123... → [REDACTED-API-KEY-1]
                      │
                      ▼
            [Cloud 大模型 Review] ─→ 代码逻辑/架构/最佳实践审查
                      │
                      ▼
              合并结果 ─→ 安全审查报告 + 代码质量报告
```

### 模型分工

| 阶段 | 模型 | 敏感级别 | 说明 |
|------|------|----------|------|
| Token 模式匹配 | Rule Detector（无需模型） | — | 正则匹配 `sk-`、`ghp_`、`AKIA`、`-----BEGIN` 等模式 |
| 上下文确认 + 提取 | 本地小模型（Qwen2.5 3B） | S3 | 判断上下文是否真正是凭据（排除误报），定位精确位置 |
| 脱敏替换 | Privacy Proxy | S2 | 用占位符替换，保持代码结构完整 |
| 代码质量审查 | 云端大模型（Claude/GPT-4） | S1 | 逻辑错误、架构设计、性能、可读性 |

## GuardClaw 配置

```json
{
  "privacy": {
    "enabled": true,
    "s2Policy": "proxy",
    "rules": {
      "keywords": {
        "S3": ["password", "secret", "private_key", "credentials"],
        "S2": ["api_key", "token", "auth"]
      },
      "patterns": {
        "S3": [
          "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
          "(?i)(password|passwd|pwd)\\s*[=:]\\s*['\"][^'\"]{8,}"
        ],
        "S2": [
          "sk-[a-zA-Z0-9]{20,}",
          "ghp_[a-zA-Z0-9]{36}",
          "AKIA[0-9A-Z]{16}",
          "xox[bsrap]-[a-zA-Z0-9-]+",
          "eyJ[a-zA-Z0-9_-]{10,}\\.eyJ[a-zA-Z0-9_-]{10,}"
        ]
      },
      "tools": {
        "S2": {
          "paths": ["**/.env", "**/.env.*", "**/secrets.*", "**/*credential*"]
        }
      }
    },
    "localModel": {
      "enabled": true,
      "type": "openai-compatible",
      "provider": "ollama",
      "model": "qwen2.5:3b",
      "endpoint": "http://localhost:11434/v1"
    }
  }
}
```

## Prompt 示例

### 发起 Code Review

```text
帮我 review 这个项目的代码安全性和质量。

重点关注：
1. 有没有硬编码的凭据、Token、密钥（GuardClaw 会自动脱敏，你看到 [REDACTED-*] 的地方就是）
2. 认证/授权逻辑是否完整
3. SQL 注入、XSS 等常见漏洞
4. 代码架构和可维护性

项目路径：~/projects/my-api-server/
```

### 查看脱敏后的代码

```text
给我看 src/config/database.ts 脱敏后发给云端模型的版本是什么样的。
```

## 关键洞察

- **Rule Detector 是第一道防线**：正则匹配成本为零，覆盖 90%+ 的常见 Token 格式。误报率稍高但无所谓 — 宁可多脱敏不可漏脱敏
- **本地小模型做上下文确认**：区分 `const API_KEY = "sk-real-key"` 和 `// Example: sk-your-key-here`，减少不必要的脱敏
- **代码结构保持完整**：脱敏替换保留变量名和代码结构，云端模型仍然能理解逻辑流（看到 `db.connect(REDACTED_URL)` 仍能判断连接逻辑对不对）
- **双重安全**：即使 Rule 漏掉了某个 Token，Privacy Proxy 在发送前还会做最后检查
- **Review 报告合并**：本地模型产出「硬编码凭据清单 + 修复建议」，云端模型产出「代码质量报告」，最后合并成完整的安全审查报告

## 进阶用法

- 配合 Git pre-commit hook：每次提交前自动触发 GuardClaw 扫描
- 对 CI/CD 产物也做审查：Docker 镜像中的环境变量、K8s Secret manifest 等
- 自定义规则：添加团队内部的 Token 格式模式（如自定义 API 的 key 前缀）

## 相关链接

- [TruffleHog (Secret Scanning)](https://github.com/trufflesecurity/trufflehog)
- [GuardClaw 技术报告](../guardclaw/docs/GuardClaw-技术报告.md)
- [GuardClaw 配置文档](../guardclaw/config.example.json)
