/**
 * In-memory session store for Phase 1.
 * Replace with Redis store in Phase 2 for multi-instance deployments.
 */

export type SessionState = {
  sessionId: string;
  tenantId: string;
  highestLevel: "S1" | "S2" | "S3";
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: number;
  lastActiveAt: number;
};

const sessions = new Map<string, SessionState>();

export function getOrCreateSession(sessionId: string, tenantId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      sessionId,
      tenantId,
      highestLevel: "S1",
      requestCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    sessions.set(sessionId, s);
  }
  s.lastActiveAt = Date.now();
  return s;
}

export function updateSession(sessionId: string, update: Partial<SessionState>): void {
  const s = sessions.get(sessionId);
  if (s) Object.assign(s, update);
}

export function getAllSessions(): SessionState[] {
  // Prune sessions inactive for > 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.lastActiveAt < cutoff) sessions.delete(id);
  }
  return [...sessions.values()];
}

export function getSessionCount(): number {
  return sessions.size;
}
