// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

// Shared Axl-native Google request and streaming response codec.

import type { JsonObject, JsonValue, Usage } from "@axl/protocol";

import { safeProviderMessage } from "./diagnostics.ts";
import type {
  GoogleGenerativeAiCompatibility,
  GoogleVertexCompatibility,
  ModelInfo,
  ModelStreamEvent,
} from "./model.ts";
import {
  isPreparedModelRequest,
  type PreparedModelRequest,
  type PreparedRequestMessage,
} from "./request-preparation.ts";
import type { SseFrame } from "./sse.ts";
import { withUsageCost } from "./usage.ts";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const RESERVED_GENERATION_FIELDS = new Set([
  "temperature",
  "topP",
  "topK",
  "candidateCount",
  "maxOutputTokens",
  "responseMimeType",
  "responseSchema",
  "seed",
  "thinkingConfig",
]);
const SAFETY_FINISH_REASONS = new Set([
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "SAFETY",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "IMAGE_OTHER",
  "RECITATION",
  "LANGUAGE",
]);

export class GoogleGenerativeAiCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GoogleGenerativeAiCodecError";
  }
}

export interface EncodedGoogleRequest {
  readonly modelId: string;
  readonly body: JsonObject;
  /** Protocol headers only. Authentication remains transport-owned. */
  readonly headers: Readonly<Record<string, string>>;
}

type MutableJsonObject = Record<string, JsonValue>;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type GoogleApiDialect = "google-generative-ai" | "google-vertex";
type GoogleCompatibility = GoogleGenerativeAiCompatibility | GoogleVertexCompatibility;

function compatibility(model: ModelInfo, expectedDialect: GoogleApiDialect): GoogleCompatibility {
  if (model.apiDialect !== expectedDialect) {
    throw new GoogleGenerativeAiCodecError(
      `Model ${model.modelId} does not use the ${expectedDialect} dialect`,
    );
  }
  if (model.compatibility?.dialect !== expectedDialect) {
    throw new GoogleGenerativeAiCodecError(
      `Model ${model.modelId} has no ${expectedDialect} compatibility record`,
    );
  }
  return model.compatibility;
}

function preparedRequest(request: PreparedModelRequest): void {
  if (!isPreparedModelRequest(request)) {
    throw new GoogleGenerativeAiCodecError(
      "Google Generative AI requires a prepared model request",
    );
  }
}

function isGemini3(modelId: string): boolean {
  return /^gemini(?:-live)?-3(?:\.|-)/i.test(modelId);
}

function isGemini3Pro(modelId: string): boolean {
  return /^gemini(?:-live)?-3(?:\.\d+)?-pro/i.test(modelId);
}

function isGemini3Flash(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return (
    /^gemini(?:-live)?-3(?:\.\d+)?-flash/.test(id) ||
    id === "gemini-flash-latest" ||
    id === "gemini-flash-lite-latest"
  );
}

function isGemma4(modelId: string): boolean {
  return /gemma-?4/i.test(modelId);
}

function requiresToolCallId(modelId: string): boolean {
  return isGemini3(modelId) || modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function googleSignature(value: string, path: string): string {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new GoogleGenerativeAiCodecError(`${path} is not a valid Google thought signature`);
  }
  return value;
}

function verifiedImage(request: PreparedModelRequest, sha256: string): MutableJsonObject {
  const blob = request.preparation.blobs.get(sha256);
  if (blob === undefined) {
    throw new GoogleGenerativeAiCodecError(`Prepared blob ${sha256} is unavailable`);
  }
  if (!SUPPORTED_IMAGE_TYPES.has(blob.reference.mediaType)) {
    throw new GoogleGenerativeAiCodecError(
      `Google Generative AI does not support image media type ${blob.reference.mediaType}`,
    );
  }
  return {
    inlineData: {
      mimeType: blob.reference.mediaType,
      data: Buffer.from(blob.bytes).toString("base64"),
    },
  };
}

function basicParts(
  request: PreparedModelRequest,
  message: PreparedRequestMessage,
): MutableJsonObject[] {
  return message.content.map((content) => {
    if (content.type === "text") return { text: content.text };
    if (content.type === "blob") return verifiedImage(request, content.blob.sha256);
    throw new GoogleGenerativeAiCodecError("Google Generative AI cannot encode this content block");
  });
}

