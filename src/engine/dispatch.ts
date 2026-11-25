import { getEnv } from "../config/env";
import { getProviderConfig } from "../config/providers";
import type { ProviderConfigEntry } from "../config/schema";
import type { ParsedDirective } from "../directive/types";
import { acquirePacer } from "./pacer_adapter";
import { calculateRetryDelay } from "./retry";
import { defaultClassifyFailure, type FailureAction } from "./status_classify";
import type { DispatchContext, ProviderExecutionStrategy } from "./strategy";
import { getStrategy } from "./strategy_registry";
import { safeClose, safeEnqueue, NoResponseError } from "../network/fetcher";
import { isProviderQuarantineEnabled, isFatalAuthError } from "../network/pool";
import { classifyUpstreamError } from "../network/classifier";
import type { ConserveRule } from "../network/cooldown";
import { verifyAndConserve } from "../network/openrouter_probe";
import type { OutboundWirePayload, PayloadTransformerContract } from "./transformer";
import {
  globalKeyPool,
  overrideProviderUrl,
  executeFusionFlow,
  type OpenAIRequestPayload,
} from "../handlers/openai_compat";
import { RequestTelemetry, type UsageRecord } from "../telemetry/session";
import { traceBuffer, MAX_LEG_BYTES, type SanitizedTrace } from "../telemetry/ring_buffer";
import { traceWriter } from "../telemetry/trace_writer";
import { sanitizeBody } from "../telemetry/sanitize";
import { extractErrorMessage } from "../ui/logger";
import { ensureSessionHeaders, extractBodySessionId, extractClientSessionId } from "./session_id";
import {
  accumulateZenStreamToCompletion,
  accumulateZenResponsesStream,
} from "./zen";

export type { OutboundWirePayload, PayloadTransformerContract };

export interface DispatchRequest {
  readonly reqId: string;
  readonly method: string;
  readonly path: string;
  readonly directive: ParsedDirective;
  readonly rawInboundBody: Record<string, unknown>;
  readonly outboundPayload: OutboundWirePayload;
  readonly clientSignal: AbortSignal;
  readonly clientHeaders: Headers;
  readonly transformer: PayloadTransformerContract;
}

export interface ResolvedTarget {
  readonly model: string;
  readonly upstreamUrl: string;
  readonly extraHeaders?: Record<string, string>;
  readonly tier?: number;
}

export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

function defaultTarget(
  provConfig: ProviderConfigEntry,
  req: DispatchRequest
): ResolvedTarget {
  const endpointKey = req.outboundPayload.endpointKey as keyof typeof provConfig.endpoints;
  const endpointPath = (provConfig.endpoints[endpointKey] as string | undefined) ?? "";
  const base = provConfig.base_url.replace(/\/+$/, "");
  const rel = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  const model = String(req.rawInboundBody.model ?? "default");

  return {
    model,
    upstreamUrl: `${base}${rel}`,
  };
}

function defaultAuthHeaders(
  provConfig: ProviderConfigEntry,
  key: string
): Record<string, string> {
  const authType = provConfig.auth_header;
  if (authType === "x-api-key") {
    return { "x-api-key": key };
  }
  return { Authorization: `Bearer ${key}` };
}

function setHeaderCaseInsensitive(
  headers: Record<string, string>,
  key: string,
  value: string
): void {
  const lower = key.toLowerCase();
  for (const existingKey of Object.keys(headers)) {
    if (existingKey.toLowerCase() === lower) {
      delete headers[existingKey];
    }
  }
  headers[key] = value;
}

export const BANNED_OUTBOUND_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

export const SAFE_CLIENT_PASS_HEADERS = new Set<string>([
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "x-request-id",
  "session-id",
  "x-session-id",
  "user-agent",
  "x-title",
  "http-referer",
]);

function isBannedOutboundHeader(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return lowerKey === "host" || BANNED_OUTBOUND_HEADERS.has(lowerKey);
}

function mergeHeaderSource(
  target: Record<string, string>,
  source?: Record<string, string>,
  filterClientHeaders = false
): void {
  if (!source) return;
  for (const [k, v] of Object.entries(source)) {
    const lower = k.toLowerCase();
    if (
      filterClientHeaders &&
      (isBannedOutboundHeader(lower) ||
        lower === "cookie" ||
        lower === "authorization" ||
        lower === "x-forwarded-for" ||
        lower === "proxy-authorization")
    ) {
      continue;
    }
    setHeaderCaseInsensitive(target, k, v);
  }
}

