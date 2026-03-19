/**
 * GuardClaw — Privacy-aware plugin for OpenClaw
 *
 * Entry point. Follows ClawRouter's three-step integration pattern:
 *   1. registerProvider  — register "guardclaw-privacy" proxy provider
 *   2. config injection  — point provider at local privacy proxy
 *   3. registerService   — manage proxy lifecycle
 *   4. init pipeline     — create router pipeline + register built-in & custom routers
 *   5. registerHooks     — wire up all detection + routing hooks
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { guardClawConfigSchema, defaultPrivacyConfig } from "./src/config-schema.js";
import { registerHooks } from "./src/hooks.js";
import { guardClawPrivacyProvider, setActiveProxy, mirrorAllProviderModels, collectTierModelIds, ensureModelMirrored } from "./src/provider.js";
import { startPrivacyProxy, setDefaultProviderTarget } from "./src/privacy-proxy.js";
import { RouterPipeline, setGlobalPipeline } from "./src/router-pipeline.js";
import { privacyRouter } from "./src/routers/privacy.js";
import { tokenSaverRouter } from "./src/routers/token-saver.js";
import { TokenStatsCollector, setGlobalCollector } from "./src/token-stats.js";
import { initLiveConfig, watchConfigFile } from "./src/live-config.js";
import { initDashboard, statsHttpHandler } from "./src/stats-dashboard.js";
import type { PrivacyConfig, PipelineConfig, RouterRegistration } from "./src/types.js";
import type { ProxyHandle } from "./src/privacy-proxy.js";
import { resolveDefaultBaseUrl } from "./src/utils.js";

// ── Standalone config file ──
// guardclaw.json is the single source of truth for all GuardClaw config.
// Structure: { "privacy": { ... } }
const OPENCLAW_DIR = join(process.env.HOME ?? "/tmp", ".openclaw");
const GUARDCLAW_CONFIG_PATH = join(OPENCLAW_DIR, "guardclaw.json");
const LEGACY_DASHBOARD_PATH = join(OPENCLAW_DIR, "guardclaw-dashboard.json");

function loadGuardClawConfigFile(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(GUARDCLAW_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function loadLegacyDashboardOverrides(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(LEGACY_DASHBOARD_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function writeGuardClawConfigFile(config: Record<string, unknown>): void {
  try {
    mkdirSync(OPENCLAW_DIR, { recursive: true });
    writeFileSync(GUARDCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch { /* best-effort */ }
}

function getPrivacyConfig(pluginConfig: Record<string, unknown> | undefined): PrivacyConfig {
  const userConfig = (pluginConfig?.privacy ?? {}) as PrivacyConfig;
  return { ...defaultPrivacyConfig, ...userConfig } as PrivacyConfig;
}

/**
 * Determine the API type to register for the guardclaw-privacy provider.
 *
 * The proxy is a transparent HTTP relay, so we need the SDK to send requests
 * in a format that both the proxy can parse and the downstream provider accepts.
 *
 * - For Google-native APIs: use "openai-completions" since most Google gateways
 *   accept OpenAI format, and Google's native SDK may bypass the HTTP proxy.
 * - For Anthropic: use "anthropic-messages" so the SDK sends the right format
 *   and auth scheme. The proxy handles forwarding transparently.
 * - For everything else: use the original API type (usually "openai-completions").
 */
function resolveProxyApi(originalApi: string): string {
  const api = originalApi.toLowerCase();
  // Google native SDKs construct their own URLs and may bypass the HTTP proxy;
  // fall back to openai-completions which Google gateways typically accept.
  if (api.includes("google") || api.includes("gemini")) {
    return "openai-completions";
  }
  // Anthropic's native API is proxy-friendly (standard HTTP POST to /v1/messages)
  if (api === "anthropic-messages") {
    return "anthropic-messages";
  }
  return originalApi;
}