function rejectContinuation(message: PreparedRequestMessage, messageIndex: number): void {
  if (message.role !== "assistant") return;
  if (message.continuation !== undefined) {
    throw new GoogleGenerativeAiCodecError(
      `messages[${messageIndex}] has continuation metadata unsupported by Google Generative AI`,
    );
  }
  for (const [contentIndex, content] of message.content.entries()) {
    if (content.type === "text" && content.continuation !== undefined) {
      throw new GoogleGenerativeAiCodecError(
        `messages[${messageIndex}].content[${contentIndex}] has unsupported continuation metadata`,
      );
    }
  }
  for (const [callIndex, call] of (message.toolCalls ?? []).entries()) {
    if (call.continuation !== undefined) {
      throw new GoogleGenerativeAiCodecError(
        `messages[${messageIndex}].toolCalls[${callIndex}] has unsupported continuation metadata`,
      );
    }
  }
}

function assistantParts(
  model: ModelInfo,
  message: Extract<PreparedRequestMessage, { role: "assistant" }>,
  messageIndex: number,
): MutableJsonObject[] {
  rejectContinuation(message, messageIndex);
  const parts: MutableJsonObject[] = [];
  for (const content of message.content) {
    if (content.type === "blob") {
      throw new GoogleGenerativeAiCodecError(
        `messages[${messageIndex}] cannot replay an assistant image through Google Generative AI`,
      );
    }
    if (content.type === "text") {
      if (content.text.length === 0 && content.signature === undefined) continue;
      parts.push({
        text: content.text,
        ...(content.signature === undefined
          ? {}
          : {
              thoughtSignature: googleSignature(
                content.signature.value,
                `messages[${messageIndex}] text signature`,
              ),
            }),
      });
      continue;
    }
    if (content.redacted === true) {
      throw new GoogleGenerativeAiCodecError(
        `messages[${messageIndex}] contains unsupported redacted thinking`,
      );
    }
    if (content.text.length === 0 && content.signature === undefined) continue;
    if (content.signature === undefined) {
      if (content.text.length > 0) parts.push({ text: content.text });
      continue;
    }
    parts.push({
      thought: true,
      text: content.text,
      thoughtSignature: googleSignature(
        content.signature.value,
        `messages[${messageIndex}] thinking signature`,
      ),
    });
  }
  for (const call of message.toolCalls ?? []) {
    parts.push({
      functionCall: {
        name: call.name,
        args: call.input,
        ...(requiresToolCallId(model.modelId) ? { id: call.callId } : {}),
      },
      ...(call.signature === undefined
        ? {}
        : {
            thoughtSignature: googleSignature(
              call.signature.value,
              `messages[${messageIndex}] tool signature`,
            ),
          }),
    });
  }
  if (parts.length === 0) {
    throw new GoogleGenerativeAiCodecError(
      `messages[${messageIndex}] has no Google-renderable assistant content`,
    );
  }
  return parts;
}

function toolResultParts(
  model: ModelInfo,
  request: PreparedModelRequest,
  message: Extract<PreparedRequestMessage, { role: "tool" }>,
): { readonly response: MutableJsonObject; readonly imageTurn?: MutableJsonObject } {
  const texts = message.content.filter((content) => content.type === "text");
  const images = message.content.filter((content) => content.type === "blob");
  const text = texts.map((content) => content.text).join("\n");
  const imageParts = images.map((content) => verifiedImage(request, content.blob.sha256));
  const responseText = text.length > 0 ? text : imageParts.length > 0 ? "(see attached image)" : "";
  const nestedImages = imageParts.length > 0 && isGemini3(model.modelId);
  return {
    response: {
      functionResponse: {
        name: message.name,
        response: message.isError ? { error: responseText } : { output: responseText },
        ...(requiresToolCallId(model.modelId) ? { id: message.callId } : {}),
        ...(nestedImages ? { parts: imageParts } : {}),
      },
    },
    ...(imageParts.length > 0 && !nestedImages
      ? { imageTurn: { role: "user", parts: [{ text: "Tool result image:" }, ...imageParts] } }
      : {}),
  };
}

function encodeContents(model: ModelInfo, request: PreparedModelRequest): JsonValue[] {
  const contents: MutableJsonObject[] = [];
  for (const [messageIndex, message] of request.messages.entries()) {
    if (message.role === "user") {
      contents.push({ role: "user", parts: basicParts(request, message) });
      continue;
    }
    if (message.role === "assistant") {
      contents.push({ role: "model", parts: assistantParts(model, message, messageIndex) });
      continue;
    }
    const result = toolResultParts(model, request, message);
    const previous = contents.at(-1);
    if (
      previous?.role === "user" &&
      Array.isArray(previous.parts) &&
      previous.parts.some((part) => object(part)?.functionResponse !== undefined)
    ) {
      previous.parts.push(result.response);
    } else {
      contents.push({ role: "user", parts: [result.response] });
    }
    if (result.imageTurn !== undefined) contents.push(result.imageTurn);
  }
  return contents;
}

