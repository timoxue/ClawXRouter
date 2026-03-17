/**
 * Router Pipeline Tests
 *
 * Tests the composable router pipeline: registration, dispatch, merging.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RouterPipeline } from "../src/router-pipeline.js";
import type { GuardClawRouter, DetectionContext } from "../src/types.js";

function makeRouter(id: string, decision: Partial<Parameters<GuardClawRouter["detect"]> extends [infer _C, infer _P] ? ReturnType<GuardClawRouter["detect"]> extends Promise<infer D> ? D : never : never>): GuardClawRouter {
  return {
    id,
    async detect() {
      return { level: "S1", action: "passthrough", ...decision, routerId: id };
    },
  };
}

const baseContext: DetectionContext = {
  checkpoint: "onUserMessage",
  message: "test message",
  sessionKey: "test-session",
};

describe("RouterPipeline", () => {
  let pipeline: RouterPipeline;

  beforeEach(() => {
    pipeline = new RouterPipeline();
  });

  describe("Registration", () => {
    it("registers and lists routers", () => {
      pipeline.register(makeRouter("a", { level: "S1" }));
      pipeline.register(makeRouter("b", { level: "S1" }));

      expect(pipeline.listRouters()).toEqual(["a", "b"]);
      expect(pipeline.hasRouter("a")).toBe(true);
      expect(pipeline.hasRouter("c")).toBe(false);
    });

    it("overwrites router with same id", () => {
      pipeline.register(makeRouter("a", { level: "S1" }));
      pipeline.register(makeRouter("a", { level: "S3" }));

      expect(pipeline.listRouters()).toEqual(["a"]);
    });
  });

  describe("Pipeline execution", () => {
    it("returns S1 passthrough when no routers configured", async () => {
      const result = await pipeline.run("onUserMessage", baseContext, {});

      expect(result.level).toBe("S1");
      expect(result.action).toBe("passthrough");
    });

    it("runs single router and returns its decision", async () => {
      pipeline.register(makeRouter("privacy", {
        level: "S3",
        action: "redirect",
        target: { provider: "ollama", model: "llama3" },
        reason: "SSH key detected",
      }));

      const result = await pipeline.run("onUserMessage", baseContext, {});

      expect(result.level).toBe("S3");
      expect(result.action).toBe("redirect");
      expect(result.target?.provider).toBe("ollama");
      expect(result.reason).toContain("SSH key");
    });

    it("merges multiple routers — highest level wins", async () => {
      pipeline.register(makeRouter("cost-router", {
        level: "S1",
        action: "redirect",
        target: { provider: "openai", model: "gpt-4o-mini" },
        reason: "cost optimization",
      }));
      pipeline.register(makeRouter("privacy", {
        level: "S2",
        action: "redirect",
        target: { provider: "guardclaw-privacy", model: "" },
        reason: "PII detected",
      }));

      const result = await pipeline.run("onUserMessage", baseContext, {});

      expect(result.level).toBe("S2");
      expect(result.target?.provider).toBe("guardclaw-privacy");
    });

    it("at same level, block > redirect > passthrough", async () => {
      pipeline.register(makeRouter("filter", {
        level: "S2",
        action: "redirect",
        target: { provider: "openai", model: "gpt-4o" },
      }));
      pipeline.register(makeRouter("blocker", {
        level: "S2",
        action: "block",
        reason: "blocked by policy",
      }));

      const result = await pipeline.run("onUserMessage", baseContext, {});

      expect(result.level).toBe("S2");
      expect(result.action).toBe("block");
      expect(result.routerId).toBe("blocker");
    });

    it("concatenates reasons from all non-S1 routers", async () => {
      pipeline.register(makeRouter("a", { level: "S2", reason: "reason from A" }));
      pipeline.register(makeRouter("b", { level: "S2", reason: "reason from B" }));

      const result = await pipeline.run("onUserMessage", baseContext, {});

      expect(result.reason).toContain("[a:w50] reason from A");
      expect(result.reason).toContain("[b:w50] reason from B");
    });
  });

  describe("Pipeline config", () => {
    it("respects pipeline checkpoint config", async () => {
      pipeline.register(makeRouter("privacy", { level: "S3", reason: "private" }));
      pipeline.register(makeRouter("cost", { level: "S1", action: "redirect", target: { provider: "openai", model: "mini" } }));

      pipeline.configure({
        pipeline: {
          onUserMessage: ["cost"],
          onToolCallProposed: ["privacy"],
        },
      });

      const userResult = await pipeline.run("onUserMessage", baseContext, {});
      expect(userResult.level).toBe("S1");
      expect(userResult.routerId).toBe("cost");

      const toolResult = await pipeline.run("onToolCallProposed", { ...baseContext, checkpoint: "onToolCallProposed" }, {});
      expect(toolResult.level).toBe("S3");
      expect(toolResult.routerId).toBe("privacy");
    });

    it("respects enabled flag — disabled routers are skipped", async () => {
      pipeline.register(makeRouter("privacy", { level: "S3" }), { enabled: false });
      pipeline.register(makeRouter("cost", { level: "S1" }), { enabled: true });

      const result = await pipeline.run("onUserMessage", baseContext, {});

      expect(result.level).toBe("S1");
      expect(result.routerId).toBe("cost");
    });
  });

  describe("Error handling", () => {
    it("continues when a router throws", async () => {
      const failingRouter: GuardClawRouter = {
        id: "broken",
        async detect() {
          throw new Error("Router crashed");
        },
      };

      pipeline.register(failingRouter);
      pipeline.register(makeRouter("backup", { level: "S2", reason: "backup detected" }));

      const result = await pipeline.run("onUserMessage", baseContext, {});

      expect(result.level).toBe("S2");
      expect(result.routerId).toBe("backup");
    });
  });
});
