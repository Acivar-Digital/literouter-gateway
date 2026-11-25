import { describe, expect, it } from "bun:test";
import {
  ensureSessionHeaders,
  extractBodySessionId,
  extractClientSessionId,
  generateOpenCodeSessionId,
  SESSION_HEADER_KEYS,
} from "../../../src/engine/session_id";
import { mergeOutboundHeaders } from "../../../src/engine/dispatch";

describe("src/engine/session_id.ts", () => {
  describe("generateOpenCodeSessionId", () => {
    it("generates a session ID with ses_ prefix, 8-hex timestamp, 8ffe marker, and 14 base62 chars", () => {
      const id = generateOpenCodeSessionId();
      expect(id).toMatch(/^ses_[0-9a-f]{8}8ffe[0-9a-zA-Z]{14}$/);
      expect(id.length).toBe(30);
    });

    it("generates unique session IDs on repeated invocations", () => {
      const id1 = generateOpenCodeSessionId();
      const id2 = generateOpenCodeSessionId();
      expect(id1).not.toBe(id2);
    });
  });

  describe("SESSION_HEADER_KEYS", () => {
    it("defines the expected canonical session header keys", () => {
      expect(SESSION_HEADER_KEYS).toEqual([
        "session-id",
        "x-session-id",
        "session_id",
        "x-prompt-cache-key",
        "x-litellm-session-id",
        "x-opencode-session",
        "x-opencode-session-id",
        "opencode-session-id",
        "opencode-session",
      ]);
    });
  });

  describe("extractBodySessionId", () => {
    it("returns the prompt_cache_key value when present", () => {
      expect(
        extractBodySessionId({
          prompt_cache_key: "01a20084-1c95-7733-b798-a6f3fdac3eee",
        })
      ).toBe("01a20084-1c95-7733-b798-a6f3fdac3eee");
    });

    it("prefers session_id over prompt_cache_key when both are present", () => {
      expect(
        extractBodySessionId({
          session_id: "ses_1",
          prompt_cache_key: "pck_2",
        })
      ).toBe("ses_1");
    });

    it("returns undefined for non-object or missing session fields", () => {
      expect(extractBodySessionId(undefined)).toBeUndefined();
      expect(extractBodySessionId(null)).toBeUndefined();
      expect(extractBodySessionId([])).toBeUndefined();
      expect(extractBodySessionId({})).toBeUndefined();
    });

    it("returns undefined for invalid session_id types or empty values", () => {
      expect(extractBodySessionId({ session_id: 123 })).toBeUndefined();
      expect(extractBodySessionId({ session_id: "" })).toBeUndefined();
      expect(extractBodySessionId({ session_id: "   " })).toBeUndefined();
    });

    it("returns undefined for session_id exceeding 256 characters", () => {
      expect(extractBodySessionId({ session_id: "a".repeat(257) })).toBeUndefined();
    });

    it("trims whitespace from valid session_id", () => {
      expect(extractBodySessionId({ session_id: "  ses_trim  " })).toBe("ses_trim");
    });

    it("rejects body session_id containing CRLF injection", () => {
      expect(extractBodySessionId({ session_id: "abc\r\nX-Injected: 1" })).toBeUndefined();
    });

    it("rejects body session_id containing ANSI escape", () => {
      expect(extractBodySessionId({ session_id: "\u001b[2J\u001b[HFAKE" })).toBeUndefined();
    });

    it("rejects body session_id containing a null byte", () => {
      expect(extractBodySessionId({ session_id: "ab\u0000cd" })).toBeUndefined();
    });

    it("still accepts a base64url-style id with - and _", () => {
      expect(extractBodySessionId({ session_id: "AbC-123_xyz" })).toBe("AbC-123_xyz");
    });
  });

  describe("extractClientSessionId", () => {
    it("returns undefined when headers is undefined or empty", () => {
      expect(extractClientSessionId(undefined)).toBeUndefined();
      expect(extractClientSessionId({})).toBeUndefined();
      expect(extractClientSessionId(new Headers())).toBeUndefined();
    });

    it("extracts session ID from Record<string, string> case-insensitively", () => {
      expect(
        extractClientSessionId({ "X-OpenCode-Session": "ses_custom_1" })
      ).toBe("ses_custom_1");
      expect(
        extractClientSessionId({ "SESSION-ID": "ses_custom_2" })
      ).toBe("ses_custom_2");
      expect(
        extractClientSessionId({ "x-session-id": "ses_custom_3" })
      ).toBe("ses_custom_3");
      expect(
        extractClientSessionId({ "Opencode-Session-Id": "ses_custom_4" })
      ).toBe("ses_custom_4");
    });

    it("extracts session ID from Headers object case-insensitively", () => {
      const headers = new Headers();
      headers.set("X-Session-ID", "ses_custom_headers");
      expect(extractClientSessionId(headers)).toBe("ses_custom_headers");
    });

    it("skips empty string values and finds the first non-empty match", () => {
      const headers = {
        "session-id": "",
        "x-session-id": "ses_non_empty",
      };
      expect(extractClientSessionId(headers)).toBe("ses_non_empty");
    });
  });

  describe("ensureSessionHeaders", () => {
    it("writes no session headers when neither client nor target provides one", () => {
      const target: Record<string, string> = {
        authorization: "Bearer test",
      };

      ensureSessionHeaders(target);

      expect(target["session-id"]).toBeUndefined();
      expect(target["x-session-id"]).toBeUndefined();
      expect(target.authorization).toBe("Bearer test");
    });

    it("preserves client-provided session ID in session-id", () => {
      const target: Record<string, string> = {};
      const client = {
        "x-opencode-session": "ses_client_123",
      };

      ensureSessionHeaders(target, client);

      expect(target["session-id"]).toBe("ses_client_123");
      expect(target["x-session-id"]).toBe("ses_client_123");
    });

    it("preserves client-provided x-session-id in both session-id and x-session-id", () => {
      const target: Record<string, string> = {};
      const client = {
        "x-session-id": "ses_client_x",
      };

      ensureSessionHeaders(target, client);

      expect(target["session-id"]).toBe("ses_client_x");
      expect(target["x-session-id"]).toBe("ses_client_x");
    });

    it("lets a client session-id override an existing target x-session-id and sets both headers", () => {
      const target: Record<string, string> = {
        "x-session-id": "ses_target_x",
      };
      const client = {
        "session-id": "ses_client_main",
      };

      ensureSessionHeaders(target, client);

      expect(target["session-id"]).toBe("ses_client_main");
      expect(target["x-session-id"]).toBe("ses_client_main");
    });

    it("uses fallbackSessionId as 3rd param to set both session headers when client headers absent", () => {
      const target: Record<string, string> = {};

      ensureSessionHeaders(target, undefined, "01a20084-body");

      expect(target["session-id"]).toBe("01a20084-body");
      expect(target["x-session-id"]).toBe("01a20084-body");
    });

    it("client header session still wins over fallbackSessionId", () => {
      const target: Record<string, string> = {};
      const client = {
        "x-opencode-session": "ses_client_wins",
      };

      ensureSessionHeaders(target, client, "body_fallback_loses");

      expect(target["session-id"]).toBe("ses_client_wins");
      expect(target["x-session-id"]).toBe("ses_client_wins");
    });
  });

  describe("mergeOutboundHeaders integration", () => {
    it("injects no session headers into merged output when no session header is provided", () => {
      const merged = mergeOutboundHeaders(
        { authorization: "Bearer key" },
        {},
        undefined,
        undefined,
        { "content-type": "application/json" }
      );

      expect(merged["session-id"]).toBeUndefined();
      expect(merged["x-session-id"]).toBeUndefined();
      expect(merged.authorization).toBe("Bearer key");
      expect(merged["content-type"]).toBe("application/json");
    });

    it("preserves client session-id from payloadHeaders", () => {
      const merged = mergeOutboundHeaders(
        { authorization: "Bearer key" },
        {},
        undefined,
        undefined,
        { "x-opencode-session-id": "ses_from_client" }
      );

      expect(merged["session-id"]).toBe("ses_from_client");
    });

    it("threads fallbackSessionId as 7th param into merged session headers", () => {
      const merged = mergeOutboundHeaders(
        { authorization: "Bearer key" },
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        "body-sess-xyz"
      );

      expect(merged["session-id"]).toBe("body-sess-xyz");
      expect(merged["x-session-id"]).toBe("body-sess-xyz");
    });
  });
});
