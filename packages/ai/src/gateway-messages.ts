// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

// Transport-neutral Gateway messages request and SSE codec.

import type {
  JsonObject,
  JsonValue,
  ModelErrorCategory,
  ModelStreamEvent,
  Usage,
} from "@axl/protocol";

import { safeProviderMessage } from "./diagnostics.ts";
import type { GatewayMessagesCompatibility, ModelInfo } from "./model.ts";
import {
  isPreparedModelRequest,
  type PreparedModelRequest,
  type PreparedRequestMessage,
} from "./request-preparation.ts";
import type { SseFrame } from "./sse.ts";

export class GatewayMessagesCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GatewayMessagesCodecError";
  }
}

export interface EncodedGatewayMessagesRequest {
  readonly body: JsonObject;
}

export interface GatewayMessagesDecodeOptions {
  readonly model: ModelInfo;
  readonly request: PreparedModelRequest;
  readonly startedAtMs?: number;
  readonly now?: () => number;
  readonly secretValues?: readonly string[];
}

type MutableJsonObject = Record<string, JsonValue>;

type GatewayToolState = {
  readonly contentIndex: number;
  readonly callId: string;
  readonly name: string;
  argumentsText: string;
};

const ERROR_CATEGORIES = new Set<ModelErrorCategory>([
  "rate_limit",
  "overloaded",
  "network",
  "timeout",
  "authentication",
  "authorization",
  "invalid_request",
  "context_limit",
  "content_policy",
  "provider_internal",
  "stream_interrupted",
  "unknown",
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compatibility(model: ModelInfo): GatewayMessagesCompatibility {
  if (model.apiDialect !== "gateway-messages") {
    throw new GatewayMessagesCodecError(
      `Model ${model.modelId} does not use the gateway-messages dialect`,
    );
  }
  if (model.compatibility?.dialect !== "gateway-messages") {
    throw new GatewayMessagesCodecError(
      `Model ${model.modelId} has no Gateway messages compatibility record`,
    );
  }
  return model.compatibility;
}

function requirePrepared(request: PreparedModelRequest): void {
  if (!isPreparedModelRequest(request)) {
    throw new GatewayMessagesCodecError("Gateway messages requires a prepared model request");
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GatewayMessagesCodecError(`${label} must be a non-empty string`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GatewayMessagesCodecError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new GatewayMessagesCodecError(`${label} must be a non-negative number`);
  }
  return value;
}

function encodeContent(
  request: PreparedModelRequest,
  message: Extract<PreparedRequestMessage, { role: "user" | "tool" }>,
): JsonValue[] {
  return message.content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    const blob = request.preparation.blobs.get(part.blob.sha256);
    if (blob === undefined) {
      throw new GatewayMessagesCodecError(`Prepared blob ${part.blob.sha256} is unavailable`);
    }
    return {
      type: "image",
      data: Buffer.from(blob.bytes).toString("base64"),
      mimeType: blob.reference.mediaType,
    };
  });
}

function rejectTextContinuation(
  continuation: Extract<
    Extract<PreparedRequestMessage, { role: "assistant" }>["content"][number],
    { type: "text" }
  >["continuation"],
  path: string,
): void {
  if (continuation !== undefined) {
    throw new GatewayMessagesCodecError(`${path} has unsupported continuation metadata`);
  }
}

function encodeAssistantMessage(
  model: ModelInfo,
  message: Extract<PreparedRequestMessage, { role: "assistant" }>,
  messageIndex: number,
): JsonObject {
  const content: JsonValue[] = message.content.map((part, contentIndex) => {
    const path = `messages[${messageIndex}].content[${contentIndex}]`;
    if (part.type === "blob") {
      throw new GatewayMessagesCodecError(`${path} cannot replay an assistant image`);
    }
    if (part.type === "text") {
      rejectTextContinuation(part.continuation, path);
      return {
        type: "text",
        text: part.text,
        ...(part.signature === undefined ? {} : { textSignature: part.signature.value }),
      };
    }
    return {
      type: "thinking",
      thinking: part.text,
      ...(part.signature === undefined ? {} : { thinkingSignature: part.signature.value }),
      ...(part.redacted === true ? { redacted: true } : {}),
    };
  });
  const toolCalls = (message.toolCalls ?? []).map((call, callIndex): JsonValue => {
    if (call.continuation?.responseId !== undefined || call.continuation?.itemId !== undefined) {
      throw new GatewayMessagesCodecError(
        `messages[${messageIndex}].toolCalls[${callIndex}] has unsupported continuation metadata`,
      );
    }
    return {
      type: "toolCall",
      id: call.callId,
      name: call.name,
      arguments: call.input,
      ...(call.signature === undefined ? {} : { thoughtSignature: call.signature.value }),
      ...(call.continuation?.namespace === undefined
        ? {}
        : { namespace: call.continuation.namespace }),
    };
  });
  if (message.continuation?.itemId !== undefined || message.continuation?.namespace !== undefined) {
    throw new GatewayMessagesCodecError(
      `messages[${messageIndex}] has unsupported continuation metadata`,
    );
  }
  if (content.length === 0 && toolCalls.length === 0) {
    throw new GatewayMessagesCodecError(
      `messages[${messageIndex}] has no Gateway-renderable assistant content`,
    );
  }
  const origin = message.origin;
  return {
    role: "assistant",
    content: [...content, ...toolCalls],
    api: "pi-messages",
    provider: origin?.providerId ?? model.providerId,
    model: model.modelId,
    ...(origin !== undefined && origin.modelId !== model.modelId
      ? { responseModel: origin.modelId }
      : {}),
    ...(message.continuation?.responseId === undefined
      ? {}
      : { responseId: message.continuation.responseId }),
    usage: emptyGatewayUsage(),
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: 0,
  };
}

function encodeMessages(model: ModelInfo, request: PreparedModelRequest): JsonValue[] {
  return request.messages.map((message, messageIndex): JsonValue => {
    if (message.role === "user") {
      const content = encodeContent(request, message);
      return {
        role: "user",
        content:
          content.length === 1 && object(content[0])?.type === "text"
            ? (object(content[0])?.text as string)
            : content,
        timestamp: 0,
      };
    }
    if (message.role === "assistant") {
      return encodeAssistantMessage(model, message, messageIndex);
    }
    return {
      role: "toolResult",
      toolCallId: message.callId,
      toolName: message.name,
      content: encodeContent(request, message),
      isError: message.isError,
      timestamp: 0,
    };
  });
}

function encodeTools(request: PreparedModelRequest): JsonValue[] | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined;
  return request.tools.map((tool): JsonValue => {
    if (tool.preparedConstraint?.type === "grammar") {
      throw new GatewayMessagesCodecError(
        `Gateway messages cannot render grammar-constrained tool ${tool.canonicalName}`,
      );
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      ...(tool.preparedConstraint?.type === "json-schema"
        ? {
            constrainedSampling: {
              type: "json_schema",
              strict: tool.preparedConstraint.strict ? "require" : "prefer",
            },
          }
        : {}),
    };
  });
}

