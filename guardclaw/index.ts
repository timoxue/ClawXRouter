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
import { guardClawConfigSchema, defaultPrivacyConfig } from "./src/config-schema.js";
import { registerHooks } from "./src/hooks.js";
import { guardClawPrivacyProvider, setActiveProxy, mirrorAllProviderModels } from "./src/provider.js";
import { startPrivacyProxy, setDefaultProviderTarget } from "./src/privacy-proxy.js";
import { RouterPipeline, setGlobalPipeline } from "./src/router-pipeline.js";
import { privacyRouter } from "./src/routers/privacy.js";
import { tokenSaverRouter } from "./src/routers/token-saver.js";
import type { PrivacyConfig, PipelineConfig, RouterRegistration } from "./src/types.js";
import type { ProxyHandle } from "./src/privacy-proxy.js";

function getPrivacyConfig(pluginConfig: Record<string, unknown> | undefined): PrivacyConfig {
  const userConfig = (pluginConfig?.privacy ?? {}) as PrivacyConfig;
  return { ...defaultPrivacyConfig, ...userConfig } as PrivacyConfig;
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

    // ── Step 1: Register provider ──
    api.registerProvider(guardClawPrivacyProvider as Parameters<typeof api.registerProvider>[0]);

    // ── Step 2: Runtime config injection ──
    const proxyPort = privacyConfig.proxyPort ?? 8403;
    if (!api.config.models) {
      (api.config as Record<string, unknown>).models = { providers: {} };
    }
    const models = api.config.models as { providers?: Record<string, unknown> };
    if (!models.providers) models.providers = {};
    models.providers["guardclaw-privacy"] = {
      baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
      api: "openai-completions",
      apiKey: "guardclaw-proxy-handles-auth",
      models: mirrorAllProviderModels(api.config as { models?: { providers?: Record<string, { models?: unknown }> } }),
    };

    // Set default provider target for the proxy — extract provider from model.primary
    const agentDefaults = (api.config.agents as Record<string, unknown> | undefined)?.defaults as Record<string, unknown> | undefined;
    const primaryModelStr = (agentDefaults?.model as Record<string, unknown> | undefined)?.primary as string ?? "";
    const defaultProvider = (agentDefaults?.provider as string) || primaryModelStr.split("/")[0] || "openai";
    const providerConfig = models.providers?.[defaultProvider] as Record<string, unknown> | undefined;
    if (providerConfig) {
      setDefaultProviderTarget({
        baseUrl: (providerConfig.baseUrl as string) ?? "https://api.openai.com/v1",
        apiKey: (providerConfig.apiKey as string) ?? "",
        provider: defaultProvider,
      });
    }

    api.logger.info(`[GuardClaw] Privacy provider registered (proxy port: ${proxyPort})`);

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

    // ── Step 5: Register all hooks ──
    registerHooks(api);

    api.logger.info("[GuardClaw] Plugin initialized (pipeline + privacy proxy + guard agent)");
  },
};

export default plugin;
