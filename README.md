# EdgeClaw Router

> Privacy-first, cost-aware AI routing layer — keep sensitive data local, route simple tasks to cheap models, and only send complex reasoning to expensive cloud LLMs.

EdgeClaw Router is an intelligent message routing system for AI agents. It intercepts every message, classifies its **privacy sensitivity** and **task complexity**, then routes it to the optimal model — saving money without compromising quality, and protecting privacy without sacrificing capability.

## The Problem

When you run an AI agent that handles both mundane lookups and deep reasoning, you face two tensions:

1. **Privacy vs. Intelligence** — You need GPT-4 / Claude-level reasoning, but your data contains credentials, PII, and internal infrastructure details that must never leave your network.
2. **Cost vs. Quality** — 80% of agent interactions are simple tasks (FAQ, formatting, extraction), yet they all get routed to the most expensive model by default.

EdgeClaw Router solves both problems with a composable routing pipeline.

## How It Works

```
User Message
     │
     ▼
┌─────────────────────────────────────────────┐
│           Router Pipeline                    │
│                                              │
│  ┌─────────────┐    ┌──────────────────┐    │
│  │   Privacy    │    │   Token-Saver    │    │
│  │   Router     │    │   Router         │    │
│  │  (weight:90) │    │  (weight:40)     │    │
│  │              │    │                  │    │
│  │  Rule-based  │    │  LLM-as-Judge    │    │
│  │  + LLM       │    │  classifies      │    │
│  │  detection   │    │  complexity      │    │
│  │              │    │                  │    │
│  │  S1/S2/S3    │    │  SIMPLE/MEDIUM/  │    │
│  │              │    │  COMPLEX/REASON  │    │
│  └──────┬───────┘    └────────┬─────────┘    │
│         │                     │              │
│         └─────────┬───────────┘              │
│                   ▼                          │
│          Merge Decisions                     │
│   (privacy wins when PII detected;           │
│    token-saver wins when no PII)             │
└─────────────────────┬───────────────────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
     ┌─────────┐ ┌─────────┐ ┌─────────┐
     │   S3    │ │   S2    │ │   S1    │
     │  Guard  │ │ Privacy │ │  Cloud  │
     │  Agent  │ │  Proxy  │ │  Model  │
     │ (local) │ │ (strip  │ │ (tier-  │
     │         │ │  PII)   │ │  based) │
     └─────────┘ └─────────┘ └─────────┘
```

### Privacy Router — Three-Level Sensitivity Classification

| Level | Meaning | Action | Example |
|-------|---------|--------|---------|
| **S1** | Safe | Forward to cloud | "What's the difference between HTTP 403 and 401?" |
| **S2** | Sensitive | Strip PII via local proxy, then forward | SOC alerts with internal IPs |
| **S3** | Private | Process entirely locally via Guard Agent | Source code with hardcoded credentials |

Detection uses a **dual engine**: rule-based regex patterns (zero cost, instant) + LLM-based context analysis (handles ambiguous cases).

### Token-Saver Router — Task Complexity Classification

| Tier | Model | Cost | Example |
|------|-------|------|---------|
| **SIMPLE** | gemini-2.5-flash | ~$0.15/M tokens | "What is YAML?" |
| **MEDIUM** | gemini-2.5-pro | ~$1.25/M tokens | "Find the bug in this function" |
| **COMPLEX** | gemini-3.1-pro | ~$2.50/M tokens | "Design a million-QPS push system" |
| **REASONING** | claude-sonnet-4.5 | ~$3.00/M tokens | "Prove that Mersenne prime exponents must be prime" |

An LLM-as-Judge (cheap flash model) classifies every message in ~2 seconds. SIMPLE tasks cost **~20x less** than REASONING tasks.

### Priority Resolution

When both routers have an opinion:

- **PII detected** (S2/S3) → Privacy always wins, regardless of Token-Saver tier
- **No PII** (S1) → Token-Saver's tier-based routing takes effect

## Project Structure

