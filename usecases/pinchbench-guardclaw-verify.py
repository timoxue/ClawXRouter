#!/usr/bin/env python3
"""
PinchBench x GuardClaw Verification — aligned with official PinchBench methodology.

Differences from official benchmark.py:
  - Execution via HTTP API (not CLI) so GuardClaw gateway hooks fire
  - Sequential execution with per-task workspace isolation (same as official)
  - Automated grading uses official _grade_automated (checks workspace files + transcript)
  - LLM judge uses direct yeysai.com API (bypass gateway, same as user requested)
  - Gateway log parsing for GuardClaw routing verification
"""

import concurrent.futures
import glob
import json
import logging
import os
import re
import shutil
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Paths & config
# ---------------------------------------------------------------------------
SKILL_DIR = Path("/Users/a1/Desktop/claw/skill")
TASKS_DIR = SKILL_DIR / "tasks"
SCRIPTS_DIR = SKILL_DIR / "scripts"
REPORT_PATH = Path("/Users/a1/Desktop/claw/Edgeclaw-router/usecases/pinchbench-verification-report.md")
REPORT_JSON = REPORT_PATH.with_suffix(".json")
TRANSCRIPTS_DIR = Path("/tmp/pinchbench/verify/transcripts")
WORKSPACES_DIR = Path("/tmp/pinchbench/verify/workspaces")
GATEWAY_URL = "http://127.0.0.1:18789"
AUTH_TOKEN = "6a7a8f9e318f5417cdd2fab4d90e6be59bd83981dfc3671b"
LOG_DIR = "/tmp/openclaw"
STATS_FILE = Path.home() / ".openclaw" / "guardclaw-stats.json"
JUDGE_API_KEY = "sk-1XuXBpolv2QWkWBJSKXut0HulM6R9FI8flIHg9mC7RjBhX8U"
JUDGE_BASE_URL = "https://yeysai.com/v1"
JUDGE_MODEL = "gemini-2.5-flash"

AGENT_WORKSPACE = Path.home() / ".openclaw" / "workspace-main"
SESSIONS_DIR = Path.home() / ".openclaw" / "agents" / "main" / "sessions"
TIMEOUT_MULTIPLIER = 1.5

RUN_ID = str(int(time.time()))

