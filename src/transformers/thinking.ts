import type { OpenAIMessage, OpenAIToolCall } from "./nuances";

const MAX_THOUGHT_SIGNATURE_ENTRIES = 2000;
const THOUGHT_SIGNATURE_STORE = new Map<string, string>();

export function storeThoughtSignature(toolCallId: string, signature: string): void {
  if (toolCallId && signature) {
    if (THOUGHT_SIGNATURE_STORE.size >= MAX_THOUGHT_SIGNATURE_ENTRIES) {
      const oldestKey = THOUGHT_SIGNATURE_STORE.keys().next().value;
      if (oldestKey !== undefined) {
        THOUGHT_SIGNATURE_STORE.delete(oldestKey);
      }
    }
    THOUGHT_SIGNATURE_STORE.set(toolCallId, signature);
  }
}

export function getThoughtSignature(toolCallId: string): string | undefined {
  return THOUGHT_SIGNATURE_STORE.get(toolCallId);
}

export function clearThoughtSignatures(): void {
  THOUGHT_SIGNATURE_STORE.clear();
}

function extractFromExtraContent(obj: Record<string, unknown>): string | undefined {
  const extra = obj.extra_content as Record<string, unknown> | undefined;
  if (!extra) {
    return undefined;
  }
  const google = extra.google as Record<string, unknown> | undefined;
  if (!google) {
    return undefined;
  }
  const sig = google.thought_signature;
  return typeof sig === "string" ? sig : undefined;
}

function extractFromCandidates(obj: Record<string, unknown>): string | undefined {
  const candidates = obj.candidates as readonly Record<string, unknown>[] | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return undefined;
  }
  const first = candidates[0];
  if (!first) {
    return undefined;
  }
  return extractFromExtraContent(first);
}

export function extractThoughtSignature(responseObj: unknown): string | undefined {
  if (typeof responseObj !== "object" || responseObj === null) {
    return undefined;
  }
  const obj = responseObj as Record<string, unknown>;
  return extractFromExtraContent(obj) ?? extractFromCandidates(obj);
}

export const SENTINEL_SIGNATURE = "c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=";

export function createThoughtSignatureStreamTap(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let lineBuffer = "";
  const toolCallsByIndex = new Map<number, { id?: string; signature?: string }>();

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:") || line === "data: [DONE]") return;
    const dataStr = line.slice(5).trim();
    if (!dataStr) return;

    try {
      const parsed = JSON.parse(dataStr) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        const choices = parsed.choices;
        if (Array.isArray(choices)) {
          for (const choice of choices) {
            const delta = (choice as Record<string, unknown>)?.delta as Record<string, unknown> | undefined;
            if (!delta) continue;

            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                if (!tc || typeof tc !== "object") continue;
                const idx = typeof (tc as any).index === "number" ? (tc as any).index : 0;
                let entry = toolCallsByIndex.get(idx);
                if (!entry) {
                  entry = {};
                  toolCallsByIndex.set(idx, entry);
                }
                if (typeof (tc as any).id === "string" && (tc as any).id) {
                  entry.id = (tc as any).id;
                  if (entry.id && entry.signature) {
                    storeThoughtSignature(entry.id, entry.signature);
                  }
                }
              }
            }

            if (Array.isArray(delta.reasoning_details)) {
              for (const item of delta.reasoning_details) {
                if (!item || typeof item !== "object") continue;
                const tcId = (item as any).id || (item as any).tool_call_id;
                const data = (item as any).data || (item as any).signature;
                if (typeof tcId === "string" && typeof data === "string") {
                  storeThoughtSignature(tcId, data);
                } else if (typeof data === "string") {
                  const idx = typeof (item as any).index === "number" ? (item as any).index : 0;
                  let entry = toolCallsByIndex.get(idx);
                  if (!entry) {
                    entry = {};
                    toolCallsByIndex.set(idx, entry);
                  }
                  entry.signature = data;
                  if (entry.id) {
                    storeThoughtSignature(entry.id, data);
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // ignore non-json lines
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      const text = decoder.decode(chunk, { stream: true });
      lineBuffer += text;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        processLine(rawLine);
      }
    },
    flush() {
      if (lineBuffer.trim()) {
        processLine(lineBuffer);
      }
      lineBuffer = "";
      toolCallsByIndex.clear();
    },
  });
}

export function storeThoughtSignaturesFromResponse(responseObj: unknown): void {
  if (!responseObj || typeof responseObj !== "object") return;
  const obj = responseObj as Record<string, unknown>;

  if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) {
      if (!choice || typeof choice !== "object") continue;
      const msg = (choice as Record<string, unknown>).message as Record<string, unknown> | undefined;
      if (msg && Array.isArray(msg.reasoning_details)) {
        const details = msg.reasoning_details as any[];
        for (let i = 0; i < details.length; i++) {
          const item = details[i];
          if (!item || typeof item !== "object") continue;
          let tcId = item.id || item.tool_call_id;
          const data = item.data || item.signature;
          if (!tcId && Array.isArray(msg.tool_calls)) {
            const idx = typeof item.index === "number" ? item.index : i;
            tcId = msg.tool_calls[idx]?.id;
          }
          if (typeof tcId === "string" && typeof data === "string") {
            storeThoughtSignature(tcId, data);
          }
        }
      }
      if (msg && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc || typeof tc !== "object") continue;
          const extra = (tc as any).extra_content?.google?.thought_signature;
          if (typeof (tc as any).id === "string" && typeof extra === "string") {
            storeThoughtSignature((tc as any).id, extra);
          }
        }
      }
    }
  }

  if (Array.isArray((obj as any).reasoning_details)) {
    const details = (obj as any).reasoning_details as any[];
    for (let i = 0; i < details.length; i++) {
      const item = details[i];
      if (!item || typeof item !== "object") continue;
      let tcId = item.id || item.tool_call_id;
      const data = item.data || item.signature;
      if (!tcId && Array.isArray((obj as any).tool_calls)) {
        const idx = typeof item.index === "number" ? item.index : i;
        tcId = (obj as any).tool_calls[idx]?.id;
      }
      if (typeof tcId === "string" && typeof data === "string") {
        storeThoughtSignature(tcId, data);
      }
    }
  }
}

