import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { detectPrivacy } from "../middleware/privacy.js";
import { beginRequest, endRequest, selectUpstream } from "../load-balancer/strategies.js";
import { getHealthyIds, markUnhealthy } from "../load-balancer/health-check.js";
import { getOrCreateSession, updateSession } from "../session/memory-store.js";
import { loadConfig } from "../config/store.js";
import { buildOpenAIEndpoint } from "../utils/upstream-url.js";
import { redactSensitiveInfo } from "../../../clawxrouter/src/utils.js";
import type { GatewayConfig, CompletionsBody, UpstreamConfig } from "../types.js";

const DEFAULT_TIMEOUT_SEC = 120;

export default async function completionsRoute(
  fastify: FastifyInstance,
  _opts: { config: GatewayConfig }
) {
  fastify.post<{ Body: CompletionsBody }>(
    "/v1/chat/completions",
    { config: { rawBody: false } },
    async (req: FastifyRequest<{ Body: CompletionsBody }>, reply: FastifyReply) => {
      const config = loadConfig();
      const body = req.body;
      const tenant = req.tenant;
      const sessionKey = `${tenant.tenantId}:${body.model}`;

      // ── 1. Privacy detection ────────────────────────────────────────────
      const userMessage = extractLastUserMessage(body);
      const decision = userMessage
        ? await detectPrivacy(userMessage, sessionKey)
        : { level: "S1" as const, action: "passthrough" as const };

      const level = decision.level;
      fastify.log.info(`[${tenant.tenantId}] Privacy: ${level} | model: ${body.model}`);

      // Record session state
      const session = getOrCreateSession(sessionKey, tenant.tenantId);
      session.requestCount++;
      if (levelNumeric(level) > levelNumeric(session.highestLevel)) {
        updateSession(sessionKey, { highestLevel: level });
      }

      // ── 2. S3: route to local model ─────────────────────────────────────
      if (level === "S3") {
        const localUpstream = getLocalUpstream(config.upstreams);
        if (!localUpstream) {
          return reply.code(503).send({
            error: {
              message:
                "Request contains confidential data (S3) and no local model is configured. " +
                "Configure a local upstream (Ollama/vLLM) to handle S3 requests.",
              type: "gateway_error",
              code: "no_local_model",
            },
          });
        }
        const timeoutSec = config.loadBalancer.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
        const localResult = await forwardWithTracking(localUpstream, body, timeoutSec);
        if (localResult.type === "error") {
          return reply.code(502).send({
            error: { message: localResult.reason, type: "gateway_error", code: "local_model_error" },
          });
        }
        return sendResponse(reply, localResult.response, body);
      }

      // ── 3. S2: redact PII before forwarding ────────────────────────────
      let forwardBody = body;
      if (level === "S2") {
        forwardBody = redactMessages(body, config.privacy as Record<string, unknown>);
        fastify.log.warn(`[${tenant.tenantId}] S2 — PII redacted before forwarding`);
      }

      // ── 4. Load-balance: select upstream ───────────────────────────────
      // S1/S2 requests go to cloud upstreams by default.
      // If no cloud upstream is enabled/healthy, we fall back to all upstreams for availability.
      const healthyIds = getHealthyIds();
      const cloudPreferred = config.upstreams.filter((u) => (u.role ?? "cloud") !== "local");
      const selectionPool = cloudPreferred.length > 0 ? cloudPreferred : config.upstreams;
      const upstream = selectUpstream(
        selectionPool,
        body.model,
        config.loadBalancer.strategy,
        healthyIds
      );

      if (!upstream) {
        return reply.code(503).send({
          error: {
            message: "No healthy upstream available",
            type: "gateway_error",
            code: "no_upstream",
          },
        });
      }

      fastify.log.info(`[${tenant.tenantId}] → upstream: ${upstream.id}`);

      // Rewrite virtual model name to the real name this upstream expects
      if (upstream.modelAlias?.[forwardBody.model]) {
        forwardBody = { ...forwardBody, model: upstream.modelAlias[forwardBody.model] };
      }

      const timeoutSec = config.loadBalancer.timeoutSec ?? DEFAULT_TIMEOUT_SEC;

      // ── 5. Forward (with one retry on a different upstream) ─────────────
      const tried = new Set<string>([upstream.id]);
      const result = await forwardWithTracking(upstream, forwardBody, timeoutSec);

      if (result.type === "error") {
        fastify.log.error(`[${tenant.tenantId}] Upstream ${upstream.id} failed: ${result.reason}`);
        markUnhealthy(upstream.id);

        // Retry once with a different healthy upstream
        const fallbackPool = selectionPool.filter((u) => !tried.has(u.id));
        const fallback = selectUpstream(
          fallbackPool,
          body.model,
          config.loadBalancer.strategy,
          getHealthyIds()
        );

        if (fallback) {
          fastify.log.warn(`[${tenant.tenantId}] Retrying with fallback upstream: ${fallback.id}`);
          const fallbackBody = fallback.modelAlias?.[body.model]
            ? { ...forwardBody, model: fallback.modelAlias[body.model] }
            : forwardBody;
          const retry = await forwardWithTracking(fallback, fallbackBody, timeoutSec);
          if (retry.type === "error") {
            markUnhealthy(fallback.id);
            return reply.code(502).send({
              error: { message: retry.reason, type: "gateway_error", code: "upstream_error" },
            });
          }
          return sendResponse(reply, retry.response, forwardBody);
        }

        return reply.code(502).send({
          error: { message: result.reason, type: "gateway_error", code: "upstream_error" },
        });
      }

      return sendResponse(reply, result.response, forwardBody);
    }
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractLastUserMessage(body: CompletionsBody): string | null {
  const messages = body.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string" && m.content.trim()) {
      return m.content;
    }
  }
  return null;
}

