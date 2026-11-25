const MAX_SESSION_ID_LENGTH = 256;

// Reject control chars / whitespace to prevent log/header injection (CWE-117/150).
const UNSAFE_SESSION_CHARS = /[\x00-\x1f\x7f\s]/;

const BASE62_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const SESSION_HEADER_KEYS = [
  "session-id",
  "x-session-id",
  "session_id",
  "x-prompt-cache-key",
  "x-litellm-session-id",
  "x-opencode-session",
  "x-opencode-session-id",
  "opencode-session-id",
  "opencode-session",
] as const;

const BODY_SESSION_KEYS = ["session_id", "prompt_cache_key"] as const;

function normalizeSessionCandidate(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SESSION_ID_LENGTH) return undefined;
  if (UNSAFE_SESSION_CHARS.test(trimmed)) return undefined;
  return trimmed;
}

export function extractBodySessionId(body?: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of BODY_SESSION_KEYS) {
    const normalized = normalizeSessionCandidate(record[key]);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

export function generateOpenCodeSessionId(): string {
  const hexBytes = new Uint8Array(4);
  crypto.getRandomValues(hexBytes);
  let hex8 = "";
  for (let i = 0; i < 4; i++) {
    hex8 += (hexBytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  const tailBytes = new Uint8Array(14);
  crypto.getRandomValues(tailBytes);
  let tail14 = "";
  for (let i = 0; i < 14; i++) {
    tail14 += BASE62_CHARS.charAt((tailBytes[i] ?? 0) % BASE62_CHARS.length);
  }
  return `ses_${hex8}8ffe${tail14}`;
}

function getFromHeadersObject(headers: Headers, key: string): string | undefined {
  const val = headers.get(key);
  return val ?? undefined;
}

function getFromRecord(rec: Record<string, string>, targetKey: string): string | undefined {
  const target = targetKey.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === target && v) {
      return v;
    }
  }
  return undefined;
}

export function getHeaderValue(
  headers: Headers | Record<string, string> | undefined,
  targetKey: string
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return getFromHeadersObject(headers as Headers, targetKey);
  }
  return getFromRecord(headers as Record<string, string>, targetKey);
}

export function extractClientSessionId(
  headers?: Headers | Record<string, string>
): string | undefined {
  if (!headers) return undefined;
  for (const key of SESSION_HEADER_KEYS) {
    const val = getHeaderValue(headers, key);
    if (val) {
      const normalized = normalizeSessionCandidate(val);
      if (normalized !== undefined) return normalized;
    }
  }
  return undefined;
}

export function ensureSessionHeaders(
  targetHeaders: Record<string, string>,
  clientHeaders?: Headers | Record<string, string>,
  fallbackSessionId?: string
): void {
  const clientSession = extractClientSessionId(clientHeaders);
  const targetSession = extractClientSessionId(targetHeaders);
  const activeSession =
    clientSession ?? targetSession ?? normalizeSessionCandidate(fallbackSessionId);

  if (activeSession) {
    targetHeaders["session-id"] = activeSession;
    targetHeaders["x-session-id"] = activeSession;
    return;
  }

  return;
}