/**
 * GuardClaw Router Pipeline
 *
 * General-purpose routing pipeline inspired by EdgeClaw's checkpoint + detector
 * composition model. Multiple routers can be registered and composed at each
 * checkpoint — the pipeline runs them all and merges decisions (highest
 * restriction level wins).
 *
 * Built-in routers:
 *   - "privacy" — wraps the existing S1/S2/S3 detector + desensitization
 *
 * Users can register custom routers (cost optimization, content filtering, etc.)
 * via config or programmatically.
 */

import type {
  Checkpoint,
  DetectionContext,
  GuardClawRouter,
  PipelineConfig,
  RouterDecision,
  RouterRegistration,
  SensitivityLevel,
} from "./types.js";
import { levelToNumeric, maxLevel } from "./types.js";

export class RouterPipeline {
  private routers = new Map<string, GuardClawRouter>();
  private pipelineConfig: PipelineConfig = {};
  private routerConfigs = new Map<string, RouterRegistration>();
  private logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

  constructor(logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }) {
    this.logger = logger ?? {
      info: (m: string) => console.log(m),
      warn: (m: string) => console.warn(m),
      error: (m: string) => console.error(m),
    };
  }

  /**
   * Register a router instance. Overwrites if same id exists.
   */
  register(router: GuardClawRouter, registration?: RouterRegistration): void {
    this.routers.set(router.id, router);
    if (registration) {
      this.routerConfigs.set(router.id, registration);
    }
    this.logger.info(`[RouterPipeline] Registered router: ${router.id}`);
  }

  /**
   * Load a custom router from a module path.
   */
  async loadCustomRouter(id: string, modulePath: string, registration?: RouterRegistration): Promise<void> {
    try {
      const mod = await import(modulePath);
      const router: GuardClawRouter = mod.default ?? mod;
      if (!router.detect || typeof router.detect !== "function") {
        this.logger.error(`[RouterPipeline] Custom router "${id}" from ${modulePath} does not export a valid detect() function`);
        return;
      }
      router.id = id;
      this.register(router, registration);
    } catch (err) {
      this.logger.error(`[RouterPipeline] Failed to load custom router "${id}" from ${modulePath}: ${String(err)}`);
    }
  }

  /**
   * Configure the pipeline from the plugin config.
   */
  configure(config: {
    routers?: Record<string, RouterRegistration>;
    pipeline?: PipelineConfig;
  }): void {
    if (config.routers) {
      for (const [id, reg] of Object.entries(config.routers)) {
        this.routerConfigs.set(id, reg);
      }
    }
    if (config.pipeline) {
      this.pipelineConfig = config.pipeline;
    }
  }

  /**
   * Load all custom routers declared in config.
   */
  async loadCustomRouters(): Promise<void> {
    for (const [id, reg] of this.routerConfigs) {
      if (reg.type === "custom" && reg.module && !this.routers.has(id)) {
        await this.loadCustomRouter(id, reg.module, reg);
      }
    }
  }

  /**
   * Get the ordered list of router IDs for a checkpoint.
   * Falls back to running all enabled routers if pipeline config is not set.
   */
  getRoutersForCheckpoint(checkpoint: Checkpoint): string[] {
    const configured = this.pipelineConfig[checkpoint];
    if (configured && configured.length > 0) {
      return configured;
    }
    // Fallback: all registered routers in registration order
    return [...this.routers.keys()];
  }

  /**
   * Check if a router is enabled via config.
   */
  private isRouterEnabled(id: string): boolean {
    const reg = this.routerConfigs.get(id);
    return reg?.enabled !== false;
  }

  /**
   * Run the pipeline for a given checkpoint.
   * Executes all configured routers, merges decisions (highest level wins).
   */
  async run(
    checkpoint: Checkpoint,
    context: DetectionContext,
    pluginConfig: Record<string, unknown>,
  ): Promise<RouterDecision> {
    const routerIds = this.getRoutersForCheckpoint(checkpoint);

    if (routerIds.length === 0) {
      return { level: "S1", action: "passthrough", reason: "No routers configured" };
    }

    const decisions: RouterDecision[] = [];

    for (const id of routerIds) {
      if (!this.isRouterEnabled(id)) continue;

      const router = this.routers.get(id);
      if (!router) {
        this.logger.warn(`[RouterPipeline] Router "${id}" referenced in pipeline but not registered`);
        continue;
      }

      try {
        const decision = await router.detect(context, pluginConfig);
        decision.routerId = id;
        decisions.push(decision);
      } catch (err) {
        this.logger.error(`[RouterPipeline] Router "${id}" failed at ${checkpoint}: ${String(err)}`);
      }
    }

    return mergeDecisions(decisions);
  }

  /**
   * List all registered router IDs.
   */
  listRouters(): string[] {
    return [...this.routers.keys()];
  }

  /**
   * Check if a router is registered.
   */
  hasRouter(id: string): boolean {
    return this.routers.has(id);
  }
}

/**
 * Merge multiple router decisions into a single decision.
 *
 * Strategy (aligned with EdgeClaw's maxLevel merge):
 *   - Highest sensitivity level wins
 *   - Among decisions at the same level, "block" > "redirect" > "transform" > "passthrough"
 *   - Target and transformed content come from the winning decision
 *   - Reasons from all non-S1 decisions are concatenated
 */
function mergeDecisions(decisions: RouterDecision[]): RouterDecision {
  if (decisions.length === 0) {
    return { level: "S1", action: "passthrough", reason: "No decisions" };
  }

  if (decisions.length === 1) {
    return decisions[0];
  }

  const levels = decisions.map((d) => d.level);
  const winningLevel = maxLevel(...levels);

  const atWinningLevel = decisions.filter((d) => d.level === winningLevel);

  const actionPriority: Record<string, number> = {
    block: 4,
    redirect: 3,
    transform: 2,
    passthrough: 1,
  };
  atWinningLevel.sort(
    (a, b) => (actionPriority[b.action ?? "passthrough"] ?? 0) - (actionPriority[a.action ?? "passthrough"] ?? 0),
  );

  const winner = atWinningLevel[0];

  const allReasons = decisions
    .filter((d) => d.level !== "S1" && d.reason)
    .map((d) => `[${d.routerId ?? "?"}] ${d.reason}`);

  const confidences = decisions.map((d) => d.confidence ?? 0.5);
  const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;

  return {
    level: winningLevel,
    action: winner.action ?? "passthrough",
    target: winner.target,
    transformedContent: winner.transformedContent,
    reason: allReasons.length > 0 ? allReasons.join("; ") : winner.reason,
    confidence: avgConfidence,
    routerId: winner.routerId,
  };
}

/** Singleton pipeline instance (set during plugin init) */
let globalPipeline: RouterPipeline | null = null;

export function setGlobalPipeline(pipeline: RouterPipeline): void {
  globalPipeline = pipeline;
}

export function getGlobalPipeline(): RouterPipeline | null {
  return globalPipeline;
}