function emptyGatewayUsage(): JsonObject {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Encodes only a validated, immutable prepared request. */
export function encodeGatewayMessagesRequest(
  model: ModelInfo,
  request: PreparedModelRequest,
): EncodedGatewayMessagesRequest {
  requirePrepared(request);
  compatibility(model);
  if (request.modelId !== model.modelId) {
    throw new GatewayMessagesCodecError(
      `Request model ${request.modelId} does not match ${model.modelId}`,
    );
  }
  if (request.safetySettings !== undefined) {
    throw new GatewayMessagesCodecError("Gateway messages cannot render safety settings");
  }
  if (request.sampling !== undefined) {
    throw new GatewayMessagesCodecError("Gateway messages cannot render sampling controls");
  }
  const context: MutableJsonObject = { messages: encodeMessages(model, request) };
  if (request.system !== undefined) context.systemPrompt = request.system;
  const tools = request.toolChoice === "none" ? undefined : encodeTools(request);
  if (tools !== undefined) context.tools = tools;
  if (request.toolChoice !== undefined && request.toolChoice !== "none" && tools === undefined) {
    throw new GatewayMessagesCodecError(`toolChoice ${request.toolChoice} needs at least one tool`);
  }
  const options: MutableJsonObject = {};
  if (
    request.preparation.reasoning !== undefined &&
    request.preparation.reasoning.effective !== "off"
  ) {
    options.reasoning = request.preparation.reasoning.effective;
  }
  if (request.maxOutputTokens !== undefined) options.maxTokens = request.maxOutputTokens;
  if (request.toolChoice !== undefined) options.toolChoice = request.toolChoice;
  if (request.preparation.cache.retention !== "none") {
    options.cacheRetention = request.preparation.cache.retention;
    if (request.preparation.cache.sessionId !== undefined) {
      options.sessionId = request.preparation.cache.sessionId;
    }
  }
  if (request.metadata !== undefined) options.metadata = { ...request.metadata };
  return { body: { model: model.modelId, context, options } };
}

function usage(raw: unknown): Usage {
  const value = object(raw);
  if (value === undefined) throw new GatewayMessagesCodecError("Gateway usage must be an object");
  const input = nonNegativeInteger(value.input, "Gateway usage input");
  const output = nonNegativeInteger(value.output, "Gateway usage output");
  const cacheRead = nonNegativeInteger(value.cacheRead, "Gateway usage cacheRead");
  const cacheWrite = nonNegativeInteger(value.cacheWrite, "Gateway usage cacheWrite");
  if (value.reasoning !== undefined) {
    nonNegativeInteger(value.reasoning, "Gateway usage reasoning");
  }
  nonNegativeInteger(value.totalTokens, "Gateway usage totalTokens");
  const cost = object(value.cost);
  if (cost === undefined)
    throw new GatewayMessagesCodecError("Gateway usage cost must be an object");
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    nonNegativeNumber(cost[field], `Gateway usage cost ${field}`);
  }
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(value.reasoning === undefined ? {} : { reasoningTokens: value.reasoning as number }),
    costUsd: cost.total as number,
  };
}

