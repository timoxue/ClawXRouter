import * as path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { RegisteredContainer } from "./types.js";

const DB_PATH =
  process.env.CLAWX_DB_PATH ??
  path.join(process.cwd(), "clawx.db");

let db: Database.Database;

// In-memory cache for last_seen_at — flushed to DB every 30s
const lastSeenCache = new Map<string, number>();

function flushLastSeen(): void {
  if (lastSeenCache.size === 0) return;
  const stmt = db.prepare("UPDATE containers SET last_seen_at = ? WHERE api_key = ?");
  const flush = db.transaction(() => {
    for (const [id, ts] of lastSeenCache) stmt.run(ts, id);
  });
  flush();
  lastSeenCache.clear();
}

export function loadRegistry(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS containers (
      api_key       TEXT PRIMARY KEY,
      username      TEXT NOT NULL,
      type          TEXT NOT NULL,
      version       TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL
    )
  `);
  const count = (db.prepare("SELECT COUNT(*) as n FROM containers").get() as { n: number }).n;
  console.log(`[Registry] SQLite ready at ${DB_PATH} (${count} container(s))`);
  setInterval(flushLastSeen, 30_000).unref();
}

function rowToContainer(row: Record<string, unknown>): RegisteredContainer {
  return {
    apiKey:      row.api_key as string,
    username:    row.username as string,
    type:        row.type as string,
    version:     row.version as string,
    registeredAt: row.registered_at as number,
    lastSeenAt:   row.last_seen_at as number,
  };
}

export function registerContainer(
  username: string,
  type: string,
  version: string
): RegisteredContainer {
  const apiKey = "gw-" + username + "-" + randomBytes(8).toString("hex");
  const now = Date.now();
  db.prepare(`
    INSERT INTO containers (api_key, username, type, version, registered_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(apiKey, username, type, version, now, now);
  console.log(`[Registry] Registered ${type} container for user "${username}"`);
  return { apiKey, username, type, version, registeredAt: now, lastSeenAt: now };
}

export function lookupByApiKey(apiKey: string): RegisteredContainer | null {
  const row = db.prepare("SELECT * FROM containers WHERE api_key = ?").get(apiKey) as Record<string, unknown> | undefined;
  return row ? rowToContainer(row) : null;
}

export function touchContainer(apiKey: string): void {
  lastSeenCache.set(apiKey, Date.now());
}

export function removeContainer(apiKey: string): boolean {
  const result = db.prepare("DELETE FROM containers WHERE api_key = ?").run(apiKey);
  return result.changes > 0;
}

export function getAllContainers(): RegisteredContainer[] {
  const rows = db.prepare("SELECT * FROM containers ORDER BY last_seen_at DESC").all() as Record<string, unknown>[];
  return rows.map((row) => {
    const c = rowToContainer(row);
    const cached = lastSeenCache.get(c.apiKey);
    if (cached) c.lastSeenAt = cached;
    return c;
  });
}

export function isOnline(c: RegisteredContainer): boolean {
  return Date.now() - c.lastSeenAt < 5 * 60 * 1000;
}