export function mergeOutboundHeaders(
  authHeaders: Record<string, string>,
  injectedHeaders: Record<string, string>,
  provHeaders?: Record<string, string>,
  targetExtraHeaders?: Record<string, string>,
  payloadHeaders?: Record<string, string>,
  clientHeaders?: Headers | Record<string, string>,
  fallbackSessionId?: string,
  isZen?: boolean
): Record<string, string> {
  const merged: Record<string, string> = {};
  setHeaderCaseInsensitive(merged, "content-type", "application/json");

  mergeHeaderSource(merged, payloadHeaders, true);
  mergeHeaderSource(merged, authHeaders);
  mergeHeaderSource(merged, injectedHeaders);
  mergeHeaderSource(merged, targetExtraHeaders);
  mergeHeaderSource(merged, provHeaders);

  ensureSessionHeaders(merged, clientHeaders ?? payloadHeaders, fallbackSessionId);

  if (isZen) {
    const { scrubZenHeaders, buildZenHeaders } = require("./zen");
    scrubZenHeaders(merged);
    const zenHeaders = buildZenHeaders();
    for (const [k, v] of Object.entries(zenHeaders)) {
      setHeaderCaseInsensitive(merged, k, String(v));
    }
  }

  return merged;
}

function parseRetryAfterSec(headerVal: string | null): number | undefined {
  if (!headerVal) return undefined;
  const num = Number(headerVal);
  if (!Number.isNaN(num) && num >= 0) {
    return num;
  }
  const dateMs = Date.parse(headerVal);
  if (!Number.isNaN(dateMs)) {
    const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
    return Math.max(0, diffSec);
  }
  return undefined;
}

/** First numeric candidate, else undefined; aliases per-wire usage field names. */
function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

function extractUsage(body: unknown): UsageRecord {
  if (body && typeof body === "object" && "usage" in body) {
    const raw = (body as { usage?: Record<string, unknown> }).usage;
    if (raw && typeof raw === "object") {
      const details = raw.prompt_tokens_details;
      const detailsRec = details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
      const inputDetails = raw.input_tokens_details;
      const inputDetailsRec =
        inputDetails && typeof inputDetails === "object" ? (inputDetails as Record<string, unknown>) : undefined;

      // dispatch parses the raw upstream body before any transformer runs, so
      // every wire shape must resolve here: OpenAI-Chat (prompt_tokens), the
      // Responses API (input_tokens + input_tokens_details) and Anthropic
      // (input_tokens + cache_read_input_tokens). Without these aliases an
      // Anthropic 200 logs Prompt=0 with no Cached= segment, hiding this
      // ticket's prefix-cache KPI.
      const promptTokens = pickNumber(raw.prompt_tokens, raw.input_tokens) ?? 0;
      const completionTokens = pickNumber(raw.completion_tokens, raw.output_tokens) ?? 0;
      const totalTokens = pickNumber(raw.total_tokens) ?? promptTokens + completionTokens;
      const cachedTokens = pickNumber(
        detailsRec?.cached_tokens,
        inputDetailsRec?.cached_tokens,
        raw.cache_read_input_tokens,
      );
      const cacheWriteTokens = pickNumber(
        detailsRec?.cache_write_tokens,
        detailsRec?.cache_creation_tokens,
        raw.cache_creation_input_tokens,
      );
      const cacheDiscount = pickNumber(raw.cache_discount);

      return {
        promptTokens,
        completionTokens,
        totalTokens,
        ...(cachedTokens !== undefined ? { cachedTokens } : {}),
        ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
        ...(cacheDiscount !== undefined ? { cacheDiscount } : {}),
      };
    }
  }
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/**
 * Config conserve-rule TTL -> classifier TTL.
 *
 * schema.ts types `conserve_rules[].ttl` as "midnight_utc" | "midnight_pacific"
 * | "indefinite" | "1h" | "24h", but cooldown.ConserveRule.ttl is only
 * `number | "midnight_utc"`. That is not a cosmetic mismatch: resolveConserveTtlSec
 * (cooldown.ts:143) handles exactly two cases - the literal "midnight_utc", and a
 * positive number - and every other string falls through to calculateMidnightUtcSec.
 * So without this table, midnight_pacific / indefinite / 1h / 24h would all be
 * silently coerced to "next midnight UTC", and 1h / 24h would be silently
 * lengthened from hours to up to 24h. The table makes each mapping explicit and
 * greppable instead of relying on that fall-through.
 *
 * midnight_pacific -> "midnight_utc": the classifier cannot resolve Pacific
 *   midnight, so this maps to the nearest expressible reset, UTC midnight.
 *   DELIBERATE APPROXIMATION, not an exact equivalent - a rule intended to
 *   release at Pacific midnight may bench a key slightly early or late.
 * indefinite -> 604800 (7 days): JUDGMENT CALL. "Indefinite" cannot be honored
 *   literally because the pool has no permanent-quarantine state -
 *   quarantineKeyWithTtl only records a cooldown when ttlMs > 0 (cooldown.ts:242),
 *   and ttlMs is computed from this value, so 0 would mean "never quarantined",
 *   the exact opposite of the intent. 7 days is a finite stand-in.
 * 1h -> 3600 and 24h -> 86400: exact. These now behave as the schema author
 *   intended, where the legacy path ignored them.
 */
const CONSERVE_TTL: Record<ProviderConfigEntry["conserve_rules"][number]["ttl"], ConserveRule["ttl"]> = {
  midnight_utc: "midnight_utc",
  midnight_pacific: "midnight_utc",
  indefinite: 604800,
  "1h": 3600,
  "24h": 86400,
};

function toConserveRules(rules: ProviderConfigEntry["conserve_rules"]): ConserveRule[] | undefined {
  if (!rules || rules.length === 0) {
    return undefined;
  }
  return rules.map((rule) => ({
    status: rule.status,
    contains: rule.contains,
    ttl: CONSERVE_TTL[rule.ttl],
    reason: rule.reason,
  }));
}

const DONE_CHUNK = new TextEncoder().encode("data: [DONE]\n\n");

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { name?: unknown; code?: unknown };
  return rec.name === "AbortError" || rec.code === 20;
}

