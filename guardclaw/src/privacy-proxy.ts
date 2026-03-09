/**
 * GuardClaw Privacy Proxy
 *
 * Lightweight HTTP proxy that intercepts S2 requests and strips PII markers
 * before forwarding to the original cloud provider. Inspired by ClawRouter's
 * proxy architecture but focused solely on privacy filtering.
 *
 * Flow:
 *   openclaw agent → guardclaw-privacy provider → localhost:PROXY_PORT
 *     → strip <guardclaw-s2> markers → forward clean request to original provider
 *     → passthrough response (including SSE)
 */

import * as http from "node:http";

// ── Marker protocol ──

export const GUARDCLAW_S2_OPEN = "<guardclaw-s2>";
export const GUARDCLAW_S2_CLOSE = "</guardclaw-s2>";

// ── Original provider target (stashed by hooks) ──

export type OriginalProviderTarget = {
  baseUrl: string;
  apiKey: string;
  provider: string;
};

const originalProviderTargets = new Map<string, OriginalProviderTarget>();

export function stashOriginalProvider(key: string, target: OriginalProviderTarget): void {
  originalProviderTargets.set(key, target);
}

export function consumeOriginalProvider(key: string): OriginalProviderTarget | undefined {
  const t = originalProviderTargets.get(key);
  originalProviderTargets.delete(key);
  return t;
}

/**
 * Fallback: read from a global default set during plugin registration.
 * Used when no per-session target is stashed (e.g., the session key
 * wasn't passed through).
 */
let defaultProviderTarget: OriginalProviderTarget | null = null;

export function setDefaultProviderTarget(target: OriginalProviderTarget): void {
  defaultProviderTarget = target;
}

// ── Proxy handle ──

export type ProxyHandle = {
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
};

// ── Request body reader ──

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── PII marker stripping ──

export function stripPiiMarkers(
  messages: Array<{ role: string; content: unknown }>,
): boolean {
  let stripped = false;

  for (const msg of messages) {
    if (msg.role !== "user" || typeof msg.content !== "string") continue;

    const openIdx = msg.content.indexOf(GUARDCLAW_S2_OPEN);
    const closeIdx = msg.content.indexOf(GUARDCLAW_S2_CLOSE);
    if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) continue;

    msg.content = msg.content
      .slice(openIdx + GUARDCLAW_S2_OPEN.length, closeIdx)
      .trim();
    stripped = true;
  }

  return stripped;
}

// ── Resolve original provider target ──

function resolveTarget(
  sessionHeader: string | undefined,
): OriginalProviderTarget | null {
  if (sessionHeader) {
    const t = consumeOriginalProvider(sessionHeader);
    if (t) return t;
  }
  return defaultProviderTarget;
}

// ── Proxy server ──

export async function startPrivacyProxy(
  port: number,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): Promise<ProxyHandle> {
  const log = logger ?? {
    info: (m: string) => console.log(m),
    warn: (m: string) => console.warn(m),
    error: (m: string) => console.error(m),
  };

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    try {
      const body = await readRequestBody(req);
      const parsed = JSON.parse(body);

      // Step 1: Strip PII markers from user messages
      const hadMarkers = stripPiiMarkers(parsed.messages ?? []);
      if (hadMarkers) {
        log.info("[GuardClaw Proxy] Stripped S2 PII markers from request");
      }

      // Step 2: Resolve the original provider to forward to
      const sessionKey = req.headers["x-guardclaw-session"] as string | undefined;
      const target = resolveTarget(sessionKey);

      if (!target) {
        log.error("[GuardClaw Proxy] No original provider target found");
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            message: "GuardClaw privacy proxy: no original provider target configured",
            type: "proxy_error",
          },
        }));
        return;
      }

      // Step 3: Build upstream URL — normalize baseUrl trailing slashes
      const baseUrl = target.baseUrl.replace(/\/+$/, "");
      const upstreamUrl = `${baseUrl}/chat/completions`;

      // Step 4: Forward cleaned request
      const upstreamHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (target.apiKey) {
        upstreamHeaders["Authorization"] = `Bearer ${target.apiKey}`;
      }

      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(parsed),
      });

      // Step 5: Passthrough response headers
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      const responseHeaders: Record<string, string> = {
        "Content-Type": contentType,
      };

      if (parsed.stream) {
        responseHeaders["Cache-Control"] = "no-cache";
        responseHeaders["Connection"] = "keep-alive";
      }

      res.writeHead(upstream.status, responseHeaders);

      // Step 6: Stream or buffer response body
      if (parsed.stream && upstream.body) {
        const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.writableEnded) {
              res.write(Buffer.from(value));
            }
          }
        } catch {
          // Upstream closed unexpectedly
        } finally {
          if (!res.writableEnded) res.end();
        }
      } else {
        const responseBody = await upstream.text();
        res.end(responseBody);
      }
    } catch (err) {
      log.error(`[GuardClaw Proxy] Request failed: ${String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({
          error: {
            message: `GuardClaw proxy error: ${String(err)}`,
            type: "proxy_error",
          },
        }));
      }
    }
  });

  // Handle server-level errors
  server.on("error", (err) => {
    log.error(`[GuardClaw Proxy] Server error: ${String(err)}`);
  });

  return new Promise<ProxyHandle>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            // Force-close lingering connections after a short grace period
            setTimeout(() => r(), 2000);
          }),
      });
    });
    server.on("error", reject);
  });
}
