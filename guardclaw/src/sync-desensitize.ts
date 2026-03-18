/**
 * Synchronous wrapper around the async LLM desensitization function.
 *
 * Uses `synckit` (Worker thread + Atomics.wait) to run `desensitizeWithLocalModel`
 * synchronously so that the `tool_result_persist` hook (sync-only) can desensitize
 * S2 tool results before they enter the persisted transcript.
 *
 * Timeout (30s) gracefully falls back to a failed result, leaving the caller
 * to decide whether to pass content through or apply regex-only redaction.
 */

import { createRequire } from "node:module";
import { createSyncFn } from "synckit";
import { fileURLToPath } from "node:url";
import type { PrivacyConfig } from "./types.js";

export type SyncDesensitizeResult = {
  desensitized: string;
  wasModelUsed: boolean;
  failed?: boolean;
};

const workerPath = fileURLToPath(new URL("./llm-desensitize-worker.ts", import.meta.url));

const _require = createRequire(import.meta.url);
const tsxPath = _require.resolve("tsx");

let _syncDesensitize: ((content: string, config: PrivacyConfig, sessionKey?: string) => SyncDesensitizeResult) | null = null;

function getSyncDesensitize() {
  if (!_syncDesensitize) {
    _syncDesensitize = createSyncFn<(content: string, config: PrivacyConfig, sessionKey?: string) => SyncDesensitizeResult>(
      workerPath,
      { timeout: 30_000, tsRunner: "tsx", execArgv: ["--import", tsxPath] },
    );
  }
  return _syncDesensitize;
}

export function syncDesensitizeWithLocalModel(
  content: string,
  config: PrivacyConfig,
  sessionKey?: string,
): SyncDesensitizeResult {
  try {
    return getSyncDesensitize()(content, config, sessionKey);
  } catch (err) {
    console.warn("[GuardClaw] syncDesensitize fallback to failed:", (err as Error)?.message?.slice(0, 120));
    return { desensitized: content, wasModelUsed: false, failed: true };
  }
}
