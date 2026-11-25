/**
 * OpenRouter key depletion verifier (blueprint §2.4).
 *
 * Single-flight, outcome-debounced probe of `GET https://openrouter.ai/api/v1/key`.
 * When a probe confirms a key is depleted (credit cap or free-model daily quota
 * exhausted) the key is conserved on the shared KeyPool so the router stops
 * selecting it until its window resets. No background timers; callers never
 * await the probe; failures are logged fail-open (never a silent catch).
 *
 * Debounce is keyed on the probe's self-describing `outcome`:
 *  - a conclusive probe (one that actually read the key status) earns the long
 *    `PROBE_DEBOUNCE_MS` window;
 *  - a failed/inconclusive probe earns a PER-KEY capped exponential backoff
 *    (`PROBE_FAILURE_BACKOFF_SCHEDULE_MS`, +/-20% jitter) so repeated failures
 *    back off progressively while a single timeout or network blip still
 *    re-probes soon. A 429 carrying `Retry-After` stamps exactly
 *    `now + retryAfterMs` instead of the computed backoff.
 */

import type { KeyPool } from "./pool";
import { resolveConserveTtlSec } from "./cooldown";

const OPENROUTER_KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";
/** Debounce window earned by a probe that successfully read the key status. */
const PROBE_DEBOUNCE_MS = 300_000;
/**
 * Per-key capped exponential backoff schedule for failed/inconclusive probes:
 * 5s -> 15s -> 60s -> 300s (cap; same as PROBE_DEBOUNCE_MS). The schedule is
 * indexed by the key's CONSECUTIVE failure count, so isolated blips re-probe
 * quickly while persistently failing keys back off to the long window.
 */
const PROBE_FAILURE_BACKOFF_SCHEDULE_MS: readonly number[] = [5_000, 15_000, 60_000, PROBE_DEBOUNCE_MS];
/** Fraction of the stamped backoff window randomized so keys don't re-probe in lockstep. */
const PROBE_BACKOFF_JITTER_RATIO = 0.2;
const PROBE_TIMEOUT_MS = 3_000;
const LIMIT_DEPLETED_TTL_SEC = 3_600;
const LIMIT_DEPLETED_REASON = "openrouter_limit_exhausted";
const FREE_DEPLETED_REASON = "openrouter_free_daily_exhausted";
const PROBE_FAILED_REASON = "probe_failed";
const DEPLETION_STATUS = 402;
const RATE_LIMIT_STATUS = 429;

/**
 * Why a probe reached its result. `conclusive` means the probe actually read
 * the key status (healthy or exhausted) and its verdict is authoritative;
 * `failed` means the probe could not read the status (timeout / network /
 * non-2xx) and the key was left untouched.
 */
export type KeyProbeOutcome = "conclusive" | "failed";

/**
 * Outcome of a single key probe. `conserveTtlSec > 0` means the key was
 * verified exhausted and conserved; `0` means it was left un-quarantined
 * (healthy, debounced, or the probe failed open). The long/short debounce
 * decision is driven by `outcome`, never by matching `reason` strings.
 * `retryAfterMs` is set only when the probe failed with a 429 that carried a
 * `Retry-After` header; the failure backoff then honours it verbatim instead
 * of the computed schedule.
 */
export interface KeyProbeResult {
  readonly keyIndex: number;
  readonly verifiedExhausted: boolean;
  readonly conserveTtlSec: number;
  readonly reason: string;
  readonly outcome: KeyProbeOutcome;
  readonly retryAfterMs?: number;
}

/** Raw shape of the OpenRouter `/api/v1/key` response (subset we read). */
interface OpenRouterKeyResponse {
  readonly data?: {
    readonly limit_remaining?: number | null;
    readonly free_model_daily_requests?: {
      readonly remaining?: number;
    };
  };
}

/** In-flight probes keyed `${provider}:${keyIndex}` (single-flight). */
const inflightProbes = new Map<string, Promise<KeyProbeResult>>();
/**
 * Earliest epoch ms at which the next probe may run, keyed
 * `${provider}:${keyIndex}`. Written from the probe outcome: a conclusive
 * probe sets `now + PROBE_DEBOUNCE_MS`; a failed probe sets `now + backoff`
 * (capped exponential + jitter, or `now + Retry-After` on a 429). Rows whose
 * window has been dead for at least `PROBE_DEBOUNCE_MS` are lazily swept on
 * the write path so long-idle keys cannot leak entries.
 */
