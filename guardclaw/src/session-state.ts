/**
 * GuardClaw Session State Management
 * 
 * Tracks privacy state for each session.
 * Per-turn semantics: memory track selection is based on the current
 * message's sensitivity level, not permanent session state.
 */

import type { Checkpoint, SensitivityLevel, SessionPrivacyState } from "./types.js";

// ── In-memory state stores ──────────────────────────────────────────────

const sessionStates = new Map<string, SessionPrivacyState>();

const pendingDetections = new Map<string, PendingDetection>();

const activeLocalRouting = new Set<string>();

// ── Per-turn privacy level ──────────────────────────────────────────────

/**
 * Mark the CURRENT TURN as private (S2 or S3 detected).
 *
 * Per-turn semantics: the privacy level is reset at the start of each turn
 * via `resetTurnLevel()`.  This replaces the old "once private, always
 * private" behaviour — memory track selection is now based on the current
 * message's sensitivity, not historical state.
 *
 * `highestLevel` still accumulates for audit / statistics.
 */
export function markSessionAsPrivate(sessionKey: string, level: SensitivityLevel): void {
  const existing = sessionStates.get(sessionKey);

  if (existing) {
    existing.currentTurnLevel = getHigherLevel(existing.currentTurnLevel, level);
    existing.highestLevel = getHigherLevel(existing.highestLevel, level);
    existing.isPrivate = existing.currentTurnLevel !== "S1";
  } else {
    const isPrivate = level === "S2" || level === "S3";
    sessionStates.set(sessionKey, {
      sessionKey,
      isPrivate,
      highestLevel: level,
      currentTurnLevel: level,
      detectionHistory: [],
    });
  }
}

/**
 * Check if the CURRENT TURN is marked as private (S2 or S3).
 */
export function isSessionMarkedPrivate(sessionKey: string): boolean {
  const state = sessionStates.get(sessionKey);
  if (!state) return false;
  return state.currentTurnLevel !== "S1";
}

/**
 * Reset the per-turn privacy level back to S1.
 * Called at the start of each new user turn in before_model_resolve.
 */
export function resetTurnLevel(sessionKey: string): void {
  const existing = sessionStates.get(sessionKey);
  if (existing) {
    existing.currentTurnLevel = "S1";
    existing.isPrivate = false;
  }
}

/**
 * Get the current turn's sensitivity level.
 */
export function getCurrentTurnLevel(sessionKey: string): SensitivityLevel {
  return sessionStates.get(sessionKey)?.currentTurnLevel ?? "S1";
}

/**
 * Get the highest detected sensitivity level for a session (all-time, for audit).
 */
export function getSessionHighestLevel(sessionKey: string): SensitivityLevel {
  return sessionStates.get(sessionKey)?.highestLevel ?? "S1";
}

// ── Detection history ───────────────────────────────────────────────────

/**
 * Record a detection event in session history
 */
export function recordDetection(
  sessionKey: string,
  level: SensitivityLevel,
  checkpoint: Checkpoint,
  reason?: string
): void {
  let state = sessionStates.get(sessionKey);

  if (!state) {
    state = {
      sessionKey,
      isPrivate: false,
      highestLevel: "S1",
      currentTurnLevel: "S1",
      detectionHistory: [],
    };
    sessionStates.set(sessionKey, state);
  }

  state.detectionHistory.push({
    timestamp: Date.now(),
    level,
    checkpoint,
    reason,
  });

  if (state.detectionHistory.length > 50) {
    state.detectionHistory = state.detectionHistory.slice(-50);
  }
}

// ── Session lifecycle ───────────────────────────────────────────────────

/**
 * Clear all session state (e.g., when session ends).
 * Cleans up sessionStates, activeLocalRouting, and pendingDetections.
 */
export function clearSessionState(sessionKey: string): void {
  sessionStates.delete(sessionKey);
  activeLocalRouting.delete(sessionKey);
  pendingDetections.delete(sessionKey);
}

/**
 * Get all active session states (for debugging/monitoring)
 */
export function getAllSessionStates(): Map<string, SessionPrivacyState> {
  return new Map(sessionStates);
}

// ── Pending detection stash ─────────────────────────────────────────────
// Used to pass detection results between before_model_resolve and
// before_prompt_build / before_message_write hooks (which fire in sequence
// but are registered separately).

export type PendingDetection = {
  level: SensitivityLevel;
  reason?: string;
  desensitized?: string;
  originalPrompt?: string;
  timestamp: number;
};

export function stashDetection(sessionKey: string, detection: PendingDetection): void {
  pendingDetections.set(sessionKey, detection);
}

export function getPendingDetection(sessionKey: string): PendingDetection | undefined {
  return pendingDetections.get(sessionKey);
}

export function consumeDetection(sessionKey: string): PendingDetection | undefined {
  const d = pendingDetections.get(sessionKey);
  pendingDetections.delete(sessionKey);
  return d;
}

// ── Session-level tracking (audit only) ─────────────────────────────────

/**
 * Track the highest detected level for a session WITHOUT permanently marking
 * it as private.
 *
 * Used when S3 is detected at before_model_resolve: the message is routed to
 * Guard Agent (physically isolated session/workspace), so S3 data never enters
 * the main session's context window.
 *
 * Updates both `highestLevel` (audit) and `currentTurnLevel` (per-turn memory
 * track selection) but does NOT set permanent `isPrivate` — next turn's
 * `resetTurnLevel()` will bring it back to S1.
 */
export function trackSessionLevel(sessionKey: string, level: SensitivityLevel): void {
  const existing = sessionStates.get(sessionKey);
  if (existing) {
    existing.highestLevel = getHigherLevel(existing.highestLevel, level);
    existing.currentTurnLevel = getHigherLevel(existing.currentTurnLevel, level);
  } else {
    sessionStates.set(sessionKey, {
      sessionKey,
      isPrivate: false,
      highestLevel: level,
      currentTurnLevel: level,
      detectionHistory: [],
    });
  }
}

// ── Active local routing tracking ───────────────────────────────────────
// Tracks sessions whose current turn is being served by a local model
// due to S3 detection.  Set at the start of before_model_resolve (S3),
// cleared at the start of the NEXT before_model_resolve call.
// Used by tool_result_persist to skip unnecessary PII redaction when
// data never leaves the local environment.

export function setActiveLocalRouting(sessionKey: string): void {
  activeLocalRouting.add(sessionKey);
}

export function clearActiveLocalRouting(sessionKey: string): void {
  activeLocalRouting.delete(sessionKey);
}

export function isActiveLocalRouting(sessionKey: string): boolean {
  return activeLocalRouting.has(sessionKey);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function getHigherLevel(a: SensitivityLevel, b: SensitivityLevel): SensitivityLevel {
  const order = { S1: 1, S2: 2, S3: 3 };
  return order[a] >= order[b] ? a : b;
}
