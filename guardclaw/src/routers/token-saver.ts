/**
 * Token-Saver Router — LLM-as-Judge Model Downgrade
 *
 * Uses a local LLM to classify task complexity into SIMPLE/MEDIUM/COMPLEX/REASONING
 * tiers, then routes to the cheapest model that can handle the tier.
 *
 * Key design decisions:
 *   - LLM-as-judge instead of keyword rules: understands semantics, any language
 *   - Subagent sessions skip entirely: no per-message judge overhead
 *   - Prompt-hash cache avoids redundant LLM calls (TTL 5 min)
 *   - Reuses GuardClaw's callChatCompletion() infrastructure (Ollama/vLLM/etc.)
 *   - Default disabled — users opt in via config
 */

import { createHash } from "node:crypto";
import type { GuardClawRouter, DetectionContext, EdgeProviderType, RouterDecision } from "../types.js";
import { callChatCompletion } from "../local-model.js";
import { loadPrompt } from "../prompt-loader.js";
import { getGlobalCollector } from "../token-stats.js";

// ── Types ──

type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

type TokenSaverConfig = {
  enabled: boolean;
  judgeEndpoint: string;
  judgeModel: string;
  judgeProviderType: EdgeProviderType;
  judgeCustomModule?: string;
  judgeApiKey?: string;
  tiers: Record<Tier, { provider: string; model: string }>;
  cacheTtlMs: number;
};

const DEFAULT_CONFIG: TokenSaverConfig = {
  enabled: false,
  judgeEndpoint: "http://localhost:11434",
  judgeModel: "openbmb/minicpm4.1",
  judgeProviderType: "openai-compatible",
  tiers: {
    SIMPLE: { provider: "openai", model: "gpt-4o-mini" },
    MEDIUM: { provider: "openai", model: "gpt-4o" },
    COMPLEX: { provider: "anthropic", model: "claude-sonnet-4.6" },
    REASONING: { provider: "openai", model: "o4-mini" },
  },
  cacheTtlMs: 300_000,
};

const DEFAULT_JUDGE_PROMPT = `You are a task complexity classifier. Classify the user's task into exactly one tier.

SIMPLE = lookup, translation, formatting, yes/no, definition, greeting, simple file search, reading a single file, listing items
MEDIUM = code generation, data analysis, moderate writing, single-file edits, summarization, debugging a specific function
COMPLEX = system design, multi-file refactoring, architecture decisions, large code generation, project-wide changes
REASONING = math proof, formal logic, step-by-step derivation, deep analysis with constraints, algorithm correctness proof

Rules:
- When unsure, pick the LOWER tier (save tokens).
- Short prompts (< 20 words) with no technical depth → SIMPLE.
- Presence of code fences alone does not mean COMPLEX — a short snippet for review is MEDIUM.

Output ONLY a JSON object, nothing else: {"tier":"SIMPLE|MEDIUM|COMPLEX|REASONING"}`;

// ── Cache ──

type CacheEntry = { tier: Tier; ts: number };
const classificationCache = new Map<string, CacheEntry>();

const CACHE_CLEANUP_INTERVAL_MS = 60_000;
const CACHE_MAX_AGE_MS = 600_000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCacheCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of classificationCache) {
      if (now - v.ts > CACHE_MAX_AGE_MS) classificationCache.delete(k);
    }
  }, CACHE_CLEANUP_INTERVAL_MS);
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }
}

// ── Helpers ──

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

const VALID_TIERS = new Set<Tier>(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]);

function parseTier(response: string): Tier {
  try {
    const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*?"tier"\s*:\s*"([A-Z]+)"[\s\S]*?\}/);
    if (match) {
      const tier = match[1] as Tier;
      if (VALID_TIERS.has(tier)) return tier;
    }
  } catch {
    // parse failure
  }
  return "MEDIUM";
}

function buildDecision(tier: Tier, config: TokenSaverConfig): RouterDecision {
  const target = config.tiers[tier];
  if (!target) {
    return { level: "S1", action: "passthrough", reason: `no model mapping for tier ${tier}` };
  }
  return {
    level: "S1",
    action: "redirect",
    target: { provider: target.provider, model: target.model },
    reason: `tier=${tier}`,
    confidence: 0.8,
  };
}

