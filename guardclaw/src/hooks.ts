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
 *   before_tool_call      → pipeline.run("onToolCallProposed") → block/allow
 *   after_tool_call       → pipeline.run("onToolCallExecuted") → mark session
 *   before_message_write  → sanitize transcript based on stashed decision
 *   + session_end, message_sending, before_agent_start, message_received
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type { PrivacyConfig, RouterDecision } from "./types.js";
import { defaultPrivacyConfig } from "./config-schema.js";
import {
  getGuardAgentConfig,
  isGuardSessionKey,
} from "./guard-agent.js";
import { desensitizeWithLocalModel } from "./local-model.js";
import { getDefaultMemoryManager } from "./memory-isolation.js";
import { loadPrompt } from "./prompt-loader.js";
import { getDefaultSessionManager, type SessionMessage } from "./session-manager.js";
import {
  markSessionAsPrivate,
  recordDetection,
  isSessionMarkedPrivate,
  markPreReadFiles,
  isFilePreRead,
  stashDetection,
  getPendingDetection,
  consumeDetection,
} from "./session-state.js";
import { isProtectedMemoryPath } from "./utils.js";
import {
  GUARDCLAW_S2_OPEN,
  GUARDCLAW_S2_CLOSE,
  stashOriginalProvider,
} from "./privacy-proxy.js";
import { getGlobalPipeline } from "./router-pipeline.js";

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

const PRIVACY_S2_SYSTEM_INSTRUCTION = `[PRIVACY GUARD - IMPORTANT]
The user's message may contain a desensitized data section.
You MUST:
1. NEVER reference, quote, or echo any specific PII values
2. Use generic references (e.g., "your address", "the recipient") instead of actual values
3. NEVER include [REDACTED:xxx] tags in your response — use natural language
4. Reply in the same language as the user.`;

