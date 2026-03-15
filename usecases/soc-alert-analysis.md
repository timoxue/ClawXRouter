# SOC 告警分析流水线

安全运营中心每天淹没在数千条告警中。90% 是误报，但你不敢忽略任何一条。一个 SOC 分析师花 80% 的时间做机械性的告警分类和关联，只有 20% 时间做真正的攻击研判。同时，告警中包含内部 IP、主机名、用户名等敏感基础设施信息。

这个 use case 同时利用 Token-Saver（小模型批量处理告警）和隐私路由（内部基础设施信息不出本地），让大模型只在需要深度推理攻击链时才介入。

## Pain Point

- 告警量巨大：中型企业日均 5,000-50,000 条告警
- 误报率高达 90%+，大量时间浪费在确认误报上
- 告警包含内网 IP、主机名、域账户名 — 这些是攻击者梦寐以求的侦察情报
- 攻击链还原需要跨告警、跨时间窗口的深度推理
- 全量告警用大模型处理 Token 成本不可接受

## 工作原理

```
步骤                              复杂度     模型          敏感级别   Token 消耗
──────────────────────────────────────────────────────────────────────────────
① 告警原文解析                    SIMPLE     小模型 💰     S2        ████████
   (Syslog/JSON/CEF → 结构化)                                       (量大)
② 告警去重 + 时间窗口聚合          SIMPLE     小模型 💰     S2        ████
   (相同 src_ip+dest_ip+5min)
③ IOC 提取                        SIMPLE     小模型 💰     S2        ██
   (IP/域名/文件哈希/URL)
④ MITRE ATT&CK 战术映射           MEDIUM     中等模型       S2        ██
   (告警内容 → T1059 等编号)
⑤ 优先级分类 (P1-P4)              MEDIUM     中等模型       S2        ██
   (综合 CVSS + 资产重要性)
⑥ 历史基线对比 → 误报判定          MEDIUM     中等模型       S2        ███
   (这个告警以前出现过多少次？)
   ─────────────────────────── 以上全部在本地 + 小/中模型 ───────────
⑦ 攻击链还原                      COMPLEX    大模型 🧠     S1*       ██
   (跨告警因果推理)                                        (脱敏后)
⑧ 影响范围评估                    COMPLEX    大模型 🧠     S1*       █
   (横向移动路径推理)
⑨ 应急响应方案生成                REASONING  大模型 🧠     S1*       █
   (场景化处置 playbook)
⑩ 事件报告撰写                    MEDIUM     中等模型       S2        ██
   (模板化 + 本地保留全细节)
```

*步骤 ⑦⑧⑨ 发给云端前，内网 IP/主机名/用户名已被脱敏替换*

### 双驱动设计

| 维度 | 策略 | 覆盖步骤 |
|------|------|----------|
| **Token-Saver** | 批量告警解析、去重、分类用小模型 | ①②③④⑤⑥ |
| **隐私路由** | 内部基础设施信息不发给云端 | 全部步骤（S2 脱敏） |

## GuardClaw 配置

```json
{
  "privacy": {
    "enabled": true,
    "s2Policy": "proxy",
    "rules": {
      "keywords": {
        "S2": ["internal", "intranet", "域控", "domain controller"],
        "S3": ["password", "credential", "ntlm_hash", "kerberos_ticket"]
      },
      "patterns": {
        "S2": [
          "10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}",
          "172\\.(1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}",
          "192\\.168\\.\\d{1,3}\\.\\d{1,3}",
          "(?i)[a-z]+-(?:srv|dc|db|web|app)-\\d+",
          "(?i)[a-z]+\\\\[a-z0-9._-]+"
        ],
        "S3": [
          "(?i)(password|passwd|pwd|hash)\\s*[=:]\\s*\\S+"
        ]
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
          "MEDIUM": { "provider": "ollama", "model": "qwen2.5:7b" },
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
  },
  "pipeline": {
    "onUserMessage": ["privacy", "token-saver"]
  }
}
```

## Prompt 示例

### 每日告警分析

