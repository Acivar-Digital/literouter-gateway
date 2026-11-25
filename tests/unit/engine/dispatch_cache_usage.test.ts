/**
 * Dispatch usage extraction & KV-cache observability (issue #9, post-e2e fix).
 *
 * Seam under test: the real `executeDispatchPipeline` (non-streaming branch) with
 * an injected fetch, asserting the observable `[USAGE]` log line that operators
 * actually read to confirm prefix-cache reuse. No source-text or wiring echoes.
 *
 * The bug this pins down: `extractUsage` read only OpenAI-Chat field names, so an
 * Anthropic-wire or Responses-API body — which reports `input_tokens` /
 * `output_tokens` / `cache_read_input_tokens` — produced `Prompt=0 | Completion=0`
 * and no `Cached=` segment at all, making the ticket's headline KPI unmeasurable.
 *
 * No live network: fetch is always injected. No `mock.module`: Bun applies module
 * mocks process-globally in file-load order; the pacer is neutralised through its
 * declarative config instead (same approach as ./session_pin.test.ts).
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
import { traceBuffer } from "../../../src/telemetry/ring_buffer";
import { globalKeyPool } from "../../../src/handlers/openai_compat";

interface RawProviderEntry {
  pacer?: { enabled?: boolean };
}

interface RawProvidersConfig {
  providers: Record<string, RawProviderEntry>;
}

/**
 * Every provider in the real config ships with pacing enabled (20-50ms per
 * dispatch). Boot the registry from the same on-disk file with pacing turned off
 * so `acquirePacer` short-circuits; `afterEach` restores the untouched config.
 */
