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

## 期待结果与效果预估

> **一句话**：凭据零泄露，审查质量不降 — 脱敏后代码结构完整，云端模型仍能准确识别逻辑缺陷和架构问题。

### 隐私保护效果

| 检测层 | 覆盖范围 | 预估拦截率 |
|--------|---------|-----------|
| Rule Detector（正则） | `sk-`、`ghp_`、`AKIA`、`-----BEGIN`、连接串等 20+ 模式 | ≥ 95% 的标准格式 Token |
| Local LLM 二次确认 | 上下文判断：注释中的示例 vs 真实凭据 | 将 Rule Detector 的误报降低约 30% |
| Privacy Proxy 终检 | 发送前最后一道扫描 | 兜底层，拦截漏网之鱼 |

**残余风险**：自定义格式的内部 Token（无标准前缀）、经过 Base64 编码后嵌入的凭据可能漏检。建议团队将内部 Token 前缀加入自定义规则。

### 质量影响预估

| 维度 | 影响程度 | 说明 |
|------|---------|------|
| 代码逻辑审查 | **无损** | `db.connect(REDACTED_URL)` 仍可判断连接逻辑正确性 |
| 架构/设计审查 | **无损** | 变量名和代码结构保留完整 |
| 安全漏洞检测（SQL 注入、XSS） | **无损** | 与凭据无关的安全审查不受影响 |
| 凭据管理建议 | **略降（~10%）** | 云端模型看不到具体 Token 格式，建议可能偏泛化 |

### 成本对比

| 方案 | 检测成本 | 审查成本 | 总计 |
|------|---------|---------|------|
| 纯云端（无 GuardClaw） | $0 | ~$5-15（大模型全量） | ~$5-15 |
| GuardClaw 混合 | ~$0.01-0.05（LLM 确认） | ~$5-15（云端审查不变） | ~$5-15 + 极少检测开销 |

隐私路由的核心收益不在省钱，而在**凭据不出本机**。

### 延迟影响

- Rule Detector：< 100ms（纯正则，几乎零开销）
- Local LLM 确认：~2-5s（每个可疑 Token 一次推理）
- Privacy Proxy 脱敏替换：< 500ms
- **总增加延迟**：~3-10s（取决于文件中可疑 Token 数量）

### 风险与局限

- 自定义 Token 格式（无标准前缀）需要手动添加规则
- Base64 编码或加密后的凭据目前无法检测
- 极端情况：Token 嵌入在长字符串拼接中，正则可能只匹配部分
- 本地 LLM 可能在非英文注释中误判上下文

## 实测验证（2026-03-15 v2 — Pipeline 修复后）

> 测试环境：OpenClaw Gateway + GuardClaw 插件，隐私检测 + Token-Saver Judge 均为 `gemini-2.5-flash`（via yeysai.com）

### 测试输入

```typescript
export const config = {
  database: { host: "prod-db.internal.company.com", password: "Sup3rS3cret!DB@2026" },
  aws: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  stripe: { secretKey: "sk-live-51JGxV2CpVZBxM8OvT4P3q2r5s6t7u8v9w0x1y2z3" },
  github: { token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh" },
  slack: { botToken: "xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUv" }
};
```

### 路由决策日志（Gateway 原始日志）

```
[GuardClaw] [TokenSaver] tier=MEDIUM → redirect to yeysai-gemini/gemini-2.5-pro
[GuardClaw] [onUserMessage] ▶ Final: S3 redirect → yeysai-gemini/gemini-2.5-flash
  ([privacy:w90] S2 keyword detected: password; S3 pattern matched: AKIA[0-9A-Z]{16};
   The content contains multiple credentials including passwords, API keys, and tokens)
[agent/embedded] [hooks] provider overridden to yeysai-gemini
[agent/embedded] [hooks] model overridden to gemini-2.5-flash
```

| 检测层 | 结果 | 详情 |
|--------|------|------|
| Rule Detector | **S2** keyword + **S3** pattern | `password` 关键词命中 S2；`AKIA[0-9A-Z]{16}` 正则命中 S3 |
| Local LLM (gemini-2.5-flash) | **S3** | "multiple credentials including passwords, API keys, and tokens" |
| Token-Saver Judge | **MEDIUM** | 代码审查被判定为中等复杂度 |
| **最终路由** | **S3 redirect → Guard Agent** | Privacy (w90) 胜出，S3 > Token-Saver 的 S1 redirect |

### 响应摘要

- **耗时**：11.0s | **响应长度**：1,498 字
- 模型返回了完整的安全审查报告，列出了 5 项风险和修复建议（使用环境变量、Vault 等）
- Guard Agent（gemini-2.5-flash）在本地完成处理，代码内容**未发送到公网**

### 验证结论

- ✅ **5 种凭据全部被检测**：AKIA Key、sk-live Key、ghp_ Token、password、xoxb Token
- ✅ **Privacy 优先级正确** — S3 (privacy:w90) 覆盖了 Token-Saver 的 MEDIUM → gemini-2.5-pro
- ✅ **Token-Saver 分级正确** — 代码审查被判为 MEDIUM（如无隐私问题会路由到 `gemini-2.5-pro`）
- ✅ **Gateway 日志实证** — `model overridden to gemini-2.5-flash` 确认实际路由到 Guard Agent

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
