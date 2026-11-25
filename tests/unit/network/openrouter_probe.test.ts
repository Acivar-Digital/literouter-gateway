/**
 * Blueprint §2.4 — OpenRouter key depletion verifier (verifyAndConserve).
 *
 * Every test injects a fake `fetchFn` (no live network) and uses a UNIQUE
 * (provider, keyIndex) pair: the module-level `inflightProbes` /
 * `probeDebounceUntil` / `probeFailures` maps are keyed `${provider}:${keyIndex}`
 * and have no reset export, so reusing a pair across tests would leak
 * single-flight/debounce/backoff state.
 *
 * `typeof fetch` in Bun carries a `preconnect` namespace member, so the stub is
 * built with `Object.assign` to satisfy that type without a cast.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { KeyPool } from "../../../src/network/pool";
import { verifyAndConserve } from "../../../src/network/openrouter_probe";

const KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";

/**
 * Backoff schedule mirrors PROBE_FAILURE_BACKOFF_SCHEDULE_MS (5s, 15s, 60s,
 * 300s) and PROBE_DEBOUNCE_MS (long conclusive window) in openrouter_probe.ts.
 */
const BACKOFF_SCHEDULE_MS = [5_000, 15_000, 60_000, 300_000] as const;
const LONG_DEBOUNCE_MS = 300_000;
/** Frozen wall clock for the debounce tests (epoch ms). */
const CLOCK_BASE = 1_760_000_000_000;

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

type FetchStub = typeof fetch;

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeFetch(respond: (callIndex: number) => Response | Promise<Response>): {
  readonly fetchFn: FetchStub;
  readonly calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return respond(calls.length - 1);
    },
    { preconnect: (): void => {} }
  );
  return { fetchFn, calls };
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (headers === undefined) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  return (headers as Record<string, string>)[name];
}

function makePool(provider: string, keys: readonly string[]): KeyPool {
  const pool = new KeyPool();
  pool.setPool(provider, keys);
  return pool;
}

