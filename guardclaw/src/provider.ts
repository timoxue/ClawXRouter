/**
 * GuardClaw Privacy Provider
 *
 * Registers "guardclaw-privacy" as an OpenClaw provider that routes through
 * the local privacy proxy. Inspired by ClawRouter's blockrunProvider pattern.
 *
 * The provider mirrors all models from the user's configured providers so that
 * `before_model_resolve` can switch providerOverride to "guardclaw-privacy"
 * without changing the model — the proxy transparently forwards to the
 * original provider after stripping PII markers.
 */

import type { ProxyHandle } from "./privacy-proxy.js";

let activeProxy: ProxyHandle | null = null;

export function setActiveProxy(proxy: ProxyHandle): void {
  activeProxy = proxy;
}

/**
 * Provider plugin definition for the privacy proxy.
 *
 * Follows the same structure as ClawRouter's blockrunProvider:
 *   - id / label / aliases
 *   - auth: [] (proxy handles auth transparently)
 *   - models: dynamically mirrored from the user's real providers
 */
export const guardClawPrivacyProvider = {
  id: "guardclaw-privacy",
  label: "GuardClaw Privacy Proxy",
  aliases: [] as string[],
  envVars: [] as string[],
  auth: [] as never[],
};

/**
 * Mirror all model definitions from every configured provider.
 *
 * This allows `providerOverride: "guardclaw-privacy"` to work with any model
 * the user has configured (openai/gpt-4o, anthropic/claude-sonnet, etc.)
 * without needing to know which provider owns the model at registration time.
 */
export function mirrorAllProviderModels(
  config: { models?: { providers?: Record<string, { models?: unknown }> } },
): unknown[] {
  const seen = new Set<string>();
  const mirrored: unknown[] = [];
  const providers = config.models?.providers ?? {};

  for (const providerConfig of Object.values(providers)) {
    if (!providerConfig.models) continue;
    const models = providerConfig.models;
    if (Array.isArray(models)) {
      for (const m of models) {
        const id = (m as Record<string, unknown>)?.id as string | undefined;
        if (id && !seen.has(id)) {
          seen.add(id);
          mirrored.push(m);
        }
      }
    } else if (typeof models === "object" && models !== null) {
      for (const [modelId, modelDef] of Object.entries(models as Record<string, unknown>)) {
        if (!seen.has(modelId)) {
          seen.add(modelId);
          mirrored.push({ id: modelId, ...(typeof modelDef === "object" && modelDef !== null ? modelDef as Record<string, unknown> : {}) });
        }
      }
    }
  }

  return mirrored;
}
