/**
 * GuardClaw Config Schema
 *
 * Configuration schema for the GuardClaw plugin using TypeBox.
 */

import { Type } from "@sinclair/typebox";

export const guardClawConfigSchema = Type.Object({
  privacy: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      s2Policy: Type.Optional(
        Type.Union([Type.Literal("proxy"), Type.Literal("local")]),
      ),
      proxyPort: Type.Optional(Type.Number()),
      checkpoints: Type.Optional(
        Type.Object({
          onUserMessage: Type.Optional(
            Type.Array(
              Type.Union([Type.Literal("ruleDetector"), Type.Literal("localModelDetector")]),
            ),
          ),
          onToolCallProposed: Type.Optional(
            Type.Array(
              Type.Union([Type.Literal("ruleDetector"), Type.Literal("localModelDetector")]),
            ),
          ),
          onToolCallExecuted: Type.Optional(
            Type.Array(
              Type.Union([Type.Literal("ruleDetector"), Type.Literal("localModelDetector")]),
            ),
          ),
        }),
      ),
      rules: Type.Optional(
        Type.Object({
          keywords: Type.Optional(
            Type.Object({
              S2: Type.Optional(Type.Array(Type.String())),
              S3: Type.Optional(Type.Array(Type.String())),
            }),
          ),
          patterns: Type.Optional(
            Type.Object({
              S2: Type.Optional(Type.Array(Type.String())),
              S3: Type.Optional(Type.Array(Type.String())),
            }),
          ),
          tools: Type.Optional(
            Type.Object({
              S2: Type.Optional(
                Type.Object({
                  tools: Type.Optional(Type.Array(Type.String())),
                  paths: Type.Optional(Type.Array(Type.String())),
                }),
              ),
              S3: Type.Optional(
                Type.Object({
                  tools: Type.Optional(Type.Array(Type.String())),
                  paths: Type.Optional(Type.Array(Type.String())),
                }),
              ),
            }),
          ),
        }),
      ),
      localModel: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          type: Type.Optional(
            Type.Union([
              Type.Literal("openai-compatible"),
              Type.Literal("ollama-native"),
              Type.Literal("custom"),
            ]),
          ),
          provider: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          endpoint: Type.Optional(Type.String()),
          apiKey: Type.Optional(Type.String()),
          module: Type.Optional(Type.String()),
        }),
      ),
      guardAgent: Type.Optional(
        Type.Object({
          id: Type.Optional(Type.String()),
          workspace: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
        }),
      ),
      localProviders: Type.Optional(Type.Array(Type.String())),
      modelPricing: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            inputPer1M: Type.Optional(Type.Number()),
            outputPer1M: Type.Optional(Type.Number()),
          }),
        ),
      ),
      session: Type.Optional(
        Type.Object({
          isolateGuardHistory: Type.Optional(Type.Boolean()),
          baseDir: Type.Optional(Type.String()),
        }),
      ),
      routers: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            enabled: Type.Optional(Type.Boolean()),
            type: Type.Optional(Type.Union([Type.Literal("builtin"), Type.Literal("custom")])),
            module: Type.Optional(Type.String()),
            options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          }),
        ),
      ),
      pipeline: Type.Optional(
        Type.Object({
          onUserMessage: Type.Optional(Type.Array(Type.String())),
          onToolCallProposed: Type.Optional(Type.Array(Type.String())),
          onToolCallExecuted: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
  ),
});

/**
 * Default configuration values.
 *
 * Detection relies entirely on the local LLM judge (localModelDetector).
 * Rule-based detection is kept as an optional fallback but NOT enabled by default.
 */
export const defaultPrivacyConfig = {
  enabled: true,
  s2Policy: "proxy" as "proxy" | "local",
  proxyPort: 8403,
  checkpoints: {
    onUserMessage: ["localModelDetector" as const],
    onToolCallProposed: ["localModelDetector" as const],
    onToolCallExecuted: ["localModelDetector" as const],
  },
  rules: {
    keywords: {
      S2: [] as string[],
      S3: [] as string[],
    },
    patterns: {
      S2: [] as string[],
      S3: [] as string[],
    },
    tools: {
      S2: { tools: [] as string[], paths: [] as string[] },
      S3: { tools: [] as string[], paths: [] as string[] },
    },
  },
  localModel: {
    enabled: true,
    type: "openai-compatible" as const,
    model: "openbmb/minicpm4.1",
    endpoint: "http://localhost:11434",
  },
  guardAgent: {
    id: "guard",
    workspace: "~/.openclaw/workspace-guard",
    model: "ollama/openbmb/minicpm4.1",
  },
  localProviders: [] as string[],
  modelPricing: {
    "claude-sonnet-4.6": { inputPer1M: 3, outputPer1M: 15 },
    "claude-3.5-sonnet": { inputPer1M: 3, outputPer1M: 15 },
    "claude-3.5-haiku": { inputPer1M: 0.8, outputPer1M: 4 },
    "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
    "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
    "deepseek-chat": { inputPer1M: 0.27, outputPer1M: 1.1 },
  } as Record<string, { inputPer1M?: number; outputPer1M?: number }>,
  session: {
    isolateGuardHistory: true,
    baseDir: "~/.openclaw",
  },
  routers: {
    privacy: { enabled: true, type: "builtin" as const },
  } as Record<string, { enabled?: boolean; type?: "builtin" | "custom"; module?: string; options?: Record<string, unknown> }>,
  pipeline: {
    onUserMessage: ["privacy"],
    onToolCallProposed: ["privacy"],
    onToolCallExecuted: ["privacy"],
  },
};