describe("verifyAndConserve — OpenRouter key depletion probe (blueprint §2.4)", () => {
  it("conserves a key whose credit limit is exhausted (limit_remaining <= 0)", async () => {
    const provider = "orp1";
    const pool = makePool(provider, ["sk-a", "sk-b"]);
    const { fetchFn, calls } = makeFetch(() =>
      jsonResponse({ data: { limit_remaining: 0, free_model_daily_requests: { remaining: 42 } } })
    );

    const result = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);

    expect(result).toEqual({
      keyIndex: 0,
      verifiedExhausted: true,
      conserveTtlSec: 3600,
      reason: "openrouter_limit_exhausted",
      outcome: "conclusive",
    });

    // Probed the real OpenRouter key endpoint with the bearer token.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(KEY_ENDPOINT);
    expect(headerValue(calls[0]?.init, "Authorization")).toBe("Bearer sk-a");

    // The exhausted key is quarantined on the pool for ~1h and skipped.
    expect(pool.getStatus(provider)).toEqual({ total: 2, active: 1, quarantined: 1 });
    expect(pool.getCooldownManager().isQuarantined(`${provider}:0`)).toBe(true);
    const remainingMs = pool.getCooldownManager().getRemainingMs(`${provider}:0`);
    expect(remainingMs).toBeGreaterThan(3_500_000);
    expect(remainingMs).toBeLessThanOrEqual(3_600_000);
    expect(pool.selectNextKey(provider)?.index).toBe(1);
  });

  it("conserves a key whose free-model daily quota is spent (remaining <= 0)", async () => {
    const provider = "orp2";
    const pool = makePool(provider, ["sk-a", "sk-b"]);
    const { fetchFn, calls } = makeFetch(() =>
      jsonResponse({ data: { limit_remaining: 10, free_model_daily_requests: { remaining: 0 } } })
    );

    const result = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);

    expect(result.keyIndex).toBe(0);
    expect(result.verifiedExhausted).toBe(true);
    expect(result.conserveTtlSec).toBeGreaterThan(0);
    expect(result.reason).toBe("openrouter_free_daily_exhausted");
    expect(result.outcome).toBe("conclusive");

    expect(calls).toHaveLength(1);
    expect(pool.getStatus(provider)).toEqual({ total: 2, active: 1, quarantined: 1 });
    expect(pool.getCooldownManager().isQuarantined(`${provider}:0`)).toBe(true);
    // The conserve TTL is the resolved midnight-UTC window, and the pool was
    // quarantined for exactly that long.
    const remainingMs = pool.getCooldownManager().getRemainingMs(`${provider}:0`);
    expect(Math.abs(remainingMs - result.conserveTtlSec * 1000)).toBeLessThan(5_000);
    expect(pool.selectNextKey(provider)?.index).toBe(1);
  });

  /**
   * Red-first (L7): the original fix widened the `typeof remaining === "number"`
   * guard to `<= 0`. A negative `remaining` is nonsensical upstream data but
   * unambiguously means exhausted, so the key MUST be conserved. The existing
   * non-number guard test (below) is defence-in-depth for the same predicate.
   */
  it("conserves a key whose free_model_daily_requests.remaining is negative", async () => {
    const provider = "orpNEG";
    const pool = makePool(provider, ["sk-a", "sk-b"]);
    const { fetchFn } = makeFetch(() =>
      jsonResponse({ data: { limit_remaining: 5, free_model_daily_requests: { remaining: -1 } } })
    );

    const result = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);

    expect(result.verifiedExhausted).toBe(true);
    expect(result.conserveTtlSec).toBeGreaterThan(0);
    expect(result.reason).toBe("openrouter_free_daily_exhausted");
    expect(result.outcome).toBe("conclusive");
    expect(pool.getCooldownManager().isQuarantined(`${provider}:0`)).toBe(true);
  });

  it("leaves a healthy key untouched (no conserve, no quarantine)", async () => {
    const provider = "orp3";
    const pool = makePool(provider, ["sk-a", "sk-b"]);
    const { fetchFn, calls } = makeFetch(() =>
      jsonResponse({ data: { limit_remaining: 5, free_model_daily_requests: { remaining: 100 } } })
    );

    const result = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);

    expect(result).toEqual({
      keyIndex: 0,
      verifiedExhausted: false,
      conserveTtlSec: 0,
      reason: "healthy",
      outcome: "conclusive",
    });
    expect(calls).toHaveLength(1);
    expect(pool.getStatus(provider)).toEqual({ total: 2, active: 2, quarantined: 0 });
    expect(pool.getCooldownManager().isQuarantined(`${provider}:0`)).toBe(false);
    expect(pool.getCooldownManager().getRemainingMs(`${provider}:0`)).toBe(0);
    // Round-robin still starts at the probed key — it was never skipped.
    expect(pool.selectNextKey(provider)?.index).toBe(0);
  });

  it("fails open on a non-2xx probe response (no throw, no conserve)", async () => {
    const provider = "orp4";
    const pool = makePool(provider, ["sk-a", "sk-b"]);
    const { fetchFn, calls } = makeFetch(() => jsonResponse({ error: "boom" }, 500));
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);

      expect(result).toEqual({
        keyIndex: 0,
        verifiedExhausted: false,
        conserveTtlSec: 0,
        reason: "probe_failed",
        outcome: "failed",
      });
      expect(calls).toHaveLength(1);
      expect(pool.getStatus(provider)).toEqual({ total: 2, active: 2, quarantined: 0 });
      expect(pool.getCooldownManager().isQuarantined(`${provider}:0`)).toBe(false);

      expect(warnSpy).toHaveBeenCalled();
      const firstWarn = warnSpy.mock.calls[0]?.[0];
      expect(typeof firstWarn).toBe("string");
      expect(firstWarn).toStartWith(`[PROBE ${provider} key#0] verification failed:`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("fails open when the probe fetch rejects (no throw, no conserve)", async () => {
    const provider = "orp5";
    const pool = makePool(provider, ["sk-a", "sk-b"]);
    const { fetchFn, calls } = makeFetch(() => {
      throw new Error("ECONNRESET");
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);

      expect(result).toEqual({
        keyIndex: 0,
        verifiedExhausted: false,
        conserveTtlSec: 0,
        reason: "probe_failed",
        outcome: "failed",
      });
      expect(calls).toHaveLength(1);
      expect(pool.getStatus(provider)).toEqual({ total: 2, active: 2, quarantined: 0 });
      expect(pool.getCooldownManager().isQuarantined(`${provider}:0`)).toBe(false);

      const firstWarn = warnSpy.mock.calls[0]?.[0];
      expect(typeof firstWarn).toBe("string");
      expect(firstWarn).toStartWith(`[PROBE ${provider} key#0] verification failed:`);
      expect(firstWarn).toContain("ECONNRESET");
    } finally {
      warnSpy.mockRestore();
    }
  });

  /**
   * A 429 from the probe endpoint must carry `Retry-After` through to the
   * debounce stamp verbatim, so the next attempt waits exactly as long as the
   * server instructed — not the generic exponential backoff.
   */
  it("honours Retry-After on a 429 probe response", async () => {
    const provider = "orpRA";
    const pool = makePool(provider, ["sk-a", "sk-b"]);
    let call = 0;
    const { fetchFn, calls } = makeFetch(() => {
      call += 1;
      return call === 1
        ? jsonResponse({ error: "rate limited" }, 429, { "retry-after": "42" })
        : jsonResponse({ data: { limit_remaining: 5, free_model_daily_requests: { remaining: 99 } } });
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const nowSpy = spyOn(Date, "now").mockImplementation(() => CLOCK_BASE);

    try {
      const first = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
      expect(first.outcome).toBe("failed");
      expect(first.reason).toBe("probe_failed");

      // Inside the 42s Retry-After window the probe is debounced.
      const heldAt = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
      expect(heldAt.reason).toBe("debounced");
      expect(calls).toHaveLength(1);

      // Past 42s the next request re-probes (Retry-After honoured, not 5s/15s).
      nowSpy.mockImplementation(() => CLOCK_BASE + 42_001);
      const retried = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
      expect(retried.reason).toBe("healthy");
      expect(calls).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("single-flights concurrent callers: exactly one probe request for the same (provider, keyIndex)", async () => {
    const provider = "orp6";
    const pool = makePool(provider, ["sk-a", "sk-b"]);

    const { promise: gate, resolve: release } = Promise.withResolvers<Response>();
    const { fetchFn, calls } = makeFetch(() => gate);

    const first = verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
    const second = verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);

    // Both callers are still in flight: only one request went out.
    expect(calls).toHaveLength(1);

    release(jsonResponse({ data: { limit_remaining: 3, free_model_daily_requests: { remaining: 7 } } }));

    const [r1, r2] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(r1).toEqual(r2);
    expect(r1).toEqual({
      keyIndex: 0,
      verifiedExhausted: false,
      conserveTtlSec: 0,
      reason: "healthy",
      outcome: "conclusive",
    });
    expect(pool.getStatus(provider)).toEqual({ total: 2, active: 2, quarantined: 0 });
  });

  it("debounces a repeat probe within 5 minutes (no second fetch)", async () => {
    const provider = "orp7";
    const pool = makePool(provider, ["sk-a", "sk-b"]);

    // The first probe answers healthy; the second (which must never be sent)
    // would have reported exhaustion.
    let call = 0;
    const { fetchFn, calls } = makeFetch(() => {
      call += 1;
      return call === 1
        ? jsonResponse({ data: { limit_remaining: 4, free_model_daily_requests: { remaining: 9 } } })
        : jsonResponse({ data: { limit_remaining: 0 } });
    });

    const first = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
    expect(first.reason).toBe("healthy");
    expect(calls).toHaveLength(1);

    const second = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);

    expect(second).toEqual({
      keyIndex: 0,
      verifiedExhausted: false,
      conserveTtlSec: 0,
      reason: "debounced",
      outcome: "failed",
    });
    expect(calls).toHaveLength(1);
    // Debouncing must not quarantine anything.
    expect(pool.getStatus(provider)).toEqual({ total: 2, active: 2, quarantined: 0 });
    expect(pool.getCooldownManager().isQuarantined(`${provider}:0`)).toBe(false);
  });

  describe("outcome-keyed debounce (L6) and dailyRemaining guard (L7)", () => {
    let clockNow = CLOCK_BASE;
    let restoreClock: () => void = () => {};
    let restoreRandom: () => void = () => {};

    beforeEach(() => {
      clockNow = CLOCK_BASE;
      const nowSpy = spyOn(Date, "now").mockImplementation(() => clockNow);
      // Pin jitter to its midpoint (ratio 0 → nominal schedule) so the
      // boundary-advancing clock steps below are deterministic instead of
      // flaking on the ±20% random jitter at the exact backoff edge.
      const randomSpy = spyOn(Math, "random").mockReturnValue(0.5);
      restoreClock = (): void => nowSpy.mockRestore();
      restoreRandom = (): void => randomSpy.mockRestore();
    });

    afterEach(() => {
      restoreClock();
      restoreRandom();
    });


    it("re-probes after the short backoff when the previous probe failed (no 5-minute freeze)", async () => {
      const provider = "orp8";
      const pool = makePool(provider, ["sk-a", "sk-b"]);
      let call = 0;
      const { fetchFn, calls } = makeFetch(() => {
        call += 1;
        return call === 1
          ? jsonResponse({ error: "upstream 503" }, 503)
          : jsonResponse({ data: { limit_remaining: 2, free_model_daily_requests: { remaining: 11 } } });
      });
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const failed = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
        expect(failed.reason).toBe("probe_failed");
        expect(failed.outcome).toBe("failed");

        // Inside the first backoff window (5s ±20% jitter → max 6s) the probe
        // still debounces.
        clockNow += 4_000;
        const held = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
        expect(held.reason).toBe("debounced");
        expect(calls).toHaveLength(1);

        // Past the worst-case first backoff (6s) the next request re-probes
        // instead of waiting out the full long window.
        clockNow += 3_000; // total 7s past the failure
        const retried = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
        expect(retried.reason).toBe("healthy");
        expect(retried.verifiedExhausted).toBe(false);
        expect(retried.outcome).toBe("conclusive");
        expect(calls).toHaveLength(2);
        expect(pool.getStatus(provider)).toEqual({ total: 2, active: 2, quarantined: 0 });
      } finally {
        warnSpy.mockRestore();
      }
    });

    /**
     * Red-first (HIGH): consecutive failed probes must back off PROGRESSIVELY
     * (5s -> 15s -> 60s -> 300s cap), not re-probe at the same flat 5s forever.
     * Each step advances past the worst-case jittered window of the prior
     * failure tier and asserts the next tier is still debounced.
     */
    it("backs off progressively across consecutive failed probes", async () => {
      const provider = "orpPROG";
      const pool = makePool(provider, ["sk-a", "sk-b"]);
      let call = 0;
      const { fetchFn, calls } = makeFetch(() => {
        call += 1;
        return jsonResponse({ error: "upstream 503" }, 503);
      });
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        // 1st failure → 5s backoff (worst case 6s with +20% jitter).
        const f1 = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
        expect(f1.outcome).toBe("failed");
        expect(calls).toHaveLength(1);

        // Inside 5s±20%: still debounced.
        clockNow += 4_000;
        expect((await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn)).reason).toBe("debounced");
        expect(calls).toHaveLength(1);

        // Past 6s: re-probe fires (call #2) → 2nd failure → 15s backoff (18s worst case).
        clockNow += 3_000;
        const f2 = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
        expect(f2.outcome).toBe("failed");
        expect(calls).toHaveLength(2);

        // Inside 15s±20%: still debounced.
        clockNow += 12_000;
        expect((await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn)).reason).toBe("debounced");
        expect(calls).toHaveLength(2);

        // Past 18s: re-probe fires (call #3) → 3rd failure → 60s backoff (72s worst case).
        clockNow += 7_000; // total 19s past 2nd failure
        const f3 = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
        expect(f3.outcome).toBe("failed");
        expect(calls).toHaveLength(3);

        // Inside 60s±20%: still debounced.
        clockNow += 50_000;
        expect((await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn)).reason).toBe("debounced");
        expect(calls).toHaveLength(3);

        // Past 72s: re-probe fires (call #4) → 4th failure → 300s cap backoff.
        clockNow += 23_000; // total 73s past 3rd failure
        const f4 = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
        expect(f4.outcome).toBe("failed");
        expect(calls).toHaveLength(4);

        // Still well inside the 300s cap window: debounced.
        clockNow += 200_000;
        expect((await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn)).reason).toBe("debounced");
        expect(calls).toHaveLength(4);
      } finally {
        warnSpy.mockRestore();
      }
    });

    /**
     * A conclusive probe resets the consecutive-failure counter to 0, so the
     * next failure starts again at the short 5s tier instead of the capped tier.
     */
    it("resets the failure count after a conclusive probe", async () => {
      const provider = "orpRST";
      const pool = makePool(provider, ["sk-a", "sk-b"]);
      let call = 0;
      const { fetchFn, calls } = makeFetch(() => {
        call += 1;
        if (call === 1) return jsonResponse({ error: "upstream 503" }, 503); // fail → 5s tier
        if (call === 2) return jsonResponse({ data: { limit_remaining: 5, free_model_daily_requests: { remaining: 9 } } }); // conclusive → reset
        return jsonResponse({ error: "upstream 503" }, 503); // fail → back to 5s tier
      });
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        // 1st failure → 5s tier.
        await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
        // Past 6s → re-probe → conclusive healthy → reset.
        clockNow += 7_000;
        const healthy = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
        expect(healthy.outcome).toBe("conclusive");
        expect(healthy.reason).toBe("healthy");
        // Past the long debounce (conclusive) → re-probe → failure → SHORT 5s tier again.
        clockNow += LONG_DEBOUNCE_MS + 1;
        const failedAgain = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
        expect(failedAgain.outcome).toBe("failed");
        // Inside a SHORT 5s window: debounced (proves the counter reset — otherwise
        // this would be the 60s/300s tier and still debounced, so the distinguishing
        // assertion is that a re-probe fires shortly after 5s, not 15s+).
        clockNow += 7_000; // 7s past the failure — past the 5s tier's 6s worst case
        const reprob = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
        expect(reprob.outcome).toBe("failed");
        expect(calls).toHaveLength(4); // 4th call fired at 7s (would NOT have at 15s tier)
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("holds a successful probe for the long TTL and re-probes only after it expires", async () => {
      const provider = "orp9";
      const pool = makePool(provider, ["sk-a", "sk-b"]);
      let call = 0;
      const { fetchFn, calls } = makeFetch(() => {
        call += 1;
        return call === 1
          ? jsonResponse({ data: { limit_remaining: 4, free_model_daily_requests: { remaining: 9 } } })
          : jsonResponse({ data: { limit_remaining: 0 } });
      });

      const first = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
      expect(first.reason).toBe("healthy");

      // Past the failure backoff a conclusive probe is still debounced.
      clockNow += 7_000;
      expect((await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn)).reason).toBe("debounced");
      expect(calls).toHaveLength(1);

      // One millisecond before the long TTL lapses: still debounced.
      clockNow += LONG_DEBOUNCE_MS - 8_000;
      expect((await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn)).reason).toBe("debounced");
      expect(calls).toHaveLength(1);

      // Past the long TTL the next request re-probes, and its verdict is applied.
      clockNow += 2_000;
      const after = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);
      expect(after.verifiedExhausted).toBe(true);
      expect(after.reason).toBe("openrouter_limit_exhausted");
      expect(after.outcome).toBe("conclusive");
      expect(calls).toHaveLength(2);
      expect(pool.getCooldownManager().isQuarantined(`${provider}:0`)).toBe(true);
    });

    /**
     * Defence-in-depth for the `typeof remaining === "number"` guard: the
     * predicate must reject non-number shapes (string "0", null, missing) so a
     * malformed upstream body never conserves a key. The negative-number test
     * above is the primary L7 red-first; this guards the type predicate itself.
     */
    it("does not conserve when free_model_daily_requests.remaining is not a number", async () => {
      const malformed = [
        { limit_remaining: 6, free_model_daily_requests: { remaining: "0" } },
        { limit_remaining: 6, free_model_daily_requests: { remaining: null } },
        { limit_remaining: 6 },
      ];

      for (const [i, data] of malformed.entries()) {
        const provider = `orpN${i}`;
        const pool = makePool(provider, ["sk-a", "sk-b"]);
        const { fetchFn, calls } = makeFetch(() => jsonResponse({ data }));

        const result = await verifyAndConserve(provider, 0, "sk-a", pool, fetchFn);

        expect(result.verifiedExhausted).toBe(false);
        expect(result.conserveTtlSec).toBe(0);
        expect(result.reason).toBe("healthy");
        expect(result.outcome).toBe("conclusive");
        expect(calls).toHaveLength(1);
        expect(pool.getStatus(provider)).toEqual({ total: 2, active: 2, quarantined: 0 });
        expect(pool.getCooldownManager().isQuarantined(`${provider}:0`)).toBe(false);
      }
    });
  });
});