function reverseToolName(request: PreparedModelRequest, name: string): string {
  return request.preparation.tools.find((tool) => tool.name === name)?.canonicalName ?? name;
}

function responseMetadata(
  event: Record<string, unknown>,
  options: GatewayMessagesDecodeOptions,
): NonNullable<Extract<ModelStreamEvent, { type: "completed" }>["response"]> {
  if (event.requestedModelId !== undefined && event.requestedModelId !== options.request.modelId) {
    throw new GatewayMessagesCodecError("Gateway terminal event has a mismatched requested model");
  }
  const routedModel = event.routedModelId ?? event.responseModel;
  const responseId = event.responseId;
  const nativeStopReason = event.nativeStopReason ?? event.rawStopReason ?? event.reason;
  if (routedModel !== undefined) nonEmptyString(routedModel, "Gateway routed model");
  if (responseId !== undefined) nonEmptyString(responseId, "Gateway response ID");
  if (nativeStopReason !== undefined)
    nonEmptyString(nativeStopReason, "Gateway native stop reason");
  return {
    providerId: options.model.providerId,
    requestedModelId: options.request.modelId,
    ...(routedModel === undefined ? {} : { routedModelId: routedModel as string }),
    ...(responseId === undefined ? {} : { responseId: responseId as string }),
    ...(nativeStopReason === undefined ? {} : { nativeStopReason: nativeStopReason as string }),
    ...(options.startedAtMs === undefined
      ? {}
      : { latencyMs: Math.max(0, (options.now ?? Date.now)() - options.startedAtMs) }),
  };
}

function replayMetadata(
  target: "text" | "thinking",
  contentIndex: number,
  signature: string,
  options: GatewayMessagesDecodeOptions,
  redacted?: boolean,
): ModelStreamEvent {
  return {
    type: "replay_metadata",
    target,
    contentIndex,
    providerId: options.model.providerId,
    apiDialect: options.model.apiDialect,
    modelId: options.model.modelId,
    signature,
    ...(redacted === true ? { redacted: true } : {}),
  };
}

function errorCategory(value: unknown): ModelErrorCategory | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ERROR_CATEGORIES.has(value as ModelErrorCategory)) {
    throw new GatewayMessagesCodecError("Gateway error category is malformed");
  }
  return value as ModelErrorCategory;
}