function patchAssistantMessageSignatures(msg: OpenAIMessage): OpenAIMessage {
  if (msg.role !== "assistant" || !msg.tool_calls || msg.tool_calls.length === 0) {
    return msg;
  }

  const hasCachedSig = msg.tool_calls.some((tc) => Boolean(getThoughtSignature(tc.id)));

  const toolCalls = msg.tool_calls.map((tc, idx) => {
    const cached = getThoughtSignature(tc.id);
    let sig: string | undefined;
    if (cached) {
      sig = cached;
    } else if (!hasCachedSig && idx === 0) {
      // Anchor placement on cache-miss turn: only first tool call receives sentinel
      sig = SENTINEL_SIGNATURE;
    } else if (!hasCachedSig) {
      // Secondary parallel tool calls on cache miss do not get duplicate signatures
      sig = undefined;
    } else {
      // Another call in this batch has an authentic signature; non-anchor gets no spurious sig
      sig = undefined;
    }

    if (!sig) {
      return tc;
    }
    return {
      ...tc,
      extra_content: {
        ...tc.extra_content,
        google: {
          thought_signature: sig,
        },
      },
    };
  });

  const existingDetails = Array.isArray((msg as any).reasoning_details)
    ? [...((msg as any).reasoning_details as any[])]
    : [];
  const seenIds = new Set(existingDetails.map((d: any) => d.id || d.tool_call_id));

  for (let i = 0; i < msg.tool_calls.length; i++) {
    const tc = msg.tool_calls[i];
    if (!tc || seenIds.has(tc.id)) continue;
    const sig = (toolCalls[i] as any)?.extra_content?.google?.thought_signature;
    if (sig) {
      existingDetails.push({
        type: "reasoning.encrypted",
        data: sig,
        id: tc.id,
        format: "google-gemini-v1",
      });
      seenIds.add(tc.id);
    }
  }

  return {
    ...msg,
    tool_calls: toolCalls,
    reasoning_details: existingDetails,
  } as OpenAIMessage;
}

export function injectThoughtSignatures(
  messages: readonly OpenAIMessage[]
): readonly OpenAIMessage[] {
  return messages.map(patchAssistantMessageSignatures);
}

export function stripReasoningParameters(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const cleaned = { ...payload };
  delete cleaned.thinking;
  delete cleaned.thinkingConfig;
  delete cleaned.thinking_config;
  delete cleaned.reasoning_effort;
  delete cleaned.budget_tokens;
  return cleaned;
}

