import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig } from "./config/store.js";
import { initHealthMap, startHealthChecks } from "./load-balancer/health-check.js";
import { initPrivacyPipeline } from "./middleware/privacy.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createAdminAuthHook } from "./middleware/admin-auth.js";
import { loadRegistry } from "./container-registry.js";
import completionsRoute from "./routes/completions.js";
import modelsRoute from "./routes/models.js";
import adminRoute from "./routes/admin.js";

async function main() {
  const config = loadConfig();

  loadRegistry();
  initHealthMap(config.upstreams);
  initPrivacyPipeline(config);

  if (config.loadBalancer.healthCheck.enabled) {
    startHealthChecks(
      () => loadConfig().upstreams,
      config.loadBalancer.healthCheck.intervalSec,
      config.loadBalancer.healthCheck.timeoutSec
    );
  }

  const fastify = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  await fastify.register(cors, { origin: true });

  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const parsed = Object.fromEntries(new URLSearchParams(body as string));
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  fastify.addHook("preHandler", createAdminAuthHook(config));
  fastify.addHook("preHandler", createAuthMiddleware(config));

  await fastify.register(completionsRoute, { config });
  await fastify.register(modelsRoute, { config });
  await fastify.register(adminRoute, { config });

  const address = await fastify.listen({
    port: config.server.port,
    host: config.server.host,
  });

  console.log("\nClawX Gateway is running");
  console.log(`API: ${address}`);
  console.log(`Dashboard: ${address}/admin/dashboard`);
  console.log(`Health: ${address}/health`);
  console.log(`Upstreams: ${config.upstreams.filter((u) => u.enabled).length}`);
  console.log(`LB strategy: ${config.loadBalancer.strategy}`);
  console.log(`Privacy enabled: ${String(config.privacy?.enabled ?? false)}\n`);

  console.log("OpenClaw container config:");
  console.log(`  baseUrl: \"${address}/v1\"`);
  console.log('  apiKey: "<your-gw-key-from-gateway.config.json>"\n');
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