function resolveTtftTimeoutMs(): number {
  const env = getEnv();
  const configured = env.LITEROUTER_TTFT_TIMEOUT_MS || env.LITEROUTER_NO_RESPONSE_TIMEOUT_MS;
  return configured && configured > 0 ? configured : 120000;
}

async function fetchWithTtftGuard(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  clientSignal: AbortSignal
): Promise<Response> {
  const linked = new AbortController();
  const onClientAbort = (): void => {
    linked.abort(clientSignal.reason);
  };
  if (clientSignal.aborted) {
    linked.abort(clientSignal.reason);
  } else {
    clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      linked.abort(new DOMException(`TTFT exceeded ${timeoutMs}ms`, "TimeoutError"));
      reject(new NoResponseError(`Upstream TTFT timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchFn(url, { ...init, signal: linked.signal }), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    clientSignal.removeEventListener("abort", onClientAbort);
  }
}

function buildTtftTimeoutResponse(reqId: string, timeoutMs: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `Upstream TTFT timeout after ${timeoutMs}ms`,
        type: "timeout_error",
        code: "ttft_timeout",
      },
    }),
    {
      status: 504,
      headers: { "content-type": "application/json", "x-request-id": reqId },
    }
  );
}

export function createCleanErrorResponse(
  upstreamResponse: Response,
  errText: string
): Response {
  const sanitizedBody = sanitizeBody(errText);
  const cleanHeaders = new Headers(upstreamResponse.headers);
  cleanHeaders.delete("content-encoding");
  cleanHeaders.delete("content-length");
  cleanHeaders.delete("transfer-encoding");
  cleanHeaders.delete("set-cookie");
  cleanHeaders.delete("server");
  cleanHeaders.delete("cf-ray");
  cleanHeaders.delete("cf-cache-status");

  return new Response(sanitizedBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: cleanHeaders,
  });
}

function createCutoffResilientStream(
  sourceStream: ReadableStream<Uint8Array>,
  onMidStreamError: (err: unknown) => void,
  clientSignal?: AbortSignal,
  onStreamComplete?: () => void
): ReadableStream<Uint8Array> {
  const reader = sourceStream.getReader();
  let emittedDone = false;
  let cleanedUp = false;

  const doCleanup = () => {
    if (!cleanedUp) {
      cleanedUp = true;
      if (clientSignal) {
        clientSignal.removeEventListener("abort", doCleanup);
      }
      onStreamComplete?.();
    }
  };

  if (clientSignal?.aborted) {
    doCleanup();
  } else if (clientSignal) {
    clientSignal.addEventListener("abort", doCleanup, { once: true });
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        const { done, value } = await reader.read();
        if (done) {
          doCleanup();
          safeClose(controller);
          return;
        }
        controller.enqueue(value);
      } catch (streamErr) {
        doCleanup();
        if (clientSignal?.aborted || isAbortError(streamErr)) {
          safeClose(controller);
          return;
        }
        onMidStreamError(streamErr);
        if (!emittedDone) {
          emittedDone = true;
          const errorChunk = new TextEncoder().encode(
            `data: ${JSON.stringify({
              id: `err-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "error",
              error: {
                message: streamErr instanceof Error ? streamErr.message : "Mid-stream connection error",
                type: "server_error",
                code: "mid_stream_error",
              },
              choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
            })}\n\n`
          );
          safeEnqueue(controller, errorChunk);
          safeEnqueue(controller, DONE_CHUNK);
        }
        safeClose(controller);
      }
    },
    async cancel(reason): Promise<void> {
      doCleanup();
      await reader.cancel(reason);
    },
  });
}