function redactMessages(
  body: CompletionsBody,
  privacyConfig: Record<string, unknown>
): CompletionsBody {
  const redactionOpts = (privacyConfig?.redaction ?? {}) as Record<string, boolean>;
  const redactedMessages = body.messages.map((m) => {
    if (typeof m.content !== "string" || !m.content) return m;
    return { ...m, content: redactSensitiveInfo(m.content, redactionOpts) };
  });
  return { ...body, messages: redactedMessages };
}

function getLocalUpstream(upstreams: UpstreamConfig[]): UpstreamConfig | null {
  return (
    upstreams.find((u) => u.enabled && u.role === "local") ??
    // Fallback heuristic for configs without explicit role
    upstreams.find(
      (u) =>
        u.enabled &&
        (u.baseUrl.includes("localhost") ||
          u.baseUrl.includes("127.0.0.1"))
    ) ??
    null
  );
}

type ForwardResult =
  | { type: "ok"; response: Response }
  | { type: "error"; reason: string };

async function forwardWithTracking(
  upstream: UpstreamConfig,
  body: CompletionsBody,
  timeoutSec: number
): Promise<ForwardResult> {
  beginRequest(upstream.id);
  try {
    return await forwardRequest(upstream, body, timeoutSec);
  } finally {
    endRequest(upstream.id);
  }
}

async function forwardRequest(
  upstream: UpstreamConfig,
  body: CompletionsBody,
  timeoutSec: number
): Promise<ForwardResult> {
  const url = buildOpenAIEndpoint(upstream.baseUrl, "chat/completions");
  const headers = buildUpstreamHeaders(upstream);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSec * 1000),
      // @ts-ignore — Node 18+ supports this
      duplex: "half",
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError"
      ? `Upstream ${upstream.id} timed out after ${timeoutSec}s`
      : `Upstream ${upstream.id} connection failed: ${String(err)}`;
    return { type: "error", reason };
  }

  // Treat 5xx as retryable errors
  if (response.status >= 500) {
    return { type: "error", reason: `Upstream ${upstream.id} returned HTTP ${response.status}` };
  }

  return { type: "ok", response };
}

async function sendResponse(
  reply: FastifyReply,
  response: Response,
  body: CompletionsBody
): Promise<void> {
  reply.code(response.status);
  reply.header("content-type", response.headers.get("content-type") ?? "application/json");

  for (const h of ["x-request-id", "retry-after", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests"]) {
    const val = response.headers.get(h);
    if (val) reply.header(h, val);
  }

  if (!response.body) {
    reply.send(await response.text());
    return;
  }

  if (body.stream) {
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
    const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream);
    reply.send(nodeStream);
  } else {
    reply.send(await response.json());
  }
}

function buildUpstreamHeaders(upstream: UpstreamConfig): Record<string, string> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (upstream.provider === "anthropic") {
    base["x-api-key"] = upstream.apiKey;
    base["anthropic-version"] = "2023-06-01";
  } else {
    if (upstream.apiKey) {
      base["Authorization"] = `Bearer ${upstream.apiKey}`;
    }
  }
  return base;
}

function levelNumeric(level: string): number {
  return level === "S3" ? 3 : level === "S2" ? 2 : 1;
}