function providersConfigWithPacerDisabled(): unknown {
  const text = readFileSync(new URL("../../../config/providers.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("providers" in parsed)) {
    throw new Error("[dispatch_cache_usage] providers.json has no providers map");
  }
  const config = parsed as RawProvidersConfig;
  for (const entry of Object.values(config.providers)) {
    if (entry.pacer) entry.pacer.enabled = false;
  }
  return config;
}

const PROVIDER = "or";
const KEYS = ["sk-cache-a", "sk-cache-b", "sk-cache-c"];

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

function buildRequest(): DispatchRequest {
  const outbound: OutboundWirePayload = {
    endpointKey: "ch",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    isStreaming: false,
  };

  return {
    reqId: `cache-usage-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    method: "POST",
    path: "/v1/chat/completions",
    directive: mockDirective,
    rawInboundBody: { model: "test-model" },
    outboundPayload: outbound,
    clientSignal: new AbortController().signal,
    clientHeaders: new Headers({ "user-agent": "OpenCode/1.0" }),
    transformer: mockTransformer,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Runs one non-streaming dispatch and returns everything the process logged,
 * joined. The `[USAGE] ... Tokens:` line is the operator-visible proof.
 */
async function dispatchAndCaptureLog(body: unknown): Promise<string> {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    const res = await executeDispatchPipeline(buildRequest(), async () => jsonResponse(body));
    expect(res.status).toBe(200);
    return logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    logSpy.mockRestore();
  }
}

/**
 * Same seam, but returns the dispatched request so the caller can look the
 * persisted trace up by reqId. `recordTrace` pushes to the process-wide
 * `traceBuffer` singleton, which is the observable an operator reads back
 * through `/v1/traces`.
 */
async function dispatchAndGetReqId(body: unknown): Promise<string> {
  const req = buildRequest();
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    const res = await executeDispatchPipeline(req, async () => jsonResponse(body));
    expect(res.status).toBe(200);
    return req.reqId;
  } finally {
    logSpy.mockRestore();
  }
}

describe("Dispatch usage extraction & KV-cache observability", () => {
  beforeEach(() => {
    resetStrategyRegistry();
    initProviderRegistry(providersConfigWithPacerDisabled());
    initStrategyRegistry();
    globalKeyPool.reset();
    globalKeyPool.setPool(PROVIDER, KEYS);
  });

  afterEach(() => {
    initProviderRegistry();
    globalKeyPool.reset();
  });

  it("logs cached tokens from an OpenAI-Chat shaped usage block", async () => {
    const logged = await dispatchAndCaptureLog({
      id: "chatcmpl-1",
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 34,
        total_tokens: 1234,
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    });

    expect(logged).toContain("Prompt=1,200");
    expect(logged).toContain("Completion=34");
    expect(logged).toContain("Total=1,234");
    expect(logged).toContain("Cached=1,024");
  });

  it("normalizes Anthropic shaped usage (input_tokens/output_tokens/cache_read_input_tokens)", async () => {
    const logged = await dispatchAndCaptureLog({
      id: "msg_1",
      type: "message",
      role: "assistant",
      usage: {
        input_tokens: 1000,
        output_tokens: 20,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 64,
      },
    });

    expect(logged).toContain("Prompt=1,000");
    expect(logged).toContain("Completion=20");
    // total_tokens is absent: derived from the normalized prompt + completion.
    expect(logged).toContain("Total=1,020");
    expect(logged).toContain("Cached=800");
    expect(logged).toContain("CacheWrite=64");
  });

  it("normalizes Responses-API shaped usage (input_tokens/output_tokens/input_tokens_details)", async () => {
    const logged = await dispatchAndCaptureLog({
      id: "resp_1",
      object: "response",
      output: [],
      usage: {
        input_tokens: 500,
        output_tokens: 12,
        input_tokens_details: { cached_tokens: 256 },
      },
    });

    expect(logged).toContain("Prompt=500");
    expect(logged).toContain("Completion=12");
    expect(logged).toContain("Cached=256");
  });

  it("keeps the zero fallback when the upstream body carries no usage block", async () => {
    const logged = await dispatchAndCaptureLog({ id: "chatcmpl-no-usage" });

    expect(logged).toContain("Prompt=0");
    expect(logged).toContain("Completion=0");
    expect(logged).toContain("Total=0");
    // Nothing was reported, so no cache segment may be invented.
    expect(logged).not.toContain("Cached=");
    expect(logged).not.toContain("CacheWrite=");
    expect(logged).not.toContain("Discount=");
  });

  it("suppresses the Cached= segment when the upstream reports zero cached tokens", async () => {
    const logged = await dispatchAndCaptureLog({
      id: "chatcmpl-cold",
      usage: {
        prompt_tokens: 900,
        completion_tokens: 10,
        total_tokens: 910,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });

    expect(logged).toContain("Prompt=900");
    // formatCacheMetric drops non-positive values: a cold cache prints no segment.
    expect(logged).not.toContain("Cached=");
  });

  it("persists cached and cache-write token counts onto the recorded trace", async () => {
    const reqId = await dispatchAndGetReqId({
      id: "chatcmpl-trace",
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 34,
        total_tokens: 1234,
        prompt_tokens_details: { cached_tokens: 1024 },
        cache_creation_input_tokens: 256,
      },
    });

    const trace = traceBuffer.get(reqId);
    expect(trace).toBeDefined();
    expect(trace?.tokensCached).toBe(1024);
    expect(trace?.tokensCacheWrite).toBe(256);
    expect(trace?.tokensPrompt).toBe(1200);
    expect(trace?.tokensCompletion).toBe(34);
  });

  it("omits trace cache fields entirely when the upstream reports none", async () => {
    const reqId = await dispatchAndGetReqId({ id: "chatcmpl-trace-cold" });

    const trace = traceBuffer.get(reqId);
    expect(trace).toBeDefined();
    // Undefined, never 0: an unreported cache metric is absence of data, not a
    // measured zero, and the column must stay NULL rather than lie.
    expect(trace?.tokensCached).toBeUndefined();
    expect(trace?.tokensCacheWrite).toBeUndefined();
    expect(trace?.cacheDiscount).toBeUndefined();
  });
});