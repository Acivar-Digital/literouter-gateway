/**
 * Session-sticky key rotation — engine-level contract (issue #9, blueprint §2.7).
 *
 * Seam under test: the real `executeDispatchPipeline` driven with an injected
 * fetch (the established pattern in ./dispatch.test.ts) over the real
 * `globalKeyPool`, plus the real `KeyPool` pin primitives where a deterministic
 * clock is required. `extractClientSessionId` is exercised through the dispatch
 * request's `clientHeaders`; no test asserts source text or wiring echoes.
 *
 * No live network: the dispatch fetch is always injected, and the fire-and-forget
 * OpenRouter probe (which uses the global fetch) is served by a temporary
 * `globalThis.fetch` stub that is restored in a `finally`.
 *
 * No `mock.module` here: Bun applies module mocks process-globally in file-load
 * order, so a mock declared in this file would corrupt every test file that
 * loads after it (pacer_adapter.test.ts sorts after session_pin.test.ts). The
 * pacer is instead neutralised through its declarative config — see
 * `providersConfigWithPacerDisabled`.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { initProviderRegistry } from "../../../src/config/providers";
import type { ParsedDirective } from "../../../src/directive/types";
import {
  executeDispatchPipeline,
  type DispatchRequest,
  type OutboundWirePayload,
  type PayloadTransformerContract,
} from "../../../src/engine/dispatch";
import { initStrategyRegistry, resetStrategyRegistry } from "../../../src/engine/strategy_registry";
import { globalKeyPool } from "../../../src/handlers/openai_compat";
import { KeyPool } from "../../../src/network/pool";

/** Restorable test double handle (Bun's `Mock` is not re-exported as a type here). */
interface RestorableMock {
  mockRestore: () => void;
}

interface RawProviderEntry {
  pacer?: { enabled?: boolean };
}

interface RawProvidersConfig {
  providers: Record<string, RawProviderEntry>;
}

/**
 * The engine reads pacer settings from the provider registry and every provider
 * in the real config ships with pacing enabled (20-50ms per dispatch). Boot the
 * registry from the same on-disk file with pacing turned off so `acquirePacer`
 * short-circuits without sleeping; `afterEach` restores the untouched config.
 */
function providersConfigWithPacerDisabled(): unknown {
  const text = readFileSync(new URL("../../../config/providers.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("providers" in parsed)) {
    throw new Error("[session_pin] providers.json has no providers map");
  }
  const config = parsed as RawProvidersConfig;
  for (const entry of Object.values(config.providers)) {
    if (entry.pacer) entry.pacer.enabled = false;
  }
  return config;
}

const PROVIDER = "or";
const KEYS = ["sk-pin-a", "sk-pin-b", "sk-pin-c"];
const AUTH_A = "Bearer sk-pin-a";
const AUTH_B = "Bearer sk-pin-b";
const AUTH_C = "Bearer sk-pin-c";

const mockDirective: ParsedDirective = {
  type: "direct",
  raw: "lr-or-oa-ch-no",
  provider: "or",
  payload: "oa",
  wire: "oa",
  completion: "ch",
  endpoint: "ch",
  nuances: ["no"],
};

const mockTransformer: PayloadTransformerContract = {
  transformClientToWire(body) {
    return {
      endpointKey: "ch",
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      isStreaming: false,
    };
  },
  transformWireToClient(upstreamJson) {
    return { transformed: upstreamJson };
  },
  createWireToClientStream() {
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    });
  },
};