const probeDebounceUntil = new Map<string, number>();
/**
 * Consecutive failed/inconclusive probe count per `${provider}:${keyIndex}`.
 * Indexes `PROBE_FAILURE_BACKOFF_SCHEDULE_MS`; reset to 0 on any conclusive
 * probe. Entries are pruned by the same lazy sweep as `probeDebounceUntil`.
 */
const probeFailures = new Map<string, number>();

/**
 * Verifies a single OpenRouter API key against `/api/v1/key` and conserves
 * it on the pool when exhausted. Concurrent callers for the same
 * (provider, keyIndex) share one in-flight request; the settled probe then
 * debounces the next attempt by its outcome (long window on a conclusive read,
 * capped exponential backoff + jitter on a failure, `Retry-After` honoured on
 * a 429). Both settlement paths stamp the debounce. Never throws: timeout /
 * network / parse failures are logged and the key is left un-quarantined.
 *
 * @param provider - Provider code (e.g. "or").
 * @param keyIndex - Index of the key within the provider's pool.
 * @param apiKey - Bearer token to probe.
 * @param pool - Shared key pool to conserve the key on.
 * @param fetchFn - Injectable fetch (defaults to global fetch).
 */
export function verifyAndConserve(
  provider: string,
  keyIndex: number,
  apiKey: string,
  pool: KeyPool,
  fetchFn: typeof fetch = fetch
): Promise<KeyProbeResult> {
  const stateKey = `${provider}:${keyIndex}`;
  // Single-flight first: concurrent callers share the in-flight promise.
  const existing = inflightProbes.get(stateKey);
  if (existing !== undefined) {
    return existing;
  }
  // Debounce window written by the last settled probe for this key.
  const notBefore = probeDebounceUntil.get(stateKey);
  if (notBefore !== undefined && Date.now() < notBefore) {
    return Promise.resolve(result(keyIndex, false, 0, "debounced", "failed"));
  }
  // Stamp on settle (not on spawn): the TTL depends on whether the probe
  // actually read the key status, which is only known once it completes.
  // `.then(onFulfilled, onRejected)` so a rejection ALSO writes the failure
  // backoff; runProbe itself never rejects, so onRejected is defensive (a
  // rejection can otherwise never reach a caller — dispatch attaches
  // `.catch(() => {})` — and would silently skip the debounce stamp).
  const probe = runProbe(provider, keyIndex, apiKey, pool, fetchFn).then(
    (outcome) => {
      stampDebounce(stateKey, outcome, outcome.retryAfterMs);
      return outcome;
    },
    (err: unknown) => {
      // Defensive rejection path (runProbe itself never rejects): a rejection
      // can otherwise never reach a caller — dispatch attaches
      // `.catch(() => {})` — and would silently skip the debounce stamp.
      const outcome = failOpen(provider, keyIndex, err, undefined);
      stampDebounce(stateKey, outcome, undefined);
      return outcome;
    }
  );
  inflightProbes.set(stateKey, probe);
  // The derived finally-promise has no unhandled-rejection path: `probe` is
  // fulfilled in both handlers above, so `probe.finally(...)` cannot reject.
  void probe.finally(() => inflightProbes.delete(stateKey));
  return probe;
}

/**
 * Folds a settled probe outcome into the per-key debounce state.
 * A conclusive probe resets the failure count and earns the long window. A
 * failed probe increments the consecutive-failure count and stamps the
 * capped exponential backoff (+/-20% jitter), unless `retryAfterMs` (from a
 * 429 `Retry-After` header) is given, in which case that exact delay wins.
 */
function stampDebounce(stateKey: string, outcome: KeyProbeResult, retryAfterMs: number | undefined): void {
  if (outcome.outcome === "conclusive") {
    probeFailures.delete(stateKey);
    probeDebounceUntil.set(stateKey, Date.now() + PROBE_DEBOUNCE_MS);
  } else {
    const failures = (probeFailures.get(stateKey) ?? 0) + 1;
    probeFailures.set(stateKey, failures);
    // A 429 `Retry-After` is an explicit server instruction: honour it
    // verbatim (no jitter — the server picked the delay). Otherwise use the
    // per-key capped exponential backoff with +/-20% jitter.
    const delayMs = retryAfterMs ?? applyJitter(backoffForFailures(failures));
    probeDebounceUntil.set(stateKey, Date.now() + delayMs);
  }
  // A conserve quarantines the key for its (much longer) window, which already
  // keeps it out of rotation — a debounce row would be redundant. Drop it in
  // BOTH branches: a conserving probe is conclusive, so it never reaches the
  // failure arm above.
  if (outcome.conserveTtlSec > 0) {
    probeDebounceUntil.delete(stateKey);
  }
  sweepDebounceRows(Date.now());
}

