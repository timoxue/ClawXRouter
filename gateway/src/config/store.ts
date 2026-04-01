import * as fs from "node:fs";
import * as path from "node:path";
import type { GatewayConfig } from "../types.js";

const CONFIG_PATH =
  process.env.CLAWX_GATEWAY_CONFIG ??
  path.join(process.cwd(), "gateway.config.json");

let cachedConfig: GatewayConfig | null = null;

export function loadConfig(): GatewayConfig {
  if (cachedConfig) return cachedConfig;
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Gateway config not found at ${CONFIG_PATH}\n` +
        `Copy gateway.config.example.json to gateway.config.json and fill in your API keys.`
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  cachedConfig = JSON.parse(raw) as GatewayConfig;
  console.log(`[Config] Loaded from ${CONFIG_PATH}`);
  return cachedConfig;
}

export function reloadConfig(): GatewayConfig {
  cachedConfig = null;
  return loadConfig();
}

export function saveConfig(config: GatewayConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  cachedConfig = config;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