/** Decodes framed Gateway SSE values into canonical model stream events. */
export async function* decodeGatewayMessagesStream(
  frames: AsyncIterable<SseFrame>,
  options: GatewayMessagesDecodeOptions,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  requirePrepared(options.request);
  compatibility(options.model);
  const tools = new Map<number, GatewayToolState>();
  const content = new Map<number, { type: "text" | "thinking"; text: string }>();
  let emittedContent = false;

  for await (const frame of frames) {
    if (options.request.signal?.aborted) {
      yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
      return;
    }
    if (frame.data === "[DONE]") break;
    let event: Record<string, unknown>;
    try {
      const parsed = object(JSON.parse(frame.data) as unknown);
      if (parsed === undefined) throw new Error("frame is not an object");
      event = parsed;
    } catch (cause) {
      throw new GatewayMessagesCodecError("Gateway sent an undecodable stream frame", { cause });
    }
    const type = nonEmptyString(event.type, "Gateway event type");
    if (type === "start") continue;
    if (type === "text_start" || type === "thinking_start") {
      const contentIndex = nonNegativeInteger(event.contentIndex, `Gateway ${type} contentIndex`);
      if (content.has(contentIndex)) {
        throw new GatewayMessagesCodecError(`Gateway repeated content position ${contentIndex}`);
      }
      content.set(contentIndex, {
        type: type === "text_start" ? "text" : "thinking",
        text: "",
      });
      continue;
    }
    if (type === "text_delta" || type === "thinking_delta") {
      const contentIndex = nonNegativeInteger(event.contentIndex, `Gateway ${type} contentIndex`);
      const contentType = type === "text_delta" ? "text" : "thinking";
      const delta = typeof event.delta === "string" ? event.delta : event.text;
      if (typeof delta !== "string") {
        throw new GatewayMessagesCodecError(`Gateway ${type} delta must be a string`);
      }
      const state = content.get(contentIndex) ?? { type: contentType, text: "" };
      if (state.type !== contentType) {
        throw new GatewayMessagesCodecError(`Gateway changed content type at ${contentIndex}`);
      }
      state.text += delta;
      content.set(contentIndex, state);
      if (delta.length > 0) emittedContent = true;
      yield {
        type: contentType === "text" ? "text_delta" : "thinking_delta",
        text: delta,
        contentIndex,
      };
      continue;
    }
    if (type === "text_end" || type === "thinking_end") {
      const contentIndex = nonNegativeInteger(event.contentIndex, `Gateway ${type} contentIndex`);
      const contentType = type === "text_end" ? "text" : "thinking";
      const finalContent = event.content;
      if (typeof finalContent !== "string") {
        throw new GatewayMessagesCodecError(`Gateway ${type} content must be a string`);
      }
      const state = content.get(contentIndex) ?? { type: contentType, text: "" };
      if (state.type !== contentType || !finalContent.startsWith(state.text)) {
        throw new GatewayMessagesCodecError(`Gateway ${type} does not match streamed content`);
      }
      const remainder = finalContent.slice(state.text.length);
      if (remainder.length > 0) {
        emittedContent = true;
        yield {
          type: contentType === "text" ? "text_delta" : "thinking_delta",
          text: remainder,
          contentIndex,
        };
      }
      content.delete(contentIndex);
      const signature = event.contentSignature;
      if (event.redacted !== undefined && typeof event.redacted !== "boolean") {
        throw new GatewayMessagesCodecError(`Gateway ${type} redacted must be a boolean`);
      }
      if (type === "text_end" && event.redacted !== undefined) {
        throw new GatewayMessagesCodecError("Gateway text_end cannot be redacted");
      }
      if (event.redacted === true && signature === undefined) {
        throw new GatewayMessagesCodecError("Gateway redacted thinking requires a signature");
      }
      if (signature !== undefined) {
        nonEmptyString(signature, `Gateway ${type} contentSignature`);
        emittedContent = true;
        yield replayMetadata(
          contentType,
          contentIndex,
          signature as string,
          options,
          contentType === "thinking" && event.redacted === true,
        );
      }
      continue;
    }
    if (type === "toolcall_start") {
      const contentIndex = nonNegativeInteger(event.contentIndex, "Gateway tool contentIndex");
      const callId = nonEmptyString(event.id ?? event.callId, "Gateway tool call ID");
      const name = nonEmptyString(event.toolName ?? event.name, "Gateway tool name");
      if (tools.has(contentIndex)) {
        throw new GatewayMessagesCodecError(`Gateway repeated tool call position ${contentIndex}`);
      }
      tools.set(contentIndex, { contentIndex, callId, name, argumentsText: "" });
      emittedContent = true;
      yield {
        type: "tool_call_start",
        contentIndex,
        callId,
        name: reverseToolName(options.request, name),
      };
      continue;
    }
    if (type === "toolcall_delta") {
      const contentIndex = nonNegativeInteger(event.contentIndex, "Gateway tool contentIndex");
      if (typeof event.delta !== "string") {
        throw new GatewayMessagesCodecError("Gateway tool call delta must be a string");
      }
      const state = tools.get(contentIndex);
      if (state === undefined) {
        throw new GatewayMessagesCodecError("Gateway tool call delta has no matching start");
      }
      state.argumentsText += event.delta;
      yield {
        type: "tool_call_delta",
        contentIndex,
        callId: state.callId,
        argumentsDelta: event.delta,
      };
      continue;
    }
    if (type === "toolcall_end") {
      const contentIndex = nonNegativeInteger(event.contentIndex, "Gateway tool contentIndex");
      const state = tools.get(contentIndex);
      if (state === undefined) {
        throw new GatewayMessagesCodecError("Gateway tool call end has no matching start");
      }
      const toolCall = object(event.toolCall);
      if (toolCall === undefined) {
        throw new GatewayMessagesCodecError("Gateway tool call end is malformed");
      }
      const callId = nonEmptyString(toolCall.id, "Gateway completed tool call ID");
      const name = nonEmptyString(toolCall.name, "Gateway completed tool name");
      if (callId !== state.callId || name !== state.name) {
        throw new GatewayMessagesCodecError("Gateway completed tool call does not match its start");
      }
      const input = object(toolCall.arguments);
      if (input === undefined) {
        throw new GatewayMessagesCodecError("Gateway completed tool arguments must be an object");
      }
      if (state.argumentsText.length > 0) {
        try {
          if (object(JSON.parse(state.argumentsText) as unknown) === undefined) {
            throw new Error("arguments are not an object");
          }
        } catch (cause) {
          throw new GatewayMessagesCodecError("Gateway streamed tool arguments are malformed", {
            cause,
          });
        }
      }
      tools.delete(contentIndex);
      const canonicalName = reverseToolName(options.request, name);
      yield {
        type: "tool_call",
        contentIndex,
        callId,
        name: canonicalName,
        input: input as JsonObject,
      };
      const signature = toolCall.thoughtSignature;
      const namespace = toolCall.namespace;
      if (signature !== undefined) {
        nonEmptyString(signature, "Gateway tool signature");
      }
      if (namespace !== undefined) {
        nonEmptyString(namespace, "Gateway tool namespace");
      }
      if (signature !== undefined || namespace !== undefined) {
        yield {
          type: "replay_metadata",
          target: "tool_call",
          contentIndex,
          callId,
          providerId: options.model.providerId,
          apiDialect: options.model.apiDialect,
          modelId: options.model.modelId,
          ...(signature === undefined ? {} : { signature: signature as string }),
          ...(namespace === undefined ? {} : { namespace: namespace as string }),
        };
      }
      continue;
    }
    if (type === "done") {
      if (tools.size > 0)
        throw new GatewayMessagesCodecError("Gateway ended with incomplete tool calls");
      const reason = nonEmptyString(event.reason, "Gateway stop reason");
      const stopReason =
        reason === "stop"
          ? "stop"
          : reason === "length"
            ? "length"
            : reason === "toolUse" || reason === "tool_use"
              ? "tool_use"
              : undefined;
      if (stopReason === undefined) {
        throw new GatewayMessagesCodecError(`Gateway stop reason ${reason} is unsupported`);
      }
      yield {
        type: "completed",
        stopReason,
        usage: usage(event.usage),
        ...(stopReason === "length" ? { partial: true } : {}),
        response: responseMetadata(event, options),
      };
      return;
    }
    if (type === "error") {
      const reason = nonEmptyString(event.reason, "Gateway error reason");
      if (reason === "aborted") {
        yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
        return;
      }
      if (reason !== "error") {
        throw new GatewayMessagesCodecError(`Gateway error reason ${reason} is unsupported`);
      }
      const code =
        event.code === undefined
          ? "gateway_error"
          : nonEmptyString(event.code, "Gateway error code");
      if (event.retryable !== undefined && typeof event.retryable !== "boolean") {
        throw new GatewayMessagesCodecError("Gateway error retryable must be a boolean");
      }
      const category = errorCategory(event.category) ?? "provider_internal";
      yield {
        type: "error",
        code,
        message: safeProviderMessage(
          typeof event.errorMessage === "string"
            ? event.errorMessage
            : "Gateway reported a failure",
          options.secretValues,
        ),
        retryable: event.retryable === true,
        category,
        requestPhase: "streaming",
        ...(emittedContent ? { partial: true } : {}),
        response: responseMetadata(event, options),
      };
      return;
    }
    throw new GatewayMessagesCodecError(`Gateway event type ${type} is unsupported`);
  }

  if (options.request.signal?.aborted) {
    yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
  }
}
