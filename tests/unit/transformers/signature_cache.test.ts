import { describe, expect, it, beforeEach } from "bun:test";
import {
  SENTINEL_SIGNATURE,
  storeThoughtSignature,
  getThoughtSignature,
  clearThoughtSignatures,
  injectThoughtSignatures,
  storeThoughtSignaturesFromResponse,
  createThoughtSignatureStreamTap,
} from "../../../src/transformers/thinking";
import { openAiChatTransformer } from "../../../src/transformers/openai_chat";
import type { ParsedDirective } from "../../../src/directive/types";
import type { OpenAIMessage } from "../../../src/transformers/nuances";

/** Helper: pipe Uint8Array chunks through a TransformStream and drain it. */
async function pipeChunksThrough(
  stream: TransformStream<Uint8Array, Uint8Array>,
  chunks: string[]
): Promise<void> {
  const encoder = new TextEncoder();
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const drainPromise = (async () => {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  })();
  for (const chunk of chunks) {
    await writer.write(encoder.encode(chunk));
  }
  await writer.close();
  await drainPromise;
}

describe("Battery 1-4: Gemini Thought Signature Cache & OpenRouter Wire Protocol", () => {
  beforeEach(() => {
    clearThoughtSignatures();
  });

  describe("Battery 1: Sequential Tool Calling with Sentinel Fallback", () => {
    it("attaches cached signature to Tool A, and attaches SENTINEL_SIGNATURE to un-cached Tool B without cross-inheriting", () => {
      // Turn 1 generates Tool A with a valid signature in cache
      storeThoughtSignature("call_a123", "sig_valid_for_a_123");

      const messages: OpenAIMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_a123",
              type: "function",
              function: { name: "get_bazi", arguments: '{"year":1990}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_a123",
          content: '{"result":"Wood Dragon"}',
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            // Tool B has no signature in cache (e.g. came from Ernie/DeepSeek before failover)
            {
              id: "call_b456",
              type: "function",
              function: { name: "analyze_luck", arguments: '{"element":"wood"}' },
            },
          ],
        },
      ];

      const rehydrated = injectThoughtSignatures(messages);

      // Verify Tool A has cached signature
      const msg0 = rehydrated[0];
      expect(msg0).toBeDefined();
      expect((msg0?.tool_calls?.[0] as any)?.extra_content?.google?.thought_signature).toBe("sig_valid_for_a_123");
      const details0 = (msg0 as any).reasoning_details;
      expect(details0).toBeDefined();
      expect(details0[0]).toEqual({
        type: "reasoning.encrypted",
        data: "sig_valid_for_a_123",
        id: "call_a123",
        format: "google-gemini-v1",
      });

      // Verify Tool B receives SENTINEL_SIGNATURE and does NOT inherit Tool A's signature
      const msg2 = rehydrated[2];
      expect(msg2).toBeDefined();
      expect((msg2?.tool_calls?.[0] as any)?.extra_content?.google?.thought_signature).toBe(SENTINEL_SIGNATURE);
      const details2 = (msg2 as any).reasoning_details;
      expect(details2).toBeDefined();
      expect(details2[0]).toEqual({
        type: "reasoning.encrypted",
        data: SENTINEL_SIGNATURE,
        id: "call_b456",
        format: "google-gemini-v1",
      });
      expect((msg2?.tool_calls?.[0] as any)?.extra_content?.google?.thought_signature).not.toBe("sig_valid_for_a_123");
    });
  });

  describe("Battery 2: Parallel Tool Calls with Anchor Placement", () => {
    it("attaches signature only to anchor tool call without spurious duplicates across parallel calls", () => {
      // Model returned parallel tool calls call_batch_1 and call_batch_2
      // Only call_batch_1 had signature
      storeThoughtSignature("call_batch_1", "sig_batch_anchor_001");

      const messages: OpenAIMessage[] = [
        {
          role: "assistant",
          content: "I will call two tools in parallel.",
          tool_calls: [
            {
              id: "call_batch_1",
              type: "function",
              function: { name: "get_bazi", arguments: "{}" },
            },
            {
              id: "call_batch_2",
              type: "function",
              function: { name: "get_tarot", arguments: "{}" },
            },
          ],
        },
      ];

      const rehydrated = injectThoughtSignatures(messages);
      const assistantMsg = rehydrated[0];
      expect(assistantMsg).toBeDefined();

      // Visible text has NO signature attached
      expect(typeof assistantMsg!.content).toBe("string");
      expect(assistantMsg!.content).toBe("I will call two tools in parallel.");

      // call_batch_1 carries signature
      expect((assistantMsg!.tool_calls?.[0] as any)?.extra_content?.google?.thought_signature).toBe("sig_batch_anchor_001");

      // call_batch_2 does not receive duplicate/spurious signature (anchor placement)
      expect((assistantMsg!.tool_calls?.[1] as any)?.extra_content?.google?.thought_signature).toBeUndefined();

      // Verify reasoning_details items: only anchor tool call carries signature
      const details = (assistantMsg as any).reasoning_details;
      expect(details).toHaveLength(1);
      expect(details[0].id).toBe("call_batch_1");
      expect(details[0].data).toBe("sig_batch_anchor_001");
    });
  });

  describe("Battery 3: Context Compaction / Client Pruning Resilience", () => {
    it("re-hydrates signature correctly when Turn 1 is pruned from history by client sliding window", () => {
      // Turn 1 generated tool call call_pruned_999
      storeThoughtSignature("call_pruned_999", "sig_pruned_persist_999");

      // Client pruned Turn 1 and user prompt, sending only assistant message Turn 2 and tool response Turn 3
      const prunedHistory: OpenAIMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_pruned_999",
              type: "function",
              function: { name: "read_chart", arguments: '{"aspect":"career"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_pruned_999",
          content: '{"prediction":"success"}',
        },
        {
          role: "user",
          content: "What does this mean for my investment?",
        },
      ];

      const rehydrated = injectThoughtSignatures(prunedHistory);
      const assistantMsg = rehydrated[0];
      expect(assistantMsg).toBeDefined();

      expect((assistantMsg!.tool_calls?.[0] as any)?.extra_content?.google?.thought_signature).toBe("sig_pruned_persist_999");
      const details = (assistantMsg as any).reasoning_details;
      expect(details).toBeDefined();
      expect(details[0].id).toBe("call_pruned_999");
      expect(details[0].data).toBe("sig_pruned_persist_999");
    });
  });

  describe("Battery 4: Real OpenRouter Streaming SSE Chunk-Split Accumulation", () => {
    it("accumulates tool_call id and reasoning_details across split SSE chunks using real OpenRouter wire schema", async () => {
      const directive: ParsedDirective = {
        type: "direct",
        provider: "or",
        endpoint: "ch",
        payload: "oa",
        completion: "ch",
        nuances: ["ts"],
        wire: "oa",
        raw: "lr-or-oa-ch-ts",
      };

      const telemetry: any = {
        reqId: "req_test_sse_split",
        markTtft: () => {},
        recordUsage: () => {},
      };

      const controller = new AbortController();
      const transformer = openAiChatTransformer.createWireToClientStream(directive, telemetry, controller.signal);

      // Real OpenRouter Wire Chunks:
      // Chunk 0: tool_calls[0].id arrives
      // Chunk 1: tool_calls[0].function.arguments arrives
      // Chunk 2: reasoning_details arrives with { type: "reasoning.encrypted", data: "...", id: "call_live_77", format: "google-gemini-v1" }
      const chunk0 = 'data: {"id":"gen_1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_live_77","type":"function","function":{"name":"get_bazi"}}]}}]}\n\n';
      const chunk1 = 'data: {"id":"gen_1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"year\\":1977}"}}]}}]}\n\n';
      const chunk2 = 'data: {"id":"gen_1","choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"EilzdXJnZTY3ODk1NDMydXRzcmFm","id":"call_live_77","format":"google-gemini-v1"}]}}]}\n\n';
      const chunkDone = "data: [DONE]\n\n";

      const reader = transformer.readable.getReader();
      const readPromise = (async () => {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      })();

      const writer = transformer.writable.getWriter();
      const encoder = new TextEncoder();

      await writer.write(encoder.encode(chunk0));
      await writer.write(encoder.encode(chunk1));
      await writer.write(encoder.encode(chunk2));
      await writer.write(encoder.encode(chunkDone));
      await writer.close();
      await readPromise;

      // Assert that THOUGHT_SIGNATURE_STORE captured call_live_77 -> EilzdXJnZTY3ODk1NDMydXRzcmFm
      const captured = getThoughtSignature("call_live_77");
      expect(captured).toBe("EilzdXJnZTY3ODk1NDMydXRzcmFm");
    });

    it("extracts and caches thought signatures from non-streaming response body", () => {
      const nonStreamResponse = {
        id: "gen_non_stream_1",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_ns_88",
                  type: "function",
                  function: { name: "calculate_pillars", arguments: "{}" },
                },
              ],
              reasoning_details: [
                {
                  type: "reasoning.encrypted",
                  data: "ns_sig_data_payload_88",
                  id: "call_ns_88",
                  format: "google-gemini-v1",
                },
              ],
            },
          },
        ],
      };

      storeThoughtSignaturesFromResponse(nonStreamResponse);
      expect(getThoughtSignature("call_ns_88")).toBe("ns_sig_data_payload_88");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Battery 5: Direct createThoughtSignatureStreamTap() – id-first, then sig
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Battery 5: createThoughtSignatureStreamTap – id-first / reasoning-later", () => {
    it("joins tool_call id (chunk 1) with reasoning_details (chunk 2) keyed by index into THOUGHT_SIGNATURE_STORE", async () => {
      // Chunk 1: id and name arrive for index 0
      const chunk1 =
        'data: {"id":"gen_2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_tap_01","type":"function","function":{"name":"forecast_luck"}}]}}]}\n\n';
      // Chunk 2: reasoning_details arrives WITHOUT an explicit id — keyed by index 0
      const chunk2 =
        'data: {"id":"gen_2","choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"SIG_TAP_INDEX_MATCH","index":0,"format":"google-gemini-v1"}]}}]}\n\n';
      const done = "data: [DONE]\n\n";

      const tap = createThoughtSignatureStreamTap();
      await pipeChunksThrough(tap, [chunk1, chunk2, done]);

      expect(getThoughtSignature("call_tap_01")).toBe("SIG_TAP_INDEX_MATCH");
    });

    it("stores immediately when reasoning_details carries an explicit id (direct-id path)", async () => {
      // reasoning_details chunk carries a direct `id` field — no index-join needed
      const chunk =
        'data: {"id":"gen_3","choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"SIG_DIRECT_ID_PATH","id":"call_direct_55","format":"google-gemini-v1"}]}}]}\n\n';
      const done = "data: [DONE]\n\n";

      const tap = createThoughtSignatureStreamTap();
      await pipeChunksThrough(tap, [chunk, done]);

      expect(getThoughtSignature("call_direct_55")).toBe("SIG_DIRECT_ID_PATH");
    });

    it("buffers signature when reasoning arrives before tool_call id; stores when id arrives", async () => {
      // Chunk 1: reasoning_details with no id — only index 0 available
      const chunk1 =
        'data: {"id":"gen_4","choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"SIG_PENDING_ARRIVAL","index":0,"format":"google-gemini-v1"}]}}]}\n\n';
      // Chunk 2: tool_call id arrives for index 0 — should trigger store from buffered sig
      const chunk2 =
        'data: {"id":"gen_4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_late_id_99","type":"function","function":{"name":"late_bazi"}}]}}]}\n\n';
      const done = "data: [DONE]\n\n";

      const tap = createThoughtSignatureStreamTap();
      await pipeChunksThrough(tap, [chunk1, chunk2, done]);

      expect(getThoughtSignature("call_late_id_99")).toBe("SIG_PENDING_ARRIVAL");
    });

    it("does not corrupt existing entries when processing [DONE] or non-json lines", async () => {
      storeThoughtSignature("call_preexisting", "PRESERVED_SIG");

      const junk = "data: not-json\n\ndata: [DONE]\n\n";
      const tap = createThoughtSignatureStreamTap();
      await pipeChunksThrough(tap, [junk]);

      // Pre-existing entry untouched
      expect(getThoughtSignature("call_preexisting")).toBe("PRESERVED_SIG");
    });

    it("passes all bytes through unmodified (tap is side-effect-only, never drops chunks)", async () => {
      const payload =
        'data: {"id":"gen_5","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n' +
        "data: [DONE]\n\n";
      const encoder = new TextEncoder();
      const tap = createThoughtSignatureStreamTap();
      const reader = tap.readable.getReader();
      const writer = tap.writable.getWriter();

      const collected: Uint8Array[] = [];
      const drainPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) collected.push(value);
        }
      })();
      await writer.write(encoder.encode(payload));
      await writer.close();
      await drainPromise;

      const received = collected.map((c) => new TextDecoder().decode(c)).join("");
      expect(received).toBe(payload);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Battery 6: Turn 2 re-hydration contract — extra_content.google.thought_signature
  //            AND reasoning_details[] both present after injectThoughtSignatures
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Battery 6: Turn 2 inbound re-hydration contract", () => {
    it("attaches both extra_content.google.thought_signature and reasoning_details[] on Turn 2 message", () => {
      const SIG = "TURN2_REHYDRATION_SIG_XYZ";
      storeThoughtSignature("call_turn2_42", SIG);

      const messages: OpenAIMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_turn2_42",
              type: "function",
              function: { name: "read_hexagram", arguments: "{}" },
            },
          ],
        },
      ];

      const rehydrated = injectThoughtSignatures(messages);
      const msg = rehydrated[0];
      expect(msg).toBeDefined();

      // 1. extra_content.google.thought_signature must be set
      const tc = msg!.tool_calls?.[0] as any;
      expect(tc?.extra_content?.google?.thought_signature).toBe(SIG);

      // 2. reasoning_details[] must be injected with correct shape
      const details = (msg as any).reasoning_details;
      expect(Array.isArray(details)).toBe(true);
      expect(details).toHaveLength(1);
      expect(details[0]).toEqual({
        type: "reasoning.encrypted",
        data: SIG,
        id: "call_turn2_42",
        format: "google-gemini-v1",
      });
    });

    it("preserves existing reasoning_details[] and de-dupes by tool_call_id", () => {
      const EXISTING_SIG = "EXISTING_SIG_DETAIL";
      storeThoughtSignature("call_dedup_77", "FROM_CACHE_SIG");

      const messages: OpenAIMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_dedup_77",
              type: "function",
              function: { name: "lunar_phase", arguments: "{}" },
            },
          ],
          reasoning_details: [
            {
              type: "reasoning.encrypted",
              data: EXISTING_SIG,
              id: "call_dedup_77",
              format: "google-gemini-v1",
            },
          ],
        } as any,
      ];

      const rehydrated = injectThoughtSignatures(messages);
      const details = (rehydrated[0] as any).reasoning_details;

      // Must NOT duplicate the existing entry
      expect(details).toHaveLength(1);
      expect(details[0].data).toBe(EXISTING_SIG);
    });

    it("uses SENTINEL_SIGNATURE for cache-miss tool calls on Turn 2", () => {
      // No storeThoughtSignature call → cache miss
      const messages: OpenAIMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_no_cache_11",
              type: "function",
              function: { name: "unknown_tool", arguments: "{}" },
            },
          ],
        },
      ];

      const rehydrated = injectThoughtSignatures(messages);
      const msg = rehydrated[0];
      expect((msg!.tool_calls?.[0] as any)?.extra_content?.google?.thought_signature).toBe(
        SENTINEL_SIGNATURE
      );
      const details = (msg as any).reasoning_details;
      expect(details[0].data).toBe(SENTINEL_SIGNATURE);
    });
  });
});