function buildRequest(overrides?: Partial<DispatchRequest>): DispatchRequest {
  const outbound: OutboundWirePayload = {
    endpointKey: "ch",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    isStreaming: false,
  };

  return {
    reqId: `session-pin-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    method: "POST",
    path: "/v1/chat/completions",
    directive: mockDirective,
    rawInboundBody: { model: "test-model" },
    outboundPayload: outbound,
    clientSignal: new AbortController().signal,
    clientHeaders: new Headers({ "user-agent": "OpenCode/1.0" }),
    transformer: mockTransformer,
    ...overrides,
  };
}

/** Request carrying a client session header under an arbitrary accepted key. */
function sessionRequest(headerName: string, sessionId: string): DispatchRequest {
  return buildRequest({
    clientHeaders: new Headers({ "user-agent": "OpenCode/1.0", [headerName]: sessionId }),
  });
}

function okResponse(): Response {
  return new Response(JSON.stringify({ id: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, message: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/** Reads the outbound Authorization header regardless of Headers/record shape. */
function authHeaderOf(init?: RequestInit): string {
  const headers = init?.headers;
  if (!headers) return "";
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get("authorization") ?? "";
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === "authorization") return value;
  }
  return "";
}

interface RecordingFetch {
  readonly fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly usedAuth: string[];
  readonly attempts: () => number;
}

/** Records the Authorization header of every upstream attempt. */
function recordingFetch(statuses: readonly number[]): RecordingFetch {
  const usedAuth: string[] = [];
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    usedAuth.push(authHeaderOf(init));
    const status = statuses[usedAuth.length - 1] ?? 200;
    if (status === 200) return okResponse();
    if (status === 429) return errorResponse(429, "Rate limit reached", { "retry-after": "1" });
    return errorResponse(status, `upstream status ${status}`);
  };
  return { fetchFn, usedAuth, attempts: () => usedAuth.length };
}

describe("Session-sticky key rotation (dispatch → KeyPool pins)", () => {
  let sleepSpy: RestorableMock | undefined;

  beforeEach(() => {
    resetStrategyRegistry();
    initProviderRegistry(providersConfigWithPacerDisabled());
    initStrategyRegistry();
    globalKeyPool.reset();
    globalKeyPool.setPool(PROVIDER, KEYS);
    // Retry backoff would otherwise add real delay between rotation attempts.
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(async () => {});
  });

  afterEach(() => {
    sleepSpy?.mockRestore();
    sleepSpy = undefined;
    // Restore the real registry so no later test file inherits a disabled pacer.
    initProviderRegistry();
    globalKeyPool.reset();
  });

  it("keeps a session on the same key across repeated dispatches when no failure occurs", async () => {
    const { fetchFn, usedAuth } = recordingFetch([200, 200, 200]);
    const req = sessionRequest("session-id", "ses_sticky_stable");

    for (let i = 0; i < 3; i += 1) {
      const res = await executeDispatchPipeline(req, fetchFn);
      expect(res.status).toBe(200);
    }

    // Pin honored: the round-robin pointer never advances for this session.
    expect(usedAuth).toEqual([AUTH_A, AUTH_A, AUTH_A]);
  });

  it("keeps two sessions on distinct, stable keys", async () => {
    const { fetchFn, usedAuth } = recordingFetch([200, 200, 200, 200]);

    const s1 = sessionRequest("session-id", "ses_session_one");
    const s2 = sessionRequest("session-id", "ses_session_two");

    expect((await executeDispatchPipeline(s1, fetchFn)).status).toBe(200);
    expect((await executeDispatchPipeline(s2, fetchFn)).status).toBe(200);
    expect((await executeDispatchPipeline(s1, fetchFn)).status).toBe(200);
    expect((await executeDispatchPipeline(s2, fetchFn)).status).toBe(200);

    // Each session is glued to its own key; neither hijacks the other.
    expect(usedAuth).toEqual([AUTH_A, AUTH_B, AUTH_A, AUTH_B]);
  });

  it("treats any accepted session header spelling as the same sticky identity", async () => {
    const { fetchFn, usedAuth } = recordingFetch([200, 200]);

    const first = sessionRequest("x-session-id", "ses_alias_identity");
    const second = sessionRequest("opencode-session", "ses_alias_identity");

    expect((await executeDispatchPipeline(first, fetchFn)).status).toBe(200);
    expect((await executeDispatchPipeline(second, fetchFn)).status).toBe(200);

    expect(usedAuth).toEqual([AUTH_A, AUTH_A]);
  });

  it("rotates the session's key on a 429 and re-pins the session to the fresh key", async () => {
    const { fetchFn, usedAuth, attempts } = recordingFetch([429, 200]);
    const req = sessionRequest("session-id", "ses_rotate_429");

    const res = await executeDispatchPipeline(req, fetchFn);

    expect(res.status).toBe(200);
    expect(attempts()).toBe(2);
    // Attempt 1 used the pinned key; the 429 rotated the pin to the next key.
    expect(usedAuth).toEqual([AUTH_A, AUTH_B]);

    // Follow-up request on the same session resumes on the rotated key (re-pinned).
    const followUp = recordingFetch([200]);
    const followUpRes = await executeDispatchPipeline(
      sessionRequest("session-id", "ses_rotate_429"),
      followUp.fetchFn
    );
    expect(followUpRes.status).toBe(200);
    expect(followUp.usedAuth).toEqual([AUTH_B]);
  });

  it("rotates the session's key on a 402 and re-pins the session to the fresh key", async () => {
    const originalFetch = globalThis.fetch;
    const probedAuth: string[] = [];
    // The fire-and-forget OpenRouter verifier uses the global fetch; serve it a
    // healthy key document so no live request is made and nothing is conserved.
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      probedAuth.push(authHeaderOf(init));
      return new Response(
        JSON.stringify({ data: { limit_remaining: 42, free_model_daily_requests: { remaining: 7 } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const { fetchFn, usedAuth, attempts } = recordingFetch([402, 200]);
      const res = await executeDispatchPipeline(
        sessionRequest("session-id", "ses_rotate_402"),
        fetchFn
      );

      expect(res.status).toBe(200);
      expect(attempts()).toBe(2);
      expect(usedAuth).toEqual([AUTH_A, AUTH_B]);
      // The 402 also triggered verification of the depleted key (never awaited).
      expect(probedAuth).toContain(AUTH_A);

      const followUp = recordingFetch([200]);
      const followUpRes = await executeDispatchPipeline(
        sessionRequest("session-id", "ses_rotate_402"),
        followUp.fetchFn
      );
      expect(followUpRes.status).toBe(200);
      expect(followUp.usedAuth).toEqual([AUTH_B]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps un-sessioned requests on plain round-robin and never pins them", async () => {
    const { fetchFn, usedAuth } = recordingFetch([200, 200, 200, 200, 200, 200]);

    for (let i = 0; i < 6; i += 1) {
      const res = await executeDispatchPipeline(buildRequest(), fetchFn);
      expect(res.status).toBe(200);
    }

    // Strict round-robin with no sticky behaviour: two full sweeps of the pool.
    expect(usedAuth).toEqual([AUTH_A, AUTH_B, AUTH_C, AUTH_A, AUTH_B, AUTH_C]);
  });

  it("lets anonymous traffic flow without disturbing an existing session pin", async () => {
    const session = sessionRequest("session-id", "ses_anon_isolation");
    const first = recordingFetch([200]);
    expect((await executeDispatchPipeline(session, first.fetchFn)).status).toBe(200);
    expect(first.usedAuth).toEqual([AUTH_A]);

    const anonymous = recordingFetch([200, 200, 200]);
    for (let i = 0; i < 3; i += 1) {
      expect((await executeDispatchPipeline(buildRequest(), anonymous.fetchFn)).status).toBe(200);
    }
    // Anonymous calls keep rotating the shared pointer ...
    expect(anonymous.usedAuth).toEqual([AUTH_B, AUTH_C, AUTH_A]);

    // ... but the session's pin is untouched and still resolves to its own key.
    const again = recordingFetch([200]);
    expect((await executeDispatchPipeline(session, again.fetchFn)).status).toBe(200);
    expect(again.usedAuth).toEqual([AUTH_A]);
  });

  it("invalidates the session pin on auth death (403) so the session resumes on a healthy key", async () => {
    const { fetchFn, usedAuth } = recordingFetch([403, 200, 200]);
    const session = sessionRequest("session-id", "ses_auth_death");

    const first = await executeDispatchPipeline(session, fetchFn);
    expect(first.status).toBe(403);
    expect(usedAuth).toEqual([AUTH_A]);

    // 403 carries a zero cooldown TTL, so key A is still selectable: the only way
    // the next request can land on B is that the pin was dropped by reportFailure.
    expect(globalKeyPool.getStatus(PROVIDER).quarantined).toBe(0);

    const second = await executeDispatchPipeline(
      sessionRequest("session-id", "ses_auth_death"),
      fetchFn
    );
    expect(second.status).toBe(200);
    expect(usedAuth).toEqual([AUTH_A, AUTH_B]);

    const third = await executeDispatchPipeline(
      sessionRequest("session-id", "ses_auth_death"),
      fetchFn
    );
    expect(third.status).toBe(200);
    // The healthy key is now the session's pin again.
    expect(usedAuth).toEqual([AUTH_A, AUTH_B, AUTH_B]);
  });

  it("invalidates the session pin on auth death (401) as well", async () => {
    const { fetchFn, usedAuth } = recordingFetch([401, 200]);

    const first = await executeDispatchPipeline(
      sessionRequest("session-id", "ses_auth_death_401"),
      fetchFn
    );
    expect(first.status).toBe(401);

    const second = await executeDispatchPipeline(
      sessionRequest("session-id", "ses_auth_death_401"),
      fetchFn
    );
    expect(second.status).toBe(200);
    expect(usedAuth).toEqual([AUTH_A, AUTH_B]);
  });
});

describe("body-session pinning (issue #10)", () => {
  let sleepSpy: RestorableMock | undefined;

  beforeEach(() => {
    resetStrategyRegistry();
    initProviderRegistry(providersConfigWithPacerDisabled());
    initStrategyRegistry();
    globalKeyPool.reset();
    globalKeyPool.setPool(PROVIDER, KEYS);
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(async () => {});
  });

  afterEach(() => {
    sleepSpy?.mockRestore();
    sleepSpy = undefined;
    initProviderRegistry();
    globalKeyPool.reset();
  });

  it("pins a session from rawInboundBody.prompt_cache_key across 3 dispatches (no headers)", async () => {
    const { fetchFn, usedAuth } = recordingFetch([200, 200, 200]);
    const req = buildRequest({
      rawInboundBody: {
        model: "test-model",
        prompt_cache_key: "01a20084-1c95-7733-b798-a6f3fdac3eee",
      },
      clientHeaders: new Headers({ "user-agent": "x" }),
    });

    for (let i = 0; i < 3; i += 1) {
      const res = await executeDispatchPipeline(req, fetchFn);
      expect(res.status).toBe(200);
    }

    // All three hit the same pinned key (no round-robin advancement).
    expect(usedAuth).toEqual([AUTH_A, AUTH_A, AUTH_A]);
  });

  it("header session-id takes precedence over body prompt_cache_key", async () => {
    // 1st request: both header AND body present — header must win.
    const both = buildRequest({
      clientHeaders: new Headers({
        "user-agent": "x",
        "x-session-id": "header-sess",
      }),
      rawInboundBody: {
        model: "test-model",
        prompt_cache_key: "body-sess",
      },
    });
    expect((await executeDispatchPipeline(both, recordingFetch([200]).fetchFn)).status).toBe(200);

    // 2nd request: only the header — must land on the SAME key as #1.
    const headerOnly = recordingFetch([200]);
    expect(
      (await executeDispatchPipeline(
        buildRequest({
          clientHeaders: new Headers({
            "user-agent": "x",
            "x-session-id": "header-sess",
          }),
        }),
        headerOnly.fetchFn
      )).status
    ).toBe(200);
    expect(headerOnly.usedAuth).toEqual([AUTH_A]);

    // Requests with ONLY the body: the body session is a distinct identity, so
    // it must land on a different key than the header session AND stay pinned
    // there. Without body reading these are anonymous and rotate B, C, A.
    const bodyOnly = recordingFetch([200, 200, 200]);
    for (let i = 0; i < 3; i += 1) {
      expect(
        (
          await executeDispatchPipeline(
            buildRequest({
              rawInboundBody: {
                model: "test-model",
                prompt_cache_key: "body-sess",
              },
              clientHeaders: new Headers({ "user-agent": "x" }),
            }),
            bodyOnly.fetchFn
          )
        ).status
      ).toBe(200);
    }
    expect(bodyOnly.usedAuth).toEqual([AUTH_B, AUTH_B, AUTH_B]);
  });

  it("pins a session from rawInboundBody.session_id across 3 dispatches (no headers)", async () => {
    const { fetchFn, usedAuth } = recordingFetch([200, 200, 200]);
    const req = buildRequest({
      rawInboundBody: {
        model: "test-model",
        session_id: "ses_body_sticky",
      },
      clientHeaders: new Headers({ "user-agent": "x" }),
    });

    for (let i = 0; i < 3; i += 1) {
      const res = await executeDispatchPipeline(req, fetchFn);
      expect(res.status).toBe(200);
    }

    expect(usedAuth).toEqual([AUTH_A, AUTH_A, AUTH_A]);
  });

  it("rotates the body-prompt_cache_key-pinned session on 402 and re-pins", async () => {
    // The fire-and-forget 402 probe debounces per `or:<keyIndex>` for 300s in
    // module state that no test hook resets (src/network/openrouter_probe.ts
    // exposes no reset, and dispatch only probes the "or" provider, so a
    // distinct provider cannot dodge the collision). To stay order-independent
    // the body session is deliberately started on key index 1 — a single
    // anonymous warm-up dispatch advances the round-robin pointer past index 0
    // — so its 402 probe hits `or:1`, disjoint from the header 402 test's
    // `or:0` stamp. The warm-up returns 200, which never reaches the probe.
    const warmUp = recordingFetch([200]);
    expect((await executeDispatchPipeline(buildRequest(), warmUp.fetchFn)).status).toBe(200);
    expect(warmUp.usedAuth).toEqual([AUTH_A]);

    const originalFetch = globalThis.fetch;
    const probedAuth: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      probedAuth.push(authHeaderOf(init));
      return new Response(
        JSON.stringify({ data: { limit_remaining: 42, free_model_daily_requests: { remaining: 7 } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const { fetchFn, usedAuth, attempts } = recordingFetch([402, 200]);
      const req = buildRequest({
        rawInboundBody: {
          model: "test-model",
          prompt_cache_key: "01a20084-402-body-pin",
        },
        clientHeaders: new Headers({ "user-agent": "x" }),
      });

      const res = await executeDispatchPipeline(req, fetchFn);

      expect(res.status).toBe(200);
      expect(attempts()).toBe(2);
      // Pinned to key 1 (AUTH_B); the 402 rotated it to key 2 (AUTH_C).
      expect(usedAuth).toEqual([AUTH_B, AUTH_C]);
      // The 402 triggered verification of the depleted key (never awaited).
      expect(probedAuth).toContain(AUTH_B);

      // Follow-up on the same body session resumes on the rotated key.
      const followUp = recordingFetch([200]);
      const followUpRes = await executeDispatchPipeline(
        buildRequest({
          rawInboundBody: {
            model: "test-model",
            prompt_cache_key: "01a20084-402-body-pin",
          },
          clientHeaders: new Headers({ "user-agent": "x" }),
        }),
        followUp.fetchFn
      );
      expect(followUpRes.status).toBe(200);
      expect(followUp.usedAuth).toEqual([AUTH_C]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("KeyPool session-pin primitives (deterministic clock)", () => {
  it("rotateSessionKey advances to the next healthy key and re-pins the session", () => {
    const pool = new KeyPool(undefined, { ttlMs: 60_000 });
    pool.setPool("rotpin", KEYS);
    const t0 = 1_700_000_000_000;

    try {
      expect(pool.selectNextKey("rotpin", t0, "ses_rot")?.index).toBe(0);

      const rotated = pool.rotateSessionKey("rotpin", "ses_rot", t0);
      expect(rotated?.index).toBe(1);
      expect(rotated?.key).toBe(KEYS[1]);

      // Re-pinned: the next selection for the session stays on the rotated key.
      expect(pool.selectNextKey("rotpin", t0 + 1, "ses_rot")?.index).toBe(1);
    } finally {
      pool.reset();
    }
  });

  it("rotateSessionKey skips a quarantined key when picking the session's next key", () => {
    const pool = new KeyPool();
    pool.setPool("rotskip", KEYS);
    const t0 = 1_700_000_000_000;

    try {
      expect(pool.selectNextKey("rotskip", t0, "ses_skip")?.index).toBe(0);
      pool.quarantineKey("rotskip", 1, 60, "test_quarantine", 500, t0);

      const rotated = pool.rotateSessionKey("rotskip", "ses_skip", t0);
      expect(rotated?.index).toBe(2);
      expect(rotated?.key).toBe(KEYS[2]);
    } finally {
      pool.reset();
    }
  });

  it("reportFailure on a pinned key drops the pin even while the key is quarantined", () => {
    const pool = new KeyPool(undefined, { ttlMs: 300_000 });
    pool.setPool("authpin", KEYS);
    const t0 = 1_700_000_000_000;

    try {
      expect(pool.selectNextKey("authpin", t0, "ses_dead")?.index).toBe(0);

      // 500 -> 10s quarantine; the pin would live for 300s.
      pool.reportFailure("authpin", 0, 500, undefined, "boom", t0);
      expect(pool.getStatus("authpin", t0).quarantined).toBe(1);

      // Past the quarantine but well inside the pin TTL: a surviving pin would
      // still resolve to key 0, an invalidated pin falls through to round-robin.
      const afterQuarantine = pool.selectNextKey("authpin", t0 + 10_001, "ses_dead");
      expect(afterQuarantine?.index).toBe(1);
    } finally {
      pool.reset();
    }
  });

  it("honours a live session pin when the pinned key stays healthy (control)", () => {
    const pool = new KeyPool(undefined, { ttlMs: 300_000 });
    pool.setPool("healthypin", KEYS);
    const t0 = 1_700_000_000_000;

    try {
      expect(pool.selectNextKey("healthypin", t0, "ses_alive")?.index).toBe(0);
      // Same clock jump as the invalidation test, but no failure was reported.
      expect(pool.selectNextKey("healthypin", t0 + 10_001, "ses_alive")?.index).toBe(0);
    } finally {
      pool.reset();
    }
  });

  it("expires a stale session pin and falls back to round-robin", () => {
    const pool = new KeyPool(undefined, { ttlMs: 1_000 });
    pool.setPool("ttlp", KEYS);
    const t0 = 1_700_000_000_000;

    try {
      expect(pool.selectNextKey("ttlp", t0, "ses_ttl")?.index).toBe(0);
      // Pin TTL elapsed: no pin, so selection resumes from the round-robin pointer.
      expect(pool.selectNextKey("ttlp", t0 + 1_001, "ses_ttl")?.index).toBe(1);
    } finally {
      pool.reset();
    }
  });
});