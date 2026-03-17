/**
 * Privacy Proxy Tests
 *
 * Tests the PII marker stripping logic and proxy request handling.
 */

import { describe, it, expect } from "vitest";
import { stripPiiMarkers, GUARDCLAW_S2_OPEN, GUARDCLAW_S2_CLOSE } from "../src/privacy-proxy.js";

describe("stripPiiMarkers", () => {
  it("extracts desensitized content from S2 markers", () => {
    const messages = [
      {
        role: "user",
        content: `${GUARDCLAW_S2_OPEN}\nAnalyze this: [REDACTED:SALARY] per month\n${GUARDCLAW_S2_CLOSE}\n\nAnalyze my payslip showing $5000/month`,
      },
    ];

    const stripped = stripPiiMarkers(messages);

    expect(stripped).toBe(true);
    expect(messages[0].content).toBe("Analyze this: [REDACTED:SALARY] per month");
    expect(messages[0].content).not.toContain("$5000");
  });

  it("does not modify messages without markers", () => {
    const messages = [
      { role: "user", content: "What is the weather today?" },
    ];

    const stripped = stripPiiMarkers(messages);

    expect(stripped).toBe(false);
    expect(messages[0].content).toBe("What is the weather today?");
  });

  it("strips from all message roles (system + user)", () => {
    const messages = [
      { role: "system", content: `${GUARDCLAW_S2_OPEN}\ntest\n${GUARDCLAW_S2_CLOSE}\n\noriginal` },
      { role: "user", content: `${GUARDCLAW_S2_OPEN}\nclean\n${GUARDCLAW_S2_CLOSE}\n\ndirty` },
    ];

    stripPiiMarkers(messages);

    expect(messages[0].content).toBe("test");
    expect(messages[1].content).toBe("clean");
  });

  it("handles multiple user messages — strips from all", () => {
    const messages = [
      { role: "user", content: `${GUARDCLAW_S2_OPEN}\nfirst clean\n${GUARDCLAW_S2_CLOSE}\n\nfirst dirty` },
      { role: "assistant", content: "response" },
      { role: "user", content: `${GUARDCLAW_S2_OPEN}\nsecond clean\n${GUARDCLAW_S2_CLOSE}\n\nsecond dirty` },
    ];

    const stripped = stripPiiMarkers(messages);

    expect(stripped).toBe(true);
    expect(messages[0].content).toBe("first clean");
    expect(messages[2].content).toBe("second clean");
  });

  it("handles markers with no trailing PII content", () => {
    const messages = [
      { role: "user", content: `${GUARDCLAW_S2_OPEN}\njust clean data\n${GUARDCLAW_S2_CLOSE}` },
    ];

    stripPiiMarkers(messages);

    expect(messages[0].content).toBe("just clean data");
  });

  it("ignores malformed markers (open without close)", () => {
    const messages = [
      { role: "user", content: `${GUARDCLAW_S2_OPEN}\nincomplete marker without close` },
    ];

    const stripped = stripPiiMarkers(messages);

    expect(stripped).toBe(false);
    expect(messages[0].content).toContain("incomplete marker");
  });

  it("ignores messages with non-string content", () => {
    const messages = [
      { role: "user", content: 42 as unknown },
      { role: "user", content: null as unknown },
    ];

    const stripped = stripPiiMarkers(messages as Array<{ role: string; content: unknown }>);

    expect(stripped).toBe(false);
  });

  it("preserves file content within markers", () => {
    const desensitizedFileContent = [
      "分析工资单",
      "",
      "--- FILE CONTENT ---",
      "姓名: [REDACTED:NAME]",
      "基本工资: [REDACTED:SALARY]",
      "--- END FILE CONTENT ---",
      "",
      "请仅根据上方已脱敏的内容完成任务。",
    ].join("\n");

    const messages = [
      {
        role: "user",
        content: `${GUARDCLAW_S2_OPEN}\n${desensitizedFileContent}\n${GUARDCLAW_S2_CLOSE}\n\n分析我的工资单 payslip.xlsx，我的月薪是50000元`,
      },
    ];

    stripPiiMarkers(messages);

    expect(messages[0].content).toContain("[REDACTED:NAME]");
    expect(messages[0].content).toContain("[REDACTED:SALARY]");
    expect(messages[0].content).not.toContain("50000");
    expect(messages[0].content).not.toContain("payslip.xlsx");
  });
});