function encodeTools(
  model: ModelInfo,
  request: PreparedModelRequest,
  expectedDialect: GoogleApiDialect,
): JsonValue[] | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined;
  const strictSupported = compatibility(model, expectedDialect).supportsStrictTools === true;
  const declarations = request.tools.map((tool): JsonValue => {
    if (tool.preparedConstraint?.type === "grammar") {
      throw new GoogleGenerativeAiCodecError(
        `Google Generative AI cannot render grammar-constrained tool ${tool.canonicalName}`,
      );
    }
    if (tool.preparedConstraint?.type === "json-schema" && tool.preparedConstraint.strict) {
      if (!strictSupported) {
        throw new GoogleGenerativeAiCodecError(
          `Google Generative AI strict tool ${tool.canonicalName} is unsupported by this model`,
        );
      }
    }
    return {
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.inputSchema,
    };
  });
  return [{ functionDeclarations: declarations }];
}

function applyThinking(
  body: MutableJsonObject,
  model: ModelInfo,
  request: PreparedModelRequest,
): void {
  const reasoning = request.preparation.reasoning;
  if (reasoning === undefined) return;
  if (reasoning.effective === "off") {
    if (isGemini3Pro(model.modelId)) {
      body.generationConfig = {
        ...(object(body.generationConfig) as JsonObject),
        thinkingConfig: { thinkingLevel: "LOW" },
      };
    } else if (isGemini3Flash(model.modelId) || isGemma4(model.modelId)) {
      body.generationConfig = {
        ...(object(body.generationConfig) as JsonObject),
        thinkingConfig: { thinkingLevel: "MINIMAL" },
      };
    } else {
      body.generationConfig = {
        ...(object(body.generationConfig) as JsonObject),
        thinkingConfig: { thinkingBudget: 0 },
      };
    }
    return;
  }
  const config: MutableJsonObject = { includeThoughts: true };
  if (reasoning.tokenBudget !== undefined) {
    config.thinkingBudget = reasoning.tokenBudget;
  } else {
    const value = (reasoning.providerValue ?? reasoning.effective).toUpperCase();
    if (!new Set(["MINIMAL", "LOW", "MEDIUM", "HIGH"]).has(value)) {
      throw new GoogleGenerativeAiCodecError(`Unsupported Google thinking level ${value}`);
    }
    config.thinkingLevel = value;
  }
  body.generationConfig = {
    ...(object(body.generationConfig) as JsonObject),
    thinkingConfig: config,
  };
}

function validCachedContentName(name: string, dialect: GoogleApiDialect): boolean {
  if (/^cachedContents\/[A-Za-z0-9._~-]+$/.test(name)) return true;
  return (
    dialect === "google-vertex" &&
    /^projects\/[A-Za-z0-9._~-]+\/locations\/[A-Za-z0-9._~-]+\/cachedContents\/[A-Za-z0-9._~-]+$/.test(
      name,
    )
  );
}

function applySampling(body: MutableJsonObject, request: PreparedModelRequest): void {
  const generation = (object(body.generationConfig) ?? {}) as MutableJsonObject;
  if (request.maxOutputTokens !== undefined) generation.maxOutputTokens = request.maxOutputTokens;
  const sampling = request.sampling;
  if (sampling !== undefined) {
    if (sampling.temperature !== undefined) generation.temperature = sampling.temperature;
    if (sampling.topP !== undefined) generation.topP = sampling.topP;
    if (sampling.topK !== undefined) generation.topK = sampling.topK;
    if (sampling.seed !== undefined) generation.seed = sampling.seed;
    for (const [field, value] of Object.entries(sampling.custom ?? {})) {
      if (RESERVED_GENERATION_FIELDS.has(field) || field in generation) {
        throw new GoogleGenerativeAiCodecError(
          `Custom sampling field ${field} collides with a Google generation field`,
        );
      }
      generation[field] = value;
    }
  }
  if (Object.keys(generation).length > 0) body.generationConfig = generation;
}

