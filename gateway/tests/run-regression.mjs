import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.GW_BASE_URL ?? "http://127.0.0.1:18070";
const configPath = process.env.GW_TEST_CONFIG_PATH ?? path.resolve("gateway/tests/gateway.config.docker.test.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readConfig() {
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

async function writeConfig(config) {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

async function waitForGatewayHealthy(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const data = await res.json();
        const healthy = (data.upstreams ?? []).filter((u) => u.healthy).length;
        if (data.status === "ok" && healthy >= 2) return data;
      }
    } catch {
      // retry
    }
    await sleep(500);
  }
  throw new Error("Gateway did not become healthy in time");
}

async function adminLogin(username, password) {
  const form = new URLSearchParams({ username, password, next: "/admin/dashboard" });
  const res = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });

  assert(res.status === 302, `Admin login failed with status ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  assert(setCookie, "Admin login did not return session cookie");
  return setCookie.split(";")[0];
}

async function reloadConfig(cookie) {
  const res = await fetch(`${baseUrl}/admin/config/reload`, {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
  assert(res.status === 200, `Config reload failed with status ${res.status}`);
  const body = await res.json();
  assert(body?.ok === true, "Config reload response was not ok=true");
}

async function setStrategy(strategy, cookie) {
  const config = await readConfig();
  config.loadBalancer.strategy = strategy;
  await writeConfig(config);
  await reloadConfig(cookie);
}

async function registerContainer(username, token) {
  const res = await fetch(`${baseUrl}/gateway/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-registration-token": token,
    },
    body: JSON.stringify({ username, type: "openclaw", version: "1.0" }),
  });
  assert(res.status === 200, `Container register failed with status ${res.status}`);
  const body = await res.json();
  assert(typeof body.apiKey === "string" && body.apiKey.length > 0, "Container register returned invalid apiKey");
  return body.apiKey;
}

async function expectRegistrationRejectedWithoutToken() {
  const res = await fetch(`${baseUrl}/gateway/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "unauthorized", type: "openclaw", version: "1.0" }),
  });
  assert(res.status === 401, `Expected 401 for missing registration token, got ${res.status}`);
}

async function chatOnce(apiKey, content) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: "gw-default", messages: [{ role: "user", content }] }),
  });

  const body = await res.json();
  assert(res.status === 200, `Completions failed with status ${res.status}: ${JSON.stringify(body)}`);
  const message = body?.choices?.[0]?.message?.content;
  assert(typeof message === "string", "Missing choices[0].message.content in completion response");
  const parsed = JSON.parse(message);
  assert(typeof parsed.upstream === "string", "Mock upstream response missing upstream field");
  return parsed;
}

function summarize(counts) {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

async function distributionTest(apiKey, n, content, parallel = false) {
  const values = parallel
    ? await Promise.all(Array.from({ length: n }, () => chatOnce(apiKey, content)))
    : await (async () => {
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(await chatOnce(apiKey, content));
        return arr;
      })();

  const counts = {};
  for (const item of values) counts[item.upstream] = (counts[item.upstream] ?? 0) + 1;
  return counts;
}

async function main() {
  const config = await readConfig();
  const token = config.registration?.token;
  const adminUser = config.adminAuth?.username;
  const adminPassword = config.adminAuth?.password;

  assert(typeof token === "string" && token.length > 0, "Test config registration.token is required");
  assert(typeof adminUser === "string" && typeof adminPassword === "string", "Test config admin credentials are required");

  await waitForGatewayHealthy();
  await expectRegistrationRejectedWithoutToken();

  const cookie = await adminLogin(adminUser, adminPassword);
  const apiKey = await registerContainer(`ci-${Date.now()}`, token);

  await setStrategy("round-robin", cookie);
  const rr = await distributionTest(apiKey, 24, "round-robin-check", false);
  assert(!rr["local-c"], `Round-robin should not hit local upstream: ${summarize(rr)}`);
  assert((rr["cloud-a"] ?? 0) > 0 && (rr["cloud-b"] ?? 0) > 0, `Round-robin missed cloud upstream(s): ${summarize(rr)}`);
  assert(Math.abs((rr["cloud-a"] ?? 0) - (rr["cloud-b"] ?? 0)) <= 2, `Round-robin imbalance too high: ${summarize(rr)}`);

  await setStrategy("weighted-round-robin", cookie);
  const wrr = await distributionTest(apiKey, 40, "weighted-rr-check", false);
  assert(!wrr["local-c"], `Weighted RR should not hit local upstream: ${summarize(wrr)}`);
  const a = wrr["cloud-a"] ?? 0;
  const b = wrr["cloud-b"] ?? 0;
  assert(a > 0 && b > 0, `Weighted RR missed cloud upstream(s): ${summarize(wrr)}`);
  assert(b > a, `Weighted RR did not prefer higher-weight upstream: ${summarize(wrr)}`);

  await setStrategy("least-connections", cookie);
  const lc = await distributionTest(apiKey, 60, "least-connections-check", true);
  assert(!lc["local-c"], `Least-connections should not hit local upstream: ${summarize(lc)}`);
  const lca = lc["cloud-a"] ?? 0;
  const lcb = lc["cloud-b"] ?? 0;
  assert(lca > 0 && lcb > 0, `Least-connections missed cloud upstream(s): ${summarize(lc)}`);
  assert(lca >= lcb - 2, `Least-connections should not over-prefer slower upstream: ${summarize(lc)}`);

  await setStrategy("round-robin", cookie);
  const s2 = await chatOnce(apiKey, "my password is 123 and token-abcdefghijklmnop");
  assert(s2.upstream !== "local-c", `S2 should route to cloud upstream, got ${s2.upstream}`);
  assert(typeof s2.echo === "string" && s2.echo.includes("[REDACTED:"), `S2 response does not show redaction: ${JSON.stringify(s2)}`);
  assert(!s2.echo.includes("password is 123"), `S2 redaction leak for password: ${JSON.stringify(s2)}`);
  assert(!s2.echo.includes("token-abcdefghijklmnop"), `S2 redaction leak for token: ${JSON.stringify(s2)}`);

  const s3 = await chatOnce(apiKey, "contains private_key and should stay local");
  assert(s3.upstream === "local-c", `S3 should route to local upstream, got ${s3.upstream}`);

  console.log(`round_robin=${summarize(rr)}`);
  console.log(`weighted_round_robin=${summarize(wrr)}`);
  console.log(`least_connections=${summarize(lc)}`);
  console.log(`s2_upstream=${s2.upstream} s2_echo=${s2.echo}`);
  console.log(`s3_upstream=${s3.upstream}`);
  console.log("gateway regression suite passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
