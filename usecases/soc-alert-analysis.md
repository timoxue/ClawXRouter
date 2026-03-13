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