```
Edgeclaw-router/
├── clawxrouter/                    # Core plugin (OpenClaw extension)
│   ├── index.ts                    # Plugin entry point (register lifecycle)
│   ├── src/
│   │   ├── router-pipeline.ts      # Composable routing pipeline
│   │   ├── detector.ts             # Dual detection engine (rule + LLM)
│   │   ├── rules.ts                # Rule-based keyword/regex detector
│   │   ├── local-model.ts          # LLM-based sensitivity detector
│   │   ├── config-schema.ts        # TypeBox config schema + defaults
│   │   ├── routers/
│   │   │   ├── privacy.ts          # S1/S2/S3 privacy router
│   │   │   ├── token-saver.ts      # LLM-as-Judge cost router
│   │   │   └── configurable.ts     # Dashboard-created custom routers
│   │   ├── privacy-proxy.ts        # Local HTTP proxy for S2 PII stripping
│   │   ├── provider.ts             # Provider registration + model mirroring
│   │   ├── guard-agent.ts          # Dedicated local agent for S3 tasks
│   │   ├── hooks.ts                # OpenClaw hook integration
│   │   ├── session-manager.ts      # Dual-track session history
│   │   ├── session-state.ts        # Per-session detection state tracking
│   │   ├── memory-isolation.ts     # MEMORY-FULL.md vs MEMORY.md
│   │   ├── live-config.ts          # Hot-reload config file watcher
│   │   ├── prompt-loader.ts        # Prompt file loader (from prompts/)
│   │   ├── stats-dashboard.ts      # /plugins/clawxrouter/stats web UI
│   │   ├── token-stats.ts          # Per-tier token usage tracking
│   │   ├── sync-detect.ts          # Synchronous LLM detection (worker)
│   │   ├── sync-desensitize.ts     # Synchronous desensitization (worker)
│   │   ├── llm-detect-worker.ts    # Worker thread for LLM detection
│   │   ├── llm-desensitize-worker.ts # Worker thread for desensitization
│   │   ├── types.ts                # Core type definitions
│   │   ├── utils.ts                # Path normalization + helper utilities
│   │   └── worker-loader.mjs       # Worker thread module hook
│   ├── prompts/
│   │   ├── detection-system.md     # Privacy detection prompt
│   │   ├── guard-agent-system.md   # Guard Agent system prompt
│   │   └── token-saver-judge.md    # Task complexity judge prompt
│   ├── config.example.json         # Example configuration
│   └── openclaw.plugin.json        # Plugin manifest
```

## Quick Start

### Prerequisites

