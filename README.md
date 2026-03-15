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
│  │  (weight:90) │    │  (weight:50)     │    │
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
├── guardclaw/                      # Core plugin (OpenClaw extension)
│   ├── src/
│   │   ├── router-pipeline.ts      # Composable routing pipeline
│   │   ├── detector.ts             # Dual detection engine (rule + LLM)
│   │   ├── rules.ts                # Rule-based keyword/regex detector
│   │   ├── local-model.ts          # LLM-based sensitivity detector
│   │   ├── routers/
│   │   │   ├── privacy.ts          # S1/S2/S3 privacy router
│   │   │   └── token-saver.ts      # LLM-as-Judge cost router
│   │   ├── privacy-proxy.ts        # Local HTTP proxy for S2 PII stripping
│   │   ├── guard-agent.ts          # Dedicated local agent for S3 tasks
│   │   ├── hooks.ts                # OpenClaw hook integration
│   │   ├── session-manager.ts      # Dual-track session history
│   │   ├── memory-isolation.ts     # MEMORY-FULL.md vs MEMORY.md
│   │   ├── stats-dashboard.ts      # /plugins/guardclaw/stats web UI
│   │   └── token-stats.ts          # Per-tier token usage tracking
│   ├── prompts/
│   │   ├── detection-system.md     # Privacy detection prompt
│   │   ├── guard-agent-system.md   # Guard Agent system prompt
│   │   └── token-saver-judge.md    # Task complexity judge prompt
│   ├── test/                       # Unit + integration + E2E tests
│   ├── docs/
│   │   └── GuardClaw-技术报告.md    # 1,500-line technical report
│   ├── config.example.json         # Example configuration
│   └── openclaw.plugin.json        # Plugin manifest
│
└── usecases/                       # Real-world use case documentation
    ├── README.md                   # Use case index + test results
    ├── code-review-token-masking.md
    ├── family-chat-summary.md
    ├── soc-alert-analysis.md
    ├── research-assistant-pipeline.md
    ├── systematic-literature-review.md
    ├── patent-landscape-analysis.md
    ├── compliance-audit.md
    ├── credential-vault.md
    ├── privacy-aware-data-analysis.md
    ├── resume-optimizer.md
    ├── mock-data/                  # Sample test data
    └── test-results/               # Raw API response JSON
```

## Quick Start

### Prerequisites

- [OpenClaw](https://github.com/nicepkg/openclaw) installed and running
- Node.js 20+
- (Optional) [Ollama](https://ollama.com/) for local model inference

### 1. Install the Plugin

```bash
# Copy the guardclaw directory into your OpenClaw extensions folder
cp -r guardclaw/ ~/.openclaw/extensions/guardclaw/
cd ~/.openclaw/extensions/guardclaw && npm install
```

### 2. Configure

Create `~/.openclaw/guardclaw.json`:

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
      "model": "qwen2.5:7b",
      "endpoint": "http://localhost:11434"
    },
    "guardAgent": {
      "id": "guard",
      "workspace": "~/.openclaw/workspace-guard",
      "model": "ollama/qwen2.5:7b"
    }
  },
  "routers": {
    "privacy": { "enabled": true, "type": "builtin", "weight": 90 },
    "token-saver": {
      "enabled": true,
      "type": "builtin",
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
```

### 3. Start

```bash
openclaw gateway
# GuardClaw Ready! Dashboard → http://127.0.0.1:18789/plugins/guardclaw/stats
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

Full test results with Gateway log excerpts: [`usecases/README.md`](usecases/README.md)

## Use Cases

### Privacy-Driven

| Use Case | Description | Privacy Level |
|----------|-------------|---------------|
| [Code Security Review](usecases/code-review-token-masking.md) | Detect and mask hardcoded credentials before cloud review | S3 → Guard Agent |
| [Family Chat Summary](usecases/family-chat-summary.md) | De-identify PII in chat logs, then summarize | S3 → Guard Agent |
| [Credential Vault](usecases/credential-vault.md) | Keep all credentials local, cloud provides security advice only | S3 isolated |
| [Privacy-Aware Data Analysis](usecases/privacy-aware-data-analysis.md) | Local SQL + de-identification, cloud analysis | S3 → S1 pipeline |
| [Resume Optimizer](usecases/resume-optimizer.md) | Strip PII, optimize wording in cloud, restore locally | S3 → S1 → S3 |

### Cost-Optimization-Driven (Token-Saver)

| Use Case | Pipeline Steps | SIMPLE % | Est. Savings |
|----------|---------------|----------|-------------|
| [Research Assistant](usecases/research-assistant-pipeline.md) | 11 steps | 45% | ~75% |
| [Systematic Literature Review](usecases/systematic-literature-review.md) | 14 steps | 43% | ~80% |
| [Patent Landscape Analysis](usecases/patent-landscape-analysis.md) | 12 steps | 50% | ~85-88% |

### Hybrid (Privacy + Token-Saver)

| Use Case | Privacy Strategy | Token-Saver Strategy | Est. Savings |
|----------|-----------------|---------------------|-------------|
| [SOC Alert Analysis](usecases/soc-alert-analysis.md) | Internal IPs → S2 proxy | Alert parsing → SIMPLE | ~60-70% |
| [Compliance Audit](usecases/compliance-audit.md) | Client PII → S2/S3 | Doc parsing → SIMPLE | ~80-85% |

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
import type { GuardClawRouter } from "./types.js";

const myRouter: GuardClawRouter = {
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
cd guardclaw

# Install dependencies
npm install

# Run tests
npm test

# Run specific test suite
npx vitest run test/router-pipeline.test.ts
npx vitest run test/token-saver.test.ts
npx vitest run test/rules.test.ts
```

### Test Coverage

| Suite | Description |
|-------|-------------|
| `detector.test.ts` | Dual detection engine (rule + LLM) |
| `rules.test.ts` | Keyword and regex pattern matching |
| `router-pipeline.test.ts` | Pipeline composition and decision merging |
| `token-saver.test.ts` | LLM-as-Judge classification |
| `privacy-proxy.test.ts` | PII stripping proxy |
| `session-manager.test.ts` | Dual-track session isolation |
| `integration.test.ts` | Cross-component integration |
| `guardclaw-plugin-e2e.test.ts` | Full plugin lifecycle E2E |

## Documentation

- **[Technical Report (1,500 lines)](guardclaw/docs/GuardClaw-技术报告.md)** — Complete architecture, API reference, security model, and customization guide
- **[Dashboard Manual Test Guide](guardclaw/docs/Dashboard-手动测试文档.md)** — How to use the web dashboard at `/plugins/guardclaw/stats`
- **[Use Case Index](usecases/README.md)** — 10 real-world use cases with verified test results
- **[Example Config](guardclaw/config.example.json)** — Annotated configuration with examples for Ollama, vLLM, LM Studio, SGLang, and custom providers

## License

MIT

## Acknowledgments

- Built as a plugin for [OpenClaw](https://github.com/nicepkg/openclaw)
- Router pipeline design inspired by the EdgeClaw checkpoint + detector composition model
- Uses [TypeBox](https://github.com/sinclairzx81/typebox) for runtime configuration validation
