/**
 * GuardClaw Session Manager Tests
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DualSessionManager } from "../src/session-manager.js";
import { redactSensitiveInfo } from "../src/utils.js";

describe("Dual Session Manager", () => {
  const testBaseDir = path.join(process.cwd(), ".test-guardclaw");
  let manager: DualSessionManager;

  beforeEach(() => {
    // Create test directory
    if (!fs.existsSync(testBaseDir)) {
      fs.mkdirSync(testBaseDir, { recursive: true });
    }
    manager = new DualSessionManager(testBaseDir);
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  describe("Message Persistence", () => {
    test("should write to both full and clean history for normal messages", async () => {
      const sessionKey = "test-session";
      const message = {
        role: "user" as const,
        content: "Hello world",
        timestamp: Date.now(),
      };

      await manager.persistMessage(sessionKey, message);

      const fullHistory = await manager.loadHistory(sessionKey, false);
      const cleanHistory = await manager.loadHistory(sessionKey, true);

      expect(fullHistory).toHaveLength(1);
      expect(cleanHistory).toHaveLength(1);
      expect(fullHistory[0].content).toBe("Hello world");
      expect(cleanHistory[0].content).toBe("Hello world");
    });

    test("should write only to full history for guard agent messages", async () => {
      const sessionKey = "test-session";
      const guardMessage = {
        role: "assistant" as const,
        content: "[Guard Agent] Processing sensitive data",
        timestamp: Date.now(),
        sessionKey: "main:guard:123",
      };

      await manager.persistMessage(sessionKey, guardMessage);

      const fullHistory = await manager.loadHistory(sessionKey, false);
      const cleanHistory = await manager.loadHistory(sessionKey, true);

      expect(fullHistory).toHaveLength(1);
      expect(cleanHistory).toHaveLength(0); // Guard message excluded
    });
  });

  describe("History Loading", () => {
    test("should load full history for local models", async () => {
      const sessionKey = "test-session";

      await manager.persistMessage(sessionKey, {
        role: "user" as const,
        content: "Normal message",
        timestamp: Date.now(),
      });

      await manager.persistMessage(sessionKey, {
        role: "assistant" as const,
        content: "[Guard Agent] Secret operation",
        sessionKey: "main:guard:123",
        timestamp: Date.now(),
      });

      const history = await manager.loadHistory(sessionKey, false);

      expect(history).toHaveLength(2);
    });

    test("should load clean history for cloud models", async () => {
      const sessionKey = "test-session";

      await manager.persistMessage(sessionKey, {
        role: "user" as const,
        content: "Normal message",
        timestamp: Date.now(),
      });

      await manager.persistMessage(sessionKey, {
        role: "assistant" as const,
        content: "[Guard Agent] Secret operation",
        sessionKey: "main:guard:123",
        timestamp: Date.now(),
      });

      const history = await manager.loadHistory(sessionKey, true);

      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("Normal message");
    });

    test("should respect limit parameter", async () => {
      const sessionKey = "test-session";

      for (let i = 0; i < 10; i++) {
        await manager.persistMessage(sessionKey, {
          role: "user" as const,
          content: `Message ${i}`,
          timestamp: Date.now(),
        });
      }

      const history = await manager.loadHistory(sessionKey, false, "main", 5);

      expect(history).toHaveLength(5);
    });
  });

  describe("History Statistics", () => {
    test("should report accurate stats", async () => {
      const sessionKey = "test-session";

      await manager.persistMessage(sessionKey, {
        role: "user" as const,
        content: "Normal",
        timestamp: Date.now(),
      });

      await manager.persistMessage(sessionKey, {
        role: "assistant" as const,
        content: "[Guard Agent] Private",
        sessionKey: "main:guard:123",
        timestamp: Date.now(),
      });

      const stats = await manager.getHistoryStats(sessionKey);

      expect(stats.fullCount).toBe(2);
      expect(stats.cleanCount).toBe(1);
      expect(stats.difference).toBe(1);
    });
  });

  describe("History Delta", () => {
    test("should return guard-agent messages as delta", async () => {
      const sessionKey = "delta-session";
      const ts = Date.now();

      await manager.persistMessage(sessionKey, {
        role: "user" as const,
        content: "Public question",
        timestamp: ts,
      });

      await manager.persistMessage(sessionKey, {
        role: "assistant" as const,
        content: "[Guard Agent] Analyzed your secret data",
        sessionKey: "main:guard:456",
        timestamp: ts + 1,
      });

      await manager.persistMessage(sessionKey, {
        role: "user" as const,
        content: "Another public message",
        timestamp: ts + 2,
      });

      const delta = await manager.loadHistoryDelta(sessionKey);

      expect(delta).toHaveLength(1);
      expect(delta[0].content).toContain("[Guard Agent]");
    });

    test("should return empty delta when full and clean are identical", async () => {
      const sessionKey = "no-delta-session";
      const ts = Date.now();

      await manager.persistMessage(sessionKey, {
        role: "user" as const,
        content: "Normal message",
        timestamp: ts,
      });

      const delta = await manager.loadHistoryDelta(sessionKey);
      expect(delta).toHaveLength(0);
    });

    test("should respect limit in delta", async () => {
      const sessionKey = "limited-delta";

      for (let i = 0; i < 10; i++) {
        await manager.writeToFull(sessionKey, {
          role: "assistant" as const,
          content: `[Guard Agent] Secret ${i}`,
          sessionKey: "main:guard:x",
          timestamp: Date.now() + i,
        });
      }

      const delta = await manager.loadHistoryDelta(sessionKey, "main", 3);
      expect(delta).toHaveLength(3);
    });
  });

  describe("Format As Context", () => {
    test("should format messages into readable context", () => {
      const messages = [
        { role: "user" as const, content: "What's my salary?" },
        { role: "assistant" as const, content: "Your base salary is competitive." },
        { role: "tool" as const, content: "file contents", toolName: "read_file" },
      ];

      const context = DualSessionManager.formatAsContext(messages);

      expect(context).toContain("[Full conversation history (original, authoritative)]");
      expect(context).toContain("User: What's my salary?");
      expect(context).toContain("Assistant: Your base salary is competitive.");
      expect(context).toContain("Tool(read_file): file contents");
      expect(context).toContain("[End of private context]");
    });

    test("should return empty string for empty messages", () => {
      const context = DualSessionManager.formatAsContext([]);
      expect(context).toBe("");
    });

    test("should truncate long messages", () => {
      const longContent = "x".repeat(3000);
      const messages = [
        { role: "user" as const, content: longContent },
      ];

      const context = DualSessionManager.formatAsContext(messages);
      expect(context).toContain("…(truncated)");
      expect(context.length).toBeLessThan(longContent.length);
    });

    test("should accept custom label", () => {
      const messages = [
        { role: "user" as const, content: "test" },
      ];

      const context = DualSessionManager.formatAsContext(messages, "Custom Label");
      expect(context).toContain("[Custom Label]");
    });
  });

  describe("PII Redaction on Local Model Responses", () => {
    test("should diverge full/clean tracks when assistant response contains PII", async () => {
      const sessionKey = "pii-assistant-session";
      const ts = Date.now();
      const originalResponse =
        "查到 13812345678 对应的邮箱是 zhangsan@example.com";
      const redacted = redactSensitiveInfo(originalResponse, { chinesePhone: true, email: true });

      expect(redacted).not.toBe(originalResponse);
      expect(redacted).toContain("[REDACTED:");
      expect(redacted).not.toContain("13812345678");
      expect(redacted).not.toContain("zhangsan@example.com");

      await manager.writeToFull(sessionKey, {
        role: "assistant",
        content: originalResponse,
        timestamp: ts,
      });
      await manager.writeToClean(sessionKey, {
        role: "assistant",
        content: redacted,
        timestamp: ts,
      });

      const fullHistory = await manager.loadHistory(sessionKey, false);
      const cleanHistory = await manager.loadHistory(sessionKey, true);

      expect(fullHistory).toHaveLength(1);
      expect(cleanHistory).toHaveLength(1);
      expect(fullHistory[0].content).toBe(originalResponse);
      expect(cleanHistory[0].content).toBe(redacted);
      expect(cleanHistory[0].content).not.toContain("13812345678");
      expect(cleanHistory[0].content).not.toContain("zhangsan@example.com");
    });

    test("should not alter assistant response without PII", async () => {
      const sessionKey = "no-pii-assistant";
      const safeResponse = "HTTP 200 表示请求成功，201 表示资源已创建。";
      const redacted = redactSensitiveInfo(safeResponse);

      expect(redacted).toBe(safeResponse);
    });

    test("should redact echoed passwords in assistant response", () => {
      const response = "password is SuperSecret123 which is weak.";
      const redacted = redactSensitiveInfo(response);

      expect(redacted).toContain("[REDACTED:PASSWORD]");
      expect(redacted).not.toContain("SuperSecret123");
    });

    test("should redact API keys echoed by local model", () => {
      const response =
        "I found sk-abc123def456ghi789jkl012mno in your config file.";
      const redacted = redactSensitiveInfo(response);

      expect(redacted).toContain("[REDACTED:KEY]");
      expect(redacted).not.toContain("sk-abc123def456ghi789jkl012mno");
    });

    test("should redact email addresses in assistant output", () => {
      const response = "发送确认邮件到 zhangsan@example.com 了。";
      const redacted = redactSensitiveInfo(response, { email: true });

      expect(redacted).toContain("[REDACTED:EMAIL]");
      expect(redacted).not.toContain("zhangsan@example.com");
    });

    test("should redact internal IPs echoed by local model", () => {
      const response = "数据库连接地址是 192.168.1.100:5432。";
      const redacted = redactSensitiveInfo(response, { internalIp: true });

      expect(redacted).toContain("[REDACTED:INTERNAL_IP]");
      expect(redacted).not.toContain("192.168.1.100");
    });
  });

  describe("Clear History", () => {
    test("should clear both histories", async () => {
      const sessionKey = "test-session";

      await manager.persistMessage(sessionKey, {
        role: "user" as const,
        content: "Test",
        timestamp: Date.now(),
      });

      await manager.clearHistory(sessionKey);

      const fullHistory = await manager.loadHistory(sessionKey, false);
      const cleanHistory = await manager.loadHistory(sessionKey, true);

      expect(fullHistory).toHaveLength(0);
      expect(cleanHistory).toHaveLength(0);
    });
  });
});
