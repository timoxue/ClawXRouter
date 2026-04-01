import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig } from "./config/store.js";
import { initHealthMap, startHealthChecks } from "./load-balancer/health-check.js";
import { initPrivacyPipeline } from "./middleware/privacy.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import completionsRoute from "./routes/completions.js";
import modelsRoute from "./routes/models.js";
import adminRoute from "./routes/admin.js";

async function main() {
  // ── Load config ───────────────────────────────────────────────────────
  const config = loadConfig();

  // ── Init subsystems ───────────────────────────────────────────────────
  initHealthMap(config.upstreams);
  initPrivacyPipeline(config);

  if (config.loadBalancer.healthCheck.enabled) {
    startHealthChecks(
      config.upstreams,
      config.loadBalancer.healthCheck.intervalSec,
      config.loadBalancer.healthCheck.timeoutSec
    );
  }

  // ── Fastify server ────────────────────────────────────────────────────
  const fastify = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  await fastify.register(cors, { origin: true });

  // Global auth middleware
  fastify.addHook("preHandler", createAuthMiddleware(config));

  // Routes — pass config as plugin option
  await fastify.register(completionsRoute, { config });
  await fastify.register(modelsRoute, { config });
  await fastify.register(adminRoute, { config });

  // ── Start ─────────────────────────────────────────────────────────────
  const address = await fastify.listen({
    port: config.server.port,
    host: config.server.host,
  });

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║        ClawX Gateway is running          ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  API     ${address.padEnd(33)}║`);
  console.log(`║  Dashboard  ${(address + "/admin/dashboard").padEnd(30)}║`);
  console.log(`║  Health  ${(address + "/health").padEnd(33)}║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(
    `║  Upstreams: ${String(config.upstreams.filter((u) => u.enabled).length).padEnd(29)}║`
  );
  console.log(
    `║  LB strategy: ${config.loadBalancer.strategy.padEnd(27)}║`
  );
  console.log(
    `║  Privacy: ${String(config.privacy?.enabled ?? false).padEnd(31)}║`
  );
  console.log(`╚══════════════════════════════════════════╝\n`);

  console.log("OpenClaw container config:");
  console.log(`  baseUrl: "${address}/v1"`);
  console.log(`  apiKey: "<your-gw-key-from-gateway.config.json>"\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
