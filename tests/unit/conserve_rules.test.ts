import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import rawProviders from "../../config/providers.json";
import { resetEnvCache } from "../../src/config/env";
import { initProviderRegistry } from "../../src/config/providers";
import {
  calculateMidnightUtcSec,
  resolveConserveTtlSec,
  type ConserveRule,
} from "../../src/network/cooldown";
import {
  classifyUpstreamError,
  type UpstreamErrorInfo,
} from "../../src/network/classifier";
import { KeyPool, isProviderQuarantineEnabled } from "../../src/network/pool";
import { getProviderEndpointConfig } from "../../src/handlers/openai_compat";
import { getProviderConfig } from "../../src/config/providers";

describe("Conserve Rules — Comprehensive Unit Test Suite", () => {
  let originalOrQuarantine: string | undefined;
  let originalTtl: string | undefined;

  beforeEach(() => {
    originalOrQuarantine = process.env.OPENROUTER_ENABLE_QUARANTINE;
    originalTtl = process.env.COOLDOWN_RATE_LIMIT_TTL_SEC;
    process.env.OPENROUTER_ENABLE_QUARANTINE = "true";
    process.env.COOLDOWN_RATE_LIMIT_TTL_SEC = "65";
    resetEnvCache();
  });

  afterEach(() => {
    if (originalOrQuarantine === undefined) {
      delete process.env.OPENROUTER_ENABLE_QUARANTINE;
    } else {
      process.env.OPENROUTER_ENABLE_QUARANTINE = originalOrQuarantine;
    }
    if (originalTtl === undefined) {
      delete process.env.COOLDOWN_RATE_LIMIT_TTL_SEC;
    } else {
      process.env.COOLDOWN_RATE_LIMIT_TTL_SEC = originalTtl;
    }
    resetEnvCache();
  });

  describe("1. calculateMidnightUtcSec and resolveConserveTtlSec Calculations", () => {
    it("calculates midnight UTC seconds with 60s buffer at 23:59:00 UTC", () => {
      // Exactly 60s before next UTC midnight
      const nowMs = Date.UTC(2026, 8, 11, 23, 59, 0, 0);
      const ttlSec = calculateMidnightUtcSec(nowMs);
      expect(ttlSec).toBe(120); // 60s remaining + 60s buffer
    });

    it("calculates midnight UTC seconds with 60s buffer at 12:00:00 UTC (noon)", () => {
      // 12 hours before midnight = 43,200s + 60s buffer = 43,260s
      const nowMs = Date.UTC(2026, 8, 11, 12, 0, 0, 0);
      const ttlSec = calculateMidnightUtcSec(nowMs);
      expect(ttlSec).toBe(43260);
    });

    it("calculates midnight UTC seconds from exact midnight 00:00:00 UTC to next day midnight", () => {
      // 24 hours before next midnight = 86,400s + 60s buffer = 86,460s
      const nowMs = Date.UTC(2026, 8, 11, 0, 0, 0, 0);
      const ttlSec = calculateMidnightUtcSec(nowMs);
      expect(ttlSec).toBe(86460);
    });

    it("guarantees a minimum 60s duration even if calculation yields small difference", () => {
      // 1 millisecond before midnight
      const nowMs = Date.UTC(2026, 8, 11, 23, 59, 59, 999);
      const ttlSec = calculateMidnightUtcSec(nowMs);
      expect(ttlSec).toBeGreaterThanOrEqual(60);
    });

    it("resolves conserve TTL when specified as 'midnight_utc'", () => {
      const nowMs = Date.UTC(2026, 8, 11, 23, 59, 0, 0);
      const resolved = resolveConserveTtlSec("midnight_utc", nowMs);
      expect(resolved).toBe(120);
    });

    it("resolves conserve TTL when specified as explicit positive number", () => {
      expect(resolveConserveTtlSec(3600)).toBe(3600);
      expect(resolveConserveTtlSec(1800)).toBe(1800);
      expect(resolveConserveTtlSec(60)).toBe(60);
    });

    it("resolves conserve TTL falling back to midnight UTC when undefined, zero, or negative", () => {
      const nowMs = Date.UTC(2026, 8, 11, 23, 59, 0, 0);
      expect(resolveConserveTtlSec(undefined, nowMs)).toBe(120);
      expect(resolveConserveTtlSec(0, nowMs)).toBe(120);
      expect(resolveConserveTtlSec(-500, nowMs)).toBe(120);
    });
  });

  describe("2. classifyUpstreamError Matching Conserve Rules", () => {
    const openrouterRules = getProviderEndpointConfig("or")?.conserve_rules;

    it("matches openrouter conserve_rules on HTTP 429 with free-models-per-day-high-balance body", () => {
      const errorInfo: UpstreamErrorInfo = {
        provider: "or",
        status: 429,
        headers: new Headers({ "content-type": "application/json" }),
        bodyText: JSON.stringify({
          error: {
            message: "Rate limit exceeded: free-models-per-day-high-balance.",
            code: 429,
          },
        }),
        conserveRules: openrouterRules,
      };

      const result = classifyUpstreamError(errorInfo);

      expect(result.isConserve).toBe(true);
      expect(result.action).toBe("retry_rotate");
      expect(result.isRetryable).toBe(true);
      expect(result.quarantineTtlSec).toBeGreaterThan(0);
      expect(result.reason).toBe("openrouter_daily_free_quota_exhausted");
    });

    it("matches custom conserve rules with exact substring and custom TTL", () => {
      const customRules: readonly ConserveRule[] = [
        {
          status: 429,
          contains: "free-models-per-day-high-balance.",
          ttl: 7200,
          reason: "custom_daily_quota_exhausted",
        },
      ];

      const errorInfo: UpstreamErrorInfo = {
        provider: "or",
        status: 429,
        headers: {},
        bodyText: "Rate limit exceeded: free-models-per-day-high-balance.",
        conserveRules: customRules,
      };

      const result = classifyUpstreamError(errorInfo);

      expect(result.isConserve).toBe(true);
      expect(result.action).toBe("retry_rotate");
      expect(result.isRetryable).toBe(true);
      expect(result.quarantineTtlSec).toBe(7200);
      expect(result.reason).toBe("custom_daily_quota_exhausted");
    });

    it("matches conserve rules case-insensitively", () => {
      const errorInfo: UpstreamErrorInfo = {
        provider: "or",
        status: 429,
        headers: {},
        bodyText: "RATE LIMIT EXCEEDED: FREE-MODELS-PER-DAY-HIGH-BALANCE.",
        conserveRules: openrouterRules,
      };

      const result = classifyUpstreamError(errorInfo);

      expect(result.isConserve).toBe(true);
      expect(result.action).toBe("retry_rotate");
      expect(result.quarantineTtlSec).toBeGreaterThan(0);
    });

    it("does not match conserve rules if HTTP status differs even if body contains trigger phrase", () => {
      const errorInfo: UpstreamErrorInfo = {
        provider: "or",
        status: 500,
        headers: {},
        bodyText: "Internal Error: free-models-per-day-high-balance.",
        conserveRules: openrouterRules,
      };

      const result = classifyUpstreamError(errorInfo);

      expect(result.isConserve).toBeUndefined();
      expect(result.reason).toBe("Transient upstream server error (500)");
      expect(result.quarantineTtlSec).toBe(10);
    });

    it("does not match conserve rules if 429 body text does not contain trigger substring", () => {
      const errorInfo: UpstreamErrorInfo = {
        provider: "or",
        status: 429,
        headers: new Headers({ "retry-after": "30" }),
        bodyText: JSON.stringify({ error: "Standard requests per minute rate limit exceeded" }),
        conserveRules: openrouterRules,
      };

      const result = classifyUpstreamError(errorInfo);

      expect(result.isConserve).toBeUndefined();
      expect(result.action).toBe("retry_rotate");
      expect(result.reason).toBe("Rate limit reached (429)");
      expect(result.quarantineTtlSec).toBe(30);
    });
  });

  describe("3. KeyPool.conserveKey with Quarantine Disabled", () => {
    let pool: KeyPool;

    beforeEach(() => {
      const customProviders = JSON.parse(JSON.stringify(rawProviders));
      customProviders.providers.openrouter.key_cooldown = {
        enabled: false,
        initial_cooldown_ms: 60000,
        max_cooldown_ms: 300000,
      };
      initProviderRegistry(customProviders);
      pool = new KeyPool();
      pool.setPool("or", ["sk-or-key-0", "sk-or-key-1"]);
    });

    afterEach(() => {
      pool.reset();
      initProviderRegistry();
    });

    it("verifies isQuarantineEnabled('or') is false when key_cooldown is disabled", () => {
      expect(pool.isQuarantineEnabled("or")).toBe(false);
    });

    it("marks key quarantined in CooldownManager via conserveKey even when isQuarantineEnabled is false", () => {
      const now = Date.now();
      const state = pool.conserveKey(
        "or",
        0,
        3600,
        "openrouter_daily_free_quota_exhausted",
        429,
        now
      );

      expect(state.quarantinedUntil).toBe(now + 3600 * 1000);
      expect(state.reason).toBe("openrouter_daily_free_quota_exhausted");
      expect(state.lastErrorStatus).toBe(429);

      const cooldown = pool.getCooldownManager();
      expect(cooldown.isQuarantined("or:0", now)).toBe(true);
      expect(cooldown.getRemainingMs("or:0", now)).toBe(3600 * 1000);
    });

    it("demonstrates quarantineKey and reportFailure bypass quarantine when isQuarantineEnabled is false", () => {
      const now = Date.now();

      // Normal quarantineKey is bypassed
      const qState = pool.quarantineKey("or", 1, 3600, "rate_limit", 429, now);
      expect(qState.quarantinedUntil).toBe(0);
      expect(qState.reason).toBe("rate_limit");
      expect(pool.getCooldownManager().isQuarantined("or:1", now)).toBe(false);

      // Normal reportFailure is bypassed
      const fState = pool.reportFailure("or", 1, 429, undefined, undefined, now);
      expect(fState.quarantinedUntil).toBe(0);
      expect(fState.reason).toBe("quarantine_disabled");
      expect(pool.getCooldownManager().isQuarantined("or:1", now)).toBe(false);
    });
  });

  describe("4. Integration: Simulated Key Rotation with Conserve Rule Parking", () => {
    let pool: KeyPool;

    beforeEach(() => {
      process.env.OPENROUTER_ENABLE_QUARANTINE = "true";
      resetEnvCache();
      pool = new KeyPool();
      pool.setPool("or", ["sk-or-key-0", "sk-or-key-1"]);
    });

    afterEach(() => {
      pool.reset();
    });

    it("parks Key #0 upon matching conserve rule and advances selection to Key #1", () => {
      const openrouterRules = getProviderEndpointConfig("or")?.conserve_rules;

      // 1. Initial selection picks Key #0
      const firstPick = pool.selectNextKey("or");
      expect(firstPick).not.toBeNull();
      expect(firstPick?.index).toBe(0);
      expect(firstPick?.key).toBe("sk-or-key-0");

      // 2. Simulated request with Key #0 returns conserve error
      const upstreamResponse = {
        status: 429,
        bodyText: "Rate limit exceeded: free-models-per-day-high-balance.",
      };

      const classification = classifyUpstreamError({
        provider: "or",
        status: upstreamResponse.status,
        bodyText: upstreamResponse.bodyText,
        conserveRules: openrouterRules,
      });

      expect(classification.isConserve).toBe(true);
      expect(classification.action).toBe("retry_rotate");
      expect(classification.quarantineTtlSec).toBeGreaterThan(0);

      // 3. Park Key #0 via conserveKey
      pool.conserveKey(
        "or",
        firstPick?.index ?? 0,
        classification.quarantineTtlSec,
        classification.reason,
        upstreamResponse.status
      );

      // Verify Key #0 is quarantined
      expect(pool.getCooldownManager().isQuarantined("or:0")).toBe(true);

      // 4. Next key selection must advance to Key #1
      const secondPick = pool.selectNextKey("or");
      expect(secondPick).not.toBeNull();
      expect(secondPick?.index).toBe(1);
      expect(secondPick?.key).toBe("sk-or-key-1");

      // 5. Subsequent selection cycles back, skips quarantined Key #0, and returns Key #1 again
      const thirdPick = pool.selectNextKey("or");
      expect(thirdPick).not.toBeNull();
      expect(thirdPick?.index).toBe(1);
      expect(thirdPick?.key).toBe("sk-or-key-1");

      // Key #0 remains quarantined throughout
      expect(pool.getCooldownManager().isQuarantined("or:0")).toBe(true);
    });
  });

  describe("5. Generic 429 with providers.openrouter.key_cooldown.enabled=false", () => {
    let pool: KeyPool;

    beforeEach(() => {
      const customProviders = JSON.parse(JSON.stringify(rawProviders));
      customProviders.providers.openrouter.key_cooldown = {
        enabled: false,
        initial_cooldown_ms: 60000,
        max_cooldown_ms: 300000,
      };
      initProviderRegistry(customProviders);
      pool = new KeyPool();
      pool.setPool("or", ["sk-or-key-0", "sk-or-key-1"]);
    });

    afterEach(() => {
      pool.reset();
      initProviderRegistry();
    });

    it("does NOT quarantine key on generic 429 when quarantine is disabled", () => {
      const openrouterRules = getProviderEndpointConfig("or")?.conserve_rules;
      const genericBody = JSON.stringify({
        error: {
          message: "Rate limit reached. Please retry in 20 seconds.",
        },
      });

      // 1. Classify generic 429 error
      const classification = classifyUpstreamError({
        provider: "or",
        status: 429,
        headers: new Headers({ "retry-after": "20" }),
        bodyText: genericBody,
        conserveRules: openrouterRules,
      });

      expect(classification.isConserve).toBeUndefined();
      expect(classification.action).toBe("retry_rotate");
      // quarantineTtlSec is 0 because isProviderQuarantineEnabled("or") is false
      expect(classification.quarantineTtlSec).toBe(0);

      // 2. reportFailure returns quarantine_disabled and does NOT quarantine key
      const failureState = pool.reportFailure(
        "or",
        0,
        429,
        new Headers({ "retry-after": "20" }),
        genericBody
      );

      expect(failureState.quarantinedUntil).toBe(0);
      expect(failureState.reason).toBe("quarantine_disabled");
      expect(pool.getCooldownManager().isQuarantined("or:0")).toBe(false);

      // 3. Key #0 remains eligible and available for subsequent picks
      const pick1 = pool.selectNextKey("or");
      expect(pick1?.index).toBe(0);

      const pick2 = pool.selectNextKey("or");
      expect(pick2?.index).toBe(1);

      // Pointer wraps back to Key #0 without skipping it
      const pick3 = pool.selectNextKey("or");
      expect(pick3?.index).toBe(0);
    });

    it("classifies a quota-429 body as retry_rotate with isConserve === false", () => {
      const openrouterRules = getProviderEndpointConfig("or")?.conserve_rules;
      const quotaBody = JSON.stringify({
        error: {
          message: "insufficient_quota: your account has no remaining credits",
        },
      });

      const classification = classifyUpstreamError({
        provider: "or",
        status: 429,
        headers: {},
        bodyText: quotaBody,
        conserveRules: openrouterRules,
      });

      // The quota branch is not a conserve-rule match: isConserve is explicitly
      // false (never undefined), so dispatch's `isConserve === true` gate never
      // consumes the park TTL as a conserve quarantine.
      expect(classification.reason).toBe("Quota or credit exhaustion (429)");
      expect(classification.action).toBe("retry_rotate");
      expect(classification.isConserve).toBe(false);
      // Quarantine is disabled for "or" in this block, so the 7-day TTL is zeroed.
      expect(classification.quarantineTtlSec).toBe(0);
    });
  });

  describe("6. OpenRouter quarantine is declared explicitly in providers.json", () => {
    it("providers.openrouter carries an explicit key_cooldown.enabled === true block", () => {
      initProviderRegistry();
      const orConfig = getProviderConfig("or") as {
        key_cooldown?: { enabled?: boolean; reset_after_success?: boolean };
      };

      // The block must exist on disk, not merely fall through to the default.
      expect(orConfig.key_cooldown).toBeDefined();
      expect(orConfig.key_cooldown?.enabled).toBe(true);
      // Declared without changing runtime behavior: dispatch.ts:713 only calls
      // reportSuccess when reset_after_success is truthy, and "or" never did.
      expect(orConfig.key_cooldown?.reset_after_success).toBe(false);
    });

    it("isProviderQuarantineEnabled reads the config block, not the default branch (enabled=false flips it)", () => {
      // Default from disk has key_cooldown.enabled === true, so quarantine is on.
      initProviderRegistry();
      expect(isProviderQuarantineEnabled("or")).toBe(true);

      // A real config read (not the default fallback) must flip it to false.
      const disabledConfig = JSON.parse(JSON.stringify(rawProviders));
      disabledConfig.providers.openrouter.key_cooldown = {
        enabled: false,
        initial_cooldown_ms: 60000,
        max_cooldown_ms: 300000,
      };
      initProviderRegistry(disabledConfig);
      try {
        expect(isProviderQuarantineEnabled("or")).toBe(false);
      } finally {
        initProviderRegistry();
      }
    });

    it("merges the block without clobbering the provider's other fields", () => {
      const orConfig = getProviderConfig("or");

      expect(orConfig.code).toBe("or");
      expect(orConfig.name).toBe("OpenRouter");
      expect(orConfig.base_url).toBe("https://openrouter.ai");
      expect(orConfig.env_key).toBe("OPENROUTER_API_KEYS");
      expect(orConfig.conserve_rules.length).toBeGreaterThan(0);
      expect(orConfig.request_retry.max_attempts).toBe(15);
      expect(orConfig.pacer.max_queue_depth).toBe(500);
    });

    it("isProviderQuarantineEnabled('or') reads true from config, not the default branch", () => {
      initProviderRegistry();
      expect(isProviderQuarantineEnabled("or")).toBe(true);

      const pool = new KeyPool();
      pool.setPool("or", ["sk-or-key-0", "sk-or-key-1"]);
      try {
        // Consumer-visible effect: a failure still quarantines the key.
        const state = pool.reportFailure("or", 0, 500, undefined, undefined, Date.now());
        expect(state.quarantinedUntil).toBeGreaterThan(0);
        expect(state.reason).not.toBe("quarantine_disabled");
        expect(pool.getCooldownManager().isQuarantined("or:0")).toBe(true);
      } finally {
        pool.reset();
      }
    });

    it("ignores the retired OPENROUTER_ENABLE_QUARANTINE=false env var", () => {
      const previous = process.env.OPENROUTER_ENABLE_QUARANTINE;
      process.env.OPENROUTER_ENABLE_QUARANTINE = "false";
      resetEnvCache();
      initProviderRegistry();
      try {
        // The .env toggle is dead: the declarative block is the source of truth.
        expect(isProviderQuarantineEnabled("or")).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.OPENROUTER_ENABLE_QUARANTINE;
        } else {
          process.env.OPENROUTER_ENABLE_QUARANTINE = previous;
        }
        resetEnvCache();
      }
    });
  });
});
