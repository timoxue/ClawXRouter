export type UpstreamProvider = "openai" | "anthropic" | "openai-compatible";

export type UpstreamConfig = {
  id: string;
  provider: UpstreamProvider;
  baseUrl: string;
  apiKey: string;
  /** Model IDs this upstream supports. Use ["*"] to match any model. */
  models: string[];
  weight: number;
  enabled: boolean;
  /**
   * "local"  → used for S3 confidential requests (Ollama, vLLM, etc.)
   * "cloud"  → used for S1/S2 requests (default when omitted)
   */
  role?: "local" | "cloud";
};

export type LoadBalancerStrategy = "round-robin" | "weighted-round-robin" | "least-connections";

export type GatewayConfig = {
  server: {
    port: number;
    host: string;
  };
  auth: {
    enabled: boolean;
    apiKeys: Record<string, { tenantId: string; name: string }>;
  };
  upstreams: UpstreamConfig[];
  loadBalancer: {
    strategy: LoadBalancerStrategy;
    /** Timeout in seconds for each upstream request. Default: 120 */
    timeoutSec?: number;
    healthCheck: {
      enabled: boolean;
      intervalSec: number;
      timeoutSec: number;
    };
  };
  /** PrivacyConfig passed directly to clawxrouter RouterPipeline */
  privacy: Record<string, unknown>;
};

export type TenantContext = {
  tenantId: string;
  name: string;
  apiKey: string;
};

export type UpstreamHealth = {
  id: string;
  healthy: boolean;
  lastCheckAt: number;
  latencyMs?: number;
  errorCount: number;
};

/** OpenAI-compatible chat message */
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

/** OpenAI-compatible completions request body */
export type CompletionsBody = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
};
