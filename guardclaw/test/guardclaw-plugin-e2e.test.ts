/**
 * GuardClaw Plugin End-to-End Test
 *
 * Tests the full plugin lifecycle within openclaw:
 *   1. Plugin loading & registration
 *   2. Detection pipeline (rule-based, no live LLM)
 *   3. Router pipeline composition
 *   4. Session state management across hooks
 *   5. Privacy proxy marker stripping
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectSensitivityLevel } from "../src/detector.js";
import { RouterPipeline } from "../src/router-pipeline.js";
import { privacyRouter } from "../src/routers/privacy.js";
import { stripPiiMarkers, GUARDCLAW_S2_OPEN, GUARDCLAW_S2_CLOSE } from "../src/privacy-proxy.js";
import {
  markSessionAsPrivate,
  isSessionMarkedPrivate,
  getSessionHighestLevel,
  recordDetection,
  clearSessionState,
  stashDetection,
  getPendingDetection,
  consumeDetection,
} from "../src/session-state.js";
import { DualSessionManager } from "../src/session-manager.js";
import { redactSensitiveInfo } from "../src/utils.js";
import type { DetectionContext, GuardClawRouter } from "../src/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ruleOnlyConfig = {
  privacy: {
    enabled: true,
    checkpoints: {
      onUserMessage: ["ruleDetector" as const],
      onToolCallProposed: ["ruleDetector" as const],
      onToolCallExecuted: ["ruleDetector" as const],
    },
    rules: {
      keywords: {
        S2: ["password", "api_key", "address"],
        S3: ["ssh", "id_rsa", "private_key", "payslip"],
      },
      patterns: {
        S2: ["\\b1[3-9]\\d{9}\\b"],
        S3: ["-----BEGIN.*PRIVATE KEY-----"],
      },
      tools: {
        S2: { tools: ["exec"], paths: ["~/secrets"] },
        S3: { tools: ["system.run"], paths: ["~/.ssh", "/etc"] },
      },
    },
    localModel: { enabled: false },
  },
};

describe("GuardClaw Plugin E2E", () => {
  describe("Full Detection → Session → Routing Pipeline", () => {
    const sessionKey = "e2e-pipeline-session";

    beforeEach(() => {
      clearSessionState(sessionKey);
    });

    it("S1 message flows through without marking session", async () => {
      const pipeline = new RouterPipeline();
      pipeline.register(privacyRouter, { enabled: true, type: "builtin" });

      const decision = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: "What is the weather?", sessionKey },
        ruleOnlyConfig,
      );

      expect(decision.level).toBe("S1");
      expect(decision.action).toBe("passthrough");
      expect(isSessionMarkedPrivate(sessionKey)).toBe(false);
    });

    it("S2 message triggers redirect to privacy proxy", async () => {
      const pipeline = new RouterPipeline();
      pipeline.register(privacyRouter, { enabled: true, type: "builtin" });

      const decision = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: "Here is my api_key for the service", sessionKey },
        ruleOnlyConfig,
      );

      expect(decision.level).toBe("S2");
      expect(decision.action).toBe("redirect");
      expect(decision.target?.provider).toBe("guardclaw-privacy");

      markSessionAsPrivate(sessionKey, decision.level);
      recordDetection(sessionKey, decision.level, "onUserMessage", decision.reason);

      expect(isSessionMarkedPrivate(sessionKey)).toBe(true);
      expect(getSessionHighestLevel(sessionKey)).toBe("S2");
    });

    it("S3 message triggers redirect to local model", async () => {
      const pipeline = new RouterPipeline();
      pipeline.register(privacyRouter, { enabled: true, type: "builtin" });

      const decision = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: "analyze my payslip", sessionKey },
        ruleOnlyConfig,
      );

      expect(decision.level).toBe("S3");
      expect(decision.action).toBe("redirect");
      expect(decision.target?.provider).toBe("ollama");

      markSessionAsPrivate(sessionKey, decision.level);
      expect(isSessionMarkedPrivate(sessionKey)).toBe(true);
      expect(getSessionHighestLevel(sessionKey)).toBe("S3");
    });

    it("multi-checkpoint flow escalates from S2 to S3", async () => {
      const pipeline = new RouterPipeline();
      pipeline.register(privacyRouter, { enabled: true, type: "builtin" });

      const d1 = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: "My password is abc123", sessionKey },
        ruleOnlyConfig,
      );
      expect(d1.level).toBe("S2");
      markSessionAsPrivate(sessionKey, d1.level);
      recordDetection(sessionKey, d1.level, "onUserMessage", d1.reason);

      const d2 = await pipeline.run(
        "onToolCallProposed",
        { checkpoint: "onToolCallProposed", toolName: "system.run", toolParams: { command: "ls" }, sessionKey },
        ruleOnlyConfig,
      );
      expect(d2.level).toBe("S3");
      markSessionAsPrivate(sessionKey, d2.level);
      recordDetection(sessionKey, d2.level, "onToolCallProposed", d2.reason);

      expect(isSessionMarkedPrivate(sessionKey)).toBe(true);
      expect(getSessionHighestLevel(sessionKey)).toBe("S3");
    });
  });

  describe("Router Pipeline Composition — Privacy + Custom Router", () => {
    it("custom router coexists with privacy router and highest level wins", async () => {
      const pipeline = new RouterPipeline();
      pipeline.register(privacyRouter, { enabled: true, type: "builtin" });

      const costRouter: GuardClawRouter = {
        id: "cost-optimizer",
        async detect() {
          return {
            level: "S1" as const,
            action: "redirect" as const,
            target: { provider: "openai", model: "gpt-4o-mini" },
            reason: "cost optimization",
          };
        },
      };
      pipeline.register(costRouter, { enabled: true, type: "custom" });

      const safeDecision = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: "translate hello to French" },
        ruleOnlyConfig,
      );
      expect(safeDecision.level).toBe("S1");

      const sensitiveDecision = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: "check my payslip" },
        ruleOnlyConfig,
      );
      expect(sensitiveDecision.level).toBe("S3");
      expect(sensitiveDecision.target?.provider).toBe("ollama");
    });
  });

  describe("Privacy Proxy Marker Stripping (Full Cycle)", () => {
    it("S2 markers are injected, then stripped by proxy logic", () => {
      const desensitized = "My address is [REDACTED:ADDRESS], phone [REDACTED:PHONE]";
      const original = "My address is 123 Main St, phone 13912345678";

      const proxyPayload = [
        {
          role: "user",
          content: `${GUARDCLAW_S2_OPEN}\n${desensitized}\n${GUARDCLAW_S2_CLOSE}\n\n${original}`,
        },
      ];

      const stripped = stripPiiMarkers(proxyPayload);

      expect(stripped).toBe(true);
      expect(proxyPayload[0].content).toBe(desensitized);
      expect(proxyPayload[0].content).not.toContain("123 Main St");
      expect(proxyPayload[0].content).not.toContain("13912345678");
    });
  });

  describe("Stash/Consume Detection State Transfer", () => {
    it("before_model_resolve stashes, before_prompt_build consumes", () => {
      const sessionKey = "e2e-stash-1";

      stashDetection(sessionKey, {
        level: "S2",
        reason: "PII detected",
        desensitized: "[REDACTED:ADDRESS]",
        originalPrompt: "123 Main Street",
        timestamp: Date.now(),
      });

      const pending = getPendingDetection(sessionKey);
      expect(pending).toBeDefined();
      expect(pending!.level).toBe("S2");
      expect(pending!.desensitized).toContain("[REDACTED:ADDRESS]");

      const consumed = consumeDetection(sessionKey);
      expect(consumed).toBeDefined();
      expect(consumed!.level).toBe("S2");

      expect(consumeDetection(sessionKey)).toBeUndefined();
    });
  });

  describe("Dual Session Manager Persistence", () => {
    const testDir = path.join(process.cwd(), ".test-guardclaw-e2e");
    let manager: DualSessionManager;

    beforeEach(() => {
      if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
      manager = new DualSessionManager(testDir);
    });

    afterEach(() => {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("guard agent messages excluded from cloud-visible history", async () => {
      const sk = "e2e-dual-history";

      await manager.persistMessage(sk, { role: "user", content: "check my salary", timestamp: Date.now() });
      await manager.persistMessage(sk, {
        role: "assistant",
        content: "[Guard Agent] Processing private data",
        sessionKey: "main:guard:1",
        timestamp: Date.now(),
      });
      await manager.persistMessage(sk, { role: "assistant", content: "Your compensation looks correct.", timestamp: Date.now() });

      const full = await manager.loadHistory(sk, false);
      const clean = await manager.loadHistory(sk, true);

      expect(full).toHaveLength(3);
      expect(clean).toHaveLength(2);
      expect(clean.every((m) => !m.content.includes("[Guard Agent]"))).toBe(true);
    });
  });

  describe("Rule-Based PII Redaction (utils.redactSensitiveInfo)", () => {
    it("redacts SSH keys, emails, internal IPs, Chinese phones", () => {
      const input = [
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpQI...\n-----END RSA PRIVATE KEY-----",
        "Contact: user@example.com",
        "Server: 192.168.1.100",
        "Phone: 13912345678",
      ].join("\n");

      const opts = { email: true, internalIp: true, chinesePhone: true };
      const redacted = redactSensitiveInfo(input, opts);

      expect(redacted).toContain("[REDACTED:PRIVATE_KEY]");
      expect(redacted).toContain("[REDACTED:EMAIL]");
      expect(redacted).toContain("[REDACTED:INTERNAL_IP]");
      expect(redacted).toContain("[REDACTED:PHONE]");
      expect(redacted).not.toContain("MIIEpQI");
      expect(redacted).not.toContain("user@example.com");
      expect(redacted).not.toContain("192.168.1.100");
      expect(redacted).not.toContain("13912345678");
    });

    it("redacts contextual passwords and API keys", () => {
      const input = "password is hunter2\napi_key = sk-abcdef1234567890";
      const redacted = redactSensitiveInfo(input);

      expect(redacted).toContain("[REDACTED:PASSWORD]");
      expect(redacted).toContain("[REDACTED:API_KEY]");
      expect(redacted).not.toContain("hunter2");
      expect(redacted).not.toContain("sk-abcdef1234567890");
    });
  });

  describe("Chinese Content Detection", () => {
    it("detects Chinese address patterns as S2", async () => {
      const config = {
        privacy: {
          ...ruleOnlyConfig.privacy,
          rules: {
            ...ruleOnlyConfig.privacy.rules,
            patterns: {
              S2: ["[\\u4e00-\\u9fa5]{2,}(?:省|市|区|路|街|号)"],
              S3: ruleOnlyConfig.privacy.rules.patterns.S3,
            },
          },
        },
      };

      const ctx: DetectionContext = {
        checkpoint: "onUserMessage",
        message: "我的地址是北京市朝阳区建国路88号",
      };

      const result = await detectSensitivityLevel(ctx, config);
      expect(result.level).toBe("S2");
    });

    it("detects salary/payslip keywords as S3", async () => {
      const ctx: DetectionContext = {
        checkpoint: "onUserMessage",
        message: "帮我分析一下 payslip 的数据",
      };

      const result = await detectSensitivityLevel(ctx, ruleOnlyConfig);
      expect(result.level).toBe("S3");
    });
  });

  describe("Disabled Plugin Passthrough", () => {
    it("returns S1 for everything when privacy is disabled", async () => {
      const disabledConfig = { privacy: { enabled: false } };
      const pipeline = new RouterPipeline();
      pipeline.register(privacyRouter, { enabled: true, type: "builtin" });

      const decision = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: "ssh id_rsa password payslip" },
        disabledConfig,
      );

      expect(decision.level).toBe("S1");
      expect(decision.action).toBe("passthrough");
    });
  });
});
