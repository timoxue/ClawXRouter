import type { FastifyRequest, FastifyReply } from "fastify";
import type { GatewayConfig, TenantContext } from "../types.js";
import { lookupByApiKey, touchContainer } from "../container-registry.js";
import { loadConfig } from "../config/store.js";

declare module "fastify" {
  interface FastifyRequest {
    tenant: TenantContext;
  }
}

export function createAuthMiddleware() {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const config = loadConfig() as GatewayConfig;

    // Skip auth for admin routes that serve their own auth
    if (req.url.startsWith("/admin/") || req.url === "/" || req.url === "/health" || req.url === "/gateway/register") {
      req.tenant = { tenantId: "system", name: "System", apiKey: "" };
      return;
    }

    if (!config.auth.enabled) {
      req.tenant = { tenantId: "default", name: "Default", apiKey: "" };
      return;
    }

    const authHeader = (req.headers.authorization as string) ?? "";
    const apiKey = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : authHeader.trim();

    if (!apiKey) {
      reply.code(401).send({
        error: {
          message: "Missing API key. Provide Authorization: Bearer <key>",
          type: "invalid_request_error",
          code: "missing_api_key",
        },
      });
      return;
    }

    // Check registered containers first
    const container = lookupByApiKey(apiKey);
    if (container) {
      touchContainer(container.apiKey);
      req.tenant = {
        tenantId: container.apiKey,
        name: `${container.username} (${container.type})`,
        apiKey,
      };
      return;
    }

    // Fall back to static API keys
    const tenant = config.auth.apiKeys[apiKey];
    if (!tenant) {
      reply.code(401).send({
        error: {
          message: "Invalid API key",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      });
      return;
    }

    req.tenant = { ...tenant, apiKey };
  };
}
