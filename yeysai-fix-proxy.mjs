#!/usr/bin/env node
// yeysai-fix-proxy.mjs — Local proxy that fixes yeysai's broken tool_call streaming.
//
// Problem: yeysai splits a single tool_call into two SSE chunks with different IDs:
//   chunk1: {id: "call_X", index: 0, function: {name: "web_search", arguments: ""}}
//   chunk2: {id: "chatcmpl-Y", index: 0, function: {name: null, arguments: "{...}"}}
//
// Fix: merge chunks sharing the same index — keep first id, non-null name, concatenate arguments.
//
// Usage:
//   node yeysai-fix-proxy.mjs [--port 18800] [--target https://yeysai.com]
//
// Then configure OpenClaw provider baseUrl to http://127.0.0.1:18800/v1

import http from "node:http";
import https from "node:https";

const DEFAULT_PORT = 18800;
const DEFAULT_TARGET = "https://yeysai.com";

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const PORT = parseInt(getArg("--port", String(DEFAULT_PORT)), 10);
const TARGET = getArg("--target", DEFAULT_TARGET);
const targetUrl = new URL(TARGET);

// ── Tool-call chunk merger ──────────────────────────────────────────────

function mergeToolCallDeltas(buffered) {
  // buffered: array of {id, index, type, function: {name, arguments}} objects
  // Group by index, merge name/arguments, keep first non-null id
  const byIndex = new Map();
  for (const tc of buffered) {
    const idx = tc.index ?? 0;
    if (!byIndex.has(idx)) {
      byIndex.set(idx, {
        id: tc.id,
        type: tc.type ?? "function",
        index: idx,
        function: {
          name: tc.function?.name ?? null,
          arguments: tc.function?.arguments ?? "",
        },
      });
    } else {
      const existing = byIndex.get(idx);
      if (!existing.id && tc.id) existing.id = tc.id;
      if (!existing.function.name && tc.function?.name) {
        existing.function.name = tc.function.name;
      }
      if (tc.function?.arguments) {
        existing.function.arguments += tc.function.arguments;
      }
    }
  }
  return [...byIndex.values()];
}

function buildSseData(originalChunk, mergedToolCalls) {
  const clone = JSON.parse(JSON.stringify(originalChunk));
  if (clone.choices?.[0]?.delta) {
    clone.choices[0].delta.tool_calls = mergedToolCalls;
  }
  return `data: ${JSON.stringify(clone)}\n\n`;
}

// ── SSE stream transformer ──────────────────────────────────────────────

function createStreamFixer(res) {
  let bufferedToolCalls = [];
  let lastToolCallChunk = null;
  let leftover = "";

  function flushToolCalls() {
    if (bufferedToolCalls.length === 0) return "";
    const merged = mergeToolCallDeltas(bufferedToolCalls);
    const output = buildSseData(lastToolCallChunk, merged);
    bufferedToolCalls = [];
    lastToolCallChunk = null;
    return output;
  }

  return {
    write(rawChunk) {
      const text = leftover + rawChunk.toString("utf-8");
      leftover = "";
      const lines = text.split("\n");

      // If text doesn't end with \n, last segment is incomplete
      if (!text.endsWith("\n")) {
        leftover = lines.pop() ?? "";
      }

      let output = "";
      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === "data: [DONE]") {
          output += flushToolCalls();
          output += trimmed + "\n\n";
          continue;
        }

        if (!trimmed.startsWith("data: ")) {
          // Pass through empty lines, comments, etc.
          if (trimmed.length > 0) output += trimmed + "\n";
          else output += "\n";
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(trimmed.slice(6));
        } catch {
          output += trimmed + "\n";
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        const finishReason = parsed.choices?.[0]?.finish_reason;

        // If this chunk has tool_calls, buffer it
        if (delta?.tool_calls && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          for (const tc of delta.tool_calls) {
            bufferedToolCalls.push(tc);
          }
          lastToolCallChunk = parsed;

          // Strip tool_calls from delta, pass through any other content in same chunk
          const otherKeys = Object.keys(delta).filter((k) => k !== "tool_calls");
          if (otherKeys.length > 0 || delta.role) {
            const passThrough = JSON.parse(JSON.stringify(parsed));
            delete passThrough.choices[0].delta.tool_calls;
            output += `data: ${JSON.stringify(passThrough)}\n\n`;
          }
          continue;
        }

        // Non-tool-call chunk — flush any pending tool calls first
        if (finishReason || bufferedToolCalls.length > 0) {
          output += flushToolCalls();
        }

        output += `data: ${JSON.stringify(parsed)}\n\n`;
      }

      if (output) res.write(output);
    },

    end() {
      // Flush any remaining
      const remaining = flushToolCalls();
      if (leftover.trim()) {
        remaining && res.write(remaining);
        res.write(leftover);
      } else if (remaining) {
        res.write(remaining);
      }
      res.end();
    },
  };
}

