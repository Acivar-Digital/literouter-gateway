import { describe, expect, it } from "bun:test";
import { sanitizeAndTransformPayload } from "../../../src/transformers/payload";
import type { OpenAIRequestPayload } from "../../../src/transformers/nuances";

describe("OpenAI Universal Compatibility & Normalization Invariant (TDD)", () => {
  it("preserves standard OpenAI multi-turn tool calling structure without proprietary vendor branching", () => {
    // Universal OpenAI multi-turn payload with tool call and tool result
    const inboundPayload: OpenAIRequestPayload = {
      model: "google/gemini-3.1-flash-lite",
      messages: [
        { role: "user", content: "What is the BaZi pillar for 1977?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_bazi_1977",
              type: "function",
              function: {
                name: "get_bazi_pillar",
                arguments: JSON.stringify({ year: 1977 }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_bazi_1977",
          content: JSON.stringify({ pillar: "Ding Si (Fire Snake)" }),
        },
      ],
      temperature: 0,
      tools: [
        {
          type: "function",
          function: {
            name: "get_bazi_pillar",
            description: "Get stem and branch for a year",
            parameters: {
              type: "object",
              properties: { year: { type: "integer" } },
              required: ["year"],
            },
          },
        },
      ],
    };

    // Transform through LiteRouter standard OpenAI pipeline
    const transformed = sanitizeAndTransformPayload(inboundPayload, {
      nuances: ["no"],
      targetWire: "oa",
      enableScrubbing: true,
    });

    // Invariants:
    // 1. Tool calls array remains intact on assistant message
    expect(transformed.messages).toHaveLength(3);
    const asstMsg = transformed.messages[1]!;
    expect(asstMsg.role).toBe("assistant");
    expect(asstMsg.tool_calls).toBeDefined();
    expect(asstMsg.tool_calls).toHaveLength(1);
    expect(asstMsg.tool_calls![0]!.id).toBe("call_bazi_1977");

    // 2. Tool response message remains intact with matching tool_call_id
    const toolMsg = transformed.messages[2]!;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call_bazi_1977");
    expect(toolMsg.content).toBe(JSON.stringify({ pillar: "Ding Si (Fire Snake)" }));

    // 3. No fragile vendor-specific branching mutated the tool structure
    expect(transformed.tools).toBeDefined();
    expect(transformed.tools).toHaveLength(1);
  });
});
