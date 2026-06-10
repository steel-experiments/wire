import type { JsonObject, JsonValue, TraceBlobKind, TraceBlobRef, TraceEvent } from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import type { ChatMessage, ChatOptions, ChatResponse, LLMProvider } from "../providers/llm/types.js";
import type { LoopState } from "./loop.js";

export interface LlmTraceOptions {
  traceLlmMessages?: boolean;
  saveTraceBlob?: (
    runId: TraceEvent["runId"],
    kind: TraceBlobKind,
    value: JsonValue,
    contentType?: string,
  ) => Promise<TraceBlobRef>;
}

function chatMessageToJson(message: ChatMessage): JsonObject {
  return {
    role: message.role,
    content: message.content as JsonValue,
  };
}

export async function recordLlmCall(
  state: LoopState,
  traceOptions: LlmTraceOptions | undefined,
  purpose: string,
  messages: ChatMessage[],
  response: ChatResponse,
): Promise<void> {
  if (traceOptions?.traceLlmMessages === true && traceOptions.saveTraceBlob) {
    const messageRefs: JsonObject[] = [];
    for (const message of messages) {
      const ref = await traceOptions.saveTraceBlob(state.run.id, "llm-message", chatMessageToJson(message), "application/json");
      messageRefs.push({ hash: ref.hash, size: ref.size, kind: ref.kind, role: message.role });
    }
    const responseRef = await traceOptions.saveTraceBlob(state.run.id, "llm-response", response.content, "text/plain");
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "llm-call",
      payload: {
        callIndex: state.stepCount + 1,
        purpose,
        model: response.model,
        messageRefs,
        responseRef: { hash: responseRef.hash, size: responseRef.size, kind: responseRef.kind },
      },
    });
  }
  if (response.usage || response.retries) {
    const payload: JsonObject = {
      callIndex: state.stepCount + 1,
      purpose,
      model: response.model,
    };
    if (response.usage) {
      payload.usage = response.usage;
    }
    // Discarded transport attempts are part of the run record — no hidden retries.
    if (response.retries) {
      payload.transportRetries = response.retries;
    }
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "llm-usage",
      payload,
    });
  }
}

export function tracingProvider(
  llm: LLMProvider,
  state: LoopState,
  traceOptions: LlmTraceOptions | undefined,
  purpose: string,
): LLMProvider {
  return {
    model: llm.model,
    chat: async (messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> => {
      const response = await llm.chat(messages, options);
      await recordLlmCall(state, traceOptions, purpose, messages, response);
      return response;
    },
  };
}
