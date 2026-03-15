#!/usr/bin/env python3
"""
PinchBench → GuardClaw Verification Script

Sends all 23 PinchBench task prompts to the OpenClaw Gateway and captures
privacy-router + token-saver routing decisions from the runtime log.
"""

import json, os, re, time, subprocess, glob, hashlib
from pathlib import Path
from datetime import datetime

GATEWAY = "http://127.0.0.1:18789/v1/chat/completions"
AUTH_TOKEN = "6a7a8f9e318f5417cdd2fab4d90e6be59bd83981dfc3671b"
LOG_DIR = "/tmp/openclaw"
TASKS_DIR = "/Users/a1/Desktop/claw/skill/tasks"
REPORT_PATH = "/Users/a1/Desktop/claw/Edgeclaw-router/usecases/pinchbench-verification-report.md"

STATS_FILE = "/Users/a1/.openclaw/guardclaw-stats.json"

TIER_MODEL_MAP = {
    "SIMPLE":    "gemini-2.5-flash",
    "MEDIUM":    "gemini-2.5-pro",
    "COMPLEX":   "gemini-3.1-pro-preview",
    "REASONING": "claude-sonnet-4-5-20250929",
}

REQUEST_TIMEOUT = 300

EXPECTED = {
    "task_00_sanity":                {"tier": "SIMPLE",    "privacy": "S1"},
    "task_01_calendar":              {"tier": "MEDIUM",    "privacy": "S2"},  # john@example.com in prompt
    "task_02_stock":                 {"tier": "MEDIUM",    "privacy": "S1"},
    "task_03_blog":                  {"tier": "MEDIUM",    "privacy": "S1"},
    "task_04_weather":               {"tier": "MEDIUM",    "privacy": "S1"},
    "task_05_summary":               {"tier": "MEDIUM",    "privacy": "S1"},
    "task_06_events":                {"tier": "MEDIUM",    "privacy": "S1"},
    "task_07_email":                 {"tier": "SIMPLE",    "privacy": "S1"},
    "task_08_memory":                {"tier": "SIMPLE",    "privacy": "S1"},
    "task_09_files":                 {"tier": "SIMPLE",    "privacy": "S1"},
    "task_10_workflow":              {"tier": "COMPLEX",   "privacy": "S1"},
    "task_11_clawdhub":              {"tier": "SIMPLE",    "privacy": "S1"},
    "task_12_skill_search":          {"tier": "MEDIUM",    "privacy": "S2"},  # password in workspace cfg
    "task_13_image_gen":             {"tier": "MEDIUM",    "privacy": "S1"},
    "task_14_humanizer":             {"tier": "MEDIUM",    "privacy": "S1"},
    "task_15_daily_summary":         {"tier": "COMPLEX",   "privacy": "S1"},
    "task_16_email_triage":          {"tier": "COMPLEX",   "privacy": "S2"},  # internal emails
    "task_17_email_search":          {"tier": "COMPLEX",   "privacy": "S2"},  # internal emails
    "task_18_market_research":       {"tier": "COMPLEX",   "privacy": "S1"},
    "task_19_spreadsheet_summary":   {"tier": "MEDIUM",    "privacy": "S1"},
    "task_20_eli5_pdf_summary":      {"tier": "MEDIUM",    "privacy": "S1"},
    "task_21_openclaw_comprehension":{"tier": "REASONING", "privacy": "S1"},
    "task_22_second_brain":          {"tier": "COMPLEX",   "privacy": "S2"},  # "secret" keyword
}


def find_latest_log():
    logs = sorted(glob.glob(os.path.join(LOG_DIR, "openclaw-*.log")))
    return logs[-1] if logs else None


def count_lines(path):
    with open(path, "rb") as f:
        return sum(1 for _ in f)


def read_new_lines(path, start_line):
    lines = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f, 1):
            if i > start_line:
                lines.append(line)
    return lines