/** Encodes only a validated, immutable prepared request. */
export function encodeGoogleRequest(
  model: ModelInfo,
  request: PreparedModelRequest,
  expectedDialect: GoogleApiDialect,
): EncodedGoogleRequest {
  preparedRequest(request);
  compatibility(model, expectedDialect);
  if (request.modelId !== model.modelId) {
    throw new GoogleGenerativeAiCodecError(
      `Request model ${request.modelId} does not match ${model.modelId}`,
    );
  }
  if (request.metadata !== undefined && Object.keys(request.metadata).length > 0) {
    throw new GoogleGenerativeAiCodecError("Google Generative AI request metadata is unsupported");
  }
  if (request.preparation.cache.retention === "long") {
    throw new GoogleGenerativeAiCodecError(
      "Google Generative AI long cache retention is unsupported",
    );
  }

  const body: MutableJsonObject = { contents: encodeContents(model, request) };
  if (request.system !== undefined && request.system.length > 0) {
    body.systemInstruction = { parts: [{ text: request.system }] };
  }
  const tools = encodeTools(model, request, expectedDialect);
  if (tools !== undefined) body.tools = tools;
  if (request.toolChoice !== undefined) {
    if (request.toolChoice !== "none" && tools === undefined) {
      throw new GoogleGenerativeAiCodecError(
        `toolChoice ${request.toolChoice} needs at least one tool`,
      );
    }
    const strict = request.tools?.some(
      (tool) => tool.preparedConstraint?.type === "json-schema" && tool.preparedConstraint.strict,
    );
    body.toolConfig = {
      functionCallingConfig: {
        mode:
          request.toolChoice === "required"
            ? "ANY"
            : request.toolChoice === "none"
              ? "NONE"
              : strict
                ? "VALIDATED"
                : "AUTO",
      },
    };
  } else if (
    request.tools?.some(
      (tool) => tool.preparedConstraint?.type === "json-schema" && tool.preparedConstraint.strict,
    )
  ) {
    body.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }
  if (request.safetySettings !== undefined) {
    body.safetySettings = request.safetySettings.map((setting) => ({ ...setting }));
  }
  if (request.preparation.cache.sessionId !== undefined) {
    if (!validCachedContentName(request.preparation.cache.sessionId, expectedDialect)) {
      throw new GoogleGenerativeAiCodecError(
        "Google cached content must use a cachedContents resource name",
      );
    }
    body.cachedContent = request.preparation.cache.sessionId;
  }
  applySampling(body, request);
  applyThinking(body, model, request);
  return {
    modelId: model.modelId,
    body,
    headers: { accept: "text/event-stream", "content-type": "application/json" },
  };
}

function parseFrame(frame: SseFrame): Record<string, unknown> | undefined {
  if (frame.data.trim() === "[DONE]") return undefined;
  if (frame.event !== undefined && frame.event !== "message" && frame.event !== "error") {
    return undefined;
  }
  try {
    const value = object(JSON.parse(frame.data) as unknown);
    if (value === undefined) throw new Error("frame is not an object");
    return value;
  } catch (error) {
    throw new GoogleGenerativeAiCodecError(
      "Provider sent an undecodable Google Generative AI stream frame",
      { cause: error },
    );
  }
}

function nonNegative(value: unknown, name: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new GoogleGenerativeAiCodecError(`Google usage ${name} must be non-negative`);
  }
  return value;
}

function usage(raw: unknown, model: ModelInfo): Usage {
  const value = object(raw);
  if (value === undefined) throw new GoogleGenerativeAiCodecError("Google usage must be an object");
  const prompt = nonNegative(value.promptTokenCount, "promptTokenCount");
  const cached = nonNegative(value.cachedContentTokenCount, "cachedContentTokenCount");
  if (cached > prompt) {
    throw new GoogleGenerativeAiCodecError("Google cached input tokens exceed prompt tokens");
  }
  const reasoning = nonNegative(value.thoughtsTokenCount, "thoughtsTokenCount");
  const mapped: Usage = {
    inputTokens: prompt - cached,
    outputTokens: nonNegative(value.candidatesTokenCount, "candidatesTokenCount") + reasoning,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: reasoning,
  };
  return model.cost === undefined ? mapped : withUsageCost(model.cost, mapped);
}

function reverseToolName(request: PreparedModelRequest, name: string): string {
  return request.preparation.tools.find((tool) => tool.name === name)?.canonicalName ?? name;
}

function retryableProviderCode(code: string): boolean {
  return new Set(["429", "RESOURCE_EXHAUSTED", "UNAVAILABLE", "INTERNAL", "DEADLINE_EXCEEDED"]).has(
    code,
  );
}

