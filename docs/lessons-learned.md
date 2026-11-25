# Lessons Learned — Six Production Pitfalls

This document distills six hard-won production fixes that are easy to get wrong
when fronting many upstream LLM providers behind one gateway. Each section names
the concrete source location and symbol so the behavior can be verified against
the code. Examples use a generic `N`-key pool and loopback addresses only.

---

## 1. KV-Cache Locality via Session-Sticky LRU Pinning

**Symptom.** Prompt-cache hit rates collapse and cost/latency spike, even though
the same logical conversation keeps hitting the gateway.

**Root cause.** Stateless round-robin key selection sprays consecutive turns of
one conversation across every key in the pool. Each upstream account has its own
prompt cache, so turn *N+1* lands on a cold cache and re-bills the full prompt.

**Fix.** Pin a session to the key it first used, with true LRU eviction.

- **Resolve the session id** from headers or body, in
  `src/engine/session_id.ts`: `extractClientSessionId` scans
  `SESSION_HEADER_KEYS` (`session-id`, `x-session-id`, `x-prompt-cache-key`,
  `x-litellm-session-id`, …); `extractBodySessionId` reads `session_id` /
  `prompt_cache_key` from the JSON body. Every candidate passes
  `normalizeSessionCandidate`, which trims, enforces
  `MAX_SESSION_ID_LENGTH`, and **rejects control characters and whitespace**
  (`UNSAFE_SESSION_CHARS`) to prevent log/header injection (CWE-117/150).
  `ensureSessionHeaders` re-injects the resolved id onto the outbound request so
  the upstream sees a stable session too.
- **Pin with real LRU**, in `src/network/pool.ts`. `KeyPool.selectNextKey`
  returns `getPinnedKey` on a hit; on a miss it round-robins and then
  `pinSessionKey`. Both `pinSessionKey` and `getPinnedKey` do
  **`delete`-then-`set`** before re-inserting — a plain re-`set` would keep the
  entry in its old insertion slot and `evictOldestSessionPin` would evict by
  insertion order (FIFO) instead of recency. Pins carry `expiresAt`
  (`DEFAULT_SESSION_PIN_TTL_MS`, 5 minutes) and the map is bounded by
  `DEFAULT_SESSION_PIN_MAX_ENTRIES`.
- **Invalidate on key death.** `reportFailure` on `401`/`403` calls
  `invalidateSessionPins` *before* throwing `FatalAuthError`, so a pinned session
  is never glued to a permanently dead key for the full pin TTL. `rotateSessionKey`
  moves a session to a fresh key on `402`/`429`.

**Takeaway.** Cache locality is a routing property, not a client concern. Resolve
the session defensively (sanitize!), pin with genuine LRU recency, and always
unpin a key the moment it dies.

---

## 2. Selective Quota Quarantine vs. Self-DoS

**Symptom.** A burst of upstream `429`s leads the gateway to bench its entire
pool, turning a transient rate limit into a self-inflicted outage — or the
opposite: a genuinely depleted key keeps getting selected and burning attempts.

**Root cause.** Treating every `429` as "bench this key for a long time." A
generic rate-limit `429` is usually transient and must **rotate keys without
benching the account**; only *verified* quota exhaustion (a `402`, or a
daily-free-limit `429` confirmed by an out-of-band probe) should conserve the
key for a long window.

**Fix.** Two-tier handling in `src/engine/dispatch.ts` +
`src/network/openrouter_probe.ts` + `src/network/cooldown.ts`.

- **Generic `429` → rotate, do not bench.** The dispatch loop only conserves when
  `classification.isConserve === true && classification.quarantineTtlSec > 0`
  from `classifyUpstreamError`. A plain `429` does not match a conserve rule, so
  the loop simply advances to the next key. `computeStatusTtlSec` keeps the
  rate-limit default at `RATE_LIMIT_DEFAULT_SEC` (`0`) — i.e. no long cooldown.
