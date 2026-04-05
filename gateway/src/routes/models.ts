import type { FastifyInstance } from "fastify";
import type { GatewayConfig } from "../types.js";
import { getHealthyIds } from "../load-balancer/health-check.js";

export default async function modelsRoute(
  fastify: FastifyInstance,
  opts: { config: GatewayConfig }
) {
  const { config } = opts;

  /** List all models available across healthy upstreams */
  fastify.get("/v1/models", async (_req, reply) => {
    const healthyIds = getHealthyIds();
    const seen = new Set<string>();
    const models: Array<{ id: string; object: string; owned_by: string }> = [];

    for (const upstream of config.upstreams) {
      if (!upstream.enabled || !healthyIds.has(upstream.id)) continue;
      for (const model of upstream.models) {
        if (model === "*" || seen.has(model)) continue;
        seen.add(model);
        models.push({ id: model, object: "model", owned_by: upstream.provider });
      }
    }

    reply.send({ object: "list", data: models });
  });
}
