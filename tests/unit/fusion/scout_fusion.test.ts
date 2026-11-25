import { describe, expect, it } from "bun:test";
import { parseDirective } from "../../../src/directive/parser";
import { getCachedFusionEngine } from "../../../src/handlers/openai_compat";

describe("Scout Fast Fallback Fusion Preset (lr-fse-scout)", () => {
  it("Directive parser parses lr-fse-scout as a valid fusion directive", () => {
    const parsed = parseDirective("lr-fse-scout");
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("fusion");
    if (parsed?.type === "fusion") {
      expect(parsed.preset).toBe("scout");
      expect(parsed.raw).toBe("lr-fse-scout");
    }
  });

  it("FusionEngine resolves 'scout' preset with sticky_fallback strategy and 12000ms timeout", () => {
    const engine = getCachedFusionEngine();
    const preset = engine.resolvePreset("scout");
    expect(preset).not.toBeNull();
    expect(preset?.strategy).toBe("sticky_fallback");
    expect(preset?.timeout_ms).toBe(12000);
  });

  it("FusionEngine orders tiers: lfm-3-1.7b -> nemotron-3.5-lightning -> nemotron-3.5-super-vl", () => {
    const engine = getCachedFusionEngine();
    const tiers = engine.resolveModelTiers("scout", "scout");
    expect(tiers).not.toBeNull();
    if (!tiers) throw new Error("Tiers cannot be null");
    expect(tiers.length).toBe(3);

    const [tier1, tier2, tier3] = tiers;
    if (!tier1 || !tier2 || !tier3) throw new Error("Expected 3 tiers");

    // Tier 1: liquid/lfm-3-1.7b:free (Instant TTFT)
    expect(tier1.priority).toBe(1);
    expect(tier1.model).toBe("liquid/lfm-3-1.7b:free");
    expect(tier1.apikey).toBe("lr-or-oa-ch-no");
    expect(tier1.overrides?.temperature).toBe(0.0);

    // Tier 2: nvidia/nemotron-3.5-lightning:free (Peak Throughput)
    expect(tier2.priority).toBe(2);
    expect(tier2.model).toBe("nvidia/nemotron-3.5-lightning:free");
    expect(tier2.apikey).toBe("lr-or-oa-ch-no");
    expect(tier2.overrides?.temperature).toBe(0.0);

    // Tier 3: nvidia/nemotron-3.5-super-vl:free (High-Capacity Anchor)
    expect(tier3.priority).toBe(3);
    expect(tier3.model).toBe("nvidia/nemotron-3.5-super-vl:free");
    expect(tier3.apikey).toBe("lr-or-oa-ch-no");
    expect(tier3.overrides?.temperature).toBe(0.0);
  });

  it("FusionEngine plans tiers in ascending priority sequence", () => {
    const engine = getCachedFusionEngine();
    const plan = engine.createExecutionPlan("scout", "scout");
    expect(plan).not.toBeNull();
    if (!plan) throw new Error("Plan cannot be null");
    expect(plan.orderedTiers.length).toBe(3);

    const [planTier1, planTier2, planTier3] = plan.orderedTiers;
    if (!planTier1 || !planTier2 || !planTier3) throw new Error("Expected 3 planned tiers");

    expect(planTier1.priority).toBe(1);
    expect(planTier2.priority).toBe(2);
    expect(planTier3.priority).toBe(3);
  });
});