export function registerHooks(api: OpenClawPluginApi): void {
  const memoryManager = getDefaultMemoryManager();
  memoryManager.initializeDirectories().catch((err) => {
    api.logger.error(`[GuardClaw] Failed to initialize memory directories: ${String(err)}`);
  });

  // =========================================================================
  // Hook 1: before_model_resolve — Run pipeline + model routing
  // =========================================================================
  api.on("before_model_resolve", async (event, ctx) => {
    try {
      const { prompt } = event;
      const sessionKey = ctx.sessionKey ?? "";
      if (!sessionKey || !prompt) return;

      const privacyConfig = getPrivacyConfigFromApi(api);
      if (!privacyConfig.enabled) return;

      if (isGuardSessionKey(sessionKey)) {
        const guardCfg = getGuardAgentConfig(privacyConfig);
        if (guardCfg) {
          return { providerOverride: guardCfg.provider, modelOverride: guardCfg.modelName };
        }
        return;
      }

      const msgStr = String(prompt);
      if (shouldSkipMessage(msgStr)) return;

      // Pre-read referenced files
      const workspaceDir = ctx.workspaceDir ?? process.cwd();
      let preReadFileContent: string | undefined;
      try {
        preReadFileContent = await tryReadReferencedFile(msgStr, workspaceDir);
      } catch { /* ignore */ }

      // Run the router pipeline
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
          fileContentSnippet: preReadFileContent?.slice(0, 800),
        },
        api.pluginConfig ?? {},
      );

      recordDetection(sessionKey, decision.level, "onUserMessage", decision.reason);
      if (decision.level === "S1" && decision.action === "passthrough") return;

      // Desensitize for S2 (needed for both proxy markers and local prompt)
      let desensitized: string | undefined;
      if (decision.level === "S2") {
        const content = preReadFileContent ?? msgStr;
        const { desensitized: d } = await desensitizeWithLocalModel(content, privacyConfig);
        desensitized = d;
      }

      // Stash decision for before_prompt_build / before_message_write
      stashDetection(sessionKey, {
        level: decision.level,
        reason: decision.reason,
        desensitized,
        preReadFileContent,
        originalPrompt: msgStr,
        timestamp: Date.now(),
      });

      // Apply routing based on decision
      if (decision.level === "S3" || (decision.level === "S2" && decision.action === "redirect" && decision.target?.provider !== "guardclaw-privacy")) {
        markSessionAsPrivate(sessionKey, decision.level);
        if (decision.target) {
          api.logger.info(`[GuardClaw] ${decision.level} — routing to ${decision.target.provider}/${decision.target.model} [${decision.routerId}]`);
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
          stashOriginalProvider(sessionKey, {
            baseUrl: (providerConfig as Record<string, unknown>).baseUrl as string ?? "https://api.openai.com/v1",
            apiKey: (providerConfig as Record<string, unknown>).apiKey as string ?? "",
            provider: defaultProvider,
          });
        }
        if (preReadFileContent) markPreReadFiles(sessionKey, msgStr);
        api.logger.info(`[GuardClaw] S2 — routing through privacy proxy [${decision.routerId}]`);
        return { providerOverride: "guardclaw-privacy" };
      }

      // Non-privacy routers may return redirect with a custom target
      if (decision.action === "redirect" && decision.target) {
        api.logger.info(`[GuardClaw] ${decision.level} — custom route to ${decision.target.provider}/${decision.target.model} [${decision.routerId}]`);
        return {
          providerOverride: decision.target.provider,
          ...(decision.target.model ? { modelOverride: decision.target.model } : {}),
        };
      }

      // Block action at model resolve level → route to local as safeguard
      if (decision.action === "block") {
        markSessionAsPrivate(sessionKey, decision.level);
        const guardCfg = getGuardAgentConfig(privacyConfig);
        api.logger.warn(`[GuardClaw] ${decision.level} BLOCK — redirecting to local model [${decision.routerId}]`);
        return {
          providerOverride: guardCfg?.provider ?? "ollama",
          modelOverride: guardCfg?.modelName ?? "openbmb/minicpm4.1",
        };
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in before_model_resolve hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 2: before_prompt_build — Inject guard prompt / S2 markers
  // =========================================================================
  api.on("before_prompt_build", async (_event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      if (!sessionKey) return;

      const pending = getPendingDetection(sessionKey);
      if (!pending || pending.level === "S1") return;

      const privacyConfig = getPrivacyConfigFromApi(api);

      // S3: keep original agent system prompt and skills — only inject file content if pre-read
      if (pending.level === "S3") {
        if (pending.preReadFileContent) {
          return { prependContext: `[File content for analysis]\n\`\`\`\n${pending.preReadFileContent}\n\`\`\`` };
        }
        return;
      }

      // S2-local: inject guard agent system prompt
      if (pending.level === "S2" && (privacyConfig.s2Policy ?? "proxy") === "local") {
        const guardPrompt = getGuardAgentSystemPrompt();
        return {
          prependSystemContext: guardPrompt,
          ...(pending.preReadFileContent
            ? { prependContext: `[File content for analysis]\n\`\`\`\n${pending.preReadFileContent}\n\`\`\`` }
            : {}),
        };
      }

      // S2-proxy: inject markers for privacy-proxy to strip
      if (pending.level === "S2" && pending.desensitized) {
        const isChinese = /[\u4e00-\u9fff]/.test(pending.originalPrompt ?? "");
        const filePathPattern = /(?:[\w./-]+\/)?[\w\u4e00-\u9fff._-]+\.(?:xlsx|xls|csv|txt|docx|json|md)/g;
        const taskDescription = (pending.originalPrompt ?? "")
          .replace(filePathPattern, "")
          .replace(/\s{2,}/g, " ")
          .trim();

        let desensitizedPrompt: string;
        if (pending.preReadFileContent) {
          const langInstruction = isChinese
            ? "请仅根据上方已脱敏的内容完成任务。不要读取任何文件——内容已经提供。回复中不得出现 [REDACTED:xxx] 标记，用自然语言概括即可。"
            : "Complete the task based ONLY on the desensitized content above. Do NOT read any files. Your reply must NOT contain any [REDACTED:xxx] tags.";
          desensitizedPrompt = `${taskDescription}\n\n--- FILE CONTENT ---\n${pending.desensitized}\n--- END FILE CONTENT ---\n\n${langInstruction}`;
        } else {
          desensitizedPrompt = pending.desensitized;
        }

        return {
          prependContext: `${GUARDCLAW_S2_OPEN}\n${desensitizedPrompt}\n${GUARDCLAW_S2_CLOSE}`,
          appendSystemContext: PRIVACY_S2_SYSTEM_INSTRUCTION,
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
      const privacyConfig = getPrivacyConfigFromApi(api);
      const baseDir = privacyConfig.session?.baseDir ?? "~/.openclaw";

      // File-access guard for cloud models
      if (!isGuardSessionKey(sessionKey)) {
        const pathValues = extractPathValuesFromParams(typedParams);
        for (const p of pathValues) {
          if (isProtectedMemoryPath(p, baseDir)) {
            api.logger.warn(`[GuardClaw] BLOCKED: cloud model tried to access protected path: ${p}`);
            return { block: true, blockReason: `GuardClaw: access to full history/memory is restricted for cloud models (${p})` };
          }
        }
      }

      // Pre-read file guard
      if (toolName === "read" || toolName === "read_file" || toolName === "cat") {
        const filePath = String(typedParams?.path ?? typedParams?.file ?? typedParams?.target ?? "");
        if (filePath && isFilePreRead(sessionKey, filePath)) {
          return { block: true, blockReason: "File content has already been provided in the conversation (desensitized for privacy)." };
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
              api.pluginConfig ?? {},
            );
            recordDetection(sessionKey, decision.level, "onToolCallProposed", decision.reason);

            if (decision.level === "S3" || decision.action === "block") {
              markSessionAsPrivate(sessionKey, decision.level);
              return { block: true, blockReason: `GuardClaw: ${isSpawn ? "subagent task" : "A2A message"} blocked — ${decision.level} (${decision.reason ?? "sensitive"})` };
            }
            if (decision.level === "S2") {
              markSessionAsPrivate(sessionKey, "S2");
              const { desensitized } = await desensitizeWithLocalModel(contentField, privacyConfig);
              return { params: { ...typedParams, [isSpawn ? "task" : "message"]: desensitized } };
            }
          }
        }
      }

      // General tool call detection via pipeline
      const pipeline = getGlobalPipeline();
      if (pipeline) {
        const decision = await pipeline.run(
          "onToolCallProposed",
          { checkpoint: "onToolCallProposed", toolName, toolParams: typedParams, sessionKey, agentId: ctx.agentId },
          api.pluginConfig ?? {},
        );
        recordDetection(sessionKey, decision.level, "onToolCallProposed", decision.reason);

        if (decision.level === "S3" || decision.action === "block") {
          markSessionAsPrivate(sessionKey, decision.level);
          return { block: true, blockReason: `GuardClaw: tool "${toolName}" blocked — ${decision.level} (${decision.reason ?? "sensitive"})` };
        }
        if (decision.level === "S2") {
          markSessionAsPrivate(sessionKey, "S2");
        }
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in before_tool_call hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 4: after_tool_call — Run pipeline at onToolCallExecuted
  // =========================================================================
  api.on("after_tool_call", async (event, ctx) => {
    try {
      const { toolName, result } = event;
      const sessionKey = ctx.sessionKey ?? "";
      if (!toolName) return;

      const pipeline = getGlobalPipeline();
      if (!pipeline) return;

      const decision = await pipeline.run(
        "onToolCallExecuted",
        { checkpoint: "onToolCallExecuted", toolName, toolResult: result, sessionKey, agentId: ctx.agentId },
        api.pluginConfig ?? {},
      );
      recordDetection(sessionKey, decision.level, "onToolCallExecuted", decision.reason);

      if (decision.level === "S3" || decision.level === "S2") {
        markSessionAsPrivate(sessionKey, decision.level);
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in after_tool_call hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 5: tool_result_persist — Dual history persistence
  // =========================================================================
  api.on("tool_result_persist", (event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      if (!isSessionMarkedPrivate(sessionKey) || !sessionKey) return;

      const sessionManager = getDefaultSessionManager();
      const msgText = typeof event.message === "string" ? event.message : JSON.stringify(event.message);
      const sessionMessage: SessionMessage = { role: "tool", content: msgText, timestamp: Date.now(), sessionKey };
      sessionManager.persistMessage(sessionKey, sessionMessage).catch((err) => {
        console.error("[GuardClaw] Failed to persist tool result to dual history:", err);
      });
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in tool_result_persist hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 6: before_message_write — Sanitize session transcript
  // =========================================================================
  api.on("before_message_write", (event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? "";
      const pending = getPendingDetection(sessionKey);
      if (!pending || pending.level === "S1") return;

      const msg = event.message;
      if (!msg || (msg as { role?: string }).role !== "user") return;

      if (pending.level === "S3") {
        consumeDetection(sessionKey);
        return { message: { ...msg, content: [{ type: "text", text: "🔒 [Private content — processed locally]" }] } };
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
      const privacyConfig = getPrivacyConfigFromApi(api);
      await memMgr.syncAllMemoryToClean(privacyConfig);
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in session_end hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 8: message_sending — Outbound message guard (via pipeline)
  // =========================================================================
  api.on("message_sending", async (event, _ctx) => {
    try {
      const { content } = event;
      if (!content?.trim()) return;

      const privacyConfig = getPrivacyConfigFromApi(api);
      if (!privacyConfig.enabled) return;

      const pipeline = getGlobalPipeline();
      if (!pipeline) return;

      const decision = await pipeline.run(
        "onToolCallExecuted",
        { checkpoint: "onToolCallExecuted", message: content },
        api.pluginConfig ?? {},
      );

      if (decision.level === "S3" || decision.action === "block") {
        api.logger.warn("[GuardClaw] BLOCKED outbound message: S3/block detected");
        return { cancel: true };
      }
      if (decision.level === "S2") {
        const { desensitized } = await desensitizeWithLocalModel(content, privacyConfig);
        return { content: desensitized };
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in message_sending hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 9: before_agent_start — Subagent guard (via pipeline)
  // =========================================================================
  api.on("before_agent_start", async (event, ctx) => {
    try {
      const { prompt } = event;
      const sessionKey = ctx.sessionKey ?? "";
      if (!sessionKey.includes(":subagent:") || !prompt?.trim()) return;

      const privacyConfig = getPrivacyConfigFromApi(api);
      if (!privacyConfig.enabled) return;

      const pipeline = getGlobalPipeline();
      if (!pipeline) return;

      const decision = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: prompt, sessionKey, agentId: ctx.agentId },
        api.pluginConfig ?? {},
      );

      // S3: subagent keeps original system prompt and skills (already routed to local model)
      // Only block if the action explicitly requires it
      if (decision.action === "block") {
        return {
          systemPrompt:
            `[PRIVACY GUARD] This task contains ${decision.level}-level content (${decision.reason ?? "sensitive data"}). ` +
            `You MUST NOT process, analyze, or echo any of this data. ` +
            `Reply with: "This task contains private data that cannot be processed by a cloud model." Do NOT attempt the task.`,
        };
      }
      if (decision.level === "S2") {
        return { prependContext: `[PRIVACY NOTICE] The task below may contain PII. Do NOT echo exact PII values. Use generic references instead.` };
      }
    } catch (err) {
      api.logger.error(`[GuardClaw] Error in before_agent_start hook: ${String(err)}`);
    }
  });

  // =========================================================================
  // Hook 10: message_received — Observational logging
  // =========================================================================
  api.on("message_received", async (event, _ctx) => {
    try {
      const privacyConfig = getPrivacyConfigFromApi(api);
      if (!privacyConfig.enabled) return;
      api.logger.info?.(`[GuardClaw] Message received from ${event.from ?? "unknown"}`);
    } catch { /* observational only */ }
  });

  api.logger.info("[GuardClaw] All hooks registered (10 hooks, pipeline-driven)");
}

// ==========================================================================
// Helpers
// ==========================================================================

function getPrivacyConfigFromApi(api: OpenClawPluginApi): PrivacyConfig {
  const userConfig = (api.pluginConfig?.privacy as PrivacyConfig) ?? {};
  return {
    ...defaultPrivacyConfig,
    ...userConfig,
    checkpoints: { ...defaultPrivacyConfig.checkpoints, ...userConfig.checkpoints },
    rules: {
      keywords: { ...defaultPrivacyConfig.rules.keywords, ...userConfig.rules?.keywords },
      patterns: { ...defaultPrivacyConfig.rules.patterns, ...userConfig.rules?.patterns },
      tools: {
        S2: { ...defaultPrivacyConfig.rules.tools.S2, ...userConfig.rules?.tools?.S2 },
        S3: { ...defaultPrivacyConfig.rules.tools.S3, ...userConfig.rules?.tools?.S3 },
      },
    },
    localModel: { ...defaultPrivacyConfig.localModel, ...userConfig.localModel },
    guardAgent: { ...defaultPrivacyConfig.guardAgent, ...userConfig.guardAgent },
    session: { ...defaultPrivacyConfig.session, ...userConfig.session },
  };
}

function shouldSkipMessage(msg: string): boolean {
  if (msg.includes("[REDACTED:") || msg.startsWith("[SYSTEM]")) return true;
  if (/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(msg)) return true;
  return false;
}

function extractPathValuesFromParams(params: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const pathKeys = ["path", "file", "filepath", "filename", "dir", "directory", "target", "source"];
  for (const key of pathKeys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) paths.push(value.trim());
  }
  for (const value of Object.values(params)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      paths.push(...extractPathValuesFromParams(value as Record<string, unknown>));
    }
  }
  return paths;
}

async function tryReadReferencedFile(message: string, workspaceDir: string): Promise<string | undefined> {
  const filePattern = /(?:^|\s)((?:[\w./-]+\/)?[\w\u4e00-\u9fff._-]+\.(?:xlsx|xls|csv|txt|docx|json|md))\b/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = filePattern.exec(message)) !== null) matches.push(m[1]);
  if (matches.length === 0) return undefined;

  const cwd = process.cwd();
  const baseDirs = [workspaceDir, cwd, resolve(cwd, "..")].filter(Boolean);

  for (const filePath of matches) {
    try {
      let absPath = "";
      for (const base of baseDirs) {
        const candidate = resolve(base, filePath);
        if (existsSync(candidate)) { absPath = candidate; break; }
      }
      if (!absPath && existsSync(filePath)) absPath = resolve(filePath);
      if (!absPath) continue;

      const ext = filePath.split(".").pop()?.toLowerCase();
      if (ext === "xlsx" || ext === "xls") {
        try { return `[Converted from ${filePath}]\n${execSync(`xlsx2csv "${absPath}"`, { encoding: "utf-8", timeout: 10000 })}`; } catch {
          try { return `[Converted from ${filePath}]\n${execSync(`python3 -c "import openpyxl; wb=openpyxl.load_workbook('${absPath}'); ws=wb.active; [print(','.join(str(c.value or '') for c in row)) for row in ws.iter_rows()]"`, { encoding: "utf-8", timeout: 10000 })}`; } catch { return undefined; }
        }
      } else if (ext === "docx") {
        const pyCmd = `"from docx import Document; d=Document('${absPath}'); print('\\n'.join(p.text for p in d.paragraphs))"`;
        for (const py of ["python3", `${process.env.HOME}/miniconda3/bin/python3`]) {
          try { return `[Extracted from ${filePath}]\n${execSync(`${py} -c ${pyCmd}`, { encoding: "utf-8", timeout: 10000 })}`; } catch { continue; }
        }
        return undefined;
      } else {
        return `[Content of ${filePath}]\n${(await readFile(absPath, "utf-8")).slice(0, 10000)}`;
      }
    } catch { continue; }
  }
  return undefined;
}