sys.path.insert(0, str(SCRIPTS_DIR))
from lib_tasks import Task, TaskLoader
from lib_grading import (
    GradeResult,
    _grade_automated,
    _build_judge_prompt,
    _summarize_transcript,
    _normalize_judge_response,
    _format_grading_criteria,
    _normalize_score_dict,
    _average_scores,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("verify")

# ---------------------------------------------------------------------------
# Expected classifications (for routing verification)
# ---------------------------------------------------------------------------
EXPECTED = {
    "task_00_sanity":                 {"tier": "SIMPLE",    "privacy": "S1"},
    "task_01_calendar":               {"tier": "MEDIUM",    "privacy": "S2"},
    "task_02_stock":                  {"tier": "MEDIUM",    "privacy": "S1"},
    "task_03_blog":                   {"tier": "MEDIUM",    "privacy": "S1"},
    "task_04_weather":                {"tier": "MEDIUM",    "privacy": "S1"},
    "task_05_summary":                {"tier": "MEDIUM",    "privacy": "S1"},
    "task_06_events":                 {"tier": "MEDIUM",    "privacy": "S1"},
    "task_07_email":                  {"tier": "SIMPLE",    "privacy": "S1"},
    "task_08_memory":                 {"tier": "SIMPLE",    "privacy": "S1"},
    "task_09_files":                  {"tier": "SIMPLE",    "privacy": "S1"},
    "task_10_workflow":               {"tier": "COMPLEX",   "privacy": "S1"},
    "task_11_clawdhub":               {"tier": "SIMPLE",    "privacy": "S1"},
    "task_12_skill_search":           {"tier": "MEDIUM",    "privacy": "S2"},
    "task_13_image_gen":              {"tier": "MEDIUM",    "privacy": "S1"},
    "task_14_humanizer":              {"tier": "MEDIUM",    "privacy": "S1"},
    "task_15_daily_summary":          {"tier": "COMPLEX",   "privacy": "S1"},
    "task_16_email_triage":           {"tier": "COMPLEX",   "privacy": "S2"},
    "task_17_email_search":           {"tier": "COMPLEX",   "privacy": "S2"},
    "task_18_market_research":        {"tier": "COMPLEX",   "privacy": "S1"},
    "task_19_spreadsheet_summary":    {"tier": "MEDIUM",    "privacy": "S1"},
    "task_20_eli5_pdf_summary":       {"tier": "MEDIUM",    "privacy": "S1"},
    "task_21_openclaw_comprehension": {"tier": "REASONING", "privacy": "S1"},
    "task_22_second_brain":           {"tier": "COMPLEX",   "privacy": "S2"},
}

TIER_MODEL_MAP = {
    "SIMPLE":    "gpt-5-mini",
    "MEDIUM":    "deepseek-v3.2-thinking",
    "COMPLEX":   "glm-5-thinking",
    "REASONING": "claude-opus-4-6-thinking",
}

# ---------------------------------------------------------------------------
# Workspace helpers — mirrors official prepare_task_workspace
# ---------------------------------------------------------------------------

BOOTSTRAP_FILES = {
    "AGENTS.md", "BOOTSTRAP.md", "HEARTBEAT.md", "IDENTITY.md",
    "SOUL.md", "TOOLS.md", "USER.md",
}
BOOTSTRAP_DIRS = {".openclaw", ".git"}


def prepare_workspace_for_task(task: Task) -> None:
    """Clean workspace-main (preserve bootstrap files) and populate with task fixtures."""
    AGENT_WORKSPACE.mkdir(parents=True, exist_ok=True)

    # Remove non-bootstrap files/dirs — leave bootstrap + .openclaw intact
    for item in list(AGENT_WORKSPACE.iterdir()):
        name = item.name
        if name in BOOTSTRAP_FILES:
            continue
        if name in BOOTSTRAP_DIRS:
            continue
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()

    for file_spec in task.workspace_files:
        if "content" in file_spec:
            dest = AGENT_WORKSPACE / file_spec["path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(file_spec["content"])
            continue
        source = SKILL_DIR / "assets" / file_spec.get("source", "")
        dest_rel = file_spec.get("dest") or file_spec.get("path", "")
        if not dest_rel:
            continue
        dest = AGENT_WORKSPACE / dest_rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if source.exists():
            shutil.copy2(str(source), str(dest))
        else:
            logger.warning("  [%s] fixture not found: %s", task.task_id, source)


def snapshot_workspace(task_id: str) -> str:
    """Copy workspace-main → task-specific dir for later grading."""
    dest = WORKSPACES_DIR / task_id
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(str(AGENT_WORKSPACE), str(dest))
    return str(dest)

# ---------------------------------------------------------------------------
# Session transcript helpers
# ---------------------------------------------------------------------------

def _find_session_id(task_id: str) -> Optional[str]:
    """Find session ID from sessions.json by bench user key."""
    store_path = SESSIONS_DIR / "sessions.json"
    if not store_path.exists():
        return None
    try:
        store = json.loads(store_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    bench_key = f"agent:main:openai-user:bench_{RUN_ID}_{task_id}"
    entry = store.get(bench_key)
    if not entry:
        return None
    return entry.get("sessionId")


def load_transcript(task_id: str) -> List[Dict]:
    """Load the session JSONL transcript for a task."""
    session_id = _find_session_id(task_id)
    if not session_id:
        logger.warning("  [%s] session not found in sessions.json", task_id)
        return []

    jsonl_path = SESSIONS_DIR / f"{session_id}.jsonl"
    if not jsonl_path.exists():
        logger.warning("  [%s] transcript file missing: %s", task_id, jsonl_path)
        return []

    events: List[Dict] = []
    for line in jsonl_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def extract_usage_from_transcript(transcript: List[Dict]) -> Dict:
    """Sum token usage from all assistant messages (mirrors official)."""
    totals = {
        "input_tokens": 0, "output_tokens": 0, "total_tokens": 0,
        "cost_usd": 0.0, "request_count": 0,
    }
    for entry in transcript:
        if entry.get("type") != "message":
            continue
        msg = entry.get("message", {})
        if msg.get("role") != "assistant":
            continue
        totals["request_count"] += 1
        usage = msg.get("usage", {})
        totals["input_tokens"] += usage.get("input", 0)
        totals["output_tokens"] += usage.get("output", 0)
        totals["total_tokens"] += usage.get("totalTokens", 0)
        cost = usage.get("cost", {})
        totals["cost_usd"] += cost.get("total", 0.0)
    return totals

# ---------------------------------------------------------------------------
# Gateway log helpers
# ---------------------------------------------------------------------------

def find_latest_log() -> Optional[str]:
    logs = sorted(glob.glob(os.path.join(LOG_DIR, "openclaw-*.log")))
    return logs[-1] if logs else None


def count_lines(path: str) -> int:
    with open(path, "rb") as f:
        return sum(1 for _ in f)


def read_new_lines(path: str, start_line: int) -> List[str]:
    lines: List[str] = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f, 1):
            if i > start_line:
                lines.append(line)
    return lines


def _extract_log_text(line: str) -> Optional[str]:
    try:
        obj = json.loads(line.strip())
    except json.JSONDecodeError:
        return None
    text = obj.get("1", obj.get("0", ""))
    if isinstance(text, dict):
        text = json.dumps(text, ensure_ascii=False)
    return text if isinstance(text, str) else None


def parse_routing_from_lines(lines: List[str]) -> Dict[str, Any]:
    """Parse GuardClaw routing decisions from gateway log lines."""
    r: Dict[str, Any] = {
        "privacy_level": None, "privacy_reason": None, "tier": None,
        "model_overridden": None, "provider_overridden": None,
        "final_decision": None, "log_excerpts": [],
    }
    for raw_line in lines:
        text = _extract_log_text(raw_line)
        if text is None:
            continue
        is_gc = any(k in text for k in ["[GuardClaw]", "[hooks]", "[RouterPipeline]"])
        if not is_gc:
            continue

        try:
            obj = json.loads(raw_line.strip())
            ts = obj.get("_meta", {}).get("date", "")
        except Exception:
            ts = ""
        r["log_excerpts"].append({"ts": ts, "msg": text})

        m = re.search(r'"tier"\s*:\s*"(SIMPLE|MEDIUM|COMPLEX|REASONING)"', text)
        if m and r["tier"] is None:
            r["tier"] = m.group(1)

        if "model overridden to" in text and r["model_overridden"] is None:
            m2 = re.search(r"model overridden to (\S+)", text)
            if m2:
                r["model_overridden"] = m2.group(1)

        if "provider overridden to" in text and r["provider_overridden"] is None:
            m2 = re.search(r"provider overridden to (\S+)", text)
            if m2:
                r["provider_overridden"] = m2.group(1)

        if "[onUserMessage]" in text and "Final:" in text:
            r["final_decision"] = text
            m2 = re.search(r"Final: (S[123])", text)
            if m2:
                r["privacy_level"] = m2.group(1)
            rm = re.search(r"\((.*?)\)\s*$", text)
            if rm:
                reason = rm.group(1)
                if not reason.startswith("tier="):
                    r["privacy_reason"] = reason[:120]

        if "[onUserMessage]" not in text and "Final:" in text:
            m2 = re.search(r"Final: (S[123])", text)
            if m2 and r["privacy_level"] is None:
                r["privacy_level"] = m2.group(1)
    return r


def _empty_routing() -> Dict[str, Any]:
    return {
        "privacy_level": None, "privacy_reason": None, "tier": None,
        "model_overridden": None, "provider_overridden": None,
        "final_decision": None, "log_excerpts": [],
    }

# ---------------------------------------------------------------------------
# GuardClaw stats helpers
# ---------------------------------------------------------------------------

def read_stats() -> Dict:
    try:
        return json.loads(STATS_FILE.read_text())
    except Exception:
        return {}


def diff_stats(before: Dict, after: Dict) -> Dict:
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

# ---------------------------------------------------------------------------
# HTTP task execution — sequential, with workspace isolation
# ---------------------------------------------------------------------------

def execute_task_http(task: Task) -> Dict:
    """Execute a single task via Gateway HTTP API with workspace isolation."""
    task_timeout = int(task.timeout_seconds * TIMEOUT_MULTIPLIER)
    log_path = find_latest_log()
    log_line_before = count_lines(log_path) if log_path else 0

    bench_user = f"bench_{RUN_ID}_{task.task_id}"

    payload = json.dumps({
        "model": "openclaw",
        "user": bench_user,
        "messages": [{"role": "user", "content": task.prompt}],
        "max_tokens": 4096,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{GATEWAY_URL}/v1/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {AUTH_TOKEN}",
        },
    )

    start = time.time()
    response_text = ""
    status = "success"
    timed_out = False
    usage_data: Dict = {}
    try:
        with urllib.request.urlopen(req, timeout=task_timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            response_text = body.get("choices", [{}])[0].get("message", {}).get("content", "")
            usage_data = body.get("usage", {})
    except urllib.error.HTTPError as e:
        status = "error"
        try:
            response_text = e.read().decode("utf-8")
        except Exception:
            response_text = str(e)
    except Exception as e:
        if "timed out" in str(e).lower():
            timed_out = True
            status = "timeout"
        else:
            status = "error"
        response_text = str(e)

    elapsed = time.time() - start

    # Parse GuardClaw routing from gateway logs
    time.sleep(0.5)
    routing = _empty_routing()
    if log_path:
        new_lines = read_new_lines(log_path, log_line_before)
        routing = parse_routing_from_lines(new_lines)

    # Load full session transcript (wait briefly for write to flush)
    time.sleep(1.5)
    transcript = load_transcript(task.task_id)
    if not transcript:
        transcript = [
            {"type": "message", "message": {"role": "user", "content": task.prompt}},
            {"type": "message", "message": {"role": "assistant", "content": response_text,
                                             "usage": usage_data}},
        ]

    # Snapshot workspace for later grading
    workspace_path = snapshot_workspace(task.task_id)

    usage = extract_usage_from_transcript(transcript)
    if not usage["total_tokens"]:
        usage = {
            "input_tokens": usage_data.get("prompt_tokens", 0),
            "output_tokens": usage_data.get("completion_tokens", 0),
            "total_tokens": usage_data.get("total_tokens", 0),
            "cost_usd": 0.0,
            "request_count": 1,
        }

    return {
        "task_id": task.task_id,
        "status": status,
        "timed_out": timed_out,
        "transcript": transcript,
        "usage": usage,
        "workspace": workspace_path,
        "execution_time": elapsed,
        "exit_code": 0 if status == "success" else -1,
        "stdout": response_text,
        "stderr": "",
        "routing": routing,
    }

# ---------------------------------------------------------------------------
# LLM Judge — direct yeysai.com API (bypass gateway)
# ---------------------------------------------------------------------------

def llm_judge_direct(prompt: str, retries: int = 3) -> str:
    from openai import OpenAI
    client = OpenAI(base_url=JUDGE_BASE_URL, api_key=JUDGE_API_KEY)
    last_err = None
    for attempt in range(retries):
        try:
            resp = client.chat.completions.create(
                model=JUDGE_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
                max_tokens=4096,
            )
            content = resp.choices[0].message.content
            if content and content.strip():
                return content
        except Exception as e:
            last_err = e
            logger.warning("  Judge API error attempt %d/%d: %s", attempt + 1, retries, e)
        if attempt < retries - 1:
            time.sleep(2 * (attempt + 1))
    if last_err:
        raise last_err
    return ""


def _parse_judge_text(raw_text: str) -> Dict:
    """Parse JSON response from judge (handles fences, partial JSON, prose fallback)."""
    stripped = raw_text.strip()
    if stripped.startswith("{"):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    fence_m = re.search(r"```(?:json)?\s*", raw_text)
    if fence_m:
        after = raw_text[fence_m.end():]
        close_fence = after.rfind("```")
        blob = after[:close_fence].strip() if close_fence > 0 else after.strip()
        try:
            return json.loads(blob)
        except json.JSONDecodeError:
            pass

    brace_depth = 0
    candidates: List[str] = []
    current: List[str] = []
    for ch in raw_text:
        if ch == "{":
            if brace_depth == 0:
                current = []
            brace_depth += 1
        if brace_depth > 0:
            current.append(ch)
        if ch == "}":
            brace_depth -= 1
            if brace_depth == 0 and current:
                candidates.append("".join(current))

    for c in reversed(candidates):
        try:
            p = json.loads(c)
            if isinstance(p, dict) and ("scores" in p or "total" in p):
                return p
        except json.JSONDecodeError:
            continue
    for c in reversed(candidates):
        try:
            p = json.loads(c)
            if isinstance(p, dict):
                return p
        except json.JSONDecodeError:
            continue

    score_m = re.search(r"(?:total|overall|final)\s*(?:score)?[:\s]*(0\.\d+|1\.0+)", raw_text, re.I)
    if score_m:
        try:
            t = float(score_m.group(1))
            if 0 <= t <= 1:
                return {"scores": {}, "total": t, "notes": "Extracted from prose"}
        except ValueError:
            pass
    return {}


def _safe_summarize_transcript(transcript: List[Dict]) -> str:
    """Summarize transcript handling both list and string content formats."""
    parts: List[str] = []
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        role = msg.get("role")
        content = msg.get("content", [])
        if role == "assistant":
            if isinstance(content, str):
                if content.strip():
                    parts.append(f"Assistant: {content[:2000]}")
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, str):
                        if item.strip():
                            parts.append(f"Assistant: {item[:2000]}")
                    elif isinstance(item, dict):
                        if item.get("type") == "toolCall":
                            args_str = json.dumps(item.get("arguments", {}), ensure_ascii=False)
                            parts.append(
                                f"Tool: {item.get('name')}({args_str[:2000]})"
                            )
                        elif item.get("type") == "text":
                            t = item.get("text", "").strip()
                            if t:
                                parts.append(f"Assistant: {t[:2000]}")
        elif role == "toolResult":
            if isinstance(content, str):
                parts.append(f"Result: {content[:2000]}")
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, str):
                        parts.append(f"Result: {item[:2000]}")
                    elif isinstance(item, dict) and item.get("text"):
                        parts.append(f"Result: {item['text'][:2000]}")
        elif role == "user":
            if isinstance(content, str):
                parts.append(f"User: {content[:1000]}")
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, str):
                        parts.append(f"User: {item[:1000]}")
                    elif isinstance(item, dict) and item.get("text"):
                        parts.append(f"User: {item['text'][:1000]}")
    return "\n".join(parts)


