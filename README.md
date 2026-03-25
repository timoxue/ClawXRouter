<div align="center">
  <img src="../assets/clawxrouter-logo.png" alt="ClawXRouter Logo" width="25%">
</div>

<h3 align="center">
Secure · Efficient · Balanced
</h3>

<p align="center">
  Edge-Cloud Collaborative AI Agent Routing Plugin<br>
  <b>ClawXRouter</b>: Automatically route every request through the best path
</p>

<p align="center">
  <a href="../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://github.com/openbmb/clawxrouter"><img src="https://img.shields.io/github/stars/openbmb/clawxrouter?style=for-the-badge" alt="Stars"></a>
  <a href="https://github.com/openbmb/clawxrouter/issues"><img src="https://img.shields.io/github/issues/openbmb/clawxrouter?style=for-the-badge" alt="Issues"></a>
</p>

<p align="center">
    【<a href="./README_zh.md"><b>中文</b></a> | English】
</p>

---

**What's New** 🔥

- **[2026.03.25]** 🎉 ClawXRouter is now open source — Edge-Cloud Collaborative AI Agent Routing

---

## 📑 Table of Contents

- [💡 About ClawXRouter](#-about-clawxrouter)
- [🎬 Demo](#-demo)
- [📦 Quick Start](#-quick-start)
- [📈 Cost-Effective Routing: Beat Sonnet at 40% of the Price!](#-cost-effective-routing-beat-sonnet-at-40-of-the-price)
- [🔧 Custom Configuration](#-custom-configuration)
- [🔌 Supported Edge Providers](#-supported-edge-providers)
- [🔒 Three-Level Privacy Routing](#-three-level-privacy-routing)
- [💰 Cost-Aware Routing](#-cost-aware-routing)
- [🚀 Composable Routing Pipeline](#-composable-routing-pipeline)
- [🏗️ Code Structure](#️-code-structure)
- [🤝 Contributing](#-contributing)
- [📖 References](#-references)

---

## 💡 About ClawXRouter

ClawXRouter is an **Edge-Cloud Collaborative AI Agent Routing Plugin**, jointly developed by [THUNLP (Tsinghua University)](https://nlp.csai.tsinghua.edu.cn), [Renmin University of China](http://ai.ruc.edu.cn/), [AI9Stars](https://github.com/AI9Stars), [ModelBest](https://modelbest.cn/en), and [OpenBMB](https://www.openbmb.cn/home), built on top of [OpenClaw](https://github.com/openclaw/openclaw).

AI Agents are profoundly changing how developers work every day. However, during real-world deployment, the current Agent usage patterns expose three major problems:

- **"Afraid to use" the cloud** — When an Agent analyzes a customer data sheet, names, phone numbers, and ID numbers are sent to the cloud along with the context. A single data analysis session exposes customer privacy to third-party servers — the data leakage risk is unacceptable.
- **"Can't afford" the cloud** — A large number of simple tasks (e.g., using grep to find a function call) are processed by expensive top-tier models. Most tokens are spent on tasks that cheaper models could easily handle.
- **"Can't rely on" the edge** — Local models are limited by compute power and parameter scale, struggling with complex reasoning, multi-file refactoring, and other difficult tasks. Simple data summarization and format conversion work fine, but multi-dimensional cross-analysis and anomaly detection are beyond their reach — the edge alone cannot meet real-world needs.

Afraid to use the cloud, can't afford the cloud, can't rely on the edge — **edge-cloud collaboration is the optimal solution**. The edge agent is like a personal physician, familiar with user habits, preferences, and private data, handling common issues directly; the cloud agent is like a specialist, with outstanding expertise but who shouldn't have access to the patient's complete private information. Effective collaboration isn't about replacing one with the other, but having the personal physician organize the necessary medical information and coordinate with the right specialist. The key to making this collaboration work is one core question: **Which path should each request take?** This is exactly the problem that a routing mechanism solves.

To address these three pain points, ClawXRouter provides corresponding solutions:

- **🔒 Afraid to use → Three-Level Privacy Routing**: Automatically identifies sensitive data. Confidential information (S3) is physically isolated locally, processed offline by edge models, and completely invisible to the cloud — fundamentally eliminating leakage risk so users can **use it with confidence**. When code review encounters an API Key, the request never leaves the machine.
- **💰 Can't afford → Cost-Aware Routing**: An edge-side small model acts as LLM-as-Judge, classifying tasks into five complexity levels and routing them to cloud models at different price tiers — saving 58% in costs while scoring 6.3% higher on PinchBench, so users can **afford to use it**. Grepping a function name goes to a cheap model instead of an expensive top-tier one.
- **🔗 Can't rely on → Smart Redaction & Forwarding**: For complex tasks involving sensitive information where edge models fall short, there's no need to struggle — for scenarios like multi-file complex data analysis, data is automatically redacted before forwarding to the cloud (S2), protecting privacy while leveraging cloud expertise, so users can **use it effectively**.
- **🎛️ Personalization → Composable Pipeline & Dashboard**: Privacy routing and cost-aware routing work together in the same pipeline through weighting and short-circuit strategies, complemented by a visual Dashboard that supports rule customization, instant configuration changes, and real-time testing, allowing every user to flexibly adjust according to their own needs.

Both routing systems run in the same composable pipeline: the edge-side dual engine (rule detection ~0ms + local LLM semantic detection ~1-2s) evaluates the sensitivity and complexity of each request in real-time, with security-first short-circuiting and cost optimization applied as needed. Developers don't need to modify business logic to achieve seamless edge-cloud collaboration: **"public data to the cloud, sensitive data redacted, confidential data stays local"**.


<div align="center">
  <img src="../assets/clawxrouter-arch.png" alt="ClawXRouter Architecture" width="90%">
</div>

---

## 🎬 Demo

<div align="center">
  <a href=""><img src="" width="70%"></a>
</div>

---

## 📦 Quick Start

### Installation

```bash
# Prerequisites: OpenClaw is already installed
npm install -g @openbmb/clawxrouter

# (Optional) Install local inference backend
ollama pull openbmb/minicpm4.1
ollama serve
```

### Launch

```bash
openclaw gateway
# ClawXRouter Ready! Dashboard → http://127.0.0.1:18789/plugins/clawxrouter/stats
```

---

## 📈 Cost-Effective Routing: Beat Sonnet at 40% of the Price!

Routing effectiveness validated using [PinchBench](https://pinchbench.com) (23 OpenClaw Agent benchmarks).

### Five-Level Classification & Model Configuration

| Level | Description | Default Model |
|-------|-------------|---------------|
| SIMPLE | Summarization, rewriting, simple Q&A, greetings | `glm-4.5-air` |
| MEDIUM | Writing emails, scripts, data analysis, project scaffolding | `minimax-m2.5` |
| COMPLEX | Batch email sorting, multi-file creation, structured data extraction | `deepseek-v3.2` |
| RESEARCH | Long-form writing, multi-source integration workflows | `glm-5` |
| REASONING | Deep PDF analysis, mathematical proofs, experiment design | `kimi-k2.5` |

### Results

| Approach | PinchBench Score (Best / Avg) | Cost |
|----------|-------------------------------|------|
| **ClawX Routing (5-model mix)** | **93.2% / 89.6%** | **$2.36** |
| All Sonnet 4.6 | 86.9% / 79.2% | $5.63 |

> **58% cost savings with 6.3% higher scores.** See the [PinchBench official leaderboard](https://pinchbench.com) for details.

---

## 🔧 Custom Configuration

All configuration supports two modification methods: **Dashboard real-time editing** (recommended) or **JSON file** (suitable for scripted deployments).

### Dashboard Configuration (Recommended)

Open `http://127.0.0.1:18789/plugins/clawxrouter/stats` — all changes take effect immediately without restart.

#### Detection Rules

**Router Rules** Tab → Expand **Privacy Router** card:

1. **Keywords** — Directly add/remove S2, S3 keyword tags
   - Left column **S2 — Sensitive (Redact → Cloud)**: Type and click `Add`, e.g., `password`, `api_key`
   - Right column **S3 — Confidential (Local Model Only)**: e.g., `ssh`, `private_key`, `.pem`
2. Expand **Advanced Configuration** → **Detection Rules (Regex & Tool Filters)**:
   - **Regex Patterns**: Add regex, e.g., `(?:mysql|postgres|mongodb)://[^\s]+`
   - **Sensitive Tool Names**: e.g., `execute_sql`, `sudo`
   - **Sensitive File Paths**: e.g., `~/secrets`, `~/private`, `~/.ssh`, `~/.aws`, `~/.config/credentials`
3. Click **Save Privacy Router**

#### Detector Combination

**Privacy Router** → **Advanced Configuration** → **When to Run**:

Each phase has two Chip buttons (click to toggle on/off):

| Phase | Keyword & Regex | LLM Classifier |
|-------|:-:|:-:|
| User Message | ✅ | ✅ |
| Before Tool Runs | ✅ | — |
| After Tool Runs | ✅ | ✅ |

Click **Save Privacy Router** to save.

#### Pipeline Execution Order

**Router Rules** Tab → Click **Router Execution Order (Advanced)** to expand:

- Each of the three phases has a tag list; click a router from the Picker below to add, drag to reorder, ✕ to remove
- Click **Save Execution Order**

#### Custom Routers

**Router Rules** Tab → Bottom **Add Custom Router**:

1. Enter a router ID (e.g., `content-filter`), click **Add Router**
2. After the card expands, configure: Enabled toggle, S2/S3 keywords and regex, custom Prompt
3. Automatically registered to the pipeline after saving

#### Prompt Editing

Each router card has an embedded Prompt editing area:

| Router | Editable Prompt | Location |
|--------|----------------|----------|
| Privacy Router | `detection-system` | Displayed directly in the card |
| Cost-Optimizer | `cost-optimizer-judge` | Inside Cost-Optimizer card |

Edit the text area directly — **Save** takes effect immediately, **Reset** restores defaults.

#### Real-Time Testing

Verify effects immediately after modifying configuration:

- **Full Pipeline Test**: **Test Classification** panel at the top of Router Rules — enter a message, select a phase, view merged results and individual router decisions
- **Single Router Test**: **Test** area at the bottom of each router card — test only that router

### JSON Configuration

Configuration file path: `~/.openclaw/clawxrouter.json` — content saved from the Dashboard is also written to this file.

#### Detection Rules

```json
{
  "privacy": {
    "rules": {
      "keywords": {
        "S2": [
          "password", "api_key", "secret", "token", "credential", "auth_token",
          "salary", "地址", "电话", "手机号", "合同", "客户", "甲方", "乙方",
          "交易", "金额", "intranet", "域控"
        ],
        "S3": [
          "ssh", "id_rsa", "private_key", ".pem", ".key", ".env", "master_password",
          "身份证", "银行卡", "社保", "病历", "诊断", "处方", "密码", "密钥",
          "简历", "resume"
        ]
      },
      "patterns": {
        "S2": [
          "\\b(?:10|172\\.(?:1[6-9]|2\\d|3[01])|192\\.168)\\.\\d{1,3}\\.\\d{1,3}\\b",
          "(?:mysql|postgres|mongodb|redis)://[^\\s]+",
          "\\b(?:sk|key|token)-[A-Za-z0-9]{16,}\\b",
          "1[3-9]\\d{9}",
          "(?i)ghp_[a-zA-Z0-9]{36}",
          "(?i)xox[bsrap]-[a-zA-Z0-9-]+",
          "(?i)(?:contract|agreement)[-_]?\\w{6,}",
          "(?i)¥[\\d,]+\\.?\\d*|\\$[\\d,]+\\.?\\d*",
          "(?i)[a-z]+-(?:srv|dc|db|web|app)-\\d+",
          "(?i)[a-z]+\\\\[a-z0-9._-]+"
        ],
        "S3": [
          "-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
          "AKIA[0-9A-Z]{16}",
          "\\d{17}[0-9Xx]",
          "\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}",
          "(?i)(password|passwd|pwd)\\s*[=:]\\s*['\"][^'\"]{8,}"
        ]
      },
      "tools": {
        "S2": { "tools": ["execute_sql"], "paths": ["~/secrets", "~/private"] },
        "S3": { "tools": ["sudo"], "paths": ["~/.ssh", "~/.aws", "~/.config/credentials", "/root", "/credentials/"] }
      }
    }
  }
}
```

#### Detector Combination

```json
{
  "privacy": {
    "checkpoints": {
      "onUserMessage": ["ruleDetector", "localModelDetector"],
      "onToolCallProposed": ["ruleDetector"],
      "onToolCallExecuted": ["ruleDetector", "localModelDetector"]
    }
  }
}
```

#### Pipeline Execution Order

```json
{
  "privacy": {
    "pipeline": {
      "onUserMessage": ["privacy", "token-saver", "content-filter"],
      "onToolCallProposed": ["privacy"],
      "onToolCallExecuted": ["privacy"]
    }
  }
}
```

> After enabling privacy routing, you can add `"privacy"` to each phase, e.g., `"onUserMessage": ["privacy", "token-saver"]`.

#### Custom Routers

Implement the `ClawXrouterRouter` interface to inject code-level routing logic:

```typescript
const myRouter: ClawXrouterRouter = {
  id: "content-filter",
  async detect(context, config) {
    if (context.message && context.message.length > 10000) {
      return {
        level: "S1",
        action: "redirect",
        target: { provider: "anthropic", model: "claude-sonnet-4.6" },
        reason: "Message too long, using larger context model",
      };
    }
    return { level: "S1", action: "passthrough" };
  },
};
```

```json
{
  "privacy": {
    "routers": {
      "content-filter": {
        "enabled": true,
        "type": "custom",
        "module": "./my-router.js",
        "weight": 60
      }
    }
  }
}
```

#### Prompt Customization

Modify the Markdown files under `clawxrouter/prompts/`:

| File                    | Purpose              |
| ----------------------- | -------------------- |
| `detection-system.md`   | S1/S2/S3 classification rules |
| `token-saver-judge.md`  | Task complexity classification |

### 🔌 Supported Edge Providers

| Provider | API Type | Config `type` |
|----------|----------|---------------|
| [Ollama](https://ollama.com/) | OpenAI-compatible or native | `openai-compatible` / `ollama-native` |
| [vLLM](https://github.com/vllm-project/vllm) | OpenAI-compatible | `openai-compatible` |
| [LM Studio](https://lmstudio.ai/) | OpenAI-compatible | `openai-compatible` |
| [SGLang](https://github.com/sgl-project/sglang) | OpenAI-compatible | `openai-compatible` |
| [LocalAI](https://localai.io/) | OpenAI-compatible | `openai-compatible` |
| Any OpenAI-compatible service | `/v1/chat/completions` | `openai-compatible` |
| Custom implementation | User module | `custom` |

---

## 🏛️ Design Overview

### 🔒 Three-Level Privacy Routing

#### Three-Level Sensitivity Classification

The core concern behind "afraid to use" is that even in common scenarios like code review, private data may accidentally end up in the cloud. ClawXRouter hooks into the OpenClaw execution flow, automatically classifying every user message, tool call parameter, and Agent output into three sensitivity levels:

| Level  | Meaning       | Forwarding Strategy      | Example                          |
| ------ | ------------- | ------------------------ | -------------------------------- |
| **S1** | Safe          | Send directly to cloud model | "What's the difference between HTTP 403 and 401?" |
| **S2** | Sensitive     | Redact before forwarding to cloud | Alerts containing internal IPs, contacts with phone numbers |
| **S3** | Confidential  | Process with local model only | SSH private keys, hardcoded passwords, payroll data |

#### Dual Detection Engine

| Engine               | Mechanism                    | Latency | Coverage                                         |
| -------------------- | ---------------------------- | ------- | ------------------------------------------------ |
| **Rule Detector**    | Keyword + regex matching     | ~0ms    | Known patterns: API Keys, DB connection strings, PEM key headers |
| **Local LLM Detector** | Semantic understanding (runs on local small model) | ~1-2s | Contextual reasoning: "Help me analyze this payroll sheet", Chinese addresses |

The rule engine covers known explicit patterns with extreme speed; the local LLM fills the semantic understanding gap, achieving higher recall on long-tail scenarios that rules cannot cover. The two engines are flexibly combined per scenario via `checkpoints` configuration, with built-in short-circuit optimization — when rules already determine S3, LLM is skipped (the result can't be higher), taking the strictest result.

#### S2 Data Flow: Redact & Forward — Use It Effectively

```
User Message (containing PII)
    │
    ▼
Local LLM Detection → S2
    │
    ▼
Local LLM Extracts PII → JSON Array
    │
    ▼
Programmatic PII Replacement → [REDACTED:PHONE], [REDACTED:ADDRESS]
    │
    ▼
Privacy Proxy (localhost:8403)
    ├── Strip PII markers
    ├── Forward to cloud model
    └── Pass through response (supports SSE streaming)
```

#### S3 Data Flow: Fully Local Processing — Use It with Confidence

```
User Message (containing confidential data)
    │
    ▼
Detection → S3
    │
    ▼
Forward to Local Guard Agent
    ├── Uses local LLM (Ollama / vLLM)
    ├── Full data visible, all-local inference
    └── Cloud-side history only receives 🔒 placeholder
```

#### Dual-Track Memory & Dual-Track Sessions

```
~/.openclaw/workspace/
├── MEMORY.md           ← What the cloud model sees (auto-redacted)
├── MEMORY-FULL.md      ← What the local model sees (complete data)
│
agents/{id}/sessions/
├── full/               ← Complete history (including Guard Agent interactions)
└── clean/              ← Clean history (for cloud model consumption)
```

The cloud model **can never see** `MEMORY-FULL.md` and `sessions/full/`, intercepted by the Hook system at the file access layer.

#### Security Guarantees

**Theorem 1 (Cloud-Side Invisibility)**: For any S3-level data _x_, its original content is completely invisible to the cloud:

<p align="center">∀ <i>x</i>, &nbsp; Detect(<i>x</i>) = S₃ &nbsp;⟹&nbsp; <i>x</i> ∉ Cloud(<i>x</i>)</p>

**Theorem 2 (Redaction Completeness)**: For any S2-level data _x_, its cloud-visible form does not contain original privacy entity values:

<p align="center">∀ <i>x</i>, &nbsp; Detect(<i>x</i>) = S₂ &nbsp;⟹&nbsp; ∀ (<i>t<sub>i</sub></i>, <i>v<sub>i</sub></i>) ∈ Extract(<i>x</i>), &nbsp; <i>v<sub>i</sub></i> ∉ Cloud(<i>x</i>)</p>

---

### 💰 Cost-Aware Routing

#### Why Cost-Aware Routing?

The root cause of "can't afford" is that most requests in a typical workflow are just checking files, reading code, or simple Q&A, yet they're all sent to the most expensive model. Using Claude just to grep a function call — your wallet can't take it. ClawXRouter's cost-aware routing uses an edge-side small model as LLM-as-Judge, classifying requests into five complexity levels and routing them to cloud models at different price tiers:

| Complexity    | Task Examples                                         | Default Target Model |
| ------------- | ----------------------------------------------------- | -------------------- |
| **SIMPLE**    | Summarization, rewriting, simple Q&A, greetings       | `glm-4.5-air`       |
| **MEDIUM**    | Writing emails, scripts, data analysis, project scaffolding | `minimax-m2.5`  |
| **COMPLEX**   | Batch email sorting, multi-file creation, structured data extraction | `deepseek-v3.2` |
| **RESEARCH**  | Long-form writing, multi-source integration workflows | `glm-5`             |
| **REASONING** | Deep PDF analysis, mathematical proofs, experiment design | `kimi-k2.5`      |



#### Smart Caching

Prompt hash caching (SHA-256, TTL 5 minutes) — identical requests don't trigger repeated Judge calls, further reducing latency overhead.



---

### 🚀 Composable Routing Pipeline

Privacy routing and cost-aware routing run in the **same pipeline**, following a security-first principle: the privacy router runs first with higher weight, short-circuiting when sensitive data is found; cost-aware routing kicks in to optimize costs only after security clearance. The entire pipeline covers the full lifecycle from model selection to session end through 10 Hooks, non-intrusively taking over the OpenClaw workflow:

```
User Message
     │
     ▼
┌──────────────────────────────────────────────┐
│         Router Pipeline                       │
│                                               │
│  Phase 1: Fast Routers (weight >= 50) in parallel │
│  ┌─────────────┐                              │
│  │   Privacy    │                              │
│  │   Router     │                              │
│  │  (weight:90) │                              │
│  │  Rule Engine │                              │
│  │  + LLM Det.  │                              │
│  │  → S1/S2/S3  │                              │
│  └──────┬───────┘                              │
│         │                                     │
│  Short-circuit: If Phase 1 finds sensitive data → Skip Phase 2 │
│         │                                     │
│  Phase 2: Slow Routers (weight < 50) on demand │
│  ┌──────────────────┐                         │
│  │  Cost-Aware       │                         │
│  │  Router           │                         │
│  │  (weight:40)      │                         │
│  │  LLM-as-Judge     │                         │
│  │  → SIMPLE/MEDIUM/ │                         │
│  │    COMPLEX/REASON │                         │
│  └────────┬─────────┘                         │
│           │                                   │
│           ▼                                   │
│      Decision Merge                            │
└─────────────────────┬────────────────────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
     ┌─────────┐ ┌─────────┐ ┌─────────┐
     │   S3    │ │   S2    │ │   S1    │
     │  Guard  │ │ Privacy │ │  Cloud  │
     │  Agent  │ │  Proxy  │ │  Model  │
     │ (Local) │ │(Redact &│ │(Tiered │
     │         │ │Forward) │ │Routing) │
     └─────────┘ └─────────┘ └─────────┘
```

**Design Philosophy**: Precondition — **ensure security**; Optimization objective — **optimal cost**. Let the right model do the right job; let the edge and cloud each play to their strengths.

#### Decision Merge Rules

The pipeline merges decisions from multiple routers according to the following rules:

1. **Highest security level wins**: S3 > S2 > S1
2. **At the same level, highest weight wins**: privacy(90) > cost-optimizer(40)
3. **`passthrough` (no opinion) yields to `redirect` (has opinion)**: When the privacy router says "no sensitive data" and the cost-aware router says "redirect to a cheaper model", the latter takes effect
4. **Among multiple redirects, the stricter behavior takes priority**: block > redirect > transform > passthrough

#### End-to-End Pipeline Formalization

```
                                                    ⎧ θ_cloud(m)        if a = passthrough
m ─[c_msg]→ Detect(m) → l ─[c_route]→ R(l) → a → ⎨ θ_cloud(De(m))    if a = desensitize
                                                    ⎩ θ_local(m)        if a = redirect

  ─[c_persist]→ W(m, l) ─[c_end]→ Sync
```

#### 10 Hooks Covering the Full Lifecycle

| Hook                   | Trigger Timing    | Core Responsibility               |
| ---------------------- | ----------------- | --------------------------------- |
| `before_model_resolve` | Before model selection | Run pipeline → routing decision |
| `before_prompt_build`  | Before prompt building | Inject Guard Prompt / S2 markers |
| `before_tool_call`     | Before tool call   | File access guard + sub-agent guard |
| `after_tool_call`      | After tool call    | Tool result detection             |
| `tool_result_persist`  | Result persistence | Dual-track session writing        |
| `before_message_write` | Before message write | S3→placeholder, S2→redacted version |
| `session_end`          | Session end        | Memory synchronization            |
| `message_sending`      | Outbound message   | Detect and redact/cancel          |
| `before_agent_start`   | Before sub-agent start | Task content guard             |
| `message_received`     | Message received   | Observational logging             |

---

### 🏗️ Code Structure

```
clawxrouter/
├── index.ts                        # Plugin entry (lifecycle registration)
├── openclaw.plugin.json            # Plugin manifest
├── config.example.json             # Configuration example
│
├── src/
│   ├── router-pipeline.ts          # Composable routing pipeline (two-phase + weighted merge)
│   ├── detector.ts                 # Dual-engine detection (rules + LLM)
│   ├── rules.ts                    # Rule detector (keywords + regex)
│   ├── local-model.ts              # Local LLM detector + redaction engine
│   ├── config-schema.ts            # TypeBox config schema + defaults
│   ├── routers/
│   │   ├── privacy.ts              # Privacy router (three-level privacy routing)
│   │   ├── token-saver.ts          # Cost-aware router (cost savings)
│   │   └── configurable.ts         # Custom routers created from Dashboard
│   ├── privacy-proxy.ts            # Local HTTP proxy for S2 PII redaction
│   ├── provider.ts                 # Provider registration + model mirroring
│   ├── guard-agent.ts              # Dedicated local Guard Agent for S3 tasks
│   ├── hooks.ts                    # OpenClaw Hook integration
│   ├── session-manager.ts          # Dual-track session history
│   ├── session-state.ts            # Per-session detection state tracking
│   ├── memory-isolation.ts         # Dual-track memory (MEMORY-FULL.md vs MEMORY.md)
│   ├── live-config.ts              # Configuration file hot-reload watcher
│   ├── prompt-loader.ts            # Prompt file loader (from prompts/)
│   ├── stats-dashboard.ts          # /plugins/clawxrouter/stats Web UI
│   ├── token-stats.ts              # Per-level token usage tracking
│   ├── sync-detect.ts              # Synchronous LLM detection (Worker)
│   ├── sync-desensitize.ts         # Synchronous redaction (Worker)
│   ├── llm-detect-worker.ts        # LLM detection Worker thread
│   ├── llm-desensitize-worker.ts   # Redaction Worker thread
│   ├── types.ts                    # Core type definitions
│   ├── utils.ts                    # Path normalization + utilities
│   └── worker-loader.mjs           # Worker thread module hook
│
└── prompts/
    ├── detection-system.md         # Privacy detection prompt
    ├── guard-agent-system.md       # Guard Agent system prompt
    └── token-saver-judge.md        # Task complexity judgment prompt
```

---

## 🤝 Contributing

Afraid to use the cloud, can't afford the cloud, can't rely on the edge — ClawXRouter's answer is: you don't have to choose one or the other; let the edge and cloud each play to their strengths. Privacy routing lets users use it with confidence, cost-aware routing makes it affordable, and smart redaction makes it effective. The project will continue to iterate as open source. We welcome developers and industry partners to contribute and jointly build a secure, efficient edge-cloud collaborative Agent ecosystem!

Contribution workflow: **Fork this repository → Submit Issues → Create Pull Requests (PRs)**

---

## ⭐ Support Us

If this project helps your research or work, please give us a ⭐!

---

## 💬 Contact Us

- For technical questions and feature requests, please use [GitHub Issues](https://github.com/openbmb/clawxrouter/issues)

---

## 📖 References

### Dependencies

- [OpenClaw](https://github.com/openclaw/openclaw) — Base AI assistant framework
- [MiniCPM](https://github.com/OpenBMB/MiniCPM) — Recommended local detection model
- [Ollama](https://ollama.ai) — Recommended local inference backend

### License

MIT