function resolveConfig(pluginConfig: Record<string, unknown>): TokenSaverConfig {
  const routers = (pluginConfig?.privacy as Record<string, unknown>)?.routers as
    | Record<string, { options?: Record<string, unknown>; enabled?: boolean }>
    | undefined;
  const tsConfig = routers?.["token-saver"];
  const options = (tsConfig?.options ?? {}) as Record<string, unknown>;

  const privacyLocalModel = (pluginConfig?.privacy as Record<string, unknown>)?.localModel as
    | { endpoint?: string; model?: string; type?: EdgeProviderType; module?: string; apiKey?: string }
    | undefined;

  return {
    enabled: tsConfig?.enabled ?? DEFAULT_CONFIG.enabled,
    judgeEndpoint:
      (options.judgeEndpoint as string) ??
      privacyLocalModel?.endpoint ??
      DEFAULT_CONFIG.judgeEndpoint,
    judgeModel:
      (options.judgeModel as string) ??
      privacyLocalModel?.model ??
      DEFAULT_CONFIG.judgeModel,
    judgeProviderType:
      (options.judgeProviderType as EdgeProviderType) ??
      privacyLocalModel?.type ??
      DEFAULT_CONFIG.judgeProviderType,
    judgeCustomModule:
      (options.judgeCustomModule as string) ??
      privacyLocalModel?.module,
    judgeApiKey:
      (options.judgeApiKey as string) ??
      privacyLocalModel?.apiKey,
    tiers: {
      ...DEFAULT_CONFIG.tiers,
      ...((options.tiers as Record<string, { provider: string; model: string }>) ?? {}),
    },
    cacheTtlMs: (options.cacheTtlMs as number) ?? DEFAULT_CONFIG.cacheTtlMs,
  };
}

// ── Router ──

export const tokenSaverRouter: GuardClawRouter = {
  id: "token-saver",

  async detect(
    context: DetectionContext,
    pluginConfig: Record<string, unknown>,
  ): Promise<RouterDecision> {
    const config = resolveConfig(pluginConfig);
    if (!config.enabled && !context.dryRun) {
      return { level: "S1", action: "passthrough" };
    }

    // Subagent sessions skip token-saver entirely.
    // No per-message judge calls — subagents use their own default model.
    const isSubagent = context.sessionKey?.includes(":subagent:") ?? false;
    if (isSubagent) {
      return { level: "S1", action: "passthrough", reason: "subagent — skipped" };
    }

    const prompt = context.message ?? "";
    if (!prompt.trim()) {
      return { level: "S1", action: "passthrough" };
    }

    startCacheCleanup();

    // Check cache
    const cacheKey = hashPrompt(prompt);
    const cached = classificationCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < config.cacheTtlMs) {
      return buildDecision(cached.tier, config);
    }

    // Call LLM judge
    try {
      const judgeSystemPrompt = loadPrompt("token-saver-judge", DEFAULT_JUDGE_PROMPT);
      const result = await callChatCompletion(
        config.judgeEndpoint,
        config.judgeModel,
        [
          { role: "system", content: judgeSystemPrompt },
          { role: "user", content: prompt },
        ],
        {
          temperature: 0,
          maxTokens: 1024,
          providerType: config.judgeProviderType,
          customModule: config.judgeCustomModule,
          apiKey: config.judgeApiKey,
        },
      );

      // Record router overhead tokens
      if (result.usage) {
        const collector = getGlobalCollector();
        collector?.record({
          sessionKey: context.sessionKey ?? "",
          provider: "edge",
          model: config.judgeModel,
          source: "router",
          usage: result.usage,
        });
      }

      const tier = parseTier(result.text);
      classificationCache.set(cacheKey, { tier, ts: Date.now() });
      return buildDecision(tier, config);
    } catch (err) {
      console.error(`[GuardClaw] [TokenSaver] judge call failed:`, err);
      return { level: "S1", action: "passthrough", reason: "judge call failed — passthrough" };
    }
  },
};

// ── Exports for testing ──

export { parseTier, hashPrompt, classificationCache, resolveConfig, DEFAULT_CONFIG, DEFAULT_JUDGE_PROMPT };
export type { Tier, TokenSaverConfig };
