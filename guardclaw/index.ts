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
import { guardClawConfigSchema, defaultPrivacyConfig } from "./src/config-schema.js";
import { registerHooks } from "./src/hooks.js";
import { buildPrivacyProvider, setActiveProxy, mirrorAllProviderModels } from "./src/provider.js";
import { startPrivacyProxy, setDefaultProviderTarget } from "./src/privacy-proxy.js";
import { RouterPipeline, setGlobalPipeline } from "./src/router-pipeline.js";
import { privacyRouter } from "./src/routers/privacy.js";
import { tokenSaverRouter } from "./src/routers/token-saver.js";
import { createConfigurableRouter } from "./src/routers/configurable.js";
import { TokenStatsCollector, setGlobalCollector } from "./src/token-stats.js";
import { initLiveConfig } from "./src/live-config.js";
import { initDashboard, statsHttpHandler } from "./src/stats-dashboard.js";
import type { PrivacyConfig, PipelineConfig, RouterRegistration } from "./src/types.js";
import type { ProxyHandle } from "./src/privacy-proxy.js";

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
    const privacyConfig = getPrivacyConfig(api.pluginConfig);

    if (privacyConfig.enabled === false) {
      api.logger.info("[GuardClaw] Plugin disabled via config");
      return;
    }

    // ── Step 1 + 2: Register provider with mirrored models ──
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

    const mirroredModels = mirrorAllProviderModels(api.config as { models?: { providers?: Record<string, { models?: unknown }> } });
    const proxyModelsConfig = {
      baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
      api: proxyApi,
      apiKey: "guardclaw-proxy-handles-auth",
      models: mirroredModels,
    };

    api.registerProvider(
      buildPrivacyProvider(proxyModelsConfig) as Parameters<typeof api.registerProvider>[0],
    );
    models.providers["guardclaw-privacy"] = proxyModelsConfig;

    // Set default provider target for the proxy
    if (providerConfig) {
      setDefaultProviderTarget({
        baseUrl: (providerConfig.baseUrl as string) ?? "https://api.openai.com/v1",
        apiKey: (providerConfig.apiKey as string) ?? "",
        provider: defaultProvider,
        api: originalApi,
      });
    }

    api.logger.info(`[GuardClaw] Privacy provider registered (proxy port: ${proxyPort})`);

    // ── Step 2b: Ensure MEMORY-FULL.md and memory-full/ are in memorySearch.extraPaths ──
    // This is required so that memory_get can read from the full-memory files
    // (isMemoryPath only allows MEMORY.md, memory.md, and memory/ by default).
    const agents = (api.config as Record<string, unknown>).agents as Record<string, unknown> | undefined;
    const defaults = (agents?.defaults ?? {}) as Record<string, unknown>;
    const memSearch = (defaults.memorySearch ?? {}) as Record<string, unknown>;
    const existingExtra = (memSearch.extraPaths ?? []) as string[];
    const requiredPaths = ["MEMORY-FULL.md", "memory-full"];
    const missing = requiredPaths.filter((p) => !existingExtra.includes(p));
    if (missing.length > 0) {
      const updated = [...existingExtra, ...missing];
      if (!agents) (api.config as Record<string, unknown>).agents = { defaults: {} };
      const agts = (api.config as Record<string, unknown>).agents as Record<string, unknown>;
      if (!agts.defaults) agts.defaults = {};
      const defs = agts.defaults as Record<string, unknown>;
      if (!defs.memorySearch) defs.memorySearch = {};
      (defs.memorySearch as Record<string, unknown>).extraPaths = updated;
      api.logger.info(`[GuardClaw] Added to memorySearch.extraPaths: ${missing.join(", ")}`);
    }

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

    // Register configurable routers (dashboard-created)
    if (routerConfigs) {
      for (const [id, reg] of Object.entries(routerConfigs)) {
        if (reg.type === "configurable" && !pipeline.hasRouter(id)) {
          pipeline.register(createConfigurableRouter(id), reg);
        }
      }
    }

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
    initLiveConfig(api.pluginConfig);

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
      loadConfig: api.runtime.config.loadConfig,
      writeConfigFile: api.runtime.config.writeConfigFile,
      pluginId: "guardclaw",
      pluginConfig: api.pluginConfig ?? {},
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
  },
};

export default plugin;