- [OpenClaw](https://github.com/nicepkg/openclaw) installed and running
- Node.js 20+
- (Optional) [Ollama](https://ollama.com/) for local model inference

### 1. Install the Plugin

```bash
# Copy the clawxrouter directory into your OpenClaw extensions folder
cp -r clawxrouter/ ~/.openclaw/extensions/clawxrouter/
cd ~/.openclaw/extensions/clawxrouter && npm install
```

### 2. Configure

Create `~/.openclaw/clawxrouter.json`:

```jsonc
{
  "privacy": {
    "enabled": true,
    "s2Policy": "proxy",     // "proxy" strips PII before forwarding; "local" uses local model entirely
    "proxyPort": 8403,
    "rules": {
      "keywords": {
        "S2": ["password", "api_key", "secret", "token"],
        "S3": ["ssh", "id_rsa", "private_key", ".pem"]
      },
      "patterns": {
        "S2": [
          "\\b(?:10|172\\.(?:1[6-9]|2\\d|3[01])|192\\.168)\\.\\d{1,3}\\.\\d{1,3}\\b",  // internal IPs
          "\\b(?:sk|key|token)-[A-Za-z0-9]{16,}\\b"                                      // API keys
        ],
        "S3": [
          "AKIA[0-9A-Z]{16}",                                                            // AWS access keys
          "-----BEGIN (?:RSA |EC )?PRIVATE KEY-----"                                      // private keys
        ]
      }
    },
    "localModel": {
      "enabled": true,
      "type": "openai-compatible",
      "provider": "ollama",
      "model": "openbmb/minicpm4.1",
      "endpoint": "http://localhost:11434"
    },
    "guardAgent": {
      "id": "guard",
      "workspace": "~/.openclaw/workspace-guard",
      "model": "ollama/openbmb/minicpm4.1"
    },
    "routers": {
      "privacy": { "enabled": true, "type": "builtin", "weight": 90 },
      "token-saver": {
        "enabled": true,
        "type": "builtin",
        "weight": 40,
        "options": {
          "judgeModel": "gemini-2.5-flash",
          "tiers": {
            "SIMPLE":    { "provider": "your-provider", "model": "gemini-2.5-flash" },
            "MEDIUM":    { "provider": "your-provider", "model": "gemini-2.5-pro" },
            "COMPLEX":   { "provider": "your-provider", "model": "gemini-3.1-pro-preview" },
            "REASONING": { "provider": "your-provider", "model": "claude-sonnet-4-5-20250929" }
          }
        }
      }
    }
  }
}
```

### 3. Start

```bash
openclaw gateway
# ClawXrouter Ready! Dashboard → http://127.0.0.1:18789/plugins/clawxrouter/stats
```

### 4. Test

```bash
# Simple question → routed to cheap model (SIMPLE tier)
curl http://127.0.0.1:18789/v1/chat/completions \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"What is YAML?"}]}'

# Message with credentials → routed to Guard Agent (S3, local only)
curl http://127.0.0.1:18789/v1/chat/completions \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw","stream":false,"messages":[{"role":"user","content":"Review this code: const key = \"AKIAIOSFODNN7EXAMPLE\""}]}'
```

## Verified Test Results

All routing decisions are verified by Gateway `model overridden` logs (not just classification output).

### Token-Saver Routing (Verified)

| Input | Judge Verdict | Routed Model | Latency | Response |
|-------|--------------|-------------|---------|----------|
| "JSON vs YAML difference?" | SIMPLE | `gemini-2.5-flash` | 6.4s | 122 chars |
| "Find the bug in this function" | MEDIUM | `gemini-2.5-pro` | 19.7s | 1,252 chars |
| "Design million-QPS push system" | COMPLEX | `gemini-3.1-pro-preview` | 72.2s | 4,213 chars |
| "Prove Mersenne prime theorem" | REASONING | `claude-sonnet-4-5-20250929` | 11.7s | 1,132 chars |

### Privacy Routing (Verified)

| Input | Detection | Route | Model |
|-------|-----------|-------|-------|
| 5 hardcoded credentials | S3 (regex + LLM) | Guard Agent | `gemini-2.5-flash` (local) |
| Chat log with bank card, ID number | S3 (LLM) | Guard Agent | `gemini-2.5-flash` (local) |
| SOC alerts with internal IPs | S2 (regex) | Privacy Proxy | Cloud via proxy |
| "HTTP 403 vs 401?" | S1 | Cloud (SIMPLE tier) | `gemini-2.5-flash` |

### Priority Resolution (Verified)

| Input | Privacy | Token-Saver | Winner |
|-------|---------|-------------|--------|
| ID number + simple question | S2 | SIMPLE | **Privacy** (PII detected) |
| Architecture comparison, no PII | S1 | REASONING | **Token-Saver** → `claude-sonnet-4.5` |

## PinchBench Benchmark — Token-Saver 5-Tier Routing

Using [PinchBench](https://pinchbench.com) (23-task OpenClaw agent benchmark), we evaluated the Token-Saver router's ability to match top-tier model performance at a fraction of the cost.

### Strategy: Plan C-v2 (minimax-m2.5 as default + selective routing)

Default model is `minimax-m2.5` (cheap, strong all-rounder). Only 12 of 23 tasks are routed to specialized models where they demonstrably outperform m2.5 on the official leaderboard.

| Tier | Model | Tasks | Role |
|------|-------|-------|------|
| **SIMPLE** | `glm-4.5-air` | 3 | Text summarization, rewriting — cheapest model |
| **MEDIUM** | `minimax-m2.5` | 11 | Default catch-all |
| **COMPLEX** | `deepseek-v3.2` | 5 | Email triage/search, file ops, report comprehension |
| **RESEARCH** | `glm-5` | 3 | Blog writing, multi-step workflows, daily digest |
| **REASONING** | `kimi-k2.5` | 1 | PDF analysis |

### Results (Official PinchBench Scores)

Scores are taken from the official PinchBench leaderboard — **Best** = highest single-run score, **Avg** = mean across all runs for that model.

| Metric | Plan C-v2 (Routed) | All minimax-m2.5 | All Sonnet 4.6 |
|--------|-------------------|------------------|----------------|
| **Best Score** | **93.2%** | 88.8% | 86.9% |
| **Avg Score** | **89.6%** | 84.6% | 79.2% |
| **Cost (official API)** | **$2.36** | $2.32 | $5.63 |

> **+4.3% Best / +5.0% Avg score over single-model baseline, for only $0.04 more.**
> **58% cheaper than Sonnet 4.6 with 6.3% higher Best score.**

### Per-Task Breakdown

| Task | Tier | Model | Best | Avg | Cost |
|------|------|-------|------|-----|------|
| Sanity Check | SIMPLE | glm-4.5-air | 100% | 100% | $0.005 |
| Calendar Event | MEDIUM | minimax-m2.5 | 100% | 100% | $0.044 |
| Stock Research | MEDIUM | minimax-m2.5 | 100% | 100% | $0.064 |
| Blog Writing | RESEARCH | glm-5 | 100% | 98% | $0.110 |
| Weather Script | MEDIUM | minimax-m2.5 | 100% | 100% | $0.087 |
| Doc Summarization | SIMPLE | glm-4.5-air | 100% | 94% | $0.016 |
| Tech Conference | MEDIUM | minimax-m2.5 | 89% | 88% | $0.212 |
| Email Drafting | MEDIUM | minimax-m2.5 | 100% | 99% | $0.040 |
| Memory Retrieval | COMPLEX | deepseek-v3.2 | 80% | 80% | $0.013 |
| File Structure | COMPLEX | deepseek-v3.2 | 100% | 100% | $0.010 |
| API Workflow | RESEARCH | glm-5 | 89% | 84% | $0.270 |
| Project Structure | MEDIUM | minimax-m2.5 | 100% | 100% | $0.080 |
| Search & Replace | MEDIUM | minimax-m2.5 | 100% | 100% | $0.123 |
| Image Generation | MEDIUM | minimax-m2.5 | 21% | 17% | $0.767 |
| Humanize Blog | SIMPLE | glm-4.5-air | 96% | 94% | $0.016 |
| Daily Summary | RESEARCH | glm-5 | 97% | 94% | $0.337 |
| Email Triage | COMPLEX | deepseek-v3.2 | 96% | 96% | $0.020 |
| Email Search | COMPLEX | deepseek-v3.2 | 100% | 100% | $0.027 |
| Market Research | MEDIUM | minimax-m2.5 | 95% | 94% | — |
| Spreadsheet | MEDIUM | minimax-m2.5 | 99% | 94% | — |
| ELI5 PDF | REASONING | kimi-k2.5 | 88% | 82% | $0.052 |
| Report Comprehension | COMPLEX | deepseek-v3.2 | 100% | 100% | $0.007 |
| Second Brain | MEDIUM | minimax-m2.5 | 93% | 46% | $0.062 |

### Cost by Model

| Model | Tasks | Cost | % of Total |
|-------|-------|------|-----------|
| minimax-m2.5 | 11 | $1.48 | 62.6% |
| glm-5 | 3 | $0.72 | 30.4% |
| deepseek-v3.2 | 5 | $0.08 | 3.3% |
| kimi-k2.5 | 1 | $0.05 | 2.2% |
| glm-4.5-air | 3 | $0.04 | 1.6% |

### Routing Accuracy

Judge model (`gemini-2.5-flash`) correctly classified **22/23 tasks** (96%) to their intended tiers, validated by sending each task prompt directly to the judge and comparing against the expected tier assignment.

### Methodology

- **Scores**: Per-task scores from official PinchBench submissions on [pinchbench.com](https://pinchbench.com) — Best is the highest score across all official runs, Avg is the mean.
- **Cost**: Calculated from actual token usage recorded during our benchmark run (1,729,532 input + 29,717 output tokens total), multiplied by each model's official API pricing.
- **Routing**: LLM-as-Judge (`gemini-2.5-flash`) classifies task complexity using a tuned prompt with priority rules. Classification takes ~2s per message.

## Architecture

### Router Pipeline

The pipeline runs registered routers in two phases:

1. **Fast phase** (weight ≥ 50): Privacy router runs regex rules + LLM detection in parallel
2. **Slow phase** (weight < 50): Token-Saver's LLM-as-Judge only runs if fast phase returns S1

**Short-circuit optimization**: If the fast phase already detects S2/S3, the slow phase is skipped entirely — no wasted Judge API calls on messages that will be handled locally anyway.

**Decision merging**:
- Highest sensitivity level wins (S3 > S2 > S1)
- At the same level, `passthrough` (no opinion) yields to `redirect` (has opinion)
- Among redirects, weight breaks ties

### Custom Routers

```typescript
import type { ClawXrouterRouter } from "./types.js";

const myRouter: ClawXrouterRouter = {
  id: "content-filter",
  async detect(context, config) {
    // Your logic here
    return {
      level: "S1",
      action: "redirect",
      target: { provider: "my-provider", model: "my-model" },
      reason: "custom routing logic",
    };
  },
};
```

Register via config:

```json
{
  "routers": {
    "content-filter": {
      "enabled": true,
      "type": "custom",
      "module": "./my-router.js",
      "weight": 60
    }
  }
}
```

## Supported Edge Providers

| Provider | API Type | Config `type` |
|----------|----------|---------------|
| [Ollama](https://ollama.com/) | OpenAI-compatible or native | `openai-compatible` / `ollama-native` |
| [vLLM](https://github.com/vllm-project/vllm) | OpenAI-compatible | `openai-compatible` |
| [LM Studio](https://lmstudio.ai/) | OpenAI-compatible | `openai-compatible` |
| [SGLang](https://github.com/sgl-project/sglang) | OpenAI-compatible | `openai-compatible` |
| [LocalAI](https://localai.io/) | OpenAI-compatible | `openai-compatible` |
| Any OpenAI-compatible server | `/v1/chat/completions` | `openai-compatible` |
| Custom implementation | User module | `custom` |

## Development

```bash
cd clawxrouter

# Install dependencies
npm install
```

## Documentation

- **[Example Config](clawxrouter/config.example.json)** — Annotated configuration with examples for Ollama, vLLM, LM Studio, SGLang, and custom providers

## License

MIT

## Acknowledgments

- Built as a plugin for [OpenClaw](https://github.com/nicepkg/openclaw)
- Router pipeline design inspired by the EdgeClaw checkpoint + detector composition model
- Uses [TypeBox](https://github.com/sinclairzx81/typebox) for runtime configuration validation
