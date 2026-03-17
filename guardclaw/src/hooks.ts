/**
 * GuardClaw Hooks — openclaw adaptation
 *
 * Registers all plugin hooks for sensitivity detection at various checkpoints.
 * Uses the RouterPipeline to dispatch to multiple composable routers
 * (built-in "privacy" + any user-defined custom routers).
 *
 * Architecture:
 *   before_model_resolve  → pipeline.run("onUserMessage") → RouterDecision
 *   before_prompt_build   → reads stashed decision → inject prompt/markers
 *   before_tool_call      → pipeline + memory_get path redirect (dual-track)
 *   after_tool_call       → pipeline + memory dual-write sync
 *   tool_result_persist   → PII redaction + memory_search result filtering
 *   before_message_write  → sanitize transcript based on stashed decision
 *   after_compaction      → full memory sync (FULL → clean)
 *   before_reset          → full memory sync before session clear
 *   + session_end, message_sending, before_agent_start, message_received
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PrivacyConfig } from "./types.js";
import {
  buildMainSessionPlaceholder,
  getGuardAgentConfig,
  isGuardSessionKey,
} from "./guard-agent.js";
import { desensitizeWithLocalModel } from "./local-model.js";
import { getDefaultMemoryManager, GUARD_SECTION_BEGIN, GUARD_SECTION_END } from "./memory-isolation.js";
import { loadPrompt } from "./prompt-loader.js";
import { DualSessionManager, getDefaultSessionManager, type SessionMessage } from "./session-manager.js";
import {
  markSessionAsPrivate,
  trackSessionLevel,
  recordDetection,
  isSessionMarkedPrivate,
  stashDetection,
  getPendingDetection,
  consumeDetection,
  setActiveLocalRouting,
  clearActiveLocalRouting,
  clearSessionState,
  isActiveLocalRouting,
} from "./session-state.js";
import { detectByRules } from "./rules.js";
import { isProtectedMemoryPath, redactSensitiveInfo, extractPathsFromParams, resolveDefaultBaseUrl } from "./utils.js";
import {
  GUARDCLAW_S2_OPEN,
  GUARDCLAW_S2_CLOSE,
  stashOriginalProvider,
} from "./privacy-proxy.js";
import { getGlobalPipeline } from "./router-pipeline.js";
import { getGlobalCollector } from "./token-stats.js";
import { getLiveConfig } from "./live-config.js";

function getPipelineConfig(): Record<string, unknown> {
  return { privacy: getLiveConfig() };
}

/**
 * Should this session read from the full (unredacted) memory track?
 *
 * Only sessions whose data stays entirely local may access MEMORY-FULL.md:
 *   - S3 active local routing (Guard Agent turn)
 *   - Guard sub-sessions (always local)
 *   - S2 with s2Policy === "local"
 *
 * S2-proxy sessions send data to cloud after desensitisation, so they MUST
 * read from the clean (already-redacted) MEMORY.md to avoid leaking PII
 * that regex-based tool_result_persist redaction might miss.
 */
function shouldUseFullMemoryTrack(sessionKey: string): boolean {
  if (isActiveLocalRouting(sessionKey)) return true;
  if (isGuardSessionKey(sessionKey)) return true;
  if (isSessionMarkedPrivate(sessionKey)) {
    const policy = getLiveConfig().s2Policy ?? "proxy";
    return policy === "local";
  }
  return false;
}

const DEFAULT_GUARD_AGENT_SYSTEM_PROMPT = `You are a privacy-aware analyst. Analyze the data the user provides. Do your job.

RULES:
1. Analyze the data directly. Do NOT write code. Do NOT generate programming examples or tutorials.
2. NEVER echo raw sensitive values (exact salary, SSN, bank account, password). Use generic references like "your base salary", "the SSN on file", etc.
3. You MAY discuss percentages, ratios, whether deductions are correct, anomalies, and recommendations.
4. Reply ONCE, then stop. No [message_id:] tags. No multi-turn simulation.
5. **Language rule: Reply in the SAME language the user writes in.** If the user writes in Chinese, reply entirely in Chinese. If the user writes in English, reply entirely in English.
6. Be concise and professional.

语言规则：必须使用与用户相同的语言回复。如果用户用中文提问，你必须用中文回答。`;

function getGuardAgentSystemPrompt(): string {
  return loadPrompt("guard-agent-system", DEFAULT_GUARD_AGENT_SYSTEM_PROMPT);
}

/**
 * Check if a tool is exempt from privacy pipeline detection and PII redaction.
 * Reads from the live config `toolAllowlist` (default: empty = no exemptions).
 */
function isToolAllowlisted(toolName: string): boolean {
  const allowlist = getLiveConfig().toolAllowlist;
  if (!allowlist || allowlist.length === 0) return false;
  return allowlist.includes(toolName);
}

// Workspace dir cache — set from first hook that has PluginHookAgentContext
let _cachedWorkspaceDir: string | undefined;

