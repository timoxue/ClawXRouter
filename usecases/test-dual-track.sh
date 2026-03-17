#!/bin/bash
# Dual-Track Session History Integration Test
# Tests: S1 -> S3 -> S1 -> S3 on the same session to verify:
#   1. S3 content is routed locally
#   2. Dual-track history is written (full vs clean)
#   3. On second S3 turn, dual-track history is injected as context

AUTH="Authorization: Bearer 6a7a8f9e318f5417cdd2fab4d90e6be59bd83981dfc3671b"
URL="http://127.0.0.1:18789/v1/chat/completions"
SESSION="dual-track-test-$(date +%s)"
OUTDIR="/Users/a1/Desktop/claw/Edgeclaw-router/usecases/test-results"
mkdir -p "$OUTDIR"

send_msg() {
  local name="$1" content="$2"
  local start end elapsed
  start=$(python3 -c "import time; print(int(time.time()*1000))")
  curl -sS --max-time 120 "$URL" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -H "x-openclaw-session-key: $SESSION" \
    -d "$(python3 -c "
import json, sys
msg = {'model':'openclaw','stream':False,'messages':[{'role':'user','content':$(python3 -c "import json; print(json.dumps('''$content'''))")}]}
print(json.dumps(msg))
")" > "$OUTDIR/${name}.json" 2>&1
  end=$(python3 -c "import time; print(int(time.time()*1000))")
  elapsed=$((end - start))
  local chars
  chars=$(python3 -c "import json; r=json.load(open('$OUTDIR/${name}.json')); c=r.get('choices',[{}])[0].get('message',{}).get('content',''); print(len(c))" 2>/dev/null || echo "0")
  local preview
  preview=$(python3 -c "
import json
r=json.load(open('$OUTDIR/${name}.json'))
c=r.get('choices',[{}])[0].get('message',{}).get('content','')
print(c[:300])
" 2>/dev/null || echo "PARSE_ERROR")
  echo "=== $name === ${elapsed}ms, ${chars} chars"
  echo "$preview"
  echo "---"
}

echo "========== DUAL-TRACK SESSION TEST =========="
echo "Session: $SESSION"
echo ""

echo "[Turn 1] S1: Safe question (expect cloud routing, no privacy action)"
send_msg "DT1-safe" "HTTP 状态码 200 和 201 有什么区别？"
sleep 2

echo ""
echo "[Turn 2] S3: Sensitive content with SSH key (expect local routing, dual-track write)"
send_msg "DT2-s3-ssh" "帮我检查这个 SSH 私钥是否有效：
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy5AHBtbeE
我的身份证号 310101199501012345 需要绑定到这个服务器上"
sleep 2

echo ""
echo "[Turn 3] S1: Safe question on same session (expect cloud, no S3 leak)"
send_msg "DT3-safe-again" "Python 的列表推导式和 map 函数哪个更快？"
sleep 2

echo ""
echo "[Turn 4] S3: Another sensitive msg (expect local + injected dual-track history from Turn 2)"
send_msg "DT4-s3-password" "我的数据库密码是 password=SuperSecret123!@# 请帮我分析这个密码强度，另外之前那个 SSH 密钥的问题解决了吗？"
sleep 2

echo ""
echo "========== VERIFICATION =========="
echo ""
echo "--- Session files ---"
echo "Full track:"
ls -la /Users/a1/.openclaw/agents/main/sessions/full/ 2>/dev/null | grep "$SESSION" || echo "(no full track file)"
echo "Clean track:"
ls -la /Users/a1/.openclaw/agents/main/sessions/clean/ 2>/dev/null | grep "$SESSION" || echo "(no clean track file)"

echo ""
echo "--- Full track content ---"
FULL_FILE=$(find /Users/a1/.openclaw/agents/main/sessions/full/ -name "*${SESSION}*" 2>/dev/null | head -1)
if [ -n "$FULL_FILE" ]; then
  echo "File: $FULL_FILE"
  echo "Lines: $(wc -l < "$FULL_FILE")"
  python3 -c "
import json
with open('$FULL_FILE') as f:
    for i, line in enumerate(f):
        m = json.loads(line.strip())
        role = m.get('role','?')
        content = m.get('content','')[:100]
        print(f'  [{i}] {role}: {content}')
" 2>/dev/null || echo "  (parse error)"
else
  echo "  (file not found)"
fi

echo ""
echo "--- Clean track content ---"
CLEAN_FILE=$(find /Users/a1/.openclaw/agents/main/sessions/clean/ -name "*${SESSION}*" 2>/dev/null | head -1)
if [ -n "$CLEAN_FILE" ]; then
  echo "File: $CLEAN_FILE"
  echo "Lines: $(wc -l < "$CLEAN_FILE")"
  python3 -c "
import json
with open('$CLEAN_FILE') as f:
    for i, line in enumerate(f):
        m = json.loads(line.strip())
        role = m.get('role','?')
        content = m.get('content','')[:100]
        print(f'  [{i}] {role}: {content}')
" 2>/dev/null || echo "  (parse error)"
else
  echo "  (file not found)"
fi

echo ""
echo "========== TEST COMPLETE =========="
echo "Session key: $SESSION"
echo "Check gateway logs for '[GuardClaw] Injected dual-track history context' and 'S3 (rule fast-path)'"