- **Verified exhaustion → conserve.** `verifyAndConserve` performs a
  **single-flight, outcome-debounced** probe of the provider's key-status
  endpoint (`GET …/api/v1/key`). Concurrent callers for the same
  `provider:keyIndex` share one in-flight promise (`inflightProbes`); the
  settled outcome stamps a debounce window (`stampDebounce`): a *conclusive*
  read earns the long `PROBE_DEBOUNCE_MS` window and resets the failure count,
  while a *failed/inconclusive* probe earns a per-key capped exponential backoff
  (`PROBE_FAILURE_BACKOFF_SCHEDULE_MS`, ±20% jitter), or exactly `Retry-After`
  on a `429`. When `classifyStatus` confirms depletion (`limit_remaining <= 0`
  or `free_model_daily_requests.remaining <= 0`) it calls
  `pool.conserveKey(...)` with a long TTL (`LIMIT_DEPLETED_TTL_SEC`, or
  `resolveConserveTtlSec("midnight_utc")` for the daily window).
- **Never awaited, never silent.** Dispatch fires the probe with
  `void verifyAndConserve(...).catch(() => {})` so it never blocks a response,
  and the probe itself logs fail-open (`failOpen`) rather than swallowing errors.

**Takeaway.** Rotate on transient pressure; conserve only on *verified*
depletion, gated by a single-flight debounced probe so N concurrent failures
cause one probe, not N.

---

## 3. SSE Mid-Stream Error Forwarding

**Symptom.** An upstream returns HTTP `200`, streams a few deltas, then emits an
in-band error object — and the client hangs, or worse, the gateway reports the
request as a success.

**Root cause.** Once `200` and the first bytes are committed to the client, the
request can no longer be retried at the HTTP layer. An in-band error that arrives
*after* content deltas cannot be transparently recovered; it must be surfaced as
a proper stream error without corrupting the SSE framing.

**Fix.** `src/network/fetcher.ts` + `src/engine/dispatch.ts`.

- **Detect in-band errors.** `isInBandErrorChunk` recognizes explicit
  `finish_reason: network_error`/`error` chunks, JSON `error`/`type:"error"`
  payloads, and known server-error substrings/codes.
- **Forward cleanly.** `createResilientStream` buffers to line boundaries and,
  on an in-band error or a mid-generation drop, calls `emitStreamError` →
  `formatMidstreamErrorFrame`, which emits a protocol-correct error frame
  (Anthropic `event: error` or OpenAI `chat.completion.chunk` with
  `finish_reason: "error"`) followed by the terminator, then closes. The
  `hasEmittedTokens` flag chooses `stream_error` vs `server_error` typing.
- **Count it.** In the Anthropic cross-wire path, `handleSseErrorChunk`
  (`src/transformers/anthropic_openai_xwire.ts`) calls
  `telemetry.upstreamStreamError(...)` so an already-`200` failure is still a
  countable failure row rather than an invisible success.
- **Cutoff resilience.** The dispatch loop wraps the transformed stream in
  `createCutoffResilientStream`, which on a non-abort stream error emits a
  terminal error chunk + `[DONE]` exactly once and always releases the pacer
  lease on completion.

**Takeaway.** After `200` is committed you cannot retry — so detect in-band
errors, translate them into a protocol-correct error frame, terminate the stream
deterministically, and record the failure.

---

## 4. Trailing-Assistant Prefill Normalization

**Symptom.** Some providers hang or time out when the message list ends with an
`assistant` turn (a "prefill"); the request never produces a first token.

**Root cause.** A conversation whose final message is `assistant` (or `model`)
is a valid client-side prefill pattern, but several upstreams treat a trailing
assistant turn as "continue this turn" and stall waiting for a user signal.

**Fix.** `ensureTerminalUserTurn` in `src/transformers/opencode_adapter.ts`
(exported through `src/transformers/thinking.ts`). When the last message is
`assistant`/`model`, it appends a minimal terminal user turn
(`{ role: "user", content: "ok go on" }`) so every outbound request ends on a
user turn. The Anthropic→OpenAI translation
(`translateAnthropicToOpenAI` in `src/transformers/anthropic_openai_xwire.ts`)
calls it on the assembled message list, guaranteeing the invariant regardless of
client.

