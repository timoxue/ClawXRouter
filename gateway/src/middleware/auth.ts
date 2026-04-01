import type { FastifyRequest, FastifyReply } from "fastify";
import type { GatewayConfig, TenantContext } from "../types.js";

declare module "fastify" {
  interface FastifyRequest {
    tenant: TenantContext;
  }
}

export function createAuthMiddleware(config: GatewayConfig) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Skip auth for admin routes that serve their own auth
    if (req.url.startsWith("/admin/dashboard") || req.url === "/health") {
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