def grade_llm_judge_direct(
    task: Task,
    execution_result: Dict,
) -> GradeResult:
    """Run LLM judge via direct API (not through gateway)."""
    transcript_summary = _safe_summarize_transcript(execution_result.get("transcript", []))
    rubric = task.llm_judge_rubric or _format_grading_criteria(task)
    prompt = _build_judge_prompt(task, transcript_summary, rubric)

    try:
        raw_text = llm_judge_direct(prompt)
    except Exception as e:
        logger.warning("  [%s] LLM judge failed: %s", task.task_id, e)
        return GradeResult(task.task_id, 0.0, 1.0, "llm_judge", {}, f"Judge error: {e}")

    parsed = _parse_judge_text(raw_text)
    normalized = _normalize_judge_response(parsed)
    breakdown = normalized.get("scores", {})
    total = normalized.get("total")
    notes = normalized.get("notes", "")
    return GradeResult(
        task_id=task.task_id,
        score=float(total) if total is not None else 0.0,
        max_score=1.0,
        grading_type="llm_judge",
        breakdown=_normalize_score_dict(breakdown),
        notes=str(notes) if notes else "",
    )

# ---------------------------------------------------------------------------
# Combined grading (mirrors official grade_task logic)
# ---------------------------------------------------------------------------

def grade_task_local(task: Task, execution_result: Dict) -> GradeResult:
    """Grade using official automated + our direct LLM judge."""
    grading_type = task.grading_type

    if grading_type == "automated":
        return _grade_automated(task, execution_result)

    if grading_type == "llm_judge":
        return grade_llm_judge_direct(task, execution_result)

    if grading_type == "hybrid":
        auto_result = _grade_automated(task, execution_result)
        llm_result = grade_llm_judge_direct(task, execution_result)
        weights = task.grading_weights or {"automated": 0.5, "llm_judge": 0.5}
        auto_w = float(weights.get("automated", 0.5))
        llm_w = float(weights.get("llm_judge", 0.5))
        total_w = auto_w + llm_w
        if total_w <= 0:
            auto_w = llm_w = 0.5
            total_w = 1.0
        combined_score = (auto_result.score * auto_w + llm_result.score * llm_w) / total_w
        breakdown = {
            **{f"auto.{k}": v for k, v in auto_result.breakdown.items()},
            **{f"judge.{k}": v for k, v in llm_result.breakdown.items()},
        }
        notes = " | ".join(filter(None, [auto_result.notes, llm_result.notes]))
        return GradeResult(
            task_id=task.task_id,
            score=combined_score,
            max_score=1.0,
            grading_type="hybrid",
            breakdown=breakdown,
            notes=notes,
        )

    raise ValueError(f"Unknown grading type: {grading_type}")