def extract_prompt_from_md(md_path):
    text = Path(md_path).read_text(encoding="utf-8")
    m = re.search(r"##\s*Prompt\s*\n(.*?)(?=\n##|\Z)", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    m = re.search(r"prompt:\s*[|>]\s*\n(.*?)(?=\n\w+:|\n---|\Z)", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    m = re.search(r"prompt:\s*\"(.*?)\"", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    lines = text.split("\n")
    in_prompt = False
    prompt_lines = []
    for line in lines:
        if re.match(r"^##\s*Prompt", line, re.I):
            in_prompt = True
            continue
        if in_prompt:
            if re.match(r"^##\s", line):
                break
            prompt_lines.append(line)
    if prompt_lines:
        return "\n".join(prompt_lines).strip()
    return None


def extract_prompt_from_frontmatter(md_path):
    text = Path(md_path).read_text(encoding="utf-8")
    fm_match = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if not fm_match:
        return None
    fm = fm_match.group(1)
    m = re.search(r"prompt:\s*[|>]-?\s*\n((?:\s+.*\n)*)", fm)
    if m:
        block = m.group(1)
        lines = []
        for l in block.split("\n"):
            if l.strip():
                lines.append(re.sub(r"^\s{2,4}", "", l))
            else:
                lines.append("")
        return "\n".join(lines).strip()
    m = re.search(r'prompt:\s*"(.*?)"', fm, re.DOTALL)
    if m:
        return m.group(1).replace("\\n", "\n").strip()
    m = re.search(r"prompt:\s*'(.*?)'", fm, re.DOTALL)
    if m:
        return m.group(1).strip()
    return None


def get_task_prompt(md_path):
    p = extract_prompt_from_frontmatter(md_path)
    if p and len(p) > 10:
        return p
    p = extract_prompt_from_md(md_path)
    if p and len(p) > 10:
        return p
    text = Path(md_path).read_text(encoding="utf-8")
    text = re.sub(r"^---.*?---", "", text, count=1, flags=re.DOTALL).strip()
    for line in text.split("\n"):
        line = line.strip()
        if len(line) > 20 and not line.startswith("#") and not line.startswith("|"):
            return line
    return text[:500]


def parse_log_entries(lines, task_prompt_hash=None):
    result = {
        "privacy_level": None,
        "privacy_reason": None,
        "privacy_level_session": None,
        "tier": None,
        "model_overridden": None,
        "provider_overridden": None,
        "final_decision": None,
        "log_excerpts": [],
    }
    for line in lines:
        try:
            obj = json.loads(line.strip())
        except json.JSONDecodeError:
            continue

        log_text = obj.get("1", obj.get("0", ""))
        if isinstance(log_text, dict):
            log_text = json.dumps(log_text, ensure_ascii=False)

        if "[GuardClaw]" in str(log_text) or "[hooks]" in str(log_text) or "[RouterPipeline]" in str(log_text):
            ts = obj.get("_meta", {}).get("date", "")
            result["log_excerpts"].append({"ts": ts, "msg": log_text})

        if isinstance(log_text, str):
            is_on_user_msg = "[onUserMessage]" in log_text

            m = re.search(r'"level"\s*:\s*"(S[123])"', log_text)
            if m and result["privacy_level"] is None:
                result["privacy_level"] = m.group(1)
                rm = re.search(r'"reason"\s*:\s*"([^"]+)"', log_text)
                if rm:
                    result["privacy_reason"] = rm.group(1)

            m = re.search(r'"tier"\s*:\s*"(SIMPLE|MEDIUM|COMPLEX|REASONING)"', log_text)
            if m and result["tier"] is None:
                result["tier"] = m.group(1)

            if "model overridden to" in log_text and result["model_overridden"] is None:
                m = re.search(r"model overridden to (\S+)", log_text)
                if m:
                    result["model_overridden"] = m.group(1)

            if "provider overridden to" in log_text and result["provider_overridden"] is None:
                m = re.search(r"provider overridden to (\S+)", log_text)
                if m:
                    result["provider_overridden"] = m.group(1)

            if is_on_user_msg and "Final:" in log_text:
                result["final_decision"] = log_text
                m = re.search(r"Final: (S[123])", log_text)
                if m:
                    result["privacy_level"] = m.group(1)
                    rm = re.search(r"\((.*?)\)", log_text)
                    if rm:
                        reason = rm.group(1)
                        if not reason.startswith("tier="):
                            result["privacy_reason"] = reason[:120]

            if not is_on_user_msg and "Final:" in log_text:
                m = re.search(r"Final: (S[123])", log_text)
                if m:
                    lvl = m.group(1)
                    cur = result["privacy_level_session"]
                    if cur is None or (lvl == "S3") or (lvl == "S2" and cur != "S3"):
                        result["privacy_level_session"] = lvl

    return result


def read_stats():
    try:
        with open(STATS_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def diff_stats(before, after):
    result = {}
    for channel in ["cloud", "local", "proxy"]:
        b = before.get("lifetime", {}).get(channel, {})
        a = after.get("lifetime", {}).get(channel, {})
        result[channel] = {
            "inputTokens": a.get("inputTokens", 0) - b.get("inputTokens", 0),
            "outputTokens": a.get("outputTokens", 0) - b.get("outputTokens", 0),
            "totalTokens": a.get("totalTokens", 0) - b.get("totalTokens", 0),
            "requestCount": a.get("requestCount", 0) - b.get("requestCount", 0),
        }
    return result


def send_request(prompt, timeout=REQUEST_TIMEOUT):
    import urllib.request
    payload = json.dumps({
        "model": "yeysai/gemini-2.5-flash",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 2048,
    }).encode("utf-8")

    req = urllib.request.Request(
        GATEWAY,
        data=payload,
        headers={
            "Authorization": f"Bearer {AUTH_TOKEN}",
            "Content-Type": "application/json",
        },
    )

    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            elapsed = time.time() - start
            data = json.loads(body)
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            usage = data.get("usage", {})
            return {
                "content": content,
                "elapsed_s": round(elapsed, 2),
                "word_count": len(content),
                "char_count": len(content),
                "model_returned": data.get("model", ""),
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
                "error": None,
            }
    except Exception as e:
        elapsed = time.time() - start
        return {
            "content": "",
            "elapsed_s": round(elapsed, 2),
            "word_count": 0,
            "char_count": 0,
            "model_returned": "",
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "error": str(e),
        }


def main():
    log_path = find_latest_log()
    if not log_path:
        print("ERROR: No log file found in", LOG_DIR)
        return

    task_files = sorted(glob.glob(os.path.join(TASKS_DIR, "task_*.md")))
    if not task_files:
        print("ERROR: No task files found in", TASKS_DIR)
        return

    print(f"Found {len(task_files)} tasks, log file: {log_path}")
    print(f"Starting PinchBench verification at {datetime.now().isoformat()}")
    print("=" * 70)

    stats_before = read_stats()
    results = []

    for tf in task_files:
        task_id = Path(tf).stem
        prompt = get_task_prompt(tf)
        if not prompt:
            print(f"SKIP {task_id}: no prompt extracted")
            continue

        prompt_preview = prompt[:80].replace("\n", " ")
        print(f"\n[{task_id}] Sending... ({prompt_preview}...)")

        line_before = count_lines(log_path)

        resp = send_request(prompt)

        time.sleep(1)

        new_lines = read_new_lines(log_path, line_before)
        log_info = parse_log_entries(new_lines)

        expected = EXPECTED.get(task_id, {})

        entry = {
            "task_id": task_id,
            "prompt_preview": prompt[:120],
            "expected_tier": expected.get("tier", "?"),
            "expected_privacy": expected.get("privacy", "?"),
            "actual_tier": log_info["tier"],
            "actual_privacy": log_info["privacy_level"],
            "actual_privacy_session": log_info.get("privacy_level_session"),
            "privacy_reason": log_info["privacy_reason"],
            "model_overridden": log_info["model_overridden"],
            "provider_overridden": log_info["provider_overridden"],
            "final_decision": log_info["final_decision"],
            "elapsed_s": resp["elapsed_s"],
            "char_count": resp["char_count"],
            "model_returned": resp["model_returned"],
            "prompt_tokens": resp.get("prompt_tokens", 0),
            "completion_tokens": resp.get("completion_tokens", 0),
            "total_tokens": resp.get("total_tokens", 0),
            "response_preview": resp["content"][:200] if resp["content"] else "",
            "error": resp["error"],
            "log_excerpts": log_info["log_excerpts"][-6:],
        }
        results.append(entry)

        tier_ok = "OK" if entry["actual_tier"] == entry["expected_tier"] else "MISMATCH"
        priv_ok = "OK" if entry["actual_privacy"] == entry["expected_privacy"] else "MISMATCH"
        print(f"  Privacy: {entry['actual_privacy']} (expected {entry['expected_privacy']}) [{priv_ok}]")
        print(f"  Tier:    {entry['actual_tier']} (expected {entry['expected_tier']}) [{tier_ok}]")
        print(f"  Model:   {entry['model_overridden']}  |  Time: {entry['elapsed_s']}s  |  Chars: {entry['char_count']}")
        if entry["error"]:
            print(f"  ERROR:   {entry['error']}")

    time.sleep(2)
    stats_after = read_stats()
    token_diff = diff_stats(stats_before, stats_after)

    results_path = REPORT_PATH.replace(".md", ".json")
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump({"results": results, "token_stats": token_diff}, f, indent=2, ensure_ascii=False)
    print(f"\nRaw results saved to {results_path}")

    generate_report(results, token_diff)
    print(f"Report saved to {REPORT_PATH}")


def generate_report(results, token_diff=None):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = []
    lines.append("# PinchBench × GuardClaw 路由验证报告")
    lines.append(f"\n> 生成时间: {now}")
    lines.append("> 测试框架: PinchBench 23 tasks → OpenClaw Gateway (127.0.0.1:18789)")
    lines.append("> GuardClaw: Privacy Router + Token-Saver Router")
    lines.append("> Token-Saver Tiers: SIMPLE→gemini-2.5-flash, MEDIUM→gemini-2.5-pro, COMPLEX→gemini-3.1-pro-preview, REASONING→claude-sonnet-4.5")
    lines.append("")

    # ── Summary Stats ──
    total = len(results)
    tier_correct = sum(1 for r in results if r["actual_tier"] == r["expected_tier"] and r["actual_tier"])
    priv_correct = sum(1 for r in results if r["actual_privacy"] == r["expected_privacy"] and r["actual_privacy"])
    errors = sum(1 for r in results if r["error"])
    tier_tested = sum(1 for r in results if r["actual_tier"])
    priv_tested = sum(1 for r in results if r["actual_privacy"])

    lines.append("## 1. 总览")
    lines.append("")
    lines.append(f"| 指标 | 数值 |")
    lines.append(f"|------|------|")
    lines.append(f"| 总任务数 | {total} |")
    lines.append(f"| Token-Saver 路由正确率 | {tier_correct}/{tier_tested} ({tier_correct*100//max(tier_tested,1)}%) |")
    lines.append(f"| Privacy 路由正确率 | {priv_correct}/{priv_tested} ({priv_correct*100//max(priv_tested,1)}%) |")
    lines.append(f"| 请求错误数 | {errors} |")
    total_time = sum(r["elapsed_s"] for r in results)
    lines.append(f"| 总耗时 | {total_time:.1f}s |")
    avg_time = total_time / max(total, 1)
    lines.append(f"| 平均耗时 | {avg_time:.1f}s |")
    lines.append("")

    # ── Privacy Verification Table ──
    lines.append("## 2. 隐私路由验证表")
    lines.append("")
    lines.append("| Task | 预期隐私级别 | 实际隐私级别 | 匹配 | 隐私判定理由 | Gateway 日志摘录 |")
    lines.append("|------|------------|------------|------|------------|----------------|")
    for r in results:
        match = "✅" if r["actual_privacy"] == r["expected_privacy"] else "❌"
        reason = (r["privacy_reason"] or "—")[:60]
        log_excerpt = ""
        for le in r["log_excerpts"]:
            msg = le["msg"] if isinstance(le["msg"], str) else json.dumps(le["msg"], ensure_ascii=False)
            if "privacy:" in msg or "S2" in msg or "S3" in msg:
                log_excerpt = msg[:80].replace("|", "\\|")
                break
        if not log_excerpt:
            for le in r["log_excerpts"]:
                msg = le["msg"] if isinstance(le["msg"], str) else json.dumps(le["msg"], ensure_ascii=False)
                if "GuardClaw" in msg:
                    log_excerpt = msg[:80].replace("|", "\\|")
                    break
        lines.append(f"| {r['task_id']} | {r['expected_privacy']} | {r['actual_privacy'] or '—'} | {match} | {reason.replace('|', '\\|')} | `{log_excerpt}` |")
    lines.append("")

    # ── Token-Saver Verification Table ──
    lines.append("## 3. Token-Saver 四级路由验证表")
    lines.append("")
    lines.append("| Task | 预期 Tier | 实际 Tier | 匹配 | model overridden | 预期模型 | 实际模型 | 耗时(s) | 字符数 |")
    lines.append("|------|----------|----------|------|-----------------|---------|---------|---------|--------|")
    for r in results:
        match = "✅" if r["actual_tier"] == r["expected_tier"] else "❌"
        expected_model = TIER_MODEL_MAP.get(r["expected_tier"], "?")
        actual_model = r["model_overridden"] or "—"
        lines.append(f"| {r['task_id']} | {r['expected_tier']} | {r['actual_tier'] or '—'} | {match} | `{actual_model}` | {expected_model} | {actual_model} | {r['elapsed_s']} | {r['char_count']} |")
    lines.append("")

    # ── Per-Task Detail ──
    lines.append("## 4. 每任务定量指标")
    lines.append("")
    lines.append("| # | Task ID | Privacy | Tier | Model | 耗时(s) | Tokens | 字符数 | 错误 |")
    lines.append("|---|---------|---------|------|-------|---------|--------|--------|------|")
    for i, r in enumerate(results):
        err = r["error"][:30] if r["error"] else "—"
        tok = r.get("total_tokens", 0)
        lines.append(f"| {i} | {r['task_id']} | {r['actual_privacy'] or '—'} | {r['actual_tier'] or '—'} | {r['model_overridden'] or '—'} | {r['elapsed_s']} | {tok:,} | {r['char_count']} | {err} |")
    lines.append("")

    # ── Log Evidence ──
    lines.append("## 5. Gateway 日志实证（关键摘录）")
    lines.append("")
    for r in results:
        if r["log_excerpts"]:
            lines.append(f"### {r['task_id']}")
            lines.append("```")
            for le in r["log_excerpts"][-4:]:
                msg = le["msg"] if isinstance(le["msg"], str) else json.dumps(le["msg"], ensure_ascii=False)
                ts = le.get("ts", "")[:19]
                lines.append(f"[{ts}] {msg[:200]}")
            lines.append("```")
            lines.append("")

    # ── Token Stats ──
    lines.append("## 6. 定量 Token 消耗统计")
    lines.append("")

    if token_diff:
        cloud = token_diff.get("cloud", {})
        local = token_diff.get("local", {})
        proxy = token_diff.get("proxy", {})
        total_in = cloud.get("inputTokens",0) + local.get("inputTokens",0) + proxy.get("inputTokens",0)
        total_out = cloud.get("outputTokens",0) + local.get("outputTokens",0) + proxy.get("outputTokens",0)
        total_tok = cloud.get("totalTokens",0) + local.get("totalTokens",0) + proxy.get("totalTokens",0)
        total_req = cloud.get("requestCount",0) + local.get("requestCount",0) + proxy.get("requestCount",0)

        lines.append("### 6.1 GuardClaw Token 统计 (guardclaw-stats.json 实测)")
        lines.append("")
        lines.append("| 通道 | Input Tokens | Output Tokens | Total Tokens | 请求数 |")
        lines.append("|------|-------------|--------------|-------------|--------|")
        lines.append(f"| Cloud (直连) | {cloud.get('inputTokens',0):,} | {cloud.get('outputTokens',0):,} | {cloud.get('totalTokens',0):,} | {cloud.get('requestCount',0)} |")
        lines.append(f"| Local (Guard Agent) | {local.get('inputTokens',0):,} | {local.get('outputTokens',0):,} | {local.get('totalTokens',0):,} | {local.get('requestCount',0)} |")
        lines.append(f"| Proxy (PII 脱敏) | {proxy.get('inputTokens',0):,} | {proxy.get('outputTokens',0):,} | {proxy.get('totalTokens',0):,} | {proxy.get('requestCount',0)} |")
        lines.append(f"| **合计** | **{total_in:,}** | **{total_out:,}** | **{total_tok:,}** | **{total_req}** |")
        lines.append("")

        if total_tok > 0:
            cloud_pct = cloud.get("totalTokens",0)*100 / total_tok
            local_pct = local.get("totalTokens",0)*100 / total_tok
            proxy_pct = proxy.get("totalTokens",0)*100 / total_tok
            lines.append(f"Token 分布: Cloud {cloud_pct:.1f}% | Local {local_pct:.1f}% | Proxy {proxy_pct:.1f}%")
            lines.append("")

    # Per-task token breakdown
    per_task_tokens = []
    for r in results:
        pt = r.get("prompt_tokens", 0)
        ct = r.get("completion_tokens", 0)
        tt = r.get("total_tokens", 0)
        per_task_tokens.append({"task": r["task_id"], "prompt": pt, "completion": ct, "total": tt, "tier": r.get("actual_tier","?"), "model": r.get("model_overridden","?")})

    lines.append("### 6.2 每任务 Token 消耗")
    lines.append("")
    lines.append("| Task | Tier | Model | Prompt Tokens | Completion Tokens | Total |")
    lines.append("|------|------|-------|--------------|------------------|-------|")
    sum_pt, sum_ct, sum_tt = 0, 0, 0
    for t in per_task_tokens:
        lines.append(f"| {t['task']} | {t['tier']} | {t['model']} | {t['prompt']:,} | {t['completion']:,} | {t['total']:,} |")
        sum_pt += t["prompt"]; sum_ct += t["completion"]; sum_tt += t["total"]
    lines.append(f"| **合计** | — | — | **{sum_pt:,}** | **{sum_ct:,}** | **{sum_tt:,}** |")
    lines.append("")

    # ── Cost Estimation ──
    lines.append("### 6.3 Token-Saver 成本节省估算")
    lines.append("")

    tier_counts = {"SIMPLE": 0, "MEDIUM": 0, "COMPLEX": 0, "REASONING": 0}
    tier_tokens = {"SIMPLE": 0, "MEDIUM": 0, "COMPLEX": 0, "REASONING": 0}
    for r in results:
        t = r["actual_tier"]
        if t in tier_counts:
            tier_counts[t] += 1
            tier_tokens[t] += r.get("total_tokens", 0)

    cost_input_per_m = {
        "gemini-2.5-flash":           0.15,
        "gemini-2.5-pro":             1.25,
        "gemini-3.1-pro-preview":     2.50,
        "claude-sonnet-4-5-20250929": 15.00,
    }
    cost_output_per_m = {
        "gemini-2.5-flash":           0.60,
        "gemini-2.5-pro":             10.00,
        "gemini-3.1-pro-preview":     15.00,
        "claude-sonnet-4-5-20250929": 75.00,
    }
    baseline_in = 15.00
    baseline_out = 75.00

    lines.append("基线模型: claude-sonnet-4.5 ($15/M input, $75/M output)")
    lines.append("")
    lines.append("| Tier | 任务数 | 路由模型 | 实测 Tokens | 实际成本 | 基线成本 | 节省 |")
    lines.append("|------|--------|---------|------------|---------|---------|------|")
    total_actual = 0
    total_baseline = 0
    for tier in ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]:
        cnt = tier_counts[tier]
        model = TIER_MODEL_MAP[tier]
        tokens = tier_tokens[tier]
        if tokens > 0:
            actual = tokens / 1_000_000 * ((cost_input_per_m.get(model,1) + cost_output_per_m.get(model,1))/2)
            baseline = tokens / 1_000_000 * ((baseline_in + baseline_out)/2)
        else:
            actual = cnt * 2000 / 1_000_000 * ((cost_input_per_m.get(model,1) + cost_output_per_m.get(model,1))/2)
            baseline = cnt * 2000 / 1_000_000 * ((baseline_in + baseline_out)/2)
        total_actual += actual
        total_baseline += baseline
        lines.append(f"| {tier} | {cnt} | {model} | {tokens:,} | ${actual:.5f} | ${baseline:.5f} | {(1-actual/max(baseline,0.001))*100:.0f}% |")
    lines.append(f"| **合计** | {sum(tier_counts.values())} | — | — | **${total_actual:.5f}** | **${total_baseline:.5f}** | **{(1-total_actual/max(total_baseline,0.0001))*100:.1f}%** |")
    lines.append("")
    lines.append(f"**总成本节省: {(1-total_actual/max(total_baseline,0.0001))*100:.1f}%** (节省 ${total_baseline - total_actual:.5f})")
    lines.append("")

    # ── Privacy accuracy ──
    lines.append("## 7. Privacy 路由准确率分析")
    lines.append("")
    privacy_tasks = [r for r in results if r["expected_privacy"] != "S1"]
    safe_tasks = [r for r in results if r["expected_privacy"] == "S1"]
    lines.append(f"- 预期含隐私信息的任务数: {len(privacy_tasks)}")
    lines.append(f"- 预期安全的任务数: {len(safe_tasks)}")
    if privacy_tasks:
        correct_priv = sum(1 for r in privacy_tasks if r["actual_privacy"] and r["actual_privacy"] != "S1")
        lines.append(f"- 隐私任务检测成功率 (true positive): {correct_priv}/{len(privacy_tasks)} ({correct_priv*100//max(len(privacy_tasks),1)}%)")
    if safe_tasks:
        correct_safe = sum(1 for r in safe_tasks if r["actual_privacy"] == "S1")
        false_pos = len(safe_tasks) - correct_safe
        lines.append(f"- 安全任务正确放行率 (true negative): {correct_safe}/{len(safe_tasks)} ({correct_safe*100//max(len(safe_tasks),1)}%)")
        lines.append(f"- 误报数 (false positive): {false_pos}")
    lines.append("")

    # ── Mismatches ──
    mismatches = [r for r in results if r["actual_tier"] != r["expected_tier"] or r["actual_privacy"] != r["expected_privacy"]]
    if mismatches:
        lines.append("## 8. 不匹配项分析")
        lines.append("")
        for r in mismatches:
            lines.append(f"### {r['task_id']}")
            if r["actual_tier"] != r["expected_tier"]:
                lines.append(f"- Tier: 预期 `{r['expected_tier']}`, 实际 `{r['actual_tier']}`")
            if r["actual_privacy"] != r["expected_privacy"]:
                lines.append(f"- Privacy: 预期 `{r['expected_privacy']}`, 实际 `{r['actual_privacy']}`")
            lines.append(f"- Prompt preview: {r['prompt_preview'][:100]}")
            lines.append(f"- Privacy reason: {r.get('privacy_reason', '—')}")
            lines.append("")

    lines.append("---")
    lines.append(f"*报告由 PinchBench × GuardClaw 验证脚本自动生成 — {now}*")

    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    main()
