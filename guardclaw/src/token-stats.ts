/**
 * GuardClaw Token Stats Collector
 *
 * Tracks token usage across cloud/local/proxy routes with hourly granularity.
 * Classification is based on GuardClaw's Sx sensitivity detection:
 *   S1 → cloud,  S2 → proxy (or local per s2Policy),  S3 → local
 * Persists to a JSON file so data survives gateway restarts.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getSessionHighestLevel } from "./session-state.js";
import { getLiveConfig } from "./live-config.js";

// ── Types ──

export type RouteCategory = "cloud" | "local" | "proxy";

export type TokenBucket = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  requestCount: number;
};

export type HourlyBucket = {
  hour: string;
  cloud: TokenBucket;
  local: TokenBucket;
  proxy: TokenBucket;
};

export type SessionTokenStats = {
  sessionKey: string;
  highestLevel: "S1" | "S2" | "S3";
  cloud: TokenBucket;
  local: TokenBucket;
  proxy: TokenBucket;
  firstSeenAt: number;
  lastActiveAt: number;
};

export type TokenStatsData = {
  lifetime: Record<RouteCategory, TokenBucket>;
  hourly: HourlyBucket[];
  sessions: Record<string, SessionTokenStats>;
  startedAt: number;
  lastUpdatedAt: number;
};

export type UsageEvent = {
  sessionKey: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

// ── Helpers ──

const MAX_HOURLY_BUCKETS = 72;
const MAX_SESSIONS = 200;

function emptyBucket(): TokenBucket {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, requestCount: 0 };
}

function currentHourKey(): string {
  return new Date().toISOString().slice(0, 13);
}

function emptyStats(): TokenStatsData {
  return {
    lifetime: { cloud: emptyBucket(), local: emptyBucket(), proxy: emptyBucket() },
    hourly: [],
    sessions: {},
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
  };
}

function addToBucket(bucket: TokenBucket, usage: UsageEvent["usage"]): void {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  bucket.inputTokens += input;
  bucket.outputTokens += output;
  bucket.cacheReadTokens += cacheRead;
  bucket.totalTokens += usage?.total ?? (input + output);
  bucket.requestCount += 1;
}

/**
 * Classify a request based on the session's Sx sensitivity level.
 *   S1 → cloud
 *   S2 → proxy or local (depends on s2Policy)
 *   S3 → local
 */
function classifyBySession(sessionKey: string): RouteCategory {
  const level = getSessionHighestLevel(sessionKey);
  if (level === "S3") return "local";
  if (level === "S2") {
    const policy = getLiveConfig().s2Policy;
    return policy === "local" ? "local" : "proxy";
  }
  return "cloud";
}

// ── Collector ──

export class TokenStatsCollector {
  private data: TokenStatsData;
  private filePath: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = emptyStats();
  }

  /** Load persisted stats from disk. Merges with empty defaults for missing fields. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<TokenStatsData>;
      const rawSessions = (parsed.sessions && typeof parsed.sessions === "object")
        ? parsed.sessions as Record<string, SessionTokenStats>
        : {};
      this.data = {
        lifetime: {
          cloud: { ...emptyBucket(), ...parsed.lifetime?.cloud },
          local: { ...emptyBucket(), ...parsed.lifetime?.local },
          proxy: { ...emptyBucket(), ...parsed.lifetime?.proxy },
        },
        hourly: Array.isArray(parsed.hourly) ? parsed.hourly : [],
        sessions: rawSessions,
        startedAt: parsed.startedAt ?? Date.now(),
        lastUpdatedAt: parsed.lastUpdatedAt ?? Date.now(),
      };
    } catch {
      this.data = emptyStats();
    }
  }

  /** Start periodic flush (every 5 minutes). */
  startAutoFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (this.dirty) this.flush().catch(() => {});
    }, 300_000);
    if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  /** Stop periodic flush. */
  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Record a usage event from llm_output hook. */
  record(event: UsageEvent): void {
    const category = classifyBySession(event.sessionKey);
    const now = Date.now();

    addToBucket(this.data.lifetime[category], event.usage);

    const hourKey = currentHourKey();
    let hourly = this.data.hourly.find((h) => h.hour === hourKey);
    if (!hourly) {
      hourly = { hour: hourKey, cloud: emptyBucket(), local: emptyBucket(), proxy: emptyBucket() };
      this.data.hourly.push(hourly);
      if (this.data.hourly.length > MAX_HOURLY_BUCKETS) {
        this.data.hourly = this.data.hourly.slice(-MAX_HOURLY_BUCKETS);
      }
    }
    addToBucket(hourly[category], event.usage);

    // Per-session tracking
    const sk = event.sessionKey;
    if (sk) {
      let sess = this.data.sessions[sk];
      if (!sess) {
        sess = {
          sessionKey: sk,
          highestLevel: getSessionHighestLevel(sk),
          cloud: emptyBucket(),
          local: emptyBucket(),
          proxy: emptyBucket(),
          firstSeenAt: now,
          lastActiveAt: now,
        };
        this.data.sessions[sk] = sess;
      }
      sess.highestLevel = getSessionHighestLevel(sk);
      sess.lastActiveAt = now;
      addToBucket(sess[category], event.usage);
      this.evictOldSessions();
    }

    this.data.lastUpdatedAt = now;
    this.dirty = true;
  }

  private evictOldSessions(): void {
    const keys = Object.keys(this.data.sessions);
    if (keys.length <= MAX_SESSIONS) return;
    const sorted = keys.sort(
      (a, b) => this.data.sessions[a].lastActiveAt - this.data.sessions[b].lastActiveAt,
    );
    const toRemove = sorted.slice(0, keys.length - MAX_SESSIONS);
    for (const k of toRemove) delete this.data.sessions[k];
  }

  /** Get snapshot of current stats. */
  getStats(): TokenStatsData {
    return this.data;
  }

  /** Get summary for API response. */
  getSummary(): { lifetime: TokenStatsData["lifetime"]; lastUpdatedAt: number; startedAt: number } {
    return {
      lifetime: this.data.lifetime,
      lastUpdatedAt: this.data.lastUpdatedAt,
      startedAt: this.data.startedAt,
    };
  }

  /** Get hourly data for API response. */
  getHourly(): HourlyBucket[] {
    return this.data.hourly;
  }

  /** Get per-session stats sorted by lastActiveAt descending. */
  getSessionStats(): SessionTokenStats[] {
    return Object.values(this.data.sessions).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    );
  }

  /** Reset all stats to empty and flush to disk. */
  async reset(): Promise<void> {
    this.data = emptyStats();
    this.dirty = true;
    await this.flush();
  }

  /** Flush to disk. */
  async flush(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
      this.dirty = false;
    } catch {
      // Non-critical — stats will be retried on next flush
    }
  }
}

// ── Singleton ──

let globalCollector: TokenStatsCollector | null = null;

export function setGlobalCollector(collector: TokenStatsCollector): void {
  globalCollector = collector;
}

export function getGlobalCollector(): TokenStatsCollector | null {
  return globalCollector;
}