```text
帮我分析今天的安全告警。

告警源：
- Suricata IDS 日志: /var/log/suricata/eve.json (最近 24h)
- Windows Event Log 导出: ~/soc/windows-events-2026-03-13.json
- Firewall deny log: ~/soc/fw-deny.log

工作流程：
1. 解析所有告警，去重聚合
2. 提取 IOC (IP/域名/哈希)，与威胁情报源比对
3. 分类为 P1-P4，标记疑似误报
4. 对 P1/P2 告警做攻击链分析
5. 生成今日安全态势报告
```

### 事件深度分析

```text
告警聚合后发现一个可疑模式：
- 03:15 异常 DNS 查询 → 多个 DGA 域名
- 03:17 同一源 IP 尝试 SMB 横向移动
- 03:22 目标主机出现 PowerShell 编码命令执行

帮我做攻击链还原，判断这是不是一次有组织的入侵。
给出应急响应建议。
```

## 期待结果与效果预估

> **一句话**：省约 60-70% Token + 内网基础设施信息零泄露 — 小模型批量处理告警解析，大模型专注攻击链推理，脱敏保留拓扑关系不影响研判。

### 成本对比（基于日均 5,000 条告警）

| 步骤 | 全量大模型 | Token-Saver + 隐私路由 | 节省 |
|------|-----------|---------------------|------|
| ①②③ 解析+去重+IOC（SIMPLE） | ~$25-50/天 | ~$1-3/天 | **~95%** |
| ④⑤⑥ 映射+分类+基线（MEDIUM） | ~$10-20/天 | ~$3-8/天 | **~60%** |
| ⑦⑧⑨ 攻击链+响应（COMPLEX/REASONING） | ~$5-10/天 | ~$5-10/天（不变） | 0% |
| **全流程** | **~$40-80/天** | **~$9-21/天** | **~60-70%** |

### 隐私保护效果

| 敏感信息 | 检测方式 | 预估拦截率 |
|----------|---------|-----------|
| 内网 IP（10.x/172.x/192.168.x） | 正则模式 | ≥ 99% |
| 主机名（xxx-srv-01 等命名规范） | 正则模式 | ≥ 95% |
| 域账户名（DOMAIN\user） | 正则模式 | ≥ 98% |
| 密码/NTLM Hash | 关键词 + 正则（S3） | ≥ 99% |

**脱敏保留拓扑关系**：`10.1.2.3` → `[INTERNAL-IP-1]`，但 "IP-1 → IP-2:445" 的连接关系完整保留，云端模型仍可推理横向移动路径。

### 质量影响预估

| 维度 | 影响程度 | 说明 |
|------|---------|------|
| 告警解析准确率 | SIMPLE 模型 ≥ 93% | Syslog/JSON/CEF 是结构化格式 |
| 告警分类（P1-P4） | MEDIUM 模型 ~85-90% | 关键：P1 不能被误分为 P3 |
| 误报识别 | MEDIUM 模型 ~80-88% | 需要历史基线积累 |
| 攻击链还原 | **无损** | 仍用大模型 + 保留拓扑 |
| 应急响应方案 | **无损** | 仍用大模型 |

### 延迟影响

- 5,000 条告警批量解析：~10-20 分钟（SIMPLE 模型）
- 攻击链分析（P1/P2 告警）：~1-3 分钟/事件（大模型）
- **与手动分析（数小时）相比，延迟完全可接受**

### 风险与局限

- 小模型可能将 P1 告警误分类为 P3（严重后果：延误响应）→ 建议对 P1/P2 结果做大模型复核
- 内网 IP 段如果使用非标准的私有地址范围（如 100.64.x.x CGNAT），需手动添加规则
- 编码后的 PowerShell 命令中的 IP 可能被脱敏遗漏（Base64 编码后正则不匹配）
- 新型告警格式（非 Syslog/JSON/CEF）可能导致解析错误

## 实测验证（2026-03-15 v2 — Pipeline 修复后）

> 测试环境：OpenClaw Gateway + GuardClaw 插件，隐私检测 + Token-Saver Judge 均为 `gemini-2.5-flash`（via yeysai.com）

### 测试输入