**Takeaway.** Normalize the tail of the message list to a terminal user turn
before dispatch; it is a cheap guard against a class of silent upstream hangs.

---

## 5. Cross-Model Thought-Signature Failover

**Symptom.** When a tool-calling conversation fails over from one provider to a
heterogeneous provider (e.g. a Google/Gemini-style upstream that requires a
`thought_signature` on assistant tool calls), the new provider rejects the
replayed assistant turn because the signature from the original provider is
missing or invalid.

**Root cause.** Tool-call "thought signatures" are provider-specific opaque
tokens. A conversation captured on provider A carries A's signatures; replaying
it on provider B fails validation, and there is no signature to forward.

**Fix.** Cache signatures and inject a sentinel bypass, in
`src/transformers/anthropic_openai_xwire.ts`.

- **Capture.** `createThoughtSignatureStreamTap` (a pass-through
  `TransformStream`) and `storeThoughtSignaturesFromResponse` extract signatures
  from streamed `reasoning_details` / `extra_content.google.thought_signature`
  and store them by tool-call id via `storeThoughtSignature` (bounded by
  `MAX_THOUGHT_SIGNATURE_ENTRIES`, FIFO-evicted).
- **Inject on replay.** `injectThoughtSignatures` →
  `patchAssistantMessageSignatures` re-attaches a cached signature to each
  assistant tool call. On a cache miss it places `SENTINEL_SIGNATURE` on the
  **first** tool call only (anchor placement) and leaves secondary parallel calls
  unsigned, so a heterogeneous provider receives a structurally valid turn
  without spurious duplicate signatures.
- **Strip when prohibited.** `shouldStripReasoning` / `stripReasoningParameters`
  remove `thinking` / `reasoning_effort` / `budget_tokens` when the target wire
  forbids them (nuances `ts`/`ds`/`sb`, or the `ao` wire).

**Takeaway.** Tool-call signatures do not survive a provider switch on their own.
Cache them with a bounded store, inject a sentinel anchor on cache miss, and strip
reasoning parameters when the destination wire disallows them.

---

## 6. HTTP/2 Outbound with Clean HTTP/1.1 Fallback

**Symptom.** Enabling HTTP/2 to upstreams improves multiplexing but a single H2
transport error (or a provider that mishandles H2) stalls TTFT and fails the
request outright.

**Root cause.** A hard dependency on H2 means any H2-specific fault
(`ERR_HTTP2_STREAM_CANCEL`, frame errors, an unhealthy pooled session) becomes a
user-visible failure, with no graceful degradation.

**Fix.** `fetchWithTtftGuard` in `src/network/fetcher.ts`.

- **Opportunistic H2.** H2 is attempted only when `LITEROUTER_H2_OUTBOUND` is
  set, the URL is `https`, and fetch is not mocked (`isFetchMocked`). The pooled
  session comes from `getHttp2Pool().acquireSession`; stream errors purge an
  unhealthy session (`pool.purgeSession`).
- **Clean fallback.** Any H2 error that is **not** a client abort is caught and
  retried once via standard `fetch` (HTTP/1.1 keep-alive). A client abort is
  re-thrown so cancellation is never masked. The chosen `protocol`
  (`"HTTP/2" | "HTTP/1.1"`) is returned alongside the response.
- **TTFT guard is protocol-agnostic.** Both paths converge on
  `readFirstContentChunkWithTimeout`, so the first-token deadline and the
  ghost-response (`200` with zero content tokens → `NoResponseError`) guard apply
  uniformly.

**Takeaway.** Treat H2 as an optimization, not a requirement: attempt it, and on
any non-abort transport fault fall back to HTTP/1.1 without surfacing the error —
while never swallowing a real client cancellation.