interface ActiveTextBlock {
  readonly type: "text" | "thinking";
  readonly contentIndex: number;
  signature?: string;
}

export interface GoogleDecodeOptions {
  readonly model: ModelInfo;
  readonly request: PreparedModelRequest;
  readonly startedAtMs?: number;
  readonly now?: () => number;
  readonly secretValues?: readonly string[];
}

/** Decodes Google Generative AI SSE frames into canonical stream events. */
export async function* decodeGoogleStream(
  frames: AsyncIterable<SseFrame>,
  options: GoogleDecodeOptions,
  expectedDialect: GoogleApiDialect,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  preparedRequest(options.request);
  compatibility(options.model, expectedDialect);
  let responseId: string | undefined;
  let routedModelId: string | undefined;
  let nativeStopReason: string | undefined;
  let finalUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...(options.model.cost === undefined ? {} : { costUsd: 0 }),
  };
  let active: ActiveTextBlock | undefined;
  let nextContentIndex = 0;
  let generatedCallId = 0;
  const callIds = new Set<string>();
  let emittedContent = false;
  let emittedToolCall = false;

  const responseMetadata = () => ({
    providerId: options.model.providerId,
    requestedModelId: options.request.modelId,
    ...(routedModelId === undefined ? {} : { routedModelId }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(nativeStopReason === undefined ? {} : { nativeStopReason }),
    ...(options.startedAtMs === undefined
      ? {}
      : { latencyMs: Math.max(0, (options.now ?? Date.now)() - options.startedAtMs) }),
  });
  const replayForActive = (): ModelStreamEvent | undefined => {
    if (active?.signature === undefined) return undefined;
    return {
      type: "replay_metadata",
      target: active.type,
      contentIndex: active.contentIndex,
      providerId: options.model.providerId,
      apiDialect: options.model.apiDialect,
      modelId: options.request.modelId,
      signature: active.signature,
    };
  };

  for await (const frame of frames) {
    if (options.request.signal?.aborted) {
      yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
      return;
    }
    const chunk = parseFrame(frame);
    if (chunk === undefined) continue;

    if (chunk.error !== undefined || frame.event === "error") {
      const providerError = object(chunk.error) ?? chunk;
      const code = String(providerError.status ?? providerError.code ?? "provider_error");
      yield {
        type: "error",
        code,
        message: safeProviderMessage(
          typeof providerError.message === "string"
            ? providerError.message
            : "Google Generative AI reported a failure",
          options.secretValues,
        ),
        retryable: retryableProviderCode(code),
        ...(emittedContent ? { partial: true } : {}),
        response: responseMetadata(),
      };
      return;
    }

    if (typeof chunk.responseId === "string" && chunk.responseId.length > 0) {
      responseId ??= chunk.responseId;
    }
    if (typeof chunk.modelVersion === "string" && chunk.modelVersion.length > 0) {
      routedModelId = chunk.modelVersion;
    }
    if (chunk.usageMetadata !== undefined) finalUsage = usage(chunk.usageMetadata, options.model);

    const promptFeedback = object(chunk.promptFeedback);
    const blockReason = promptFeedback?.blockReason;
    if (
      typeof blockReason === "string" &&
      blockReason.length > 0 &&
      blockReason !== "BLOCK_REASON_UNSPECIFIED"
    ) {
      nativeStopReason = blockReason;
      const replay = replayForActive();
      if (replay !== undefined) yield replay;
      active = undefined;
      yield {
        type: "error",
        code: blockReason.toLowerCase(),
        message: safeProviderMessage(
          typeof promptFeedback?.blockReasonMessage === "string"
            ? promptFeedback.blockReasonMessage
            : `Google blocked the prompt with: ${blockReason}`,
          options.secretValues,
        ),
        retryable: false,
        ...(emittedContent ? { partial: true } : {}),
        response: responseMetadata(),
      };
      return;
    }

    if (chunk.candidates !== undefined && !Array.isArray(chunk.candidates)) {
      throw new GoogleGenerativeAiCodecError("Google candidates must be an array");
    }
    const candidate = Array.isArray(chunk.candidates) ? object(chunk.candidates[0]) : undefined;
    if (candidate !== undefined) {
      const content = object(candidate.content);
      if (content?.parts !== undefined && !Array.isArray(content.parts)) {
        throw new GoogleGenerativeAiCodecError("Google candidate parts must be an array");
      }
      for (const rawPart of Array.isArray(content?.parts) ? content.parts : []) {
        const part = object(rawPart);
        if (part === undefined)
          throw new GoogleGenerativeAiCodecError("Google part must be an object");
        if (part.text !== undefined) {
          if (typeof part.text !== "string") {
            throw new GoogleGenerativeAiCodecError("Google text part is malformed");
          }
          const type = part.thought === true ? "thinking" : "text";
          if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== "string") {
            throw new GoogleGenerativeAiCodecError("Google thought signature is malformed");
          }
          if (active?.type !== type) {
            const replay = replayForActive();
            if (replay !== undefined) yield replay;
            active = { type, contentIndex: nextContentIndex++ };
          }
          if (typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
            active.signature = googleSignature(part.thoughtSignature, "Google thought signature");
          }
          if (part.text.length > 0) {
            emittedContent = true;
            yield {
              type: type === "thinking" ? "thinking_delta" : "text_delta",
              text: part.text,
              contentIndex: active.contentIndex,
            };
          }
        }
        if (part.functionCall !== undefined) {
          const replay = replayForActive();
          if (replay !== undefined) yield replay;
          active = undefined;
          const call = object(part.functionCall);
          if (
            call === undefined ||
            typeof call.name !== "string" ||
            call.name.length === 0 ||
            (call.id !== undefined && typeof call.id !== "string")
          ) {
            throw new GoogleGenerativeAiCodecError("Google function call is malformed");
          }
          const input = call.args === undefined ? {} : object(call.args);
          if (input === undefined) {
            throw new GoogleGenerativeAiCodecError(
              "Google function call arguments must be an object",
            );
          }
          let callId = typeof call.id === "string" && call.id.length > 0 ? call.id : "";
          if (callId.length === 0 || callIds.has(callId)) {
            generatedCallId += 1;
            callId = `google_call_${generatedCallId}`;
            while (callIds.has(callId)) {
              generatedCallId += 1;
              callId = `google_call_${generatedCallId}`;
            }
          }
          callIds.add(callId);
          const contentIndex = nextContentIndex++;
          const name = reverseToolName(options.request, call.name);
          const argumentsText = JSON.stringify(input);
          emittedContent = true;
          emittedToolCall = true;
          yield { type: "tool_call_start", contentIndex, callId, name };
          if (argumentsText.length > 0) {
            yield { type: "tool_call_delta", contentIndex, callId, argumentsDelta: argumentsText };
          }
          yield { type: "tool_call", contentIndex, callId, name, input: input as JsonObject };
          if (typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
            yield {
              type: "replay_metadata",
              target: "tool_call",
              contentIndex,
              callId,
              providerId: options.model.providerId,
              apiDialect: options.model.apiDialect,
              modelId: options.request.modelId,
              signature: googleSignature(part.thoughtSignature, "Google tool thought signature"),
            };
          } else if (part.thoughtSignature !== undefined) {
            throw new GoogleGenerativeAiCodecError("Google thought signature is malformed");
          }
        }
      }

      if (candidate.finishReason !== undefined) {
        if (typeof candidate.finishReason !== "string" || candidate.finishReason.length === 0) {
          throw new GoogleGenerativeAiCodecError("Google finish reason is malformed");
        }
        nativeStopReason = candidate.finishReason;
        const replay = replayForActive();
        if (replay !== undefined) yield replay;
        active = undefined;
        if (nativeStopReason === "STOP") {
          yield {
            type: "completed",
            stopReason: emittedToolCall ? "tool_use" : "stop",
            usage: finalUsage,
            response: responseMetadata(),
          };
          return;
        }
        if (nativeStopReason === "MAX_TOKENS") {
          yield {
            type: "completed",
            stopReason: "length",
            usage: finalUsage,
            partial: true,
            response: responseMetadata(),
          };
          return;
        }
        const message =
          typeof candidate.finishMessage === "string"
            ? candidate.finishMessage
            : `Provider stopped with: ${nativeStopReason}`;
        yield {
          type: "error",
          code: SAFETY_FINISH_REASONS.has(nativeStopReason)
            ? nativeStopReason.toLowerCase()
            : "google_generation_failure",
          message: safeProviderMessage(message, options.secretValues),
          retryable: false,
          ...(emittedContent ? { partial: true } : {}),
          response: responseMetadata(),
        };
        return;
      }
    }
  }

  if (options.request.signal?.aborted) {
    yield { type: "aborted", ...(emittedContent ? { partial: true } : {}) };
  }
}
