/**
 * Token-Saver Router Tests
 *
 * Tests the LLM-as-judge classification, subagent skip, caching, and
 * integration with the router pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseTier,
  hashPrompt,
  classificationCache,
  resolveConfig,
  tokenSaverRouter,
} from "../src/routers/token-saver.js";
import type { DetectionContext } from "../src/types.js";

// Mock callChatCompletion to avoid real LLM calls
vi.mock("../src/local-model.js", () => ({
  callChatCompletion: vi.fn(),
}));

// Mock token-stats to avoid side effects in tests
vi.mock("../src/token-stats.js", () => ({
  getGlobalCollector: vi.fn(() => null),
}));

import { callChatCompletion } from "../src/local-model.js";
const mockCallChat = vi.mocked(callChatCompletion);

const baseConfig = {
  privacy: {
    routers: {
      "token-saver": {
        enabled: true,
        type: "builtin" as const,
        options: {
          judgeEndpoint: "http://localhost:11434",
          judgeModel: "test-model",
          tiers: {
            SIMPLE: { provider: "openai", model: "gpt-4o-mini" },
            MEDIUM: { provider: "openai", model: "gpt-4o" },
            COMPLEX: { provider: "anthropic", model: "claude-sonnet-4.6" },
            REASONING: { provider: "openai", model: "o4-mini" },
          },
        },
      },
    },
  },
};

const baseContext: DetectionContext = {
  checkpoint: "onUserMessage",
  message: "What is the capital of France?",
  sessionKey: "main:user:123",
};

describe("Token-Saver Router", () => {
  beforeEach(() => {
    classificationCache.clear();
    mockCallChat.mockReset();
  });

  describe("parseTier", () => {
    it("parses valid JSON tier response", () => {
      expect(parseTier('{"tier":"SIMPLE"}')).toBe("SIMPLE");
      expect(parseTier('{"tier":"MEDIUM"}')).toBe("MEDIUM");
      expect(parseTier('{"tier":"COMPLEX"}')).toBe("COMPLEX");
      expect(parseTier('{"tier":"REASONING"}')).toBe("REASONING");
    });

    it("handles whitespace and extra text around JSON", () => {
      expect(parseTier('  {"tier": "SIMPLE"}  ')).toBe("SIMPLE");
      expect(parseTier('Here is the result: {"tier":"COMPLEX"}')).toBe("COMPLEX");
    });

    it("strips <think> tags from reasoning models", () => {
      expect(parseTier('<think>Let me analyze this...</think>{"tier":"SIMPLE"}')).toBe("SIMPLE");
    });

    it("falls back to MEDIUM on invalid input", () => {
      expect(parseTier("")).toBe("MEDIUM");
      expect(parseTier("not json")).toBe("MEDIUM");
      expect(parseTier('{"tier":"INVALID"}')).toBe("MEDIUM");
      expect(parseTier('{"wrong":"SIMPLE"}')).toBe("MEDIUM");
    });
  });

  describe("hashPrompt", () => {
    it("returns a 16-char hex string", () => {
      const hash = hashPrompt("test prompt");
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("returns same hash for same prompt", () => {
      expect(hashPrompt("hello")).toBe(hashPrompt("hello"));
    });

    it("returns different hash for different prompts", () => {
      expect(hashPrompt("hello")).not.toBe(hashPrompt("world"));
    });
  });

  describe("resolveConfig", () => {
    it("uses defaults when no config provided", () => {
      const config = resolveConfig({});
      expect(config.enabled).toBe(false);
      expect(config.judgeModel).toBe("openbmb/minicpm4.1");
    });

    it("inherits judge endpoint from privacy localModel", () => {
      const config = resolveConfig({
        privacy: {
          localModel: { endpoint: "http://custom:1234", model: "custom-model" },
          routers: { "token-saver": { enabled: true } },
        },
      });
      expect(config.judgeEndpoint).toBe("http://custom:1234");
      expect(config.judgeModel).toBe("custom-model");
    });

    it("options override privacy localModel", () => {
      const config = resolveConfig({
        privacy: {
          localModel: { endpoint: "http://from-privacy:1234" },
          routers: {
            "token-saver": {
              enabled: true,
              options: { judgeEndpoint: "http://explicit:5678" },
            },
          },
        },
      });
      expect(config.judgeEndpoint).toBe("http://explicit:5678");
    });
  });

  describe("detect()", () => {
    it("returns passthrough when disabled", async () => {
      const result = await tokenSaverRouter.detect(baseContext, {});
      expect(result.action).toBe("passthrough");
    });

    it("routes SIMPLE task to cheap model", async () => {
      mockCallChat.mockResolvedValueOnce({ text: '{"tier":"SIMPLE"}' });

      const result = await tokenSaverRouter.detect(baseContext, baseConfig);

      expect(result.action).toBe("redirect");
      expect(result.target?.model).toBe("gpt-4o-mini");
      expect(result.reason).toContain("SIMPLE");
    });

    it("routes COMPLEX task to strong model", async () => {
      mockCallChat.mockResolvedValueOnce({ text: '{"tier":"COMPLEX"}' });

      const result = await tokenSaverRouter.detect(
        { ...baseContext, message: "Design a microservices architecture for an e-commerce platform" },
        baseConfig,
      );

      expect(result.action).toBe("redirect");
      expect(result.target?.provider).toBe("anthropic");
      expect(result.target?.model).toBe("claude-sonnet-4.6");
    });

    it("routes REASONING task to reasoning model", async () => {
      mockCallChat.mockResolvedValueOnce({ text: '{"tier":"REASONING"}' });

      const result = await tokenSaverRouter.detect(
        { ...baseContext, message: "Prove that the square root of 2 is irrational" },
        baseConfig,
      );

      expect(result.target?.model).toBe("o4-mini");
    });
  });

  describe("subagent skip", () => {
    it("returns passthrough for subagent sessions", async () => {
      const result = await tokenSaverRouter.detect(
        { ...baseContext, sessionKey: "main:user:123:subagent:search-agent" },
        baseConfig,
      );

      expect(result.action).toBe("passthrough");
      expect(result.reason).toContain("subagent");
      expect(mockCallChat).not.toHaveBeenCalled();
    });

    it("calls LLM judge for main agent sessions", async () => {
      mockCallChat.mockResolvedValueOnce({ text: '{"tier":"MEDIUM"}' });

      await tokenSaverRouter.detect(
        { ...baseContext, sessionKey: "main:user:123" },
        baseConfig,
      );

      expect(mockCallChat).toHaveBeenCalledTimes(1);
    });
  });

  describe("cache", () => {
    it("uses cached result on second call with same prompt", async () => {
      mockCallChat.mockResolvedValueOnce({ text: '{"tier":"SIMPLE"}' });

      const result1 = await tokenSaverRouter.detect(baseContext, baseConfig);
      const result2 = await tokenSaverRouter.detect(baseContext, baseConfig);

      expect(mockCallChat).toHaveBeenCalledTimes(1);
      expect(result1.target?.model).toBe(result2.target?.model);
    });

    it("calls LLM again for different prompts", async () => {
      mockCallChat.mockResolvedValueOnce({ text: '{"tier":"SIMPLE"}' });
      mockCallChat.mockResolvedValueOnce({ text: '{"tier":"COMPLEX"}' });

      await tokenSaverRouter.detect(baseContext, baseConfig);
      await tokenSaverRouter.detect(
        { ...baseContext, message: "Different prompt entirely" },
        baseConfig,
      );

      expect(mockCallChat).toHaveBeenCalledTimes(2);
    });
  });

  describe("error handling", () => {
    it("returns passthrough when LLM judge fails", async () => {
      mockCallChat.mockRejectedValueOnce(new Error("Connection refused"));

      const result = await tokenSaverRouter.detect(baseContext, baseConfig);

      expect(result.action).toBe("passthrough");
      expect(result.reason).toContain("failed");
    });

    it("falls back to MEDIUM when LLM returns invalid JSON", async () => {
      mockCallChat.mockResolvedValueOnce({ text: "I cannot classify this task" });

      const result = await tokenSaverRouter.detect(baseContext, baseConfig);

      expect(result.action).toBe("redirect");
      expect(result.target?.model).toBe("gpt-4o");
    });
  });

  describe("prompt forwarding", () => {
    it("sends full prompt to judge without truncation", async () => {
      mockCallChat.mockResolvedValueOnce({ text: '{"tier":"SIMPLE"}' });
      const longPrompt = "x".repeat(1000);

      await tokenSaverRouter.detect(
        { ...baseContext, message: longPrompt },
        baseConfig,
      );

      const callArgs = mockCallChat.mock.calls[0];
      const messages = callArgs[2] as Array<{ role: string; content: string }>;
      const userMessage = messages.find((m) => m.role === "user");
      expect(userMessage?.content).toHaveLength(1000);
    });
  });
});
