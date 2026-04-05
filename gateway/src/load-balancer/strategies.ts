import type { UpstreamConfig, LoadBalancerStrategy } from "../types.js";

// Round-robin counters keyed by model (or "any")
const rrCounters = new Map<string, number>();
const activeConnections = new Map<string, number>();
const weightedState = new Map<string, Map<string, number>>();

/**
 * Select an upstream for the given model using the configured strategy.
 * Falls back to any healthy upstream if none supports the specific model.
 */
export function selectUpstream(
  upstreams: UpstreamConfig[],
  model: string,
  strategy: LoadBalancerStrategy,
  healthyIds: Set<string>
): UpstreamConfig | null {
  const enabled = upstreams.filter((u) => u.enabled && healthyIds.has(u.id));
  if (enabled.length === 0) return null;

  // Prefer upstreams that explicitly support this model
  let candidates = enabled.filter(
    (u) => u.models.includes(model) || u.models.includes("*")
  );

  // Fallback: use any enabled healthy upstream
  if (candidates.length === 0) candidates = enabled;

  switch (strategy) {
    case "weighted-round-robin":
      return weightedRoundRobin(candidates, model);
    case "round-robin":
      return roundRobin(candidates, model);
    case "least-connections":
      return leastConnections(candidates, model);
    default:
      return candidates[0];
  }
}

export function beginRequest(upstreamId: string): void {
  activeConnections.set(upstreamId, (activeConnections.get(upstreamId) ?? 0) + 1);
}

export function endRequest(upstreamId: string): void {
  const current = activeConnections.get(upstreamId) ?? 0;
  if (current <= 1) {
    activeConnections.delete(upstreamId);
    return;
  }
  activeConnections.set(upstreamId, current - 1);
}

export function getActiveConnections(upstreamId: string): number {
  return activeConnections.get(upstreamId) ?? 0;
}

function roundRobin(candidates: UpstreamConfig[], key: string): UpstreamConfig {
  const idx = (rrCounters.get(key) ?? 0) % candidates.length;
  rrCounters.set(key, idx + 1);
  return candidates[idx];
}

/**
 * Smooth weighted round-robin (deterministic).
 * Better than random weighted selection because distribution is stable over time.
 */
function weightedRoundRobin(candidates: UpstreamConfig[], model: string): UpstreamConfig {
  const ids = candidates.map((c) => c.id).sort().join(",");
  const stateKey = `${model}|${ids}`;
  let state = weightedState.get(stateKey);
  if (!state) {
    state = new Map<string, number>();
    weightedState.set(stateKey, state);
  }

  const totalWeight = candidates.reduce((sum, u) => sum + Math.max(u.weight, 1), 0);
  let selected = candidates[0];
  let maxCurrent = Number.NEGATIVE_INFINITY;

  for (const u of candidates) {
    const next = (state.get(u.id) ?? 0) + Math.max(u.weight, 1);
    state.set(u.id, next);
    if (next > maxCurrent) {
      maxCurrent = next;
      selected = u;
    }
  }

  state.set(selected.id, (state.get(selected.id) ?? 0) - totalWeight);
  return selected;
}

function leastConnections(candidates: UpstreamConfig[], model: string): UpstreamConfig {
  let bestScore = Number.POSITIVE_INFINITY;
  let ties: UpstreamConfig[] = [];

  for (const candidate of candidates) {
    // Least-connections should reflect real in-flight pressure.
    // Weighting is handled by weighted-round-robin strategy.
    const score = getActiveConnections(candidate.id);
    if (score < bestScore) {
      bestScore = score;
      ties = [candidate];
    } else if (score === bestScore) {
      ties.push(candidate);
    }
  }

  if (ties.length === 1) return ties[0];
  return roundRobin(ties, `lc:${model}`);
}
