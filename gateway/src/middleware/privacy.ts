/**
 * Privacy detection middleware for the gateway.
 * Wraps the existing clawxrouter RouterPipeline — zero code duplication.
 */
import { RouterPipeline } from "../../../clawxrouter/src/router-pipeline.js";
import { privacyRouter } from "../../../clawxrouter/src/routers/privacy.js";
import type { RouterDecision } from "../../../clawxrouter/src/types.js";
import type { GatewayConfig } from "../types.js";

let pipeline: RouterPipeline | null = null;
let pluginConfig: Record<string, unknown> = {};

export function initPrivacyPipeline(config: GatewayConfig): void {
  pipeline = new RouterPipeline({
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  });

  // Register privacy router (weight 90 = high priority / fast phase)
  pipeline.register(privacyRouter, {
    weight: 90,
    enabled: true,
    type: "builtin",
  });

  // pluginConfig mirrors what the original plugin passes to routers
  pluginConfig = { privacy: config.privacy };

  // Configure pipeline checkpoints
  pipeline.configure({
    pipeline: {
      onUserMessage: ["privacy"],
      onToolCallProposed: ["privacy"],
      onToolCallExecuted: ["privacy"],
    },
  });

  console.log("[Privacy] Pipeline initialized");
}

/**
 * Detect the sensitivity level of a message.
 * Returns an S1/S2/S3 RouterDecision.
 */
export async function detectPrivacy(
  message: string,
  sessionKey: string
): Promise<RouterDecision> {
  if (!pipeline) {
    return { level: "S1", action: "passthrough", reason: "Pipeline not initialized" };
  }

  try {
    return await pipeline.run(
      "onUserMessage",
      {
        checkpoint: "onUserMessage",
        message,
        sessionKey,
      },
      pluginConfig
    );
  } catch (err) {
    console.error("[Privacy] Detection error:", err);
    // Fail-safe: treat as S1 on detection error (can be made fail-closed in config)
    return { level: "S1", action: "passthrough", reason: "Detection error — defaulting to S1" };
  }
}

export function updatePrivacyConfig(privacy: Record<string, unknown>): void {
  pluginConfig = { privacy };
}
