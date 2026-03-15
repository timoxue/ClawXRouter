#!/bin/bash
AUTH="Authorization: Bearer 6a7a8f9e318f5417cdd2fab4d90e6be59bd83981dfc3671b"
URL="http://127.0.0.1:18789/v1/chat/completions"
OUTDIR="/Users/a1/Desktop/claw/Edgeclaw-router/usecases/test-results"
mkdir -p "$OUTDIR"

run_test() {
  local name="$1" session="$2" body="$3"
  local start end elapsed
  start=$(python3 -c "import time; print(int(time.time()*1000))")
  curl -sS --max-time 180 "$URL" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -H "x-openclaw-session-key: $session" \
    -d "$body" > "$OUTDIR/${name}.json" 2>&1
  end=$(python3 -c "import time; print(int(time.time()*1000))")
  elapsed=$((end - start))
  local chars content_preview
  chars=$(python3 -c "import json; r=json.load(open('$OUTDIR/${name}.json')); c=r.get('choices',[{}])[0].get('message',{}).get('content',''); print(len(c))" 2>/dev/null || echo "0")
  content_preview=$(python3 -c "
import json
r=json.load(open('$OUTDIR/${name}.json'))
c=r.get('choices',[{}])[0].get('message',{}).get('content','')
print(c[:300])
" 2>/dev/null || echo "PARSE_ERROR")
  echo "=== $name === ${elapsed}ms, ${chars} chars"
  echo "$content_preview"
  echo "---"
}

echo "========== PRIVACY TESTS =========="

# P1: 代码审查 -> 期望 S3
run_test "P1-codereview" "rt3-p1" '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"帮我 review 这段代码的安全性：\n\nexport const config = {\n  database: { host: \"prod-db.internal.company.com\", password: \"Sup3rS3cret!DB@2026\" },\n  aws: { accessKeyId: \"AKIAIOSFODNN7EXAMPLE\", secretAccessKey: \"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\" },\n  stripe: { secretKey: \"sk-live-51JGxV2CpVZBxM8OvT4P3q2r5s6t7u8v9w0x1y2z3\" },\n  github: { token: \"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh\" },\n  slack: { botToken: \"xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUv\" }\n};"}]}'

# P2: 家庭群聊 -> 期望 S3
run_test "P2-familychat" "rt3-p2" '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"帮我总结这段家庭群聊天记录的重点：\n\n2026-03-10 09:00 张小明：周六下午2点在外婆家聚会，地址是北京市朝阳区望京街道花家地南里15号楼3单元502\n2026-03-10 09:05 王丽芳：好的，我卡号 6222 0200 1234 5678\n2026-03-10 10:30 李美华：带你爸去北京协和医院看了李医生，空腹血糖7.2\n2026-03-10 10:36 李美华：110108196503124518\n2026-03-10 11:02 张小红：换了，13912345678，你存一下\n2026-03-10 15:00 张建国：小明，你公司那个API密钥 sk-proj-abc123def456ghi789 帮我配一下"}]}'

# P3: SOC 告警 -> 期望 S2
run_test "P3-socalert" "rt3-p3" '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"分析这条 SOC 告警，判断严重性并给出应急建议：\n\n[2026-03-15 03:15:42] ALERT P1: Suspicious DNS query from 10.1.2.50 to DGA domain xkf7a9b3c.evil.com\n[2026-03-15 03:17:15] ALERT P1: SMB lateral movement attempt from 10.1.2.50 to 10.1.3.100 (DC-SRV-01) port 445\n[2026-03-15 03:18:30] ALERT P2: NTLM relay detected CORP\\\\admin.svc -> 10.1.3.100\n[2026-03-15 03:22:01] ALERT P1: Encoded PowerShell execution on WIN-DB-03 (10.1.3.100)\n[2026-03-15 03:25:00] ALERT P2: Data exfiltration 500MB to 185.123.45.67:8443\nSource: Suricata IDS + CrowdStrike EDR"}]}'

# P4: 安全消息 -> 期望 S1
run_test "P4-safe" "rt3-p4" '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"HTTP 状态码 403 和 401 的区别是什么？"}]}'

echo ""
echo "========== TOKEN-SAVER TESTS =========="

# T1: SIMPLE -> 期望 gemini-2.5-flash
run_test "T1-simple" "rt3-t1" '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"JSON 和 YAML 的区别是什么？用一段话说明。"}]}'

# T2: MEDIUM -> 期望 gemini-2.5-pro
run_test "T2-medium" "rt3-t2" '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"帮我总结下面这个函数做了什么，并找出其中的 bug：\n\nfunction calculateDiscount(items, memberLevel) {\n  let total = 0;\n  for (let i = 0; i <= items.length; i++) {\n    total += items[i].price * items[i].quantity;\n  }\n  const discount = memberLevel === \"gold\" ? 0.2 : memberLevel === \"silver\" ? 0.1 : 0;\n  return total * (1 - discount);\n}"}]}'

# T3: COMPLEX -> 期望 gemini-3-pro
run_test "T3-complex" "rt3-t3" '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"设计一个支持百万级并发的实时消息推送系统架构。需要包括：消息队列选型（Kafka vs RabbitMQ vs Pulsar）、WebSocket 网关集群设计、消息持久化策略、多机房容灾方案，以及从客户端到服务端的完整消息流转链路图。"}]}'

# T4: REASONING -> 期望 claude-sonnet-4.5
run_test "T4-reasoning" "rt3-t4" '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"请严格证明以下命题：对于任意正整数 n，如果 2^n - 1 是素数（梅森素数），则 n 本身必须是素数。要求给出完整的反证法证明过程，并讨论逆命题是否成立。"}]}'

echo ""
echo "========== MIXED TESTS =========="

# M1: 含PII的简单问题 -> 期望 privacy 胜出
run_test "M1-pii-simple" "rt3-m1" '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"我的身份证号是 310101199001011234，请问这是哪个省份的？"}]}'

# M2: 不含PII的复杂问题 -> 期望 token-saver 生效
run_test "M2-clean-complex" "rt3-m2" '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"对比分析 Transformer、Mamba 和 RWKV 三种架构在长序列建模上的理论复杂度差异，并设计一个实验来验证它们在 100K token 上下文窗口下的实际推理速度和困惑度表现。"}]}'

echo ""
echo "========== ALL TESTS DONE =========="