const plugin = {
  id: "guardclaw",
  name: "GuardClaw",
  description: "Privacy-aware plugin with extensible router pipeline, guard agent, and built-in privacy proxy",
  version: "2026.3.0",
  configSchema: guardClawConfigSchema,

  register(api: OpenClawPluginApi) {
    // ── Resolve config: guardclaw.json > (openclaw.json + legacy overrides) ──
    let resolvedPluginConfig: Record<string, unknown>;
    const fileConfig = loadGuardClawConfigFile();
    if (fileConfig) {
      resolvedPluginConfig = fileConfig;
      api.logger.info("[GuardClaw] Config loaded from guardclaw.json");
    } else {
      // First run: generate guardclaw.json from openclaw.json plugin config + defaults
      const userPrivacy = ((api.pluginConfig ?? {}) as Record<string, unknown>).privacy as Record<string, unknown> | undefined;
      const legacyOverrides = loadLegacyDashboardOverrides();
      const mergedPrivacy = {
        ...defaultPrivacyConfig,
        ...(userPrivacy ?? {}),
        ...(legacyOverrides ?? {}),
      };
      if (legacyOverrides) {
        api.logger.info("[GuardClaw] Migrated legacy guardclaw-dashboard.json overrides");
      }
      resolvedPluginConfig = { privacy: mergedPrivacy };
      writeGuardClawConfigFile(resolvedPluginConfig);
      api.logger.info("[GuardClaw] Generated guardclaw.json with full defaults");
    }

    const privacyConfig = getPrivacyConfig(resolvedPluginConfig);

    if (privacyConfig.enabled === false) {
      api.logger.info("[GuardClaw] Plugin disabled via config");
      return;
    }

    // ── Step 1: Register provider ──
    api.registerProvider(guardClawPrivacyProvider as Parameters<typeof api.registerProvider>[0]);

    // ── Step 2: Runtime config injection ──
    const proxyPort = privacyConfig.proxyPort ?? 8403;
    if (!api.config.models) {
      (api.config as Record<string, unknown>).models = { providers: {} };
    }
    const models = api.config.models as { providers?: Record<string, unknown> };
    if (!models.providers) models.providers = {};

    // Detect the default provider's API type so the proxy can adapt
    const agentDefaults = (api.config.agents as Record<string, unknown> | undefined)?.defaults as Record<string, unknown> | undefined;
    const primaryModelStr = (agentDefaults?.model as Record<string, unknown> | undefined)?.primary as string ?? "";
    const defaultProvider = (agentDefaults?.provider as string) || primaryModelStr.split("/")[0] || "openai";
    const providerConfig = models.providers?.[defaultProvider] as Record<string, unknown> | undefined;
    const originalApi = (providerConfig?.api as string) ?? "openai-completions";

    // Use openai-completions for the proxy provider: the proxy acts as a transparent
    // HTTP relay and most providers (including Google gateways) accept OpenAI format.
    // For Anthropic-native, we match the API so the SDK sends the right format.
    const proxyApi = resolveProxyApi(originalApi);

    // Phase 1a: mirror all models explicitly listed in provider configs
    const mirroredModels = mirrorAllProviderModels(
      api.config as { models?: { providers?: Record<string, { models?: unknown }> } },
    );

    // Phase 1b: also pre-register models referenced by router tier configs
    // (e.g. token-saver tiers) that may not appear in any provider's models list
    const tierModels = collectTierModelIds(resolvedPluginConfig);
    const mirroredIds = new Set(mirroredModels.map((m) => (m as Record<string, unknown>).id));
    for (const { provider: tierProv, modelId: tierModel } of tierModels) {
      if (mirroredIds.has(tierModel)) continue;
      // Look up the model in its provider; if not found, create a fallback
      // entry with properties from that provider's first model so that
      // contextWindow / maxTokens / reasoning match the direct route.
      const tierProvModels = (models.providers?.[tierProv] as Record<string, unknown> | undefined)?.models;
      let entry: Record<string, unknown> | undefined;
      if (Array.isArray(tierProvModels)) {
        const found = tierProvModels.find((m: unknown) => (m as Record<string, unknown>).id === tierModel);
        if (found) entry = { ...(found as Record<string, unknown>) };
      }
      if (!entry) {
        const firstModel = Array.isArray(tierProvModels) && tierProvModels.length > 0
          ? tierProvModels[0] as Record<string, unknown>
          : null;
        entry = {
          id: tierModel,
          name: tierModel,
          ...(firstModel?.contextWindow != null ? { contextWindow: firstModel.contextWindow } : {}),
          ...(firstModel?.maxTokens != null ? { maxTokens: firstModel.maxTokens } : {}),
        };
      }
      mirroredModels.push(entry);
      mirroredIds.add(tierModel);
    }

    const privacyProviderEntry = {
      baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
      api: proxyApi,
      apiKey: "guardclaw-proxy-handles-auth",
      models: mirroredModels,
    };
    models.providers["guardclaw-privacy"] = privacyProviderEntry;

    // Patch the runtime config snapshot (structuredClone of api.config) so
    // that model resolution inside the embedded agent runner can find the
    // guardclaw-privacy virtual provider.
    const runtimeLoadConfig = (): Record<string, unknown> | undefined => {
      try { return api.runtime.config.loadConfig(); } catch { return undefined; }
    };
    try {
      const runtimeCfg = runtimeLoadConfig();
      if (runtimeCfg && runtimeCfg !== api.config) {
        if (!runtimeCfg.models) {
          (runtimeCfg as Record<string, unknown>).models = { providers: {} };
        }
        const rtModels = runtimeCfg.models as { providers?: Record<string, unknown> };
        if (!rtModels.providers) rtModels.providers = {};
        rtModels.providers["guardclaw-privacy"] = privacyProviderEntry;
      }
    } catch {
      // Non-fatal: runtime config patching is best-effort
    }

    // Propagate thinking + streaming defaults for all mirrored models.
    // Uses ensureModelMirrored's internal propagateThinkingForModel for
    // reasoning models; streaming propagation is handled separately below.
    for (const m of mirroredModels as Array<Record<string, unknown>>) {
      if (m.reasoning === true && typeof m.id === "string") {
        ensureModelMirrored(
          api.config as Record<string, unknown>,
          m.id as string,
          defaultProvider,
          runtimeLoadConfig,
        );
      }
    }

    // Propagate streaming=false for models that have it set in agent defaults
    const existingModelsOverrides = (agentDefaults?.models as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [key, override] of Object.entries(existingModelsOverrides)) {
      if (override?.streaming === false) {
        const modelId = key.includes("/") ? key.split("/").slice(1).join("/") : key;
        const proxyKey = `guardclaw-privacy/${modelId}`;
        if (!existingModelsOverrides[proxyKey]) {
          existingModelsOverrides[proxyKey] = { streaming: false };
        }
      }
    }
    try {
      const runtimeCfg = runtimeLoadConfig();
      if (runtimeCfg) {
        const rtAgents = (runtimeCfg as Record<string, unknown>).agents as Record<string, unknown> | undefined;
        const rtDefaults = rtAgents?.defaults as Record<string, unknown> | undefined;
        if (rtDefaults) {
          const rtModelsOverrides = (rtDefaults.models ?? {}) as Record<string, Record<string, unknown>>;
          for (const [key, override] of Object.entries(existingModelsOverrides)) {
            if (key.startsWith("guardclaw-privacy/")) {
              rtModelsOverrides[key] = override;
            }
          }
          rtDefaults.models = rtModelsOverrides;
        }
      }
    } catch {
      // Non-fatal
    }

    // Set default provider target for the proxy
    if (providerConfig) {
      const defaultBaseUrl = resolveDefaultBaseUrl(defaultProvider, originalApi);
      const modelsOverrides = (agentDefaults?.models as Record<string, Record<string, unknown>> | undefined) ?? {};
      const modelStreamingPref = modelsOverrides[primaryModelStr]?.streaming;
      setDefaultProviderTarget({
        baseUrl: (providerConfig.baseUrl as string) ?? defaultBaseUrl,
        apiKey: (providerConfig.apiKey as string) ?? "",
        provider: defaultProvider,
        api: originalApi,
        ...(modelStreamingPref === false ? { streaming: false } : {}),
      });
    }

    api.logger.info(`[GuardClaw] Privacy provider registered (proxy port: ${proxyPort})`);

    // ── Step 2b: Ensure MEMORY-FULL.md and memory-full/ are in memorySearch.extraPaths ──
    // This is required so that memory_get can read from the full-memory files
    // (isMemoryPath only allows MEMORY.md, memory.md, and memory/ by default).
    const patchExtraPaths = (cfg: Record<string, unknown>) => {
      const agts = (cfg.agents ?? {}) as Record<string, unknown>;
      const defs = (agts.defaults ?? {}) as Record<string, unknown>;
      const ms = (defs.memorySearch ?? {}) as Record<string, unknown>;
      const existing = (ms.extraPaths ?? []) as string[];
      const requiredPaths = ["MEMORY-FULL.md", "memory-full"];
      const missing = requiredPaths.filter((p) => !existing.includes(p));
      if (missing.length === 0) return false;
      const updated = [...existing, ...missing];
      if (!cfg.agents) cfg.agents = { defaults: {} };
      const a = cfg.agents as Record<string, unknown>;
      if (!a.defaults) a.defaults = {};
      const d = a.defaults as Record<string, unknown>;
      if (!d.memorySearch) d.memorySearch = {};
      (d.memorySearch as Record<string, unknown>).extraPaths = updated;
      return true;
    };
    if (patchExtraPaths(api.config as Record<string, unknown>)) {
      api.logger.info(`[GuardClaw] Added to memorySearch.extraPaths: MEMORY-FULL.md, memory-full`);
    }
    try {
      const runtimeCfg = api.runtime.config.loadConfig();
      if (runtimeCfg && runtimeCfg !== api.config) {
        patchExtraPaths(runtimeCfg as Record<string, unknown>);
      }
    } catch { /* best-effort */ }

    // ── Step 3: Register service for proxy lifecycle ──
    let proxyHandle: ProxyHandle | null = null;
    api.registerService({
      id: "guardclaw-proxy",
      start: async () => {
        try {
          proxyHandle = await startPrivacyProxy(proxyPort, api.logger);
          setActiveProxy(proxyHandle);
          api.logger.info(`[GuardClaw] Privacy proxy started on port ${proxyPort}`);
        } catch (err) {
          api.logger.error(`[GuardClaw] Failed to start privacy proxy: ${String(err)}`);
        }
      },
      stop: async () => {
        if (proxyHandle) {
          try {
            await proxyHandle.close();
            api.logger.info("[GuardClaw] Privacy proxy stopped");
          } catch (err) {
            api.logger.warn(`[GuardClaw] Failed to close proxy: ${String(err)}`);
          }
        }
      },
    });

    // ── Step 4: Initialize router pipeline ──
    const pipeline = new RouterPipeline(api.logger);

    // Register built-in routers
    const routerConfigs = (privacyConfig as Record<string, unknown>).routers as Record<string, RouterRegistration> | undefined;
    pipeline.register(privacyRouter, routerConfigs?.privacy ?? { enabled: true, type: "builtin" });
    pipeline.register(tokenSaverRouter, routerConfigs?.["token-saver"] ?? { enabled: false, type: "builtin" });

    // Configure pipeline from user config
    pipeline.configure({
      routers: routerConfigs,
      pipeline: (privacyConfig as Record<string, unknown>).pipeline as PipelineConfig | undefined,
    });

    // Load custom routers (async, non-blocking)
    pipeline.loadCustomRouters().then(() => {
      const routers = pipeline.listRouters();
      if (routers.length > 1) {
        api.logger.info(`[GuardClaw] Pipeline routers: ${routers.join(", ")}`);
      }
    }).catch((err) => {
      api.logger.error(`[GuardClaw] Failed to load custom routers: ${String(err)}`);
    });

    setGlobalPipeline(pipeline);
    api.logger.info(`[GuardClaw] Router pipeline initialized (built-in: privacy)`);

    // ── Step 5: Initialize live config & token stats ──
    initLiveConfig(resolvedPluginConfig);
    watchConfigFile(GUARDCLAW_CONFIG_PATH, api.logger);

    const statsPath = join(process.env.HOME ?? "/tmp", ".openclaw", "guardclaw-stats.json");
    const collector = new TokenStatsCollector(statsPath);
    setGlobalCollector(collector);
    collector.load().then(() => {
      collector.startAutoFlush();
      api.logger.info(`[GuardClaw] Token stats initialized (${statsPath})`);
    }).catch((err) => {
      api.logger.error(`[GuardClaw] Failed to load token stats: ${String(err)}`);
    });

    // ── Step 6: Register Dashboard HTTP route ──
    initDashboard({
      pluginId: "guardclaw",
      pluginConfig: resolvedPluginConfig,
      pipeline,
    });

    api.registerHttpRoute({
      path: "/plugins/guardclaw/stats",
      auth: "plugin",
      match: "prefix",
      handler: async (req, res) => {
        const handled = await statsHttpHandler(req, res);
        if (!handled) {
          res.writeHead(404);
          res.end("Not Found");
        }
      },
    });

    api.logger.info("[GuardClaw] Dashboard registered at /plugins/guardclaw/stats");

    // ── Step 7: Register all hooks ──
    registerHooks(api);

    api.logger.info("[GuardClaw] Plugin initialized (pipeline + privacy proxy + guard agent + dashboard)");

    const c = "\x1b[36m", g = "\x1b[32m", y = "\x1b[33m", b = "\x1b[1m", d = "\x1b[2m", r = "\x1b[0m", bg = "\x1b[46m\x1b[30m";
    const W = 70;
    const bar = "═".repeat(W);
    const pad = (colored: string, visLen: number) => {
      const sp = " ".repeat(Math.max(0, W - visLen));
      return `${c}  ║${r}${colored}${sp}${c}║${r}`;
    };

    api.logger.info("");
    api.logger.info(`${c}  ╔${bar}╗${r}`);
    api.logger.info(pad(`  ${bg}${b} 🛡️  GuardClaw ${r}${g}${b}  Ready!${r}`, 25));
    api.logger.info(pad("", 0));
    api.logger.info(pad(`  ${y}Dashboard${r} ${d}→${r}  ${b}http://127.0.0.1:18789/plugins/guardclaw/stats${r}`, 62));
    api.logger.info(pad(`  ${y}Config${r}    ${d}→${r}  ${b}~/.openclaw/guardclaw.json${r}`, 40));
    api.logger.info(pad("", 0));
    api.logger.info(pad(`  ${d}Use the Dashboard to configure routers, rules & prompts.${r}`, 58));
    api.logger.info(`${c}  ╚${bar}╝${r}`);
    api.logger.info("");
  },
};

export default plugin;
