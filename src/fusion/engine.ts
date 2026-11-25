import type { FusionConfig, FusionPreset, FusionTier } from "../config/schema";
import { StickyPositionCache } from "./sticky";

export interface FusionExecutionPlan {
  readonly preset: string;
  readonly model: string;
  readonly orderedTiers: readonly FusionTier[];
  readonly isStickyActive: boolean;
  readonly timeoutMs?: number;
}

export class FusionEngine {
  private readonly config: FusionConfig;
  private readonly stickyCache: StickyPositionCache;

  public constructor(config: FusionConfig, stickyCache?: StickyPositionCache) {
    this.config = config;
    this.stickyCache = stickyCache ?? new StickyPositionCache();
  }

  public getStickyCache(): StickyPositionCache {
    return this.stickyCache;
  }

  public resolvePreset(presetName: string): FusionPreset | null {
    const preset = this.config.presets[presetName];
    return preset ?? null;
  }

  public resolveModelTiers(
    presetName: string,
    requestedModel: string
  ): readonly FusionTier[] | null {
    const preset = this.resolvePreset(presetName);
    if (!preset) {
      return null;
    }
    const modelConfig = preset.models[requestedModel];
    if (!modelConfig || modelConfig.tiers.length === 0) {
      return null;
    }
    return Object.freeze([...modelConfig.tiers].sort((a, b) => a.priority - b.priority));
  }

  private sortTiersWithSticky(
    tiers: readonly FusionTier[],
    stickyPriority: number
  ): readonly FusionTier[] {
    const stickyTier = tiers.find((t) => t.priority === stickyPriority);
    if (!stickyTier) {
      return tiers;
    }
    const otherTiers = tiers.filter((t) => t.priority !== stickyPriority);
    return Object.freeze([stickyTier, ...otherTiers]);
  }

  public createExecutionPlan(
    presetName: string,
    modelName: string,
    now: number = Date.now()
  ): FusionExecutionPlan | null {
    const allTiers = this.resolveModelTiers(presetName, modelName);
    if (!allTiers || allTiers.length === 0) {
      return null;
    }
    const preset = this.resolvePreset(presetName);
    const sticky = this.stickyCache.getStickyTier(presetName, modelName, now);
    if (sticky) {
      const ordered = this.sortTiersWithSticky(allTiers, sticky.tierPriority);
      return { preset: presetName, model: modelName, orderedTiers: ordered, isStickyActive: true, timeoutMs: preset?.timeout_ms };
    }
    return { preset: presetName, model: modelName, orderedTiers: allTiers, isStickyActive: false, timeoutMs: preset?.timeout_ms };
  }

  public handleTierSuccess(
    presetName: string,
    modelName: string,
    successfulTier: FusionTier,
    now: number = Date.now()
  ): void {
    if (successfulTier.priority === 1) {
      this.stickyCache.clearStickyTier(presetName, modelName);
    } else {
      const existing = this.stickyCache.getStickyTier(presetName, modelName, now);
      if (!existing) {
        this.stickyCache.setStickyTier(presetName, modelName, successfulTier, undefined, now);
      }
    }
  }

  public handleTierFailure(
    presetName: string,
    modelName: string,
    failedTier: FusionTier
  ): void {
    const currentSticky = this.stickyCache.getStickyTier(presetName, modelName);
    if (currentSticky && currentSticky.tierPriority === failedTier.priority) {
      this.stickyCache.clearStickyTier(presetName, modelName);
    }
  }
}