# ---------------------------------------------------------------------------
# Cost estimation
# ---------------------------------------------------------------------------
COST_INPUT = {
    "gpt-5-mini": 0.15,
    "deepseek-v3.2-thinking": 0.20,
    "glm-5-thinking": 0.70,
    "claude-opus-4-6-thinking": 15.00,
}
COST_OUTPUT = {
    "gpt-5-mini": 0.60,
    "deepseek-v3.2-thinking": 0.80,
    "glm-5-thinking": 0.70,
    "claude-opus-4-6-thinking": 75.00,
}
BASELINE_MODEL = "claude-opus-4-6-thinking"

# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def generate_report(entries: List[Dict], token_diff: Dict) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    L: List[str] = []
    L.append("# PinchBench x GuardClaw 路由验证 + 跑分报告")
    L.append(f"\n> 生成时间: {now}")
    L.append("> Gateway: `127.0.0.1:18789` | GuardClaw: Privacy Router + Token-Saver Router")
    L.append("> Token-Saver: SIMPLE→gpt-5-mini | MEDIUM→deepseek-v3.2-thinking | COMPLEX→glm-5-thinking | REASONING→claude-opus-4-6-thinking")
    L.append("> PinchBench LLM Judge: gemini-2.5-flash via yeysai.com (直连)")
    L.append("> 评分方法: 官方 PinchBench grading (automated + llm_judge + hybrid)")
    L.append("> 执行模式: sequential with per-task workspace isolation")
    L.append("")

    total = len(entries)
    tier_ok = sum(1 for e in entries if e.get("actual_tier") == e.get("expected_tier") and e.get("actual_tier"))
    tier_tested = sum(1 for e in entries if e.get("actual_tier"))
    priv_ok = sum(1 for e in entries if e.get("actual_privacy") == e.get("expected_privacy") and e.get("actual_privacy"))
    priv_tested = sum(1 for e in entries if e.get("actual_privacy"))
    scores = [e["score"] for e in entries if e.get("score") is not None]
    avg_score = statistics.mean(scores) if scores else 0
    total_time = sum(e.get("elapsed_s", 0) for e in entries)
    errors = sum(1 for e in entries if e.get("status") == "error")

    L.append("## 1. 执行摘要")
    L.append("")
    L.append("| 指标 | 数值 |")
    L.append("|------|------|")
    L.append(f"| 总任务数 | {total} |")
    L.append(f"| Token-Saver 路由正确率 | {tier_ok}/{tier_tested} ({tier_ok*100//max(tier_tested,1)}%) |")
    L.append(f"| Privacy 路由正确率 | {priv_ok}/{priv_tested} ({priv_ok*100//max(priv_tested,1)}%) |")
    L.append(f"| PinchBench 平均分 | **{avg_score:.3f}** / 1.0 |")
    L.append(f"| PinchBench 总分 | {sum(scores):.2f} / {len(scores)}.0 |")
    L.append(f"| 累计耗时 | {total_time:.0f}s |")
    L.append(f"| 请求错误数 | {errors} |")
    L.append("")

    L.append("## 2. 隐私路由验证表")
    L.append("")
    L.append("| Task | 预期 | 实际 | Match | 理由 |")
    L.append("|------|------|------|-------|------|")
    for e in entries:
        match = "✅" if e.get("actual_privacy") == e.get("expected_privacy") else "❌"
        reason = (e.get("privacy_reason") or "-")[:60].replace("|", "/")
        L.append(f"| {e['task_id']} | {e['expected_privacy']} | {e.get('actual_privacy') or '-'} | {match} | {reason} |")
    L.append("")

    L.append("## 3. Token-Saver 四级路由验证表")
    L.append("")
    L.append("| Task | 预期 Tier | 实际 Tier | Match | model overridden | 耗时(s) |")
    L.append("|------|----------|----------|-------|-----------------|---------|")
    for e in entries:
        match = "✅" if e.get("actual_tier") == e.get("expected_tier") else "❌"
        model = e.get("model_overridden") or "-"
        L.append(f"| {e['task_id']} | {e['expected_tier']} | {e.get('actual_tier') or '-'} | {match} | `{model}` | {e.get('elapsed_s', 0):.1f} |")
    L.append("")

    L.append("## 4. PinchBench 跑分表")
    L.append("")
    L.append("| Task | 评分方式 | 分数 | Breakdown | Notes |")
    L.append("|------|---------|------|-----------|-------|")
    for e in entries:
        bd = e.get("breakdown", {})
        bd_str = ", ".join(f"{k}={v:.2f}" for k, v in bd.items())[:100] if bd else "-"
        notes = (e.get("grade_notes") or "-")[:80].replace("|", "/")
        L.append(f"| {e['task_id']} | {e.get('grading_type','?')} | **{e.get('score', 0):.3f}** | {bd_str} | {notes} |")
    L.append("")

    L.append("## 5. 每任务定量指标")
    L.append("")
    L.append("| # | Task | Privacy | Tier | Model | Score | 耗时(s) | Tokens | Status |")
    L.append("|---|------|---------|------|-------|-------|---------|--------|--------|")
    for i, e in enumerate(entries):
        L.append(f"| {i} | {e['task_id']} | {e.get('actual_privacy') or '-'} | {e.get('actual_tier') or '-'} | {e.get('model_overridden') or '-'} | {e.get('score', 0):.3f} | {e.get('elapsed_s', 0):.1f} | {e.get('total_tokens', 0):,} | {e.get('status', '?')} |")
    L.append("")

    L.append("## 6. Token 消耗统计")
    L.append("")
    if token_diff:
        cloud = token_diff.get("cloud", {})
        local = token_diff.get("local", {})
        proxy = token_diff.get("proxy", {})
        L.append("| 通道 | Input | Output | Total | 请求数 |")
        L.append("|------|-------|--------|-------|--------|")
        L.append(f"| Cloud | {cloud.get('inputTokens',0):,} | {cloud.get('outputTokens',0):,} | {cloud.get('totalTokens',0):,} | {cloud.get('requestCount',0)} |")
        L.append(f"| Local | {local.get('inputTokens',0):,} | {local.get('outputTokens',0):,} | {local.get('totalTokens',0):,} | {local.get('requestCount',0)} |")
        L.append(f"| Proxy | {proxy.get('inputTokens',0):,} | {proxy.get('outputTokens',0):,} | {proxy.get('totalTokens',0):,} | {proxy.get('requestCount',0)} |")
    L.append("")

    L.append("## 7. Token-Saver 成本节省")
    L.append("")
    tier_tokens: Dict[str, int] = {"SIMPLE": 0, "MEDIUM": 0, "COMPLEX": 0, "REASONING": 0}
    tier_counts: Dict[str, int] = {"SIMPLE": 0, "MEDIUM": 0, "COMPLEX": 0, "REASONING": 0}
    for e in entries:
        t = e.get("actual_tier")
        if t in tier_tokens:
            tier_tokens[t] += e.get("total_tokens", 0)
            tier_counts[t] += 1
    L.append("| Tier | 任务数 | 模型 | Tokens | 实际成本 | 基线成本 | 节省 |")
    L.append("|------|--------|------|--------|---------|---------|------|")
    total_actual, total_baseline = 0.0, 0.0
    for tier in ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]:
        model = TIER_MODEL_MAP[tier]
        tokens = tier_tokens[tier]
        cnt = tier_counts[tier]
        if tokens > 0:
            ci = COST_INPUT.get(model, 1)
            co = COST_OUTPUT.get(model, 1)
            actual = tokens / 1e6 * (ci + co) / 2
            baseline = tokens / 1e6 * (COST_INPUT[BASELINE_MODEL] + COST_OUTPUT[BASELINE_MODEL]) / 2
        else:
            actual = baseline = 0
        total_actual += actual
        total_baseline += baseline
        saving = f"{(1 - actual / max(baseline, 1e-9)) * 100:.0f}%" if baseline > 0 else "-"
        L.append(f"| {tier} | {cnt} | {model} | {tokens:,} | ${actual:.5f} | ${baseline:.5f} | {saving} |")
    total_saving = f"{(1 - total_actual / max(total_baseline, 1e-9)) * 100:.1f}%" if total_baseline > 0 else "-"
    L.append(f"| **Total** | {sum(tier_counts.values())} | - | - | **${total_actual:.5f}** | **${total_baseline:.5f}** | **{total_saving}** |")
    L.append("")

    L.append("## 8. Privacy 路由准确率")
    L.append("")
    priv_tasks = [e for e in entries if e.get("expected_privacy") != "S1"]
    safe_tasks = [e for e in entries if e.get("expected_privacy") == "S1"]
    if priv_tasks:
        tp = sum(1 for e in priv_tasks if e.get("actual_privacy") and e["actual_privacy"] != "S1")
        L.append(f"- 隐私任务 True Positive: {tp}/{len(priv_tasks)}")
    if safe_tasks:
        tn = sum(1 for e in safe_tasks if e.get("actual_privacy") == "S1")
        fp = len(safe_tasks) - tn
        L.append(f"- 安全任务 True Negative: {tn}/{len(safe_tasks)}")
        L.append(f"- 误报 (False Positive): {fp}")
    L.append("")

    mismatches = [e for e in entries if e.get("actual_tier") != e.get("expected_tier") or e.get("actual_privacy") != e.get("expected_privacy")]
    if mismatches:
        L.append("## 9. 路由不匹配项分析")
        L.append("")
        for e in mismatches:
            L.append(f"### {e['task_id']}")
            if e.get("actual_tier") != e.get("expected_tier"):
                L.append(f"- Tier: 预期 `{e['expected_tier']}`, 实际 `{e.get('actual_tier')}`")
            if e.get("actual_privacy") != e.get("expected_privacy"):
                L.append(f"- Privacy: 预期 `{e['expected_privacy']}`, 实际 `{e.get('actual_privacy')}`")
            L.append(f"- Score: {e.get('score', 0):.3f}")
            L.append("")

    L.append("---")
    L.append(f"*PinchBench x GuardClaw 自动验证报告 — {now}*")
    return "\n".join(L)