function buildDirectiveTelemetryParams(req: DispatchRequest): {
  targetProvider?: string;
  wireFormat?: string;
  endpoint?: string;
  nuances?: readonly string[];
} {
  if (req.directive.type === "direct") {
    return {
      targetProvider: req.directive.provider,
      wireFormat: req.directive.wire,
      endpoint: req.directive.completion,
      nuances: req.directive.nuances,
    };
  }
  return {
    targetProvider: "fusion",
    wireFormat: "oa",
    endpoint: "ch",
  };
}

function recordTrace(
  telemetry: RequestTelemetry,
  status: number,
  legs: {
    clientInbound?: string;
    upstreamOutbound?: string;
    upstreamInbound?: string;
    clientOutbound?: string;
  }
): void {
  const metrics = telemetry.toTraceMetrics();
  const trace: SanitizedTrace = {
    reqId: metrics.reqId,
    createdAt: Date.now(),
    provider: metrics.provider,
    model: metrics.model,
    status,
    durationMs: metrics.durationMs,
    ttftMs: metrics.ttftMs,
    tokensPrompt: metrics.promptTokens,
    tokensCompletion: metrics.completionTokens,
    ...(metrics.cachedTokens !== undefined ? { tokensCached: metrics.cachedTokens } : {}),
    ...(metrics.cacheWriteTokens !== undefined ? { tokensCacheWrite: metrics.cacheWriteTokens } : {}),
    ...(metrics.cacheDiscount !== undefined ? { cacheDiscount: metrics.cacheDiscount } : {}),
    legs: {
      clientInbound: legs.clientInbound ?? "",
      upstreamOutbound: legs.upstreamOutbound ?? "",
      upstreamInbound: legs.upstreamInbound ?? "",
      clientOutbound: legs.clientOutbound ?? "",
    },
  };
  traceBuffer.push(trace);
  traceWriter.enqueue(trace);
}

