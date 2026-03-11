/**
 * GuardClaw Live Config
 *
 * Mutable in-memory config cache that hooks read from at runtime.
 * When the Dashboard saves new settings, both the disk file and this
 * cache are updated — so changes take effect immediately without restart.
 *
 * The only setting that cannot be hot-reloaded is proxyPort (already bound).
 */

import type { PrivacyConfig } from "./types.js";
import { defaultPrivacyConfig } from "./config-schema.js";

let liveConfig: PrivacyConfig = { ...defaultPrivacyConfig } as PrivacyConfig;

/** Initialize live config from the plugin's startup config snapshot. */
export function initLiveConfig(pluginConfig: Record<string, unknown> | undefined): void {
  const userConfig = (pluginConfig?.privacy ?? {}) as PrivacyConfig;
  liveConfig = mergeConfig(userConfig);
}

/** Get the current live config (mutable, always up-to-date). */
export function getLiveConfig(): PrivacyConfig {
  return liveConfig;
}

/** Hot-update the live config. Called from Dashboard save handler. */
export function updateLiveConfig(patch: Partial<PrivacyConfig>): void {
  liveConfig = mergeConfig({ ...liveConfig, ...patch });
}

/** Replace the entire privacy config in the live cache. */
export function setLiveConfig(config: PrivacyConfig): void {
  liveConfig = mergeConfig(config);
}

function mergeConfig(userConfig: PrivacyConfig): PrivacyConfig {
  return {
    ...defaultPrivacyConfig,
    ...userConfig,
    checkpoints: { ...defaultPrivacyConfig.checkpoints, ...userConfig.checkpoints },
    rules: {
      keywords: { ...defaultPrivacyConfig.rules?.keywords, ...userConfig.rules?.keywords },
      patterns: { ...defaultPrivacyConfig.rules?.patterns, ...userConfig.rules?.patterns },
      tools: {
        S2: { ...defaultPrivacyConfig.rules?.tools?.S2, ...userConfig.rules?.tools?.S2 },
        S3: { ...defaultPrivacyConfig.rules?.tools?.S3, ...userConfig.rules?.tools?.S3 },
      },
    },
    localModel: { ...defaultPrivacyConfig.localModel, ...userConfig.localModel },
    guardAgent: { ...defaultPrivacyConfig.guardAgent, ...userConfig.guardAgent },
    session: { ...defaultPrivacyConfig.session, ...userConfig.session },
    localProviders: [
      ...defaultPrivacyConfig.localProviders,
      ...(userConfig.localProviders ?? []),
    ],
  } as PrivacyConfig;
}