# ---------------------------------------------------------------------------
# Main — sequential execution + parallel grading
# ---------------------------------------------------------------------------

def main():
    loader = TaskLoader(TASKS_DIR)
    tasks = loader.load_all_tasks()
    logger.info("Loaded %d tasks", len(tasks))

    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    WORKSPACES_DIR.mkdir(parents=True, exist_ok=True)

    stats_before = read_stats()

    # ── Phase 1: sequential execution with workspace isolation ─────────
    logger.info("=" * 70)
    logger.info("Phase 1: Sequential execution (%d tasks, per-task timeout x%.1f)", len(tasks), TIMEOUT_MULTIPLIER)
    logger.info("=" * 70)

    exec_results: Dict[str, Dict] = {}
    for i, task in enumerate(tasks, 1):
        logger.info("")
        logger.info("━" * 60)
        task_timeout = int(task.timeout_seconds * TIMEOUT_MULTIPLIER)
        logger.info("[%d/%d] %s (%s, timeout=%ds [%ds x %.1f])", i, len(tasks), task.task_id, task.name, task_timeout, task.timeout_seconds, TIMEOUT_MULTIPLIER)
        logger.info("━" * 60)

        prepare_workspace_for_task(task)
        wfiles = list(AGENT_WORKSPACE.rglob("*"))
        wfiles = [f for f in wfiles if f.is_file()]
        logger.info("  Workspace: %d files prepared", len(wfiles))

        result = execute_task_http(task)
        exec_results[task.task_id] = result

        t_len = len(result["transcript"])
        usage = result["usage"]
        logger.info("  ← status=%s  time=%.1fs  transcript=%d events  tokens=%d",
                     result["status"], result["execution_time"], t_len, usage.get("total_tokens", 0))

        # Save transcript
        ts_path = TRANSCRIPTS_DIR / f"{task.task_id}.jsonl"
        with open(ts_path, "w", encoding="utf-8") as f:
            for ev in result["transcript"]:
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")

    logger.info("")
    logger.info("Phase 1 complete. %d results collected.", len(exec_results))

    # ── Phase 2: parallel grading ──────────────────────────────────────
    logger.info("")
    logger.info("=" * 70)
    logger.info("Phase 2: Grading (%d tasks, parallel LLM judge)", len(tasks))
    logger.info("=" * 70)

    grades: Dict[str, GradeResult] = {}

    def _grade(task: Task) -> Tuple[str, GradeResult]:
        res = exec_results[task.task_id]
        try:
            g = grade_task_local(task, res)
        except Exception as e:
            logger.warning("  [%s] grading failed: %s", task.task_id, e)
            g = GradeResult(task.task_id, 0.0, 1.0, task.grading_type, {}, f"Error: {e}")
        return task.task_id, g

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(_grade, t): t for t in tasks}
        for fut in concurrent.futures.as_completed(futures):
            tid, g = fut.result()
            grades[tid] = g
            emoji = "✅" if g.score >= 0.7 else "⚠️" if g.score > 0 else "❌"
            logger.info("  %s [%s] score=%.3f (%s)  %s",
                         emoji, tid, g.score, g.grading_type,
                         f"notes={g.notes[:80]}" if g.notes else "")

    logger.info("")
    logger.info("Phase 2 complete.")

    # ── Phase 3: assemble entries & generate report ────────────────────
    logger.info("")
    logger.info("=" * 70)
    logger.info("Phase 3: Report generation")
    logger.info("=" * 70)

    entries: List[Dict] = []
    for task in tasks:
        res = exec_results[task.task_id]
        routing = res.get("routing", _empty_routing())
        grade = grades[task.task_id]
        exp = EXPECTED.get(task.task_id, {})

        entry = {
            "task_id": task.task_id,
            "task_name": task.name,
            "grading_type": grade.grading_type,
            "expected_tier": exp.get("tier", "?"),
            "expected_privacy": exp.get("privacy", "?"),
            "actual_tier": routing.get("tier"),
            "actual_privacy": routing.get("privacy_level"),
            "privacy_reason": routing.get("privacy_reason"),
            "model_overridden": routing.get("model_overridden"),
            "provider_overridden": routing.get("provider_overridden"),
            "log_excerpts": (routing.get("log_excerpts") or [])[-6:],
            "elapsed_s": round(res["execution_time"], 2),
            "status": res["status"],
            "total_tokens": res["usage"].get("total_tokens", 0),
            "input_tokens": res["usage"].get("input_tokens", 0),
            "output_tokens": res["usage"].get("output_tokens", 0),
            "score": grade.score,
            "max_score": grade.max_score,
            "breakdown": grade.breakdown,
            "grade_notes": grade.notes,
        }
        entries.append(entry)

    time.sleep(1)
    stats_after = read_stats()
    token_diff = diff_stats(stats_before, stats_after)

    REPORT_JSON.write_text(
        json.dumps({"entries": entries, "token_stats": token_diff, "run_id": RUN_ID},
                   indent=2, ensure_ascii=False),
        encoding="utf-8"
    )
    logger.info("Raw JSON → %s", REPORT_JSON)

    report = generate_report(entries, token_diff)
    REPORT_PATH.write_text(report, encoding="utf-8")
    logger.info("Report → %s", REPORT_PATH)

    scores = [e["score"] for e in entries]
    avg = statistics.mean(scores) if scores else 0
    logger.info("")
    logger.info("=" * 70)
    logger.info("DONE. Average PinchBench score: %.3f / 1.0  (total: %.2f / %d)",
                avg, sum(scores), len(scores))
    logger.info("=" * 70)


if __name__ == "__main__":
    main()