export function shouldStripReasoning(
  globalStrip: boolean,
  nuances: readonly string[],
  targetWire?: string,
  aoStripReasoning?: boolean
): boolean {
  if (nuances.includes("ts") || nuances.includes("ds")) {
    return false;
  }
  if (nuances.includes("sb")) {
    return true;
  }
  if (targetWire === "ao" && (aoStripReasoning ?? true)) {
    return true;
  }
  return globalStrip;
}

export interface StreamThinkingState {
  isInThinkTag: boolean;
  bufferedText: string;
}

export function createStreamThinkingState(): StreamThinkingState {
  return {
    isInThinkTag: false,
    bufferedText: "",
  };
}

function formatAnthropicThinkingDelta(text: string): string {
  const event = {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "thinking_delta",
      thinking: text,
    },
  };
  return `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`;
}

function formatAnthropicTextDelta(text: string): string {
  const event = {
    type: "content_block_delta",
    index: 1,
    delta: {
      type: "text_delta",
      text: text,
    },
  };
  return `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`;
}

function processTagOpen(
  text: string,
  state: StreamThinkingState,
  preserveThinking: boolean
): string {
  const parts = text.split("<think>");
  const before = parts[0] ?? "";
  const after = parts.slice(1).join("<think>");
  state.isInThinkTag = true;

  let out = "";
  if (before.length > 0) {
    out += formatAnthropicTextDelta(before);
  }
  if (after.length > 0 && preserveThinking) {
    out += formatAnthropicThinkingDelta(after);
  }
  return out;
}

function processTagClose(
  text: string,
  state: StreamThinkingState,
  preserveThinking: boolean
): string {
  const parts = text.split("</think>");
  const thinkPart = parts[0] ?? "";
  const textPart = parts.slice(1).join("</think>");
  state.isInThinkTag = false;

  let out = "";
  if (thinkPart.length > 0 && preserveThinking) {
    out += formatAnthropicThinkingDelta(thinkPart);
  }
  if (textPart.length > 0) {
    out += formatAnthropicTextDelta(textPart);
  }
  return out;
}

function appendThinkingIfPreserved(out: string, thinkPart: string, preserveThinking: boolean): string {
  if (thinkPart.length > 0 && preserveThinking) {
    return out + formatAnthropicThinkingDelta(thinkPart);
  }
  return out;
}

function processFullThinkTag(
  text: string,
  preserveThinking: boolean
): string {
  const parts = text.split("<think>");
  const before = parts[0] ?? "";
  const rest = parts.slice(1).join("<think>");
  const closeParts = rest.split("</think>");
  const thinkPart = closeParts[0] ?? "";
  const after = closeParts.slice(1).join("</think>");

  let out = before.length > 0 ? formatAnthropicTextDelta(before) : "";
  out = appendThinkingIfPreserved(out, thinkPart, preserveThinking);
  if (after.length > 0) {
    out += formatAnthropicTextDelta(after);
  }
  return out;
}

function formatDefaultDelta(
  chunk: string,
  state: StreamThinkingState,
  preserveThinking: boolean
): string {
  if (state.isInThinkTag) {
    return preserveThinking ? formatAnthropicThinkingDelta(chunk) : "";
  }
  return formatAnthropicTextDelta(chunk);
}

export function processThinkingDelta(
  chunk: string,
  state: StreamThinkingState,
  preserveThinking: boolean
): string {
  const hasOpen = chunk.includes("<think>");
  const hasClose = chunk.includes("</think>");

  if (hasOpen && hasClose) {
    state.isInThinkTag = false;
    return processFullThinkTag(chunk, preserveThinking);
  }
  if (hasOpen) {
    return processTagOpen(chunk, state, preserveThinking);
  }
  if (hasClose) {
    return processTagClose(chunk, state, preserveThinking);
  }
  return formatDefaultDelta(chunk, state, preserveThinking);
}

export {
  REASONING_KEYS,
  deleteReasoningKeys,
  isOpenCodeClient,
  hasMeaningfulDeltaFields,
  sanitizeDelta,
  filterReasoningFromChoice,
  filterReasoningFromChunk,
  sanitizeRawControlChars,
  createSyntheticHeartbeatChunk,
  processSseDataLine,
  FILTER_HEARTBEAT_INTERVAL_MS,
  type FilterTransformerState,
  createOpenCodeReasoningFilterStreamTransformer,
  stripReasoningFromResponseBody,
  normalizeToolContent,
  stripClientMetadata,
  stripToolMetadata,
  scrubReasoningFromMessage,
  scrubReasoningFromMessages,
} from "./opencode_adapter";

