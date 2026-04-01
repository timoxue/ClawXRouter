import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { detectPrivacy } from "../middleware/privacy.js";
import { selectUpstream } from "../load-balancer/strategies.js";
import { getHealthyIds, markUnhealthy } from "../load-balancer/health-check.js";
import { getOrCreateSession, updateSession } from "../session/memory-store.js";
import { redactSensitiveInfo } from "../../../clawxrouter/src/utils.js";
import type { GatewayConfig, CompletionsBody, UpstreamConfig } from "../types.js";

export default async function completionsRoute(
  fastify: FastifyInstance,
  opts: { config: GatewayConfig }
) {
  const { config } = opts;

  fastify.post<{ Body: CompletionsBody }>(
    "/v1/chat/completions",
    { config: { rawBody: false } },
    async (req: FastifyRequest<{ Body: CompletionsBody }>, reply: FastifyReply) => {
      const body = req.body;
      const tenant = req.tenant;
      const sessionKey = `${tenant.tenantId}:${body.model}:${Date.now()}`;

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
        return forwardRequest(reply, localUpstream, body);
      }

      // ── 3. S2: redact PII before forwarding ────────────────────────────
      let forwardBody = body;
      if (level === "S2") {
        forwardBody = redactMessages(body, config.privacy as Record<string, unknown>);
        fastify.log.warn(`[${tenant.tenantId}] S2 — PII redacted before forwarding`);
      }

      // ── 4. Load-balance: select upstream ───────────────────────────────
      const healthyIds = getHealthyIds();
      const upstream = selectUpstream(
        config.upstreams,
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

      // ── 5. Forward ──────────────────────────────────────────────────────
      return forwardRequest(reply, upstream, forwardBody, (err) => {
        fastify.log.error(`[${tenant.tenantId}] Upstream ${upstream.id} error: ${err}`);
        markUnhealthy(upstream.id);
      });
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
  // Prefer upstreams tagged as local or with localhost/127 baseUrl
  return (
    upstreams.find(
      (u) =>
        u.enabled &&
        (u.baseUrl.includes("localhost") ||
          u.baseUrl.includes("127.0.0.1") ||
          u.baseUrl.includes("ollama") ||
          u.provider === "openai-compatible")
    ) ?? null
  );
}

async function forwardRequest(
  reply: FastifyReply,
  upstream: UpstreamConfig,
  body: CompletionsBody,
  onError?: (err: unknown) => void
): Promise<void> {
  const url = `${upstream.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const headers = buildUpstreamHeaders(upstream);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // @ts-ignore — Node 18+ supports this
      duplex: "half",
    });
  } catch (err) {
    onError?.(err);
    reply.code(502).send({
      error: {
        message: `Upstream connection failed: ${String(err)}`,
        type: "gateway_error",
        code: "upstream_connection_failed",
      },
    });
    return;
  }

  if (!response.ok && response.status >= 500) {
    onError?.(new Error(`HTTP ${response.status}`));
  }

  // Forward status and headers
  reply.code(response.status);

  const contentType = response.headers.get("content-type") ?? "application/json";
  reply.header("content-type", contentType);

  // Copy other relevant headers
  for (const header of ["x-request-id", "retry-after", "x-ratelimit-limit-requests"]) {
    const val = response.headers.get(header);
    if (val) reply.header(header, val);
  }

  if (!response.body) {
    const text = await response.text();
    reply.send(text);
    return;
  }

  // Stream: pipe upstream SSE to client
  if (body.stream) {
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
    // Convert Web ReadableStream → Node Readable for Fastify
    const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream);
    reply.send(nodeStream);
  } else {
    const data = await response.json();
    reply.send(data);
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
