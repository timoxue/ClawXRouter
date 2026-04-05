import http from "node:http";

const id = process.env.UPSTREAM_ID ?? "mock";
const port = Number(process.env.PORT ?? 19091);
const delayMs = Number(process.env.DELAY_MS ?? 0);
const bindHost = process.env.BIND_HOST ?? "0.0.0.0";

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/v1/models") {
    return sendJson(res, 200, {
      object: "list",
      data: [{ id: "gw-default", object: "model", owned_by: id }],
    });
  }

  if (req.method === "POST" && url === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        return sendJson(res, 400, { error: { message: "invalid json" } });
      }

      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const last = messages.length ? messages[messages.length - 1] : { content: "" };
      const content = typeof last.content === "string" ? last.content : "";

      const run = () => sendJson(res, 200, {
        id: `chatcmpl-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        object: "chat.completion",
        model: parsed.model ?? "unknown",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({ upstream: id, model: parsed.model ?? "unknown", echo: content }),
            },
            finish_reason: "stop",
          },
        ],
      });

      if (delayMs > 0) setTimeout(run, delayMs);
      else run();
    });
    return;
  }

  sendJson(res, 404, { error: { message: "not found", upstream: id } });
});

server.listen(port, bindHost, () => {
  console.log(`[mock:${id}] listening on ${bindHost}:${port} delay=${delayMs}ms`);
});