export async function executeDispatchPipeline(
  req: DispatchRequest,
  fetchFn: FetchFn = fetch
): Promise<Response> {
  if (req.directive.type === "fusion") {
    return executeFusionFlow(
      req.directive.preset,
      req.rawInboundBody as OpenAIRequestPayload,
      req.clientSignal,
      req.reqId,
      {
        userAgent: req.clientHeaders.get("user-agent") || undefined,
        headers: req.clientHeaders,
      }
    );
  }

  const providerCode = req.directive.type === "direct" ? req.directive.provider : "or";
  const provConfig = getProviderConfig(providerCode);
  const strategy: ProviderExecutionStrategy = getStrategy(providerCode);

  const dirParams = buildDirectiveTelemetryParams(req);
  const modelName = String(req.rawInboundBody.model ?? "unknown");

  const telemetry = new RequestTelemetry({
    reqId: req.reqId,
    method: req.method,
    path: req.path,
    clientAgent: req.clientHeaders.get("user-agent") ?? "Unknown",
    directiveStr: req.directive.raw,
    model: modelName,
    ...dirParams,
  });

  let initialTarget: ResolvedTarget;
  try {
    const resolutionCtx: DispatchContext = {
      reqId: req.reqId,
      path: req.path,
      directive: req.directive,
      providerConfig: provConfig,
      telemetry,
      clientSignal: req.clientSignal,
      selectedKey: { key: "", index: 0, poolSize: 1 },
      attempt: 1,
      maxAttempts: provConfig.request_retry.enabled ? provConfig.request_retry.max_attempts : 1,
    };
    initialTarget =
      (strategy.resolveTarget?.(resolutionCtx, req.rawInboundBody) as ResolvedTarget | undefined) ??
      defaultTarget(provConfig, req);
  } catch {
    initialTarget = defaultTarget(provConfig, req);
  }

  const initialTier =
    initialTarget.tier ??
    (initialTarget.extraHeaders?.["x-literouter-tier"]
      ? parseInt(initialTarget.extraHeaders["x-literouter-tier"].split("/")[0] ?? "", 10) || undefined
      : undefined);

  telemetry.setResolvedTarget(initialTarget.model, initialTier);
  telemetry.emitInbound();

  const sessionId =
    extractClientSessionId(req.clientHeaders) ??
    extractClientSessionId(req.outboundPayload.headers) ??
    extractBodySessionId(req.rawInboundBody);
  telemetry.setSessionPin(sessionId);

  const poolSize = globalKeyPool.getPoolSize(providerCode);
  const initialKey = globalKeyPool.selectNextKey(providerCode, Date.now(), sessionId);

  const initialCtx: DispatchContext = {
    reqId: req.reqId,
    path: req.path,
    directive: req.directive,
    providerConfig: provConfig,
    telemetry,
    clientSignal: req.clientSignal,
    selectedKey: {
      key: initialKey?.key ?? "",
      index: initialKey?.index ?? 0,
      poolSize: Math.max(1, poolSize),
    },
    attempt: 1,
    maxAttempts: provConfig.request_retry.enabled ? provConfig.request_retry.max_attempts : 1,
  };

  const preResult = strategy.preDispatch?.(initialCtx, req.rawInboundBody);
  if (preResult) {
    telemetry.served(preResult.status);
    recordTrace(telemetry, preResult.status, {
      clientInbound: sanitizeBody(req.rawInboundBody, MAX_LEG_BYTES),
    });
    return preResult;
  }

  const retryConfig = provConfig.request_retry;
  const maxAttempts = retryConfig.enabled ? retryConfig.max_attempts : 1;
  const ttftTimeoutMs = resolveTtftTimeoutMs();
  const conserveRules = toConserveRules(provConfig.conserve_rules);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (req.clientSignal.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const pacerLease = await acquirePacer(providerCode, provConfig.pacer, req.clientSignal);

    const key = attempt === 1 && initialKey
      ? initialKey
      : globalKeyPool.selectNextKey(providerCode, Date.now(), sessionId);

    if (!key) {
      pacerLease?.release();
      telemetry.error("All keys exhausted or in cooldown");
      telemetry.served(429, attempt, maxAttempts);
      recordTrace(telemetry, 429, {
        clientInbound: sanitizeBody(req.rawInboundBody, MAX_LEG_BYTES),
        clientOutbound: JSON.stringify({
          error: {
            message: "All keys in cooldown or exhausted",
            type: "rate_limit_error",
            code: "keys_exhausted",
          },
        }),
      });
      return new Response(
        JSON.stringify({
          error: {
            message: "All keys in cooldown or exhausted",
            type: "rate_limit_error",
            code: "keys_exhausted",
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "x-request-id": req.reqId },
        }
      );
    }

    telemetry.setKeyIndex(key.index, key.totalKeys);

    const currentCtx: DispatchContext = {
      ...initialCtx,
      selectedKey: {
        key: key.key,
        index: key.index,
        poolSize: Math.max(1, key.totalKeys),
      },
      attempt,
      maxAttempts,
    };

    const resolvedTarget = strategy.resolveTarget?.(currentCtx, req.rawInboundBody) ?? defaultTarget(provConfig, req);
    const targetTier =
      (resolvedTarget as ResolvedTarget).tier ??
      (resolvedTarget.extraHeaders?.["x-literouter-tier"]
        ? parseInt(resolvedTarget.extraHeaders["x-literouter-tier"].split("/")[0] ?? "", 10) || undefined
        : undefined);
    const target: ResolvedTarget = {
      ...resolvedTarget,
      tier: targetTier,
      upstreamUrl: overrideProviderUrl(resolvedTarget.upstreamUrl, providerCode),
    };

    if (
      resolvedTarget.model !== telemetry.session.resolvedModel ||
      targetTier !== telemetry.session.tier
    ) {
      telemetry.setResolvedTarget(resolvedTarget.model, targetTier);
      telemetry.emitResolvedModel();
    } else {
      telemetry.setResolvedTarget(resolvedTarget.model, targetTier);
    }
    const authHeaders = strategy.buildAuthHeaders?.(key.key, req.clientHeaders) ?? defaultAuthHeaders(provConfig, key.key);
    const injectedHeaders = strategy.injectHeaders?.(currentCtx, authHeaders) ?? authHeaders;
    const isZen =
      provConfig.code === "zn" ||
      provConfig.name?.toLowerCase() === "zen" ||
      provConfig.strategy === "zen";
    const finalHeaders = mergeOutboundHeaders(
      authHeaders,
      injectedHeaders,
      provConfig.headers,
      target.extraHeaders,
      req.outboundPayload.headers,
      req.clientHeaders,
      sessionId,
      isZen
    );

    try {
      const upstreamResponse = await fetchWithTtftGuard(
        fetchFn,
        target.upstreamUrl,
        {
          method: req.outboundPayload.method,
          headers: finalHeaders,
          body: JSON.stringify(req.outboundPayload.body),
          signal: req.clientSignal,
        },
        ttftTimeoutMs,
        req.clientSignal
      );

      if (upstreamResponse.status < 400) {
        if (provConfig.key_cooldown?.reset_after_success) {
          globalKeyPool.reportSuccess(providerCode, key.index);
        }

        if (req.outboundPayload.isStreaming) {
          const wireTransformStream = req.transformer.createWireToClientStream(
            req.directive,
            telemetry,
            req.clientSignal
          );

          const rawBody = upstreamResponse.body ?? new ReadableStream<Uint8Array>();
          const transformedStream = rawBody.pipeThrough(wireTransformStream);

          const resilientStream = createCutoffResilientStream(
            transformedStream,
            (streamErr) => {
              telemetry.error("Mid-stream upstream failure encountered", streamErr);
            },
            req.clientSignal,
            () => pacerLease?.release()
          );

          telemetry.served(upstreamResponse.status, attempt, maxAttempts);
          recordTrace(telemetry, upstreamResponse.status, {
            clientInbound: sanitizeBody(req.rawInboundBody, MAX_LEG_BYTES),
            upstreamOutbound: sanitizeBody(req.outboundPayload.body, MAX_LEG_BYTES),
            clientOutbound: "[STREAM]",
          });

          return new Response(resilientStream, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
              "x-request-id": req.reqId,
            },
          });
        }

        // If the upstream responded with an event stream but client requested non-streaming (e.g. Zen adaptation),
        // accumulate SSE events into a chat.completion or responses JSON object
        if (upstreamResponse.headers.get("content-type")?.includes("text/event-stream") && upstreamResponse.body) {
          const isResponses = req.outboundPayload.endpointKey === "rs";
          const accumulated = isResponses
            ? await accumulateZenResponsesStream(upstreamResponse.body, String(req.outboundPayload.body?.model ?? ""))
            : await accumulateZenStreamToCompletion(upstreamResponse.body, String(req.outboundPayload.body?.model ?? ""));
          const clientJson = req.transformer.transformWireToClient(accumulated, req.directive);
          telemetry.recordUsage(extractUsage(accumulated));
          telemetry.served(upstreamResponse.status, attempt, maxAttempts);
          pacerLease?.release();
          return new Response(JSON.stringify(clientJson), {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "x-request-id": req.reqId,
            },
          });
        }

        // Read outside the parse guard: transport failures retain their retry policy.
        const responseText = await upstreamResponse.text();
        let jsonBody: Record<string, unknown>;
        try {
          jsonBody = JSON.parse(responseText) as Record<string, unknown>;
        } catch {
          // Never echo the body or parser exception: upstream pages may contain secrets.
          const contentType = (upstreamResponse.headers.get("content-type") ?? "missing")
            .split(";")[0]!.trim().slice(0, 100).replace(/[^a-zA-Z0-9/+._-]/g, "_");
          const error = {
            message: `Provider ${providerCode} returned non-JSON or malformed JSON (HTTP ${upstreamResponse.status}, content-type ${contentType})`,
            type: "upstream_response_error",
            code: "invalid_upstream_response",
            upstream_status: upstreamResponse.status,
            upstream_content_type: contentType,
          };
          pacerLease?.release();
          telemetry.error(error.message);
          telemetry.served(502, attempt, maxAttempts);
          return Response.json({ error }, {
            status: 502,
            headers: { "x-request-id": req.reqId },
          });
        }
        const clientJson = req.transformer.transformWireToClient(jsonBody, req.directive);
        telemetry.recordUsage(extractUsage(jsonBody));
        telemetry.served(upstreamResponse.status, attempt, maxAttempts);
        recordTrace(telemetry, upstreamResponse.status, {
          clientInbound: sanitizeBody(req.rawInboundBody, MAX_LEG_BYTES),
          upstreamOutbound: sanitizeBody(req.outboundPayload.body, MAX_LEG_BYTES),
          upstreamInbound: sanitizeBody(jsonBody, MAX_LEG_BYTES),
          clientOutbound: sanitizeBody(clientJson, MAX_LEG_BYTES),
        });

        pacerLease?.release();
        return new Response(JSON.stringify(clientJson), {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: {
            "content-type": "application/json",
            "x-request-id": req.reqId,
          },
        });
      }

      // Upstream failure classification
      const errText = await upstreamResponse.text();
      const rawErrorMsg = extractErrorMessage(errText);
      const quarantineEnabled = isProviderQuarantineEnabled(providerCode);
      const rawRetryAfterSec = parseRetryAfterSec(upstreamResponse.headers.get("retry-after"));
      const retryAfterSec = quarantineEnabled ? rawRetryAfterSec : undefined;
      const rawRemTokens = upstreamResponse.headers.get("x-ratelimit-remaining-tokens");
      const rawRemRequests = upstreamResponse.headers.get("x-ratelimit-remaining-requests");
      const remainingTokens = rawRemTokens ? parseInt(rawRemTokens, 10) : undefined;
      const remainingRequests = rawRemRequests ? parseInt(rawRemRequests, 10) : undefined;

      telemetry.recordLimit({
        status: upstreamResponse.status,
        retryAfterSec,
        totalKeys: key.totalKeys,
        rawMessage: rawErrorMsg,
        hasUpstreamRetryAfter: retryAfterSec !== undefined,
        remainingTokens: remainingTokens !== undefined && !Number.isNaN(remainingTokens) ? remainingTokens : undefined,
        remainingRequests: remainingRequests !== undefined && !Number.isNaN(remainingRequests) ? remainingRequests : undefined,
      });

      const failureAction: FailureAction = strategy.classifyFailure?.(currentCtx, upstreamResponse.status)
        ?? defaultClassifyFailure(upstreamResponse.status);

      const classification = classifyUpstreamError({
        provider: providerCode,
        status: upstreamResponse.status,
        headers: upstreamResponse.headers,
        bodyText: errText,
        conserveRules,
      });

      // Session-pinned key rotation: the upstream account behind a pinned key is
      // now suspect (402 = depleted credits, 429 = quota exhausted). Rotate the
      // pin so the session resumes on a fresh key, and record the rotation.
      if (sessionId !== undefined && (upstreamResponse.status === 402 || upstreamResponse.status === 429)) {
        const rotated = globalKeyPool.rotateSessionKey(providerCode, sessionId);
        telemetry.rotateKey({
          fromIndex: key.index,
          toIndex: rotated?.index ?? -1,
          totalKeys: key.totalKeys,
          attempt,
          maxAttempts,
        });
      }

      // Conserve only on an explicit conserve_rule match (§1.3c: a generic 429
      // must never bench the key). quarantineTtlSec is already resolved by the
      // classifier (midnight_utc -> epoch seconds), so no extra cooldown import.
      if (classification.isConserve === true && classification.quarantineTtlSec > 0) {
        globalKeyPool.conserveKey(
          providerCode,
          key.index,
          classification.quarantineTtlSec,
          classification.reason,
          upstreamResponse.status
        );
      }

      // Auth death (401/403): reportFailure quarantines the key AND invalidates
      // any session pin bound to it, so a pinned session cannot stay glued to a
      // permanently-dead key for the 5-minute pin TTL. FatalAuthError is the
      // expected signal, not a fault (mirrors openai_compat.ts:305-320).
      if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
        try {
          globalKeyPool.reportFailure(
            providerCode,
            key.index,
            upstreamResponse.status,
            upstreamResponse.headers,
            errText
          );
        } catch (authErr: unknown) {
          if (!isFatalAuthError(authErr)) {
            throw authErr;
          }
        }
      }

      // OpenRouter 402 / terminal attempt: async single-flight probe verifies
      // whether the key is truly depleted and conserves it. Never awaited.
      if (providerCode === "or" && (upstreamResponse.status === 402 || attempt === maxAttempts)) {
        void verifyAndConserve(providerCode, key.index, key.key, globalKeyPool).catch(() => {});
      }

      if (failureAction === "fail_fast") {
        pacerLease?.release();
        telemetry.served(upstreamResponse.status, attempt, maxAttempts);
        recordTrace(telemetry, upstreamResponse.status, {
          clientInbound: sanitizeBody(req.rawInboundBody, MAX_LEG_BYTES),
          upstreamOutbound: sanitizeBody(req.outboundPayload.body, MAX_LEG_BYTES),
        });
        return createCleanErrorResponse(upstreamResponse, errText);
      }

      if (failureAction === "advance_target") {
        pacerLease?.release();
        telemetry.rotateKey({
          fromIndex: key.index,
          toIndex: -1,
          totalKeys: key.totalKeys,
          attempt,
          maxAttempts,
        });
        continue;
      }

      // failureAction === "retry_same_target"
      pacerLease?.release();

      if (attempt < maxAttempts) {
        const delayMs = retryAfterSec !== undefined
          ? Math.min(retryAfterSec * 1000, 15000)
          : calculateRetryDelay(retryConfig.delay, attempt);
        await Bun.sleep(delayMs);
        telemetry.rotateKey({
          fromIndex: key.index,
          toIndex: -1,
          totalKeys: key.totalKeys,
          attempt: attempt + 1,
          maxAttempts,
        });
        continue;
      }

      telemetry.served(upstreamResponse.status, attempt, maxAttempts);
      recordTrace(telemetry, upstreamResponse.status, {
        clientInbound: sanitizeBody(req.rawInboundBody, MAX_LEG_BYTES),
        upstreamOutbound: sanitizeBody(req.outboundPayload.body, MAX_LEG_BYTES),
      });
      return createCleanErrorResponse(upstreamResponse, errText);
    } catch (err) {
      pacerLease?.release();
      if (req.clientSignal.aborted) {
        throw err;
      }

      if (err instanceof NoResponseError) {
        telemetry.error("Upstream TTFT timeout during dispatch attempt", err);

        if (attempt < maxAttempts) {
          const delayMs = calculateRetryDelay(retryConfig.delay, attempt);
          await Bun.sleep(delayMs);
          continue;
        }

        telemetry.served(504, attempt, maxAttempts);
        recordTrace(telemetry, 504, {
          clientInbound: sanitizeBody(req.rawInboundBody, MAX_LEG_BYTES),
          upstreamOutbound: sanitizeBody(req.outboundPayload.body, MAX_LEG_BYTES),
        });
        return buildTtftTimeoutResponse(req.reqId, ttftTimeoutMs);
      }

      telemetry.error("Network or fetch error during dispatch attempt", err);

      if (attempt < maxAttempts) {
        const delayMs = calculateRetryDelay(retryConfig.delay, attempt);
        await Bun.sleep(delayMs);
        continue;
      }

      telemetry.served(500, attempt, maxAttempts);
      recordTrace(telemetry, 500, {
        clientInbound: sanitizeBody(req.rawInboundBody, MAX_LEG_BYTES),
        upstreamOutbound: sanitizeBody(req.outboundPayload.body, MAX_LEG_BYTES),
      });

      telemetry.served(502, attempt, maxAttempts);
      recordTrace(telemetry, 502, {
        clientInbound: sanitizeBody(req.rawInboundBody, MAX_LEG_BYTES),
        upstreamOutbound: sanitizeBody(req.outboundPayload.body, MAX_LEG_BYTES),
      });
      return new Response(
        JSON.stringify({
          error: {
            message: `Provider ${provConfig.name ?? providerCode} retry attempts exhausted: ${err instanceof Error ? err.message : String(err)}`,
            type: "gateway_error",
            code: "retries_exhausted",
          },
        }),
        {
          status: 502,
          headers: { "content-type": "application/json" },
        }
      );
    }
  }

  // Should never be reached (all loop paths return), but satisfies TypeScript exhaustiveness
  return new Response(
    JSON.stringify({
      error: {
        message: `Provider ${provConfig.name ?? providerCode} dispatch completed without response`,
        type: "gateway_error",
        code: "dispatch_unexpected_exit",
      },
    }),
    {
      status: 500,
      headers: { "content-type": "application/json" },
    }
  );
}
