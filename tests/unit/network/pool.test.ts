import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  CooldownManager,
  RATE_LIMIT_DEFAULT_SEC,
  calculateMidnightUtcSec,
  computeStatusTtlSec,
  parseResetDelay,
} from "../../../src/network/cooldown";
import {
  FatalAuthError,
  KeyPool,
  isFatalAuthError,
} from "../../../src/network/pool";

describe("KeyPool & Cooldown — Fail-Fast 401/403 and Purged 65s Quarantine", () => {
  let pool: KeyPool;

  beforeEach(() => {
    pool = new KeyPool();
  });

  afterEach(() => {
    pool.reset();
  });

  describe("1. Fatal Auth Failures (401 & 403) — Fail-Fast with Zero Quarantine Lockout", () => {
    it("immediately throws FatalAuthError on 401 Unauthorized", () => {
      pool.setPool("prov", ["sk-key-1", "sk-key-2"]);

      expect(() => {
        pool.reportFailure("prov", 0, 401);
      }).toThrow(FatalAuthError);
    });

    it("immediately throws FatalAuthError on 403 Forbidden", () => {
      pool.setPool("prov", ["sk-key-1", "sk-key-2"]);

      expect(() => {
        pool.reportFailure("prov", 0, 403);
      }).toThrow(FatalAuthError);
    });

    it("does NOT quarantine the key for 24 hours on 401 or 403", () => {
      pool.setPool("prov", ["sk-key-1", "sk-key-2"]);
      const now = 1000000;

      try {
        pool.reportFailure("prov", 0, 401, undefined, undefined, now);
      } catch (err) {
        expect(isFatalAuthError(err)).toBe(true);
      }

      // The key MUST NOT be quarantined in CooldownManager
      expect(pool.getCooldownManager().isQuarantined("prov:0", now)).toBe(false);
      expect(pool.getCooldownManager().getRemainingMs("prov:0", now)).toBe(0);

      // Key 0 must remain selectable and not locked out for 24h
      const selected = pool.selectNextKey("prov", now);
      expect(selected?.key).toBe("sk-key-1");
      expect(selected?.index).toBe(0);
    });

    it("does NOT escalate through a 24-hour lockout table (300s -> 1800s -> 86400s)", () => {
      pool.setPool("prov", ["sk-key-1"]);
      const now = 2000000;

      // Consecutive auth failures
      for (let i = 0; i < 5; i++) {
        expect(() => {
          pool.reportFailure("prov", 0, 401, undefined, undefined, now);
        }).toThrow(FatalAuthError);

        expect(pool.getCooldownManager().isQuarantined("prov:0", now)).toBe(false);
      }
    });

    it("validates isFatalAuthError helper on FatalAuthError instances", () => {
      const err401 = new FatalAuthError("testprov", 1, 401);
      expect(err401.status).toBe(401);
      expect(err401.provider).toBe("testprov");
      expect(err401.keyIndex).toBe(1);
      expect(err401.isFatal).toBe(true);
      expect(isFatalAuthError(err401)).toBe(true);

      const standardError = new Error("Generic failure");
      expect(isFatalAuthError(standardError)).toBe(false);
      expect(isFatalAuthError(null)).toBe(false);
      expect(isFatalAuthError(undefined)).toBe(false);
    });
  });

  describe("2. Generic 429 Rate Limits — Zero Reactive 65s Quarantine Lockout", () => {
    it("has RATE_LIMIT_DEFAULT_SEC = 0", () => {
      expect(RATE_LIMIT_DEFAULT_SEC).toBe(0);
      expect(computeStatusTtlSec(429)).toBe(0);
    });

    it("does NOT quarantine keys on generic HTTP 429 without Retry-After", () => {
      pool.setPool("prov", ["sk-key-1", "sk-key-2"]);
      const now = 3000000;

      const state = pool.reportFailure("prov", 0, 429, undefined, undefined, now);

      // Quarantine duration must be 0 ms
      expect(state.quarantinedUntil).toBe(now);
      expect(pool.getCooldownManager().isQuarantined("prov:0", now)).toBe(false);
      expect(pool.getCooldownManager().getRemainingMs("prov:0", now)).toBe(0);

      // Key 0 must not be locked out and can be selected immediately
      const nextKey = pool.selectNextKey("prov", now);
      expect(nextKey?.key).toBe("sk-key-1");
    });

    it("returns delayMs = 0 in parseResetDelay for generic 429 without headers or body", () => {
      const parsed = parseResetDelay();
      expect(parsed.delayMs).toBe(0);
      expect(parsed.isGraceRetry).toBe(false);
    });
  });

  describe("3. Explicit 429 Delays & Clamps — Respects Explicit Directives", () => {
    it("respects explicit Retry-After numeric header", () => {
      pool.setPool("prov", ["sk-key-1"]);
      const now = 4000000;
      const headers = new Headers({ "retry-after": "120" });

      const state = pool.reportFailure("prov", 0, 429, headers, undefined, now);

      expect(state.quarantinedUntil).toBe(now + 120000);
      expect(pool.getCooldownManager().isQuarantined("prov:0", now)).toBe(true);
      expect(pool.getCooldownManager().getRemainingMs("prov:0", now)).toBe(120000);
    });

    it("respects explicit customTtlSec parameter on reportFailure", () => {
      pool.setPool("prov", ["sk-key-1", "sk-key-2"]);
      const now = 5000000;

      const state = pool.reportFailure("prov", 0, 429, undefined, undefined, now, 45);

      expect(state.quarantinedUntil).toBe(now + 45000);
      expect(pool.getCooldownManager().isQuarantined("prov:0", now)).toBe(true);
      expect(pool.getCooldownManager().getRemainingMs("prov:0", now)).toBe(45000);

      // Key 1 should be selected since Key 0 is explicitly quarantined
      const nextKey = pool.selectNextKey("prov", now);
      expect(nextKey?.key).toBe("sk-key-2");
    });

    it("clamps sub-minimum delay to 5s min threshold", () => {
      const headers = new Headers({ "retry-after": "3" });
      const parsed = parseResetDelay(headers);
      expect(parsed.delayMs).toBe(5000);
    });

    it("flags sub-2s delay for immediate grace retry", () => {
      const headers = new Headers({ "retry-after": "1.5" });
      const parsed = parseResetDelay(headers);
      expect(parsed.delayMs).toBe(1500);
      expect(parsed.isGraceRetry).toBe(true);
    });

    it("purges 2-hour clamp so large delays are not capped to 7200s", () => {
      const headers = new Headers({ "retry-after": "999999" });
      const parsed = parseResetDelay(headers);
      // Previously clamped to 7200000ms; now unconstrained
      expect(parsed.delayMs).toBe(999999000);
    });
  });

  describe("4. Explicit Conserve Rules — conserveKey Functionality", () => {
    it("retains conserveKey for explicit quota exhaustion (e.g. OpenRouter)", () => {
      pool.setPool("openrouter", ["sk-or-key-1", "sk-or-key-2"]);
      const now = 6000000;

      const state = pool.conserveKey("openrouter", 0, 3600, "daily_quota_exhausted", 429, now);

      expect(state.quarantinedUntil).toBe(now + 3600000);
      expect(state.reason).toBe("daily_quota_exhausted");
      expect(pool.getCooldownManager().isQuarantined("openrouter:0", now)).toBe(true);
      expect(pool.getCooldownManager().getRemainingMs("openrouter:0", now)).toBe(3600000);

      // Key 1 is selected
      const selected = pool.selectNextKey("openrouter", now);
      expect(selected?.key).toBe("sk-or-key-2");
    });

    it("calculates midnight UTC sec with 60s buffer via calculateMidnightUtcSec", () => {
      const testDateMs = Date.UTC(2026, 8, 13, 23, 59, 0, 0);
      const ttlSec = calculateMidnightUtcSec(testDateMs);
      expect(ttlSec).toBe(120); // 60s to midnight + 60s buffer
    });

    it("integrates calculateMidnightUtcSec with conserveKey", () => {
      pool.setPool("openrouter", ["sk-or-key-1"]);
      const now = Date.UTC(2026, 8, 13, 23, 50, 0, 0); // 10 mins before midnight
      const ttlSec = calculateMidnightUtcSec(now); // 600s + 60s = 660s

      const state = pool.conserveKey("openrouter", 0, ttlSec, "midnight_conserve", 429, now);
      expect(state.quarantinedUntil).toBe(now + 660000);
      expect(pool.getCooldownManager().isQuarantined("openrouter:0", now)).toBe(true);
    });
  });

  describe("5. Pool Lifecycle, Round-Robin and Reset", () => {
    it("round-robins across active non-quarantined keys", () => {
      pool.setPool("prov", ["k1", "k2", "k3"]);

      expect(pool.selectNextKey("prov")?.key).toBe("k1");
      expect(pool.selectNextKey("prov")?.key).toBe("k2");
      expect(pool.selectNextKey("prov")?.key).toBe("k3");
      expect(pool.selectNextKey("prov")?.key).toBe("k1");
    });

    it("clears all quarantined state on reset()", () => {
      pool.setPool("prov", ["k1"]);
      const now = 7000000;
      pool.conserveKey("prov", 0, 300, "conserve", 429, now);

      expect(pool.getCooldownManager().isQuarantined("prov:0", now)).toBe(true);
      pool.reset();
      expect(pool.getCooldownManager().isQuarantined("prov:0", now)).toBe(false);
    });
  });

  describe("session pinning", () => {
    // Deterministic clock: every assertion passes an explicit `now` so pin TTLs
    // never depend on wall-clock time.
    const T0 = 1_000_000;
    const SESSION_KEYS = ["p1", "p2", "p3"];

    /**
     * White-box view of the private pin map. The pin LRU/recency and the
     * expired-entry purge are internal invariants with no public size accessor,
     * so these tests read the map (and, for the purge case, drive the lookup)
     * directly to prove the entry is gone rather than merely re-pinned.
     */
    function pinIds(t: KeyPool): string[] {
      const internal = t as unknown as { sessionPins: Map<string, unknown> };
      return [...internal.sessionPins.keys()];
    }

    it("pins the first selected key to a session and returns the same key index on repeat calls", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      const first = pool.selectNextKey("pinprov", T0, "sess-1");
      expect(first?.index).toBe(0);
      expect(first?.key).toBe("p1");

      const second = pool.selectNextKey("pinprov", T0 + 1, "sess-1");
      expect(second?.index).toBe(0);
      expect(second?.key).toBe("p1");

      const third = pool.selectNextKey("pinprov", T0 + 2, "sess-1");
      expect(third?.index).toBe(0);
      expect(third?.totalKeys).toBe(3);
    });

    it("pin hits do NOT advance the round-robin pointer", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      // Session pin takes index 0; the round-robin pointer is now 1.
      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      // Pinned hits must not move the pointer.
      expect(pool.selectNextKey("pinprov", T0 + 1, "sess-1")?.index).toBe(0);
      expect(pool.selectNextKey("pinprov", T0 + 2, "sess-1")?.index).toBe(0);

      // A session-less caller resumes exactly where round-robin left off.
      expect(pool.selectNextKey("pinprov", T0 + 3)?.index).toBe(1);
      expect(pool.selectNextKey("pinprov", T0 + 4)?.index).toBe(2);
      expect(pool.selectNextKey("pinprov", T0 + 5)?.index).toBe(0);
    });

    it("pin hits by one session do not disturb another session's round-robin position", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      // Unrelated session consumes the next round-robin slot.
      expect(pool.selectNextKey("pinprov", T0, "sess-2")?.index).toBe(1);
      // sess-1 is still pinned to 0.
      expect(pool.selectNextKey("pinprov", T0 + 1, "sess-1")?.index).toBe(0);
      // sess-2 is still pinned to 1.
      expect(pool.selectNextKey("pinprov", T0 + 1, "sess-2")?.index).toBe(1);
      // Round-robin resumes at 2, unaffected by the pinned hits.
      expect(pool.selectNextKey("pinprov", T0 + 2)?.index).toBe(2);
    });

    it("keeps independent pins for different sessionIds", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      const a = pool.selectNextKey("pinprov", T0, "sess-A");
      const b = pool.selectNextKey("pinprov", T0, "sess-B");

      expect(a?.index).toBe(0);
      expect(b?.index).toBe(1);
      expect(a?.index).not.toBe(b?.index);

      // Each session keeps its own key.
      expect(pool.selectNextKey("pinprov", T0 + 1, "sess-A")?.index).toBe(0);
      expect(pool.selectNextKey("pinprov", T0 + 1, "sess-B")?.index).toBe(1);
      expect(pool.selectNextKey("pinprov", T0 + 1, "sess-A")?.index).toBe(0);
    });

    it("rotateSessionKey returns a different healthy key and re-pins it for the session", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      const pinned = pool.selectNextKey("pinprov", T0, "sess-1");
      expect(pinned?.index).toBe(0);

      const rotated = pool.rotateSessionKey("pinprov", "sess-1", T0 + 1);
      expect(rotated).not.toBeNull();
      expect(rotated?.index).not.toBe(pinned?.index);
      expect(rotated?.index).toBe(1);
      expect(rotated?.key).toBe("p2");

      // The rotated key is now the session's pin.
      const afterRotate = pool.selectNextKey("pinprov", T0 + 2, "sess-1");
      expect(afterRotate?.index).toBe(1);
      expect(afterRotate?.key).toBe("p2");

      // A second rotation moves off the new pin.
      const rotatedAgain = pool.rotateSessionKey("pinprov", "sess-1", T0 + 3);
      expect(rotatedAgain?.index).toBe(2);
      expect(pool.selectNextKey("pinprov", T0 + 4, "sess-1")?.index).toBe(2);
    });

    it("rotateSessionKey skips keys that are quarantined", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      pool.quarantineKey("pinprov", 1, 300, "probe_quarantine", 429, T0 + 1);

      const rotated = pool.rotateSessionKey("pinprov", "sess-1", T0 + 2);
      expect(rotated?.index).toBe(2);
      expect(rotated?.key).toBe("p3");
    });

    it("rotateSessionKey without a prior pin starts from the provider round-robin pointer", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      const rotated = pool.rotateSessionKey("pinprov", "sess-fresh", T0);
      expect(rotated?.index).toBe(0);

      const pinned = pool.selectNextKey("pinprov", T0 + 1, "sess-fresh");
      expect(pinned?.index).toBe(0);
    });

    it("rotateSessionKey returns null when the provider has no keys", () => {
      pool.setPool("pinprov", []);

      expect(pool.rotateSessionKey("pinprov", "sess-1", T0)).toBeNull();
    });

    it("expires a pin after ttlMs and falls back to round-robin", () => {
      const shortLived = new KeyPool(undefined, { ttlMs: 50 });
      shortLived.setPool("pinprov", SESSION_KEYS);

      // Pin taken at T0.
      expect(shortLived.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      // Still inside the TTL window (the hit slides the expiry forward).
      expect(shortLived.selectNextKey("pinprov", T0 + 40, "sess-1")?.index).toBe(0);

      // Past T0 + 40 + ttlMs the pin is gone, so round-robin (pointer 1) wins.
      const afterExpiry = shortLived.selectNextKey("pinprov", T0 + 100, "sess-1");
      expect(afterExpiry?.index).toBe(1);

      // The expired session re-pins whatever round-robin handed it.
      expect(shortLived.selectNextKey("pinprov", T0 + 101, "sess-1")?.index).toBe(1);
      shortLived.reset();
    });

    it("honors a pin one tick before its ttl boundary", () => {
      const shortLived = new KeyPool(undefined, { ttlMs: 50 });
      shortLived.setPool("pinprov", SESSION_KEYS);

      // expiresAt = T0 + 50. A hit at T0 + 49 is still inside the window and
      // slides the expiry forward to T0 + 99.
      expect(shortLived.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      expect(shortLived.selectNextKey("pinprov", T0 + 49, "sess-1")?.index).toBe(0);
      // At the slid boundary (T0 + 49 + 50 = T0 + 99) the pin has lapsed and
      // round-robin (pointer 1) answers instead.
      expect(shortLived.selectNextKey("pinprov", T0 + 99, "sess-1")?.index).toBe(1);
      shortLived.reset();
    });

    it("expires a pin exactly at its ttl boundary (expiresAt <= now)", () => {
      const shortLived = new KeyPool(undefined, { ttlMs: 50 });
      shortLived.setPool("pinprov", SESSION_KEYS);

      // No intervening hit, so expiresAt stays at T0 + 50. The check is
      // `expiresAt <= now`, so a call at exactly T0 + 50 is already a miss.
      expect(shortLived.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      expect(shortLived.selectNextKey("pinprov", T0 + 50, "sess-1")?.index).toBe(1);
      shortLived.reset();
    });

    it("evicts the oldest session pin when maxEntries is exceeded", () => {
      const tiny = new KeyPool(undefined, { maxEntries: 2 });
      tiny.setPool("pinprov", SESSION_KEYS);

      expect(tiny.selectNextKey("pinprov", T0, "sess-A")?.index).toBe(0);
      expect(tiny.selectNextKey("pinprov", T0, "sess-B")?.index).toBe(1);
      // Inserting the third distinct session evicts the oldest pin (sess-A).
      expect(tiny.selectNextKey("pinprov", T0, "sess-C")?.index).toBe(2);

      // Surviving pins are unaffected.
      expect(tiny.selectNextKey("pinprov", T0 + 1, "sess-B")?.index).toBe(1);
      expect(tiny.selectNextKey("pinprov", T0 + 1, "sess-C")?.index).toBe(2);

      // sess-A was evicted: advance the round-robin pointer first so a fresh
      // pin cannot masquerade as the stale one.
      expect(tiny.selectNextKey("pinprov", T0 + 1)?.index).toBe(0);
      expect(tiny.selectNextKey("pinprov", T0 + 1, "sess-A")?.index).toBe(1);
      tiny.reset();
    });

    it("refreshing a pin under cap pressure keeps it alive while the truly-oldest is evicted (LRU, not FIFO)", () => {
      const tiny = new KeyPool(undefined, { maxEntries: 2 });
      tiny.setPool("pinprov", SESSION_KEYS);

      // sess-A pins key 0 (oldest); sess-B pins key 1 (most-recent).
      expect(tiny.selectNextKey("pinprov", T0, "sess-A")?.index).toBe(0);
      expect(tiny.selectNextKey("pinprov", T0, "sess-B")?.index).toBe(1);
      // A live hit on sess-A must refresh it to the MRU end, so sess-B is now
      // the least-recently-used pin.
      expect(tiny.selectNextKey("pinprov", T0 + 1, "sess-A")?.index).toBe(0);

      // Inserting sess-C exceeds the cap and must evict the LRU pin (sess-B),
      // NOT sess-A. A FIFO evictOldest would have dropped sess-A here.
      expect(tiny.selectNextKey("pinprov", T0 + 1, "sess-C")?.index).toBe(2);

      const survivors = pinIds(tiny);
      expect(survivors).toContain("pinprov:sess-A");
      expect(survivors).toContain("pinprov:sess-C");
      expect(survivors).not.toContain("pinprov:sess-B");

      // The refreshed pin still resolves to its original key.
      expect(tiny.selectNextKey("pinprov", T0 + 2, "sess-A")?.index).toBe(0);
      tiny.reset();
    });

    it("purges an expired pin on lookup so the stale entry is dropped (map size falls)", () => {
      const shortLived = new KeyPool(undefined, { ttlMs: 50 });
      shortLived.setPool("pinprov", SESSION_KEYS);

      // Pin taken at T0; the map now holds exactly one entry.
      expect(shortLived.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      expect(pinIds(shortLived)).toEqual(["pinprov:sess-1"]);

      // Drive the lookup directly (a full selectNextKey would immediately
      // re-pin). Past the ttl the lookup must miss AND delete the stale entry.
      const internal = shortLived as unknown as {
        getPinnedKey: (provider: string, sessionId: string, total: number, now: number) => unknown;
        sessionPins: Map<string, unknown>;
      };
      expect(internal.getPinnedKey("pinprov", "sess-1", SESSION_KEYS.length, T0 + 51)).toBeNull();
      expect(pinIds(shortLived)).toEqual([]);
      expect(internal.sessionPins.size).toBe(0);
      shortLived.reset();
    });

    it("invalidates the pin when the pinned key is quarantined", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      // The pin is live before the quarantine lands.
      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);

      // 1s quarantine: expired long before the assertion instant, so key 0 is
      // selectable again and only the pin's absence can explain the result.
      pool.quarantineKey("pinprov", 0, 1, "probe_quarantine", 429, T0);
      expect(pool.getCooldownManager().isQuarantined("pinprov:0", T0)).toBe(true);

      const afterQuarantine = pool.selectNextKey("pinprov", T0 + 5000, "sess-1");
      expect(pool.getCooldownManager().isQuarantined("pinprov:0", T0 + 5000)).toBe(false);
      expect(afterQuarantine?.index).not.toBe(0);
      expect(afterQuarantine?.index).toBe(1);
      expect(afterQuarantine?.key).toBe("p2");
    });

    it("invalidates the pin when the pinned key is conserved", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      // The pin is live before the conserve lands.
      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);

      pool.conserveKey("pinprov", 0, 1, "quota_exhausted", 429, T0);
      expect(pool.getStatus("pinprov", T0).quarantined).toBe(1);

      const afterConserve = pool.selectNextKey("pinprov", T0 + 5000, "sess-1");
      expect(pool.getStatus("pinprov", T0 + 5000).quarantined).toBe(0);
      expect(afterConserve?.index).not.toBe(0);
      expect(afterConserve?.index).toBe(1);
    });

    it("invalidates the pin when reportFailure quarantines the pinned key", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      // The pin is live before the failure lands.
      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);

      pool.reportFailure("pinprov", 0, 429, undefined, undefined, T0, 1);
      expect(pool.getCooldownManager().isQuarantined("pinprov:0", T0)).toBe(true);

      const afterFailure = pool.selectNextKey("pinprov", T0 + 5000, "sess-1");
      expect(pool.getCooldownManager().isQuarantined("pinprov:0", T0 + 5000)).toBe(false);
      expect(afterFailure?.index).not.toBe(0);
      expect(afterFailure?.index).toBe(1);
    });

    it("drops the pin even when reportFailure applies a zero-duration quarantine", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      // The pin is live before the failure lands.
      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);

      // Generic 429 quarantines for 0 ms, so key 0 is immediately selectable;
      // the pin must still be dropped.
      pool.reportFailure("pinprov", 0, 429, undefined, undefined, T0);
      expect(pool.getCooldownManager().isQuarantined("pinprov:0", T0)).toBe(false);

      expect(pool.selectNextKey("pinprov", T0 + 1, "sess-1")?.index).toBe(1);
    });

    it("only invalidates pins for the affected provider and key index", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      expect(pool.selectNextKey("pinprov", T0, "sess-2")?.index).toBe(1);
      // Both pins are live before the quarantine lands.
      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(0);
      expect(pool.selectNextKey("pinprov", T0, "sess-2")?.index).toBe(1);

      pool.quarantineKey("pinprov", 0, 1, "probe_quarantine", 429, T0);

      // sess-2's pin on key 1 survives the quarantine of key 0.
      expect(pool.selectNextKey("pinprov", T0 + 5000, "sess-2")?.index).toBe(1);
      // sess-1's pin on key 0 is gone.
      expect(pool.selectNextKey("pinprov", T0 + 5000, "sess-1")?.index).not.toBe(0);
    });

    it("keeps session pins scoped to their own provider", () => {
      pool.setPool("pinprov", SESSION_KEYS);
      pool.setPool("otherprov", ["o1", "o2", "o3"]);

      expect(pool.selectNextKey("pinprov", T0, "shared-session")?.index).toBe(0);
      expect(pool.selectNextKey("otherprov", T0, "shared-session")?.index).toBe(0);
      // Both pins are live before the cross-provider check.
      expect(pool.selectNextKey("pinprov", T0, "shared-session")?.index).toBe(0);
      expect(pool.selectNextKey("otherprov", T0, "shared-session")?.index).toBe(0);

      // The otherprov pin did not disturb the pinprov pin.
      expect(pool.selectNextKey("pinprov", T0 + 1, "shared-session")?.index).toBe(0);
      expect(pool.selectNextKey("otherprov", T0 + 1, "shared-session")?.index).toBe(0);
    });

    it("reset() clears every session pin and the round-robin pointer", () => {
      pool.setPool("pinprov", SESSION_KEYS);

      // sess-anchor consumes index 0; sess-1 then pins index 1.
      expect(pool.selectNextKey("pinprov", T0, "sess-anchor")?.index).toBe(0);
      expect(pool.selectNextKey("pinprov", T0, "sess-1")?.index).toBe(1);
      expect(pool.selectNextKey("pinprov", T0 + 1, "sess-1")?.index).toBe(1);

      pool.reset();
      pool.setPool("pinprov", SESSION_KEYS);

      // Pointer back to 0 and no pin left: sess-1 now starts over at index 0
      // instead of resuming on its old key 1.
      expect(pool.selectNextKey("pinprov", T0 + 1, "sess-1")?.index).toBe(0);
    });
  });
});