// ── Non-streaming response fixer ────────────────────────────────────────

function fixNonStreamingResponse(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  for (const choice of parsed.choices ?? []) {
    const tcs = choice.message?.tool_calls;
    if (!Array.isArray(tcs) || tcs.length <= 1) continue;

    // Merge tool_calls sharing the same index
    const merged = mergeToolCallDeltas(tcs);
    choice.message.tool_calls = merged;
  }

  return JSON.stringify(parsed);
}

// ── HTTP proxy server ───────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const isStream =
    req.method === "POST" && (req.url?.includes("/chat/completions") || req.url?.includes("/v1/"));

  // Collect request body
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    let wantsStream = false;
    if (isStream) {
      try {
        const payload = JSON.parse(body.toString("utf-8"));
        wantsStream = payload.stream === true;
      } catch {
        // not JSON, pass through
      }
    }

    // Build upstream request
    const upstreamPath = req.url?.startsWith("/v1") ? req.url : `/v1${req.url}`;
    const upstreamOpts = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path: upstreamPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.host,
      },
    };
    // Remove transfer-encoding from forwarded headers to avoid conflicts
    delete upstreamOpts.headers["transfer-encoding"];
    // Set correct content-length
    if (body.length > 0) {
      upstreamOpts.headers["content-length"] = body.length;
    }

    const transport = targetUrl.protocol === "https:" ? https : http;
    const proxyReq = transport.request(upstreamOpts, (proxyRes) => {
      const contentType = proxyRes.headers["content-type"] || "";
      const isSSE = contentType.includes("text/event-stream") || wantsStream;

      if (isSSE) {
        // Streaming — fix tool_call chunks on the fly
        const fwdHeaders = { ...proxyRes.headers };
        delete fwdHeaders["content-length"]; // length will change
        delete fwdHeaders["content-encoding"]; // we handle raw text
        res.writeHead(proxyRes.statusCode ?? 200, fwdHeaders);

        const fixer = createStreamFixer(res);
        proxyRes.on("data", (chunk) => fixer.write(chunk));
        proxyRes.on("end", () => fixer.end());
      } else {
        // Non-streaming — buffer, fix, forward
        const responseChunks = [];
        proxyRes.on("data", (c) => responseChunks.push(c));
        proxyRes.on("end", () => {
          let responseBody = Buffer.concat(responseChunks).toString("utf-8");
          if (
            proxyRes.statusCode === 200 &&
            contentType.includes("application/json")
          ) {
            responseBody = fixNonStreamingResponse(responseBody);
          }
          const fwdHeaders = { ...proxyRes.headers };
          fwdHeaders["content-length"] = Buffer.byteLength(responseBody);
          delete fwdHeaders["transfer-encoding"];
          res.writeHead(proxyRes.statusCode ?? 200, fwdHeaders);
          res.end(responseBody);
        });
      }
    });

    proxyReq.on("error", (err) => {
      console.error(`[proxy] upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: `Proxy upstream error: ${err.message}` } }));
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[yeysai-fix-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[yeysai-fix-proxy] forwarding to ${TARGET}`);
  console.log(`[yeysai-fix-proxy] configure OpenClaw baseUrl → http://127.0.0.1:${PORT}/v1`);
});