/** Capped exponential backoff for the Nth consecutive failure (1-based). */
function backoffForFailures(failures: number): number {
  const index = Math.min(Math.max(failures, 1), PROBE_FAILURE_BACKOFF_SCHEDULE_MS.length) - 1;
  return PROBE_FAILURE_BACKOFF_SCHEDULE_MS[index] ?? PROBE_DEBOUNCE_MS;
}

/** Applies +/-20% jitter to a backoff window so keys don't re-probe in lockstep. */
function applyJitter(baseMs: number): number {
  const jitter = baseMs * PROBE_BACKOFF_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(baseMs + jitter));
}

/** Lazily drops debounce rows dead for at least one long window (write path only). */
function sweepDebounceRows(now: number): void {
  const cutoff = now - PROBE_DEBOUNCE_MS;
  for (const [key, notBefore] of probeDebounceUntil) {
    if (notBefore < cutoff) {
      probeDebounceUntil.delete(key);
      probeFailures.delete(key);
    }
  }
}

async function runProbe(
  provider: string,
  keyIndex: number,
  apiKey: string,
  pool: KeyPool,
  fetchFn: typeof fetch
): Promise<KeyProbeResult> {
  let json: OpenRouterKeyResponse;
  try {
    json = await fetchKeyStatus(apiKey, fetchFn);
  } catch (err) {
    // A 429 carrying `Retry-After` is flagged on the result so the debounce
    // stamp in `verifyAndConserve` honours `now + retryAfterMs` instead of
    // the computed exponential backoff.
    const retryAfterMs = err instanceof RateLimitProbeError ? err.retryAfterMs : undefined;
    return failOpen(provider, keyIndex, err, retryAfterMs);
  }
  const decision = classifyStatus(json, keyIndex);
  if (decision.conserveTtlSec > 0) {
    pool.conserveKey(provider, keyIndex, decision.conserveTtlSec, decision.reason, DEPLETION_STATUS);
  }
  return decision;
}

async function fetchKeyStatus(apiKey: string, fetchFn: typeof fetch): Promise<OpenRouterKeyResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(OPENROUTER_KEY_ENDPOINT, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === RATE_LIMIT_STATUS) {
        throw new RateLimitProbeError(parseRetryAfterMs(res.headers.get("retry-after")));
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const json: OpenRouterKeyResponse = await res.json();
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** A 429 from the probe endpoint; carries the parsed `Retry-After` delay if any. */
class RateLimitProbeError extends Error {
  public readonly retryAfterMs: number | undefined;

  constructor(retryAfterMs: number | undefined) {
    super("HTTP 429");
    this.name = "RateLimitProbeError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parses a `Retry-After` header (delta-seconds or HTTP-date) to epoch ms. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null || header.trim() === "") {
    return undefined;
  }
  const trimmed = header.trim();
  const seconds = Number.parseFloat(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, dateMs - Date.now());
}

function classifyStatus(json: OpenRouterKeyResponse, keyIndex: number): KeyProbeResult {
  const limitRemaining = json.data?.limit_remaining;
  if (typeof limitRemaining === "number" && limitRemaining <= 0) {
    return result(keyIndex, true, LIMIT_DEPLETED_TTL_SEC, LIMIT_DEPLETED_REASON, "conclusive");
  }
  const dailyRemaining = json.data?.free_model_daily_requests?.remaining;
  if (typeof dailyRemaining === "number" && dailyRemaining <= 0) {
    return result(keyIndex, true, resolveConserveTtlSec("midnight_utc"), FREE_DEPLETED_REASON, "conclusive");
  }
  return result(keyIndex, false, 0, "healthy", "conclusive");
}

function result(
  keyIndex: number,
  verifiedExhausted: boolean,
  conserveTtlSec: number,
  reason: string,
  outcome: KeyProbeOutcome,
  retryAfterMs?: number
): KeyProbeResult {
  return retryAfterMs === undefined
    ? { keyIndex, verifiedExhausted, conserveTtlSec, reason, outcome }
    : { keyIndex, verifiedExhausted, conserveTtlSec, reason, outcome, retryAfterMs };
}

function failOpen(
  provider: string,
  keyIndex: number,
  err: unknown,
  retryAfterMs: number | undefined
): KeyProbeResult {
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(`[PROBE ${provider} key#${keyIndex}] verification failed: ${reason} -> no quarantine`);
  return result(keyIndex, false, 0, PROBE_FAILED_REASON, "failed", retryAfterMs);
}