```
[2026-03-15 03:15:42] ALERT P1: Suspicious DNS query from 10.1.2.50 to DGA domain xkf7a9b3c.evil.com
[2026-03-15 03:17:15] ALERT P1: SMB lateral movement attempt from 10.1.2.50 to 10.1.3.100 (DC-SRV-01) port 445
[2026-03-15 03:18:30] ALERT P2: NTLM relay detected CORP\\admin.svc -> 10.1.3.100
[2026-03-15 03:22:01] ALERT P1: Encoded PowerShell execution on WIN-DB-03 (10.1.3.100)
[2026-03-15 03:25:00] ALERT P2: Data exfiltration 500MB to 185.123.45.67:8443
Source: Suricata IDS + CrowdStrike EDR
```

### 路由决策日志（Gateway 原始日志）

```
[GuardClaw] [TokenSaver] tier=COMPLEX → redirect to yeysai-gemini/gemini-3.1-pro-preview
[GuardClaw] [onUserMessage] ▶ Final: S2 redirect → guardclaw-privacy/
  ([privacy:w90] S2 pattern matched: \b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b)
[agent/embedded] [hooks] provider overridden to guardclaw-privacy
```

| 检测层 | 结果 | 详情 |
|--------|------|------|
| Rule Detector | **S2** pattern | 内网 IP 正则匹配 `10.1.2.50`、`10.1.3.100` |
| Token-Saver Judge | **COMPLEX** | SOC 告警分析涉及攻击链推理 → COMPLEX（改进版 Judge 正确识别） |
| **最终路由** | **S2 redirect → Privacy Proxy** | Privacy (w90) 胜出，内网信息通过隐私代理脱敏后转发 |

### 检测到的敏感信息

| 类型 | 示例 | 检测结果 |
|------|------|---------|
| 内网 IP | `10.1.2.50`、`10.1.3.100` | ✅ S2 正则精确匹配 |
| 主机名 | `DC-SRV-01`、`WIN-DB-03` | ✅ LLM 上下文判断 |
| 端口信息 | `port 445` (SMB) | ✅ 关联内网拓扑 |

### 响应摘要

- **耗时**：32.6s | **响应长度**：2,506 字
- 模型返回了详细的告警分析报告，包含：
  - **攻击链还原**：DGA DNS → SMB 横向移动 → NTLM 中继 → PowerShell 执行 → 500MB 数据外泄
  - **严重性评估**：P0 紧急事件（10 分钟内完成全链路）
  - **应急建议**：立即隔离 `[REDACTED:ADDRESS]`、封锁外联 IP、检查 DNS 日志
- 响应内容中**内网 IP 被脱敏为 `[REDACTED:ADDRESS]`**，拓扑关系保留完整

### 验证结论

- ✅ 内网 IP 被 S2 正则精确匹配
- ✅ S2 路由正确 → 走隐私代理脱敏后转发云端
- ✅ **Token-Saver 分级改善** — 从之前的 MEDIUM 提升为 COMPLEX（更合理）
- ✅ 攻击链推理质量高，脱敏后拓扑关系保留完整
- ✅ Gateway 日志 `provider overridden to guardclaw-privacy` 实证

## 关键洞察

- **Privacy 权重 > Token-Saver 权重**：配置中 privacy weight=80, token-saver weight=30。安全优先，即使 Token-Saver 判断可以用云端，如果 privacy router 认为内容含内网信息，也会路由到本地
- **内网 IP 是侦察金矿**：攻击者拿到你的内网 IP 段和命名规范，等于拿到了网络拓扑的半张地图。这些信息发给云端的风险远超想象
- **脱敏保留拓扑关系**：`10.1.2.3` → `[INTERNAL-IP-1]`，但保持 "IP-1 连接了 IP-2 的 445 端口" 这种关系，云端模型仍能推理攻击链
- **步骤①的 Token 消耗**：5,000 条告警 × 平均 500 Token/条 = 2.5M Token。用小模型做解析能省 $20-50/天
- **误报基线学习**：中等模型对比历史数据判断误报，随着基线积累会越来越准

## 相关链接

- [MITRE ATT&CK Framework](https://attack.mitre.org/)
- [Suricata IDS](https://suricata.io/)
- [Sigma Rules (Generic Detection)](https://github.com/SigmaHQ/sigma)