export function registerHooks(api: OpenClawPluginApi): void {
  const privacyCfgInit = getLiveConfig();
  const sessionBaseDir = privacyCfgInit.session?.baseDir;

  const memoryManager = getDefaultMemoryManager();
  memoryManager.initializeDirectories().catch((err) => {
    api.logger.error(`[GuardClaw] Failed to initialize memory directories: ${String(err)}`);
  });

  getDefaultSessionManager(sessionBaseDir);

  // =========================================================================
  // Hook 1: before_model_resolve — Run pipeline + model routing
  // =========================================================================
  api.on("before_model_resolve", async (event, ctx) => {
    try {
      const { prompt } = event;
      const sessionKey = ctx.sessionKey ?? "";
      if (!sessionKey || !prompt) return;

      clearActiveLocalRouting(sessionKey);

      const privacyConfig = getLiveConfig();
      if (!privacyConfig.enabled) return;

      if (isGuardSessionKey(sessionKey)) {
        const guardCfg = getGuardAgentConfig(privacyConfig);
        if (guardCfg) {
          return { providerOverride: guardCfg.provider, modelOverride: guardCfg.modelName };
        }
        return;
      }

      if (ctx.workspaceDir) _cachedWorkspaceDir = ctx.workspaceDir;

      const msgStr = String(prompt);
      if (shouldSkipMessage(msgStr)) return;

      // ── S3 fast path: rule-based pre-check ──────────────────────────
      // Rules are synchronous and deterministic. When they detect S3 we
      // can route to the local model immediately — no need to run the
      // full pipeline (LLM detector, token-saver, custom routers, etc.)
      // which would waste compute and needlessly expose sensitive content.
      const rulePreCheck = detectByRules(
        { checkpoint: "onUserMessage", message: msgStr, sessionKey },
        privacyConfig,
      );

      if (rulePreCheck.level === "S3") {
        recordDetection(sessionKey, "S3", "onUserMessage", rulePreCheck.reason);
        trackSessionLevel(sessionKey, "S3");
        setActiveLocalRouting(sessionKey);
        stashDetection(sessionKey, {
          level: "S3",
          reason: rulePreCheck.reason,
          originalPrompt: msgStr,
          timestamp: Date.now(),
        });

        const guardCfg = getGuardAgentConfig(privacyConfig);
        const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
        const provider = guardCfg?.provider ?? defaultProvider;
        const model = guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1";
        api.logger.info(`[GuardClaw] S3 (rule fast-path) — routing to ${provider}/${model}`);
        return { providerOverride: provider, modelOverride: model };
      }

      // ── Normal path: run the full router pipeline ──────────────────
      const pipeline = getGlobalPipeline();
      if (!pipeline) {
        api.logger.warn("[GuardClaw] Router pipeline not initialized");
        return;
      }

      const decision = await pipeline.run(
        "onUserMessage",
        {
          checkpoint: "onUserMessage",
          message: prompt,
          sessionKey,
          agentId: ctx.agentId,
        },
        getPipelineConfig(),
      );

      recordDetection(sessionKey, decision.level, "onUserMessage", decision.reason);
      api.logger.info(`[GuardClaw] ROUTE: session=${sessionKey} level=${decision.level} action=${decision.action} target=${JSON.stringify(decision.target)} reason=${decision.reason}`);
      if (decision.level === "S1" && decision.action === "passthrough") {
        return;
      }

      // S3 from LLM detector (rules didn't catch it above): route to local
      if (decision.level === "S3") {
        trackSessionLevel(sessionKey, "S3");
        setActiveLocalRouting(sessionKey);
        stashDetection(sessionKey, {
          level: "S3",
          reason: decision.reason,
          originalPrompt: msgStr,
          timestamp: Date.now(),
        });
        if (decision.target) {
          api.logger.info(`[GuardClaw] S3 — routing to ${decision.target.provider}/${decision.target.model} [${decision.routerId}]`);
          return {
            providerOverride: decision.target.provider,
            ...(decision.target.model ? { modelOverride: decision.target.model } : {}),
          };
        }
        const guardCfg = getGuardAgentConfig(privacyConfig);
        const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
        api.logger.info(`[GuardClaw] S3 — routing to ${guardCfg?.provider ?? defaultProvider}/${guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1"} [${decision.routerId}]`);
        return {
          providerOverride: guardCfg?.provider ?? defaultProvider,
          modelOverride: guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1",
        };
      }

      // Desensitize for S2 (needed for both proxy markers and local prompt).
      // If desensitization fails (local model down), escalate to S3 so the
      // message stays entirely local — never send raw PII to cloud.
      let desensitized: string | undefined;
      if (decision.level === "S2") {
        const result = await desensitizeWithLocalModel(msgStr, privacyConfig, sessionKey);
        if (result.failed) {
          api.logger.warn("[GuardClaw] S2 desensitization failed — escalating to S3 (local-only) to prevent PII leak");
          trackSessionLevel(sessionKey, "S3");
          setActiveLocalRouting(sessionKey);
          stashDetection(sessionKey, {
            level: "S3",
            reason: `${decision.reason}; desensitization failed — escalated to S3`,
            originalPrompt: msgStr,
            timestamp: Date.now(),
          });
          const guardCfg = getGuardAgentConfig(privacyConfig);
          const fallbackProvider = privacyConfig.localModel?.provider ?? "ollama";
          return {
            providerOverride: guardCfg?.provider ?? fallbackProvider,
            modelOverride: guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1",
          };
        }
        desensitized = result.desensitized;
      }

      // Stash decision for before_prompt_build / before_message_write
      stashDetection(sessionKey, {
        level: decision.level,
        reason: decision.reason,
        desensitized,
        originalPrompt: msgStr,
        timestamp: Date.now(),
      });

      // S2-local: route to edge model
      if (decision.level === "S2" && decision.action === "redirect" && decision.target?.provider !== "guardclaw-privacy") {
        markSessionAsPrivate(sessionKey, decision.level);
        if (decision.target) {
          api.logger.info(`[GuardClaw] S2 — routing to ${decision.target.provider}/${decision.target.model} [${decision.routerId}]`);
          return {
            providerOverride: decision.target.provider,
            ...(decision.target.model ? { modelOverride: decision.target.model } : {}),
          };
        }
      }

      // S2-proxy path
      if (decision.level === "S2" && decision.target?.provider === "guardclaw-privacy") {
        markSessionAsPrivate(sessionKey, "S2");
        const defaults = api.config.agents?.defaults as Record<string, unknown> | undefined;
        const primaryModel = (defaults?.model as Record<string, unknown> | undefined)?.primary as string ?? "";
        const defaultProvider = (defaults?.provider as string) || primaryModel.split("/")[0] || "openai";
        const providerConfig = api.config.models?.providers?.[defaultProvider];
        if (providerConfig) {
          const pc = providerConfig as Record<string, unknown>;
          const providerApi = (pc.api as string) ?? undefined;
          const stashTarget = {
            baseUrl: (pc.baseUrl as string) ?? resolveDefaultBaseUrl(defaultProvider, providerApi),
            apiKey: (pc.apiKey as string) ?? "",
            provider: defaultProvider,
            api: providerApi,
          };
          stashOriginalProvider(sessionKey, stashTarget);
        }
        const modelInfo = decision.target.model ? ` (model=${decision.target.model})` : "";
        api.logger.info(`[GuardClaw] S2 — routing through privacy proxy${modelInfo} [${decision.routerId}]`);
        return {
          providerOverride: "guardclaw-privacy",
          ...(decision.target.model ? { modelOverride: decision.target.model } : {}),
        };
      }

      // Non-privacy routers may return redirect with a custom target
      if (decision.action === "redirect" && decision.target) {
        api.logger.info(`[GuardClaw] ${decision.level} — custom route to ${decision.target.provider}/${decision.target.model} [${decision.routerId}]`);
        return {
          providerOverride: decision.target.provider,
          ...(decision.target.model ? { modelOverride: decision.target.model } : {}),
        };
      }

      // Block action at model resolve level → route to edge model as safeguard
      if (decision.action === "block") {
        if (decision.level === "S3") {
          trackSessionLevel(sessionKey, "S3");
          setActiveLocalRouting(sessionKey);
        } else {
          markSessionAsPrivate(sessionKey, decision.level);
        }
        const guardCfg = getGuardAgentConfig(privacyConfig);
        const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
        api.logger.warn(`[GuardClaw] ${decision.level} BLOCK — redirecting to edge model [${decision.routerId}]`);
        return {
          providerOverride: guardCfg?.provider ?? defaultProvider,
          modelOverride: guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1",
        };
      }

      // Default: no override — let the original provider handle the request
      // so provider-specific sanitization (Google turn ordering, tool schema
      // cleaning, transcript policy) in openclaw core still triggers correctly.
      return;
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in before_model_resolve hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 2: before_prompt_build — Inject guard prompt / S2 markers /
  //         dual-track history for local models
  // =========================================================================
  api.on("before_prompt_build", async (_event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      if (!sessionKey) return;

      const pending = getPendingDetection(sessionKey);
      if (!pending || pending.level === "S1") return;

      const privacyConfig = getLiveConfig();
      const sessionCfg = privacyConfig.session ?? {};
      const shouldInject = sessionCfg.injectDualHistory !== false
        && sessionCfg.isolateGuardHistory !== false;
      const historyLimit = sessionCfg.historyLimit ?? 20;

      // S3: data processed entirely locally. Inject full-track history
      // so the local model sees previous S3 interactions that were replaced
      // by "🔒 [Private content]" placeholders in the main transcript.
      if (pending.level === "S3") {
        if (shouldInject) {
          const context = await loadDualTrackContext(sessionKey, ctx.agentId, historyLimit);
          if (context) {
            api.logger.info(`[GuardClaw] Injected full-track history for S3 turn`);
            return { prependContext: context };
          }
        }
        return;
      }

      const s2Policy = privacyConfig.s2Policy ?? "proxy";

      // S2-local: data stays on-device — inject full-track history for richer context.
      if (pending.level === "S2" && s2Policy === "local") {
        if (shouldInject) {
          const context = await loadDualTrackContext(sessionKey, ctx.agentId, historyLimit);
          if (context) {
            api.logger.info(`[GuardClaw] Injected full-track history for S2-local turn`);
            return { prependContext: context };
          }
        }
        return;
      }

      // S2-proxy: inject desensitized content wrapped in markers for privacy-proxy to strip.
      //
      // SAFETY CONTRACT: OpenClaw's before_prompt_build `prependContext` prepends
      // text directly to the user prompt string (see plugin.md §Prompt build order).
      // The resulting message content becomes:
      //   "<guardclaw-s2>\n{desensitized}\n</guardclaw-s2>\n\n{original PII}"
      // The proxy's stripPiiMarkers() replaces the ENTIRE content with only the text
      // between markers, effectively discarding the original PII that follows.
      // If OpenClaw ever changes prependContext semantics (e.g. to a separate message),
      // the proxy's fallback regex redaction provides defense-in-depth.
      if (pending.level === "S2" && pending.desensitized) {
        return {
          prependContext: `${GUARDCLAW_S2_OPEN}\n${pending.desensitized}\n${GUARDCLAW_S2_CLOSE}`,
        };
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in before_prompt_build hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 3: before_tool_call — Run pipeline at onToolCallProposed
  // =========================================================================
  api.on("before_tool_call", async (event, ctx) => {
    try {
      const { toolName, params } = event;
      const sessionKey = ctx.sessionKey ?? "";
      if (!toolName) return;

      const typedParams = params as Record<string, unknown>;
      const privacyConfig = getLiveConfig();
      const baseDir = privacyConfig.session?.baseDir ?? "~/.openclaw";

      // File-access guard for cloud models only — local models (Guard Agent
      // sessions and S3 active routing) are trusted to read full history.
      if (!isGuardSessionKey(sessionKey) && !isActiveLocalRouting(sessionKey)) {
        const pathValues = extractPathsFromParams(typedParams);
        for (const p of pathValues) {
          if (isProtectedMemoryPath(p, baseDir)) {
            api.logger.warn(`[GuardClaw] BLOCKED: cloud model tried to access protected path: ${p}`);
            return { block: true, blockReason: `GuardClaw: access to full history/memory is restricted for cloud models (${p})` };
          }
        }
      }

      // Memory read routing: only fully-local sessions read from MEMORY-FULL.md.
      // S2-proxy sessions stay on the clean track to avoid leaking PII to cloud.
      if (toolName === "memory_get" && shouldUseFullMemoryTrack(sessionKey)) {
        const p = String(typedParams.path ?? "");
        if (p === "MEMORY.md" || p === "memory.md") {
          return { params: { ...typedParams, path: "MEMORY-FULL.md" } };
        }
        if (p.startsWith("memory/")) {
          return { params: { ...typedParams, path: p.replace(/^memory\//, "memory-full/") } };
        }
      }

      // Subagent / A2A guard
      const isSpawn = toolName === "sessions_spawn";
      const isSend = toolName === "sessions_send";
      if (isSpawn || isSend) {
        const contentField = isSpawn ? String(typedParams?.task ?? "") : String(typedParams?.message ?? "");
        if (contentField.trim()) {
          const pipeline = getGlobalPipeline();
          if (pipeline) {
            const decision = await pipeline.run(
              "onToolCallProposed",
              { checkpoint: "onToolCallProposed", message: contentField, toolName, toolParams: typedParams, sessionKey, agentId: ctx.agentId },
              getPipelineConfig(),
            );
            recordDetection(sessionKey, decision.level, "onToolCallProposed", decision.reason);

            if (decision.level === "S3" || decision.action === "block") {
              if (decision.level === "S3") {
                trackSessionLevel(sessionKey, "S3");
              } else {
                markSessionAsPrivate(sessionKey, decision.level);
              }
              return { block: true, blockReason: `GuardClaw: ${isSpawn ? "subagent task" : "A2A message"} blocked — ${decision.level} (${decision.reason ?? "sensitive"})` };
            }
            if (decision.level === "S2") {
              markSessionAsPrivate(sessionKey, "S2");
              const { desensitized } = await desensitizeWithLocalModel(contentField, privacyConfig, sessionKey);
              return { params: { ...typedParams, [isSpawn ? "task" : "message"]: desensitized } };
            }
          }
        }
      }

      // General tool call detection via pipeline.
      // S3 local routing: the model is already local — re-running the
      // pipeline would block the very tool calls the local model needs.
      // Internal infrastructure tools are also exempt from pipeline checks.
      if (!isActiveLocalRouting(sessionKey) && !isToolAllowlisted(toolName)) {
        const pipeline = getGlobalPipeline();
        if (pipeline) {
          const decision = await pipeline.run(
            "onToolCallProposed",
            { checkpoint: "onToolCallProposed", toolName, toolParams: typedParams, sessionKey, agentId: ctx.agentId },
            getPipelineConfig(),
          );
          recordDetection(sessionKey, decision.level, "onToolCallProposed", decision.reason);

          if (decision.level === "S3" || decision.action === "block") {
            if (decision.level === "S3") {
              trackSessionLevel(sessionKey, "S3");
            } else {
              markSessionAsPrivate(sessionKey, decision.level);
            }
            return { block: true, blockReason: `GuardClaw: tool "${toolName}" blocked — ${decision.level} (${decision.reason ?? "sensitive"})` };
          }
          if (decision.level === "S2") {
            markSessionAsPrivate(sessionKey, "S2");
          }
        }
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in before_tool_call hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 4: after_tool_call — Pipeline detection + memory dual-write sync
  // =========================================================================
  api.on("after_tool_call", async (event, ctx) => {
    try {
      const { toolName, result } = event;
      const sessionKey = ctx.sessionKey ?? "";
      if (!toolName) return;

      // Pipeline detection — skip when already in S3 local routing
      // Also skip for internal infrastructure tools whose results naturally contain tokens
      if (!isActiveLocalRouting(sessionKey) && !isToolAllowlisted(toolName)) {
        const pipeline = getGlobalPipeline();
        if (pipeline) {
          const decision = await pipeline.run(
            "onToolCallExecuted",
            { checkpoint: "onToolCallExecuted", toolName, toolResult: result, sessionKey, agentId: ctx.agentId },
            getPipelineConfig(),
          );
          recordDetection(sessionKey, decision.level, "onToolCallExecuted", decision.reason);

          if (decision.level === "S3") {
            trackSessionLevel(sessionKey, "S3");
            setActiveLocalRouting(sessionKey);
          } else if (decision.level === "S2") {
            markSessionAsPrivate(sessionKey, "S2");
          }

          // S3/S2 mid-turn: model can't be switched (this hook is void/fire-and-forget),
          // so both levels receive S2-equivalent treatment — LLM-based PII extraction
          // for better desensitization than the sync rule-based pass in tool_result_persist.
          // tool_result_persist already did rule-based redaction on the session transcript
          // (first defense for the cloud model's next API call). This async pass writes
          // properly desensitized content to the dual-track histories.
          if (decision.level === "S3" || decision.level === "S2") {
            const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
            if (resultStr.length >= 10) {
              const privacyConfig = getLiveConfig();
              const desenResult = await desensitizeWithLocalModel(resultStr, privacyConfig, sessionKey);
              const desensitized = desenResult.failed
                ? redactSensitiveInfo(resultStr)
                : desenResult.desensitized;

              const sessionManager = getDefaultSessionManager();
              sessionManager.writeToFull(sessionKey, {
                role: "tool", content: resultStr, timestamp: Date.now(), sessionKey,
              }).catch(() => {});
              sessionManager.writeToClean(sessionKey, {
                role: "tool", content: desensitized, timestamp: Date.now(), sessionKey,
              }).catch(() => {});

              api.logger.info(`[GuardClaw] ${decision.level} tool result LLM-desensitized for dual-track (tool=${toolName}, model=${desenResult.failed ? "fallback-rules" : "llm"})`);
            }
          }
        }
      }

      // Memory dual-write: when Agent writes to memory files, sync the other track
      if (toolName === "write" || toolName === "write_file") {
        const writePath = String(event.params?.path ?? "");
        if (writePath && isMemoryWritePath(writePath)) {
          const workspaceDir = _cachedWorkspaceDir ?? process.cwd();
          const privacyConfig = getLiveConfig();
          syncMemoryWrite(writePath, workspaceDir, privacyConfig, api.logger, isGuardSessionKey(sessionKey)).catch((err) => {
            api.logger.warn(`[GuardClaw] Memory dual-write sync failed: ${String(err)}`);
          });
        }
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in after_tool_call hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 5: tool_result_persist — PII detection, memory_search filtering
  // =========================================================================
  api.on("tool_result_persist", (event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      if (!sessionKey) return;

      const msg = event.message;
      if (!msg) return;

      // ── memory_search result filtering ──
      // QMD indexes both MEMORY.md and MEMORY-FULL.md (via extraPaths).
      // Filter out the wrong track so each session type only sees its own.
      if (ctx.toolName === "memory_search") {
        const filtered = filterMemorySearchResults(msg, shouldUseFullMemoryTrack(sessionKey));
        if (filtered) return { message: filtered };
        return;
      }

      // ── S3 local routing: dual-track split ──
      // The local model sees full content (via dual-track history injection),
      // but the main transcript must be redacted so future S1 turns don't
      // leak S3 tool results to cloud models.
      if (isActiveLocalRouting(sessionKey)) {
        const textContent = extractMessageText(msg);
        if (textContent && textContent.length >= 10) {
          const sessionManager = getDefaultSessionManager();
          const ts = Date.now();
          sessionManager.writeToFull(sessionKey, {
            role: "tool", content: textContent, timestamp: ts, sessionKey,
          }).catch(() => {});
          const redacted = redactSensitiveInfo(textContent);
          if (redacted !== textContent) {
            api.logger.info(`[GuardClaw] S3 tool result PII-redacted for transcript (tool=${ctx.toolName ?? "unknown"})`);
            sessionManager.writeToClean(sessionKey, {
              role: "tool", content: redacted, timestamp: ts, sessionKey,
            }).catch(() => {});
            const modified = replaceMessageText(msg, redacted);
            if (modified) return { message: modified };
          } else {
            sessionManager.writeToClean(sessionKey, {
              role: "tool", content: textContent, timestamp: ts, sessionKey,
            }).catch(() => {});
          }
        }
        return;
      }

      // Internal infrastructure tools (gateway, web_fetch, etc.) naturally contain
      // auth headers/tokens that must NOT be redacted or the tool breaks.
      if (ctx.toolName && isToolAllowlisted(ctx.toolName)) return;

      const textContent = extractMessageText(msg);
      if (!textContent || textContent.length < 10) return;

      // ── Synchronous sensitivity detection + PII redaction ──
      //
      // This hook is sync so we cannot call the local model. Both S3 and S2
      // content discovered mid-turn receive the same treatment: rule-based
      // PII redaction. The cloud model cannot be switched mid-loop (after_tool_call
      // is void/fire-and-forget), so S3 is effectively handled as S2 here.
      //
      // We still differentiate state tracking:
      //   S3 → trackSessionLevel + setActiveLocalRouting (same-turn subsequent
      //         tool results enter the activeLocalRouting branch above;
      //         cleared at start of next turn's before_model_resolve)
      //   S2 → markSessionAsPrivate (persists across turns)
      //
      // after_tool_call may race with this hook (async vs sync). Running
      // detectByRules here ensures we catch S3/S2 content regardless.

      const privacyConfig = getLiveConfig();
      const ruleCheck = detectByRules(
        {
          checkpoint: "onToolCallExecuted",
          toolName: ctx.toolName,
          toolResult: textContent,
          sessionKey,
        },
        privacyConfig,
      );

      const detectedSensitive = ruleCheck.level === "S3" || ruleCheck.level === "S2";

      if (detectedSensitive) {
        if (ruleCheck.level === "S3") {
          trackSessionLevel(sessionKey, "S3");
          setActiveLocalRouting(sessionKey);
        }
        markSessionAsPrivate(sessionKey, ruleCheck.level);
        recordDetection(sessionKey, ruleCheck.level, "onToolCallExecuted", ruleCheck.reason);
      }

      const redacted = redactSensitiveInfo(textContent);
      const wasRedacted = redacted !== textContent;

      // Dual-track persistence: original → full, redacted → clean
      if (detectedSensitive || wasRedacted || isSessionMarkedPrivate(sessionKey)) {
        const sessionManager = getDefaultSessionManager();
        const ts = Date.now();
        sessionManager.writeToFull(sessionKey, {
          role: "tool", content: textContent, timestamp: ts, sessionKey,
        }).catch(() => {});
        sessionManager.writeToClean(sessionKey, {
          role: "tool", content: wasRedacted ? redacted : textContent, timestamp: ts, sessionKey,
        }).catch(() => {});
      }

      if (wasRedacted) {
        const level = ruleCheck.level !== "S1" ? ruleCheck.level : "S2";
        api.logger.info(`[GuardClaw] ${level} tool result desensitized for transcript (tool=${ctx.toolName ?? "unknown"}${ruleCheck.reason ? `, reason=${ruleCheck.reason}` : ""})`);
        if (!detectedSensitive) markSessionAsPrivate(sessionKey, "S2");
        const modified = replaceMessageText(msg, redacted);
        if (modified) return { message: modified };
      } else if (detectedSensitive) {
        api.logger.info(`[GuardClaw] ${ruleCheck.level} detected in tool result but no PII patterns to redact (tool=${ctx.toolName ?? "unknown"}, reason=${ruleCheck.reason ?? "rule match"})`);
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in tool_result_persist hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 6: before_message_write — Dual history persistence + sanitize transcript
  // =========================================================================
  api.on("before_message_write", (event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      if (!sessionKey) return;

      const msg = event.message;
      if (!msg) return;

      const role = (msg as { role?: string }).role ?? "";
      const pending = getPendingDetection(sessionKey);

      // ── Dual session history persistence ──
      // Persist every message (user, assistant, system) to full/clean tracks
      // when the session is private.  Tool messages are handled separately
      // in tool_result_persist (Hook 5) to avoid double-writes.
      //
      // Also persist when pending detection is S3: Guard Agent is physically
      // isolated so the main session isn't marked private, but we still want
      // the S3 user message recorded (original → full, placeholder → clean)
      // for audit purposes.
      const needsDualHistory = isSessionMarkedPrivate(sessionKey) || (pending?.level === "S3") || isActiveLocalRouting(sessionKey);
      if (needsDualHistory && role !== "tool") {
        const sessionManager = getDefaultSessionManager();
        const msgText = extractMessageText(msg);
        const ts = Date.now();

        if (role === "user" && pending && pending.level !== "S1") {
          // S2/S3 user message: original content → full, sanitized → clean
          const original = pending.originalPrompt ?? msgText;
          sessionManager.writeToFull(sessionKey, {
            role: "user", content: original, timestamp: ts, sessionKey,
          }).catch((err) => {
            console.error("[GuardClaw] Failed to persist user message to full history:", err);
          });
          const cleanContent = pending.level === "S3"
            ? buildMainSessionPlaceholder("S3", undefined, ts)
            : (pending.desensitized ?? msgText);
          sessionManager.writeToClean(sessionKey, {
            role: "user", content: cleanContent, timestamp: ts, sessionKey,
          }).catch((err) => {
            console.error("[GuardClaw] Failed to persist user message to clean history:", err);
          });
        } else if (msgText) {
          if (role === "assistant" && isActiveLocalRouting(sessionKey)) {
            // Local model response may contain echoed PII — write original
            // to full track, PII-redacted version to clean track.
            const redacted = redactSensitiveInfo(msgText);
            sessionManager.writeToFull(sessionKey, {
              role: "assistant", content: msgText, timestamp: ts, sessionKey,
            }).catch((err) => {
              console.error("[GuardClaw] Failed to persist assistant message to full history:", err);
            });
            sessionManager.writeToClean(sessionKey, {
              role: "assistant", content: redacted, timestamp: ts, sessionKey,
            }).catch((err) => {
              console.error("[GuardClaw] Failed to persist assistant message to clean history:", err);
            });
          } else {
            // System / S1-user / non-local-routing assistant messages:
            // persistMessage handles guard-agent filtering (guard → full only, others → both).
            sessionManager.persistMessage(sessionKey, {
              role: (role as SessionMessage["role"]) || "assistant",
              content: msgText, timestamp: ts, sessionKey,
            }).catch((err) => {
              console.error("[GuardClaw] Failed to persist message to dual history:", err);
            });
          }
        }
      }

      // ── PII-redact assistant responses from local model ──
      // When S3 data is processed locally the model may echo back PII
      // (e.g. "Your ID 310101... is valid"). Redact before entering the
      // main transcript so subsequent cloud turns don't see raw PII.
      if (role === "assistant" && isActiveLocalRouting(sessionKey)) {
        const assistantText = extractMessageText(msg);
        if (assistantText && assistantText.length >= 10) {
          const redacted = redactSensitiveInfo(assistantText);
          if (redacted !== assistantText) {
            api.logger.info("[GuardClaw] PII-redacted local model response before transcript write");
            return { message: { ...(msg as Record<string, unknown>), content: [{ type: "text", text: redacted }] } };
          }
        }
      }

      // ── Sanitize user messages for session transcript ──
      if (role !== "user") return;
      if (!pending || pending.level === "S1") return;

      if (pending.level === "S3") {
        consumeDetection(sessionKey);
        return { message: { ...msg, content: [{ type: "text", text: buildMainSessionPlaceholder("S3", undefined, pending.timestamp) }] } };
      }
      if (pending.level === "S2" && pending.desensitized) {
        consumeDetection(sessionKey);
        return { message: { ...msg, content: [{ type: "text", text: pending.desensitized }] } };
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in before_message_write hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 7: session_end — Memory sync
  // =========================================================================
  api.on("session_end", async (event, ctx) => {
    try {
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      if (!sessionKey) return;

      const wasPrivate = isSessionMarkedPrivate(sessionKey);
      api.logger.info(`[GuardClaw] ${wasPrivate ? "private" : "cloud"} session ${sessionKey} ended. Syncing memory…`);

      const memMgr = getDefaultMemoryManager();
      const privacyConfig = getLiveConfig();
      await memMgr.syncAllMemoryToClean(privacyConfig);

      clearSessionState(sessionKey);

      const collector = getGlobalCollector();
      if (collector) await collector.flush();
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in session_end hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 8: after_compaction — Full memory sync
  // =========================================================================
  api.on("after_compaction", async (_event, ctx) => {
    try {
      if (ctx.workspaceDir) _cachedWorkspaceDir = ctx.workspaceDir;
      const memMgr = getDefaultMemoryManager();
      const privacyConfig = getLiveConfig();
      await memMgr.syncAllMemoryToClean(privacyConfig);
      api.logger.info("[GuardClaw] Memory synced after compaction");
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in after_compaction hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 9: llm_output — Token usage tracking
  // =========================================================================
  api.on("llm_output", async (event, ctx) => {
    try {
      const collector = getGlobalCollector();
      if (!collector) return;
      collector.record({
        sessionKey: ctx.sessionKey ?? event.sessionId ?? "",
        provider: event.provider ?? "unknown",
        model: event.model ?? "unknown",
        source: "task",
        usage: event.usage,
      });
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in llm_output hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 10: before_reset — Full memory sync before session clear
  // =========================================================================
  api.on("before_reset", async (_event, ctx) => {
    try {
      if (ctx.workspaceDir) _cachedWorkspaceDir = ctx.workspaceDir;
      const memMgr = getDefaultMemoryManager();
      const privacyConfig = getLiveConfig();
      await memMgr.syncAllMemoryToClean(privacyConfig);
      api.logger.info("[GuardClaw] Memory synced before reset");
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in before_reset hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 11: message_sending — Outbound message guard (via pipeline)
  // =========================================================================
  api.on("message_sending", async (event, ctx) => {
    try {
      const { content } = event;
      if (!content?.trim()) return;

      const privacyConfig = getLiveConfig();
      if (!privacyConfig.enabled) return;

      const pipeline = getGlobalPipeline();
      if (!pipeline) return;

      const decision = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: content },
        getPipelineConfig(),
      );

      if (decision.level === "S3" || decision.action === "block") {
        api.logger.warn("[GuardClaw] BLOCKED outbound message: S3/block detected");
        return { cancel: true };
      }
      if (decision.level === "S2") {
        const { desensitized } = await desensitizeWithLocalModel(content, privacyConfig, ctx.sessionKey);
        return { content: desensitized };
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in message_sending hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 12: before_agent_start — Subagent guard (via pipeline)
  // =========================================================================
  api.on("before_agent_start", async (event, ctx) => {
    try {
      const { prompt } = event;
      const sessionKey = ctx.sessionKey ?? "";
      if (!sessionKey.includes(":subagent:") || !prompt?.trim()) return;

      const privacyConfig = getLiveConfig();
      if (!privacyConfig.enabled) return;

      const pipeline = getGlobalPipeline();
      if (!pipeline) return;

      const decision = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: prompt, sessionKey, agentId: ctx.agentId },
        getPipelineConfig(),
      );

      // S3 / block: route the subagent to a local model instead of
      // modifying the system prompt.  The cloud model has already seen the
      // prompt text, so altering system instructions is not a reliable
      // security control.  Routing to a local model keeps the data local.
      if (decision.level === "S3" || decision.action === "block") {
        const guardCfg = getGuardAgentConfig(privacyConfig);
        const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
        const provider = guardCfg?.provider ?? defaultProvider;
        const model = guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1";
        api.logger.info(`[GuardClaw] Subagent ${decision.level} — routing to ${provider}/${model}`);
        return {
          providerOverride: provider,
          modelOverride: model,
        };
      }
      if (decision.level === "S2") {
        const privacyCfg = getLiveConfig();
        const desenResult = await desensitizeWithLocalModel(prompt, privacyCfg, sessionKey);
        if (desenResult.failed) {
          const guardCfg = getGuardAgentConfig(privacyCfg);
          const fallbackProvider = privacyCfg.localModel?.provider ?? "ollama";
          const provider = guardCfg?.provider ?? fallbackProvider;
          const model = guardCfg?.modelName ?? privacyCfg.localModel?.model ?? "openbmb/minicpm4.1";
          api.logger.warn(`[GuardClaw] Subagent S2 desensitization failed — routing to local ${provider}/${model}`);
          return { providerOverride: provider, modelOverride: model };
        }
        api.logger.info("[GuardClaw] Subagent S2 — prompt desensitized before forwarding");
        return { prompt: desenResult.desensitized };
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in before_agent_start hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 13: message_received — Observational logging
  // =========================================================================
  api.on("message_received", async (event, _ctx) => {
    try {
      const privacyConfig = getLiveConfig();
      if (!privacyConfig.enabled) return;
      api.logger.info?.(`[GuardClaw] Message received from ${event.from ?? "unknown"}`);
    } catch { /* observational only */ }
  });

  api.logger.info("[GuardClaw] All hooks registered (13 hooks, pipeline-driven)");
}

// ==========================================================================
// Helpers
// ==========================================================================

function shouldSkipMessage(msg: string): boolean {
  if (msg.includes("[REDACTED:") || msg.startsWith("[SYSTEM]")) return true;
  if (/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(msg)) return true;
  return false;
}

/**
 * Extract text from an AgentMessage (supports string content and content arrays).
 */
function extractMessageText(msg: unknown): string {
  if (typeof msg === "string") return msg;
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;

  if (typeof m.content === "string") return m.content;

  if (Array.isArray(m.content)) {
    return m.content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
          return (part as Record<string, unknown>).text as string;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

/**
 * Replace text content in an AgentMessage, preserving the message structure.
 */
function replaceMessageText(msg: unknown, newText: string): unknown | null {
  if (typeof msg === "string") return newText;
  if (!msg || typeof msg !== "object") return null;
  const m = { ...(msg as Record<string, unknown>) };

  if (typeof m.content === "string") {
    return { ...m, content: newText };
  }

  if (Array.isArray(m.content)) {
    return { ...m, content: [{ type: "text", text: newText }] };
  }

  return null;
}

// ── Dual-track history injection helper ───────────────────────────────────

/**
 * Load the full (unsanitized) session history for local model injection.
 *
 * The full track is seeded from the clean track on first write, so it
 * contains the complete conversation from the start — S1 messages (copied
 * from clean) plus S2/S3 originals.  The local model gets a single,
 * coherent, authoritative history without needing to reconcile two sources.
 */
async function loadDualTrackContext(
  sessionKey: string,
  agentId?: string,
  limit?: number,
): Promise<string | null> {
  try {
    const mgr = getDefaultSessionManager();
    const full = await mgr.loadHistory(sessionKey, false, agentId ?? "main", limit);
    if (full.length === 0) return null;
    return DualSessionManager.formatAsContext(full);
  } catch {
    return null;
  }
}

// ── Memory dual-write helpers ─────────────────────────────────────────────

const MEMORY_WRITE_PATTERNS = [
  /^MEMORY\.md$/,
  /^memory\.md$/,
  /^memory\//,
];

function isMemoryWritePath(writePath: string): boolean {
  const rel = writePath.replace(/^\.\//, "");
  return MEMORY_WRITE_PATTERNS.some((p) => p.test(rel));
}

/**
 * After Agent writes to a memory file, dual-write to the other track:
 *   MEMORY.md written → read content → write full to MEMORY-FULL.md, redact to MEMORY.md
 *   memory/X.md written → read → write full to memory-full/X.md, redact to memory/X.md
 */
async function syncMemoryWrite(
  writePath: string,
  workspaceDir: string,
  privacyConfig: PrivacyConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  isGuardSession: boolean = false,
): Promise<void> {
  const rel = writePath.replace(/^\.\//, "");
  const absPath = path.isAbsolute(writePath)
    ? writePath
    : path.resolve(workspaceDir, rel);

  let content: string;
  try {
    content = await fs.promises.readFile(absPath, "utf-8");
  } catch {
    return;
  }

  if (!content.trim()) return;

  // Determine the counterpart path
  let fullRelPath: string;
  if (rel === "MEMORY.md" || rel === "memory.md") {
    fullRelPath = "MEMORY-FULL.md";
  } else if (rel.startsWith("memory/")) {
    fullRelPath = rel.replace(/^memory\//, "memory-full/");
  } else {
    return;
  }

  const fullAbsPath = path.resolve(workspaceDir, fullRelPath);

  // Ensure directory exists for daily memory files
  await fs.promises.mkdir(path.dirname(fullAbsPath), { recursive: true });

  // Wrap guard agent content with explicit markers so filterGuardContent
  // can reliably strip it when syncing FULL → CLEAN.
  const fullContent = isGuardSession
    ? `${GUARD_SECTION_BEGIN}\n${content}\n${GUARD_SECTION_END}`
    : content;
  await fs.promises.writeFile(fullAbsPath, fullContent, "utf-8");

  // Redact PII and overwrite the clean version
  const memMgr = getDefaultMemoryManager();
  const redacted = await memMgr.redactContentPublic(content, privacyConfig);
  if (redacted !== content) {
    await fs.promises.writeFile(absPath, redacted, "utf-8");
    logger.info(`[GuardClaw] Memory dual-write: ${rel} → ${fullRelPath} (redacted clean copy)`);
  } else {
    logger.info(`[GuardClaw] Memory dual-write: ${rel} → ${fullRelPath} (no PII found)`);
  }
}

/**
 * Filter memory_search results: strip results from the wrong memory track.
 * Cloud-bound sessions should not see MEMORY-FULL.md / memory-full/ results.
 * Fully-local sessions should not see MEMORY.md / memory/ results (prefer full).
 */
function filterMemorySearchResults(msg: unknown, useFullTrack: boolean): unknown | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;

  const textContent = extractMessageText(msg);
  if (!textContent) return null;

  try {
    const parsed = JSON.parse(textContent);
    if (!parsed || typeof parsed !== "object") return null;

    const results = (parsed as Record<string, unknown>).results;
    if (!Array.isArray(results)) return null;

    const filtered = results.filter((r: unknown) => {
      if (!r || typeof r !== "object") return true;
      const rPath = String((r as Record<string, unknown>).path ?? "");
      if (useFullTrack) {
        // Fully-local session: exclude clean-track results (prefer full)
        if (rPath === "MEMORY.md" || rPath === "memory.md" || rPath.startsWith("memory/")) {
          return false;
        }
      } else {
        // Cloud-bound session: exclude full-track results
        if (rPath === "MEMORY-FULL.md" || rPath.startsWith("memory-full/")) {
          return false;
        }
      }
      return true;
    });

    if (filtered.length === results.length) return null;

    const newParsed = { ...parsed as Record<string, unknown>, results: filtered };
    const newText = JSON.stringify(newParsed);
    return replaceMessageText(msg, newText);
  } catch {
    return null;
  }
}
