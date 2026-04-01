import type { UpstreamConfig, LoadBalancerStrategy } from "../types.js";

// Round-robin counters keyed by model (or "any")
const rrCounters = new Map<string, number>();

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
      return weightedRoundRobin(candidates);
    case "round-robin":
      return roundRobin(candidates, model);
    case "least-connections":
      // Phase 2: track active connections. For now, fall through to WRR.
      return weightedRoundRobin(candidates);
    default:
      return candidates[0];
  }
}

function roundRobin(candidates: UpstreamConfig[], key: string): UpstreamConfig {
  const idx = (rrCounters.get(key) ?? 0) % candidates.length;
  rrCounters.set(key, idx + 1);
  return candidates[idx];
}

function weightedRoundRobin(candidates: UpstreamConfig[]): UpstreamConfig {
  const totalWeight = candidates.reduce((s, u) => s + u.weight, 0);
  if (totalWeight === 0) return candidates[0];
  let rand = Math.random() * totalWeight;
  for (const u of candidates) {
    rand -= u.weight;
    if (rand <= 0) return u;
  }
  return candidates[candidates.length - 1];
}
