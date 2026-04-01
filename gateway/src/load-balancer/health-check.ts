import type { UpstreamConfig, UpstreamHealth } from "../types.js";

const healthMap = new Map<string, UpstreamHealth>();

export function initHealthMap(upstreams: UpstreamConfig[]): void {
  for (const u of upstreams) {
    healthMap.set(u.id, {
      id: u.id,
      healthy: true,
      lastCheckAt: Date.now(),
      errorCount: 0,
    });
  }
}

export function getHealthyIds(): Set<string> {
  return new Set(
    [...healthMap.values()].filter((h) => h.healthy).map((h) => h.id)
  );
}

export function markUnhealthy(id: string): void {
  const h = healthMap.get(id);
  if (h) {
    h.healthy = false;
    h.errorCount++;
    h.lastCheckAt = Date.now();
    console.warn(`[HealthCheck] Upstream ${id} marked unhealthy (errors: ${h.errorCount})`);
  }
}

export function markHealthy(id: string, latencyMs: number): void {
  const h = healthMap.get(id);
  if (h) {
    const wasUnhealthy = !h.healthy;
    h.healthy = true;
    h.latencyMs = latencyMs;
    h.lastCheckAt = Date.now();
    if (wasUnhealthy) {
      console.log(`[HealthCheck] Upstream ${id} recovered (latency: ${latencyMs}ms)`);
    }
  }
}

export function getAllHealth(): UpstreamHealth[] {
  return [...healthMap.values()];
}

/**
 * Periodic health check. Probes each upstream's /v1/models endpoint.
 * Mark unhealthy on failure; mark healthy on recovery.
 */
export function startHealthChecks(
  upstreams: UpstreamConfig[],
  intervalSec: number,
  timeoutSec: number
): void {
  const probe = async (u: UpstreamConfig) => {
    const start = Date.now();
    try {
      const headers: Record<string, string> =
        u.provider === "anthropic"
          ? { "x-api-key": u.apiKey, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${u.apiKey}` };

      const res = await fetch(`${u.baseUrl}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(timeoutSec * 1000),
      });
      if (res.ok || res.status === 404) {
        // 404 is fine — endpoint exists but may not support /v1/models listing
        markHealthy(u.id, Date.now() - start);
      } else {
        markUnhealthy(u.id);
      }
    } catch {
      markUnhealthy(u.id);
    }
  };

  console.log(
    `[HealthCheck] Starting health checks every ${intervalSec}s for ${upstreams.length} upstreams`
  );
  setInterval(() => {
    for (const u of upstreams) {
      if (u.enabled) probe(u);
    }
  }, intervalSec * 1000);
}
