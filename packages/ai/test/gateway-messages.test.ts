// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  decodeGatewayMessagesStream,
  encodeGatewayMessagesRequest,
  GatewayMessagesCodecError,
  normalizeModelStream,
  prepareModelRequest,
  type ModelInfo,
  type ModelRequest,
  type SseFrame,
} from "../src/index.ts";

function gatewayModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId: "radius",
    modelId: "auto",
    displayName: "Radius Auto",
    apiDialect: "gateway-messages",
    capabilities: { toolUse: true, structuredOutput: true, imageInput: true },
    reasoning: true,
    thinkingLevelMap: { high: "high" },
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    cost: { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
    cache: {
      supported: true,
      defaultRetention: "short",
      supportedRetentions: ["none", "short"],
    },
    compatibility: { dialect: "gateway-messages", supportsStrictTools: true },
    ...overrides,
  };
}

const baseRequest: ModelRequest = {
  modelId: "auto",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

async function prepared(request: ModelRequest = baseRequest, model = gatewayModel()) {
  return prepareModelRequest(model, request);
}

async function* frames(items: readonly (string | Record<string, unknown>)[]) {
  for (const item of items) {
    yield { data: typeof item === "string" ? item : JSON.stringify(item) } satisfies SseFrame;
  }
}

const gatewayUsage = {
  input: 10,
  output: 5,
  cacheRead: 3,
  cacheWrite: 2,
  reasoning: 1,
  totalTokens: 20,
  cost: { input: 0.01, output: 0.2, cacheRead: 0.003, cacheWrite: 0.004, total: 0.217 },
};

test("encodes prepared Gateway context, images, replay, strict tools, and routing metadata", async () => {
  const model = gatewayModel();
  const image = new Uint8Array([1, 2, 3]);
  const sha256 = createHash("sha256").update(image).digest("hex");
  const identity = {
    providerId: model.providerId,
    apiDialect: model.apiDialect,
    modelId: model.modelId,
  };
  const request = await prepared({
    modelId: model.modelId,
    system: "Route carefully.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "blob", blob: { sha256, mediaType: "image/png", sizeBytes: image.length } },
        ],
      },
      {
        role: "assistant",
        origin: identity,
        continuation: { ...identity, responseId: "response-old" },
        content: [
          { type: "thinking", text: "reason", signature: { ...identity, value: "think-sig" } },
          { type: "text", text: "calling", signature: { ...identity, value: "text-sig" } },
        ],
        toolCalls: [
          {
            callId: "call_1",
            name: "lookup",
            input: { query: "pi" },
            signature: { ...identity, value: "tool-sig" },
            continuation: { ...identity, namespace: "functions" },
          },
        ],
      },
      {
        role: "tool",
        callId: "call_1",
        name: "lookup",
        content: [{ type: "text", text: "result" }],
        isError: false,
      },
    ],
    tools: [
      {
        name: "lookup",
        description: "Look up a value",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        constraint: { type: "json-schema", strict: "require" },
      },
    ],
    thinkingLevel: "high",
    maxOutputTokens: 100,
    toolChoice: "required",
    cache: { retention: "short", sessionId: "session-1" },
    metadata: { route: "quality", tenant: 7 },
    readBlob: async () => image,
  });

  assert.deepEqual(encodeGatewayMessagesRequest(model, request).body, {
    model: "auto",
    context: {
      systemPrompt: "Route carefully.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            { type: "image", data: "AQID", mimeType: "image/png" },
          ],
          timestamp: 0,
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reason", thinkingSignature: "think-sig" },
            { type: "text", text: "calling", textSignature: "text-sig" },
            {
              type: "toolCall",
              id: "call_1",
              name: "lookup",
              arguments: { query: "pi" },
              thoughtSignature: "tool-sig",
              namespace: "functions",
            },
          ],
          api: "pi-messages",
          provider: "radius",
          model: "auto",
          responseId: "response-old",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "lookup",
          content: [{ type: "text", text: "result" }],
          isError: false,
          timestamp: 0,
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          constrainedSampling: { type: "json_schema", strict: "require" },
        },
      ],
    },
    options: {
      reasoning: "high",
      maxTokens: 100,
      toolChoice: "required",
      cacheRetention: "short",
      sessionId: "session-1",
      metadata: { route: "quality", tenant: 7 },
    },
  });
});

test("decodes text, reasoning, tools, signatures, usage, cost, and routed identity", async () => {
  const request = await prepared({
    ...baseRequest,
    tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
  });
  const decoded = await Array.fromAsync(
    decodeGatewayMessagesStream(
      frames([
        { type: "start" },
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_delta", contentIndex: 0, delta: "why" },
        {
          type: "thinking_end",
          contentIndex: 0,
          content: "why",
          contentSignature: "think-sig",
        },
        { type: "text_start", contentIndex: 1 },
        { type: "text_delta", contentIndex: 1, delta: "answer" },
        {
          type: "text_end",
          contentIndex: 1,
          content: "answer",
          contentSignature: "text-sig",
        },
        { type: "toolcall_start", contentIndex: 2, id: "call_2", toolName: "lookup" },
        { type: "toolcall_delta", contentIndex: 2, delta: '{"query":' },
        { type: "toolcall_delta", contentIndex: 2, delta: '"pi"}' },
        {
          type: "toolcall_end",
          contentIndex: 2,
          toolCall: {
            type: "toolCall",
            id: "call_2",
            name: "lookup",
            arguments: { query: "pi" },
            thoughtSignature: "tool-sig",
            namespace: "functions",
          },
        },
        {
          type: "done",
          reason: "toolUse",
          nativeStopReason: "upstream_tool_calls",
          usage: gatewayUsage,
          requestedModelId: "auto",
          routedModelId: "anthropic/claude-sonnet",
          responseId: "response-1",
        },
      ]),
      { model: gatewayModel(), request, startedAtMs: 10, now: () => 52 },
    ),
  );

  assert.deepEqual(decoded, [
    { type: "thinking_delta", text: "why", contentIndex: 0 },
    {
      type: "replay_metadata",
      target: "thinking",
      contentIndex: 0,
      providerId: "radius",
      apiDialect: "gateway-messages",
      modelId: "auto",
      signature: "think-sig",
    },
    { type: "text_delta", text: "answer", contentIndex: 1 },
    {
      type: "replay_metadata",
      target: "text",
      contentIndex: 1,
      providerId: "radius",
      apiDialect: "gateway-messages",
      modelId: "auto",
      signature: "text-sig",
    },
    { type: "tool_call_start", contentIndex: 2, callId: "call_2", name: "lookup" },
    {
      type: "tool_call_delta",
      contentIndex: 2,
      callId: "call_2",
      argumentsDelta: '{"query":',
    },
    {
      type: "tool_call_delta",
      contentIndex: 2,
      callId: "call_2",
      argumentsDelta: '"pi"}',
    },
    {
      type: "tool_call",
      contentIndex: 2,
      callId: "call_2",
      name: "lookup",
      input: { query: "pi" },
    },
    {
      type: "replay_metadata",
      target: "tool_call",
      contentIndex: 2,
      callId: "call_2",
      providerId: "radius",
      apiDialect: "gateway-messages",
      modelId: "auto",
      signature: "tool-sig",
      namespace: "functions",
    },
    {
      type: "completed",
      stopReason: "tool_use",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 1,
        costUsd: 0.217,
      },
      response: {
        providerId: "radius",
        requestedModelId: "auto",
        routedModelId: "anthropic/claude-sonnet",
        responseId: "response-1",
        nativeStopReason: "upstream_tool_calls",
        latencyMs: 42,
      },
    },
  ]);
});

test("maps native length and aborted terminal events with safe partial state", async () => {
  const request = await prepared();
  const limited = await Array.fromAsync(
    decodeGatewayMessagesStream(
      frames([
        { type: "text_delta", contentIndex: 0, delta: "partial" },
        { type: "done", reason: "length", usage: gatewayUsage },
      ]),
      { model: gatewayModel(), request },
    ),
  );
  assert.deepEqual(limited.at(-1), {
    type: "completed",
    stopReason: "length",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
      costUsd: 0.217,
    },
    partial: true,
    response: {
      providerId: "radius",
      requestedModelId: "auto",
      nativeStopReason: "length",
    },
  });

  const aborted = await Array.fromAsync(
    decodeGatewayMessagesStream(
      frames([
        { type: "text_delta", contentIndex: 0, delta: "partial" },
        { type: "error", reason: "aborted", usage: gatewayUsage },
      ]),
      { model: gatewayModel(), request },
    ),
  );
  assert.deepEqual(aborted.at(-1), { type: "aborted", partial: true });
});

test("redacts Gateway failures and preserves partial response identity", async () => {
  const request = await prepared();
  const secret = "gateway-secret";
  const decoded = await Array.fromAsync(
    decodeGatewayMessagesStream(
      frames([
        { type: "text_delta", contentIndex: 0, delta: "partial" },
        {
          type: "error",
          reason: "error",
          code: "upstream_rate_limit",
          category: "rate_limit",
          retryable: true,
          errorMessage: `${secret} exhausted`,
          requestedModelId: "auto",
          routedModelId: "openai/gpt",
          responseId: "response-2",
          rawStopReason: "rate_limit",
          usage: gatewayUsage,
        },
      ]),
      { model: gatewayModel(), request, secretValues: [secret] },
    ),
  );
  assert.deepEqual(decoded.at(-1), {
    type: "error",
    code: "upstream_rate_limit",
    message: "[REDACTED] exhausted",
    retryable: true,
    category: "rate_limit",
    requestPhase: "streaming",
    partial: true,
    response: {
      providerId: "radius",
      requestedModelId: "auto",
      routedModelId: "openai/gpt",
      responseId: "response-2",
      nativeStopReason: "rate_limit",
    },
  });
});

test("honors local cancellation before accepting a Gateway terminal", async () => {
  const controller = new AbortController();
  const request = await prepared({ ...baseRequest, signal: controller.signal });
  async function* cancelling(): AsyncGenerator<SseFrame> {
    yield { data: JSON.stringify({ type: "text_delta", contentIndex: 0, delta: "partial" }) };
    controller.abort();
    yield { data: JSON.stringify({ type: "done", reason: "stop", usage: gatewayUsage }) };
  }
  const decoded = await Array.fromAsync(
    decodeGatewayMessagesStream(cancelling(), { model: gatewayModel(), request }),
  );
  assert.deepEqual(decoded.at(-1), { type: "aborted", partial: true });
});

test("fails malformed events and normalizes truncated streams exactly once", async () => {
  const request = await prepared();
  await assert.rejects(
    Array.fromAsync(
      decodeGatewayMessagesStream(
        frames([{ type: "toolcall_delta", contentIndex: 0, delta: "{}" }]),
        {
          model: gatewayModel(),
          request,
        },
      ),
    ),
    GatewayMessagesCodecError,
  );
  await assert.rejects(
    Array.fromAsync(
      decodeGatewayMessagesStream(
        frames([{ type: "done", reason: "stop", usage: { ...gatewayUsage, input: -1 } }]),
        { model: gatewayModel(), request },
      ),
    ),
    /usage input must be a non-negative safe integer/,
  );

  const normalized = await Array.fromAsync(
    normalizeModelStream(
      decodeGatewayMessagesStream(
        frames([{ type: "text_delta", contentIndex: 0, delta: "partial" }]),
        { model: gatewayModel(), request },
      ),
    ),
  );
  assert.deepEqual(normalized.at(-1), {
    type: "error",
    code: "provider_stream_truncated",
    message: "provider ended the stream without a terminal event",
    retryable: false,
    category: "stream_interrupted",
    requestPhase: "streaming",
    partial: true,
  });
  assert.equal(normalized.filter((event) => event.type === "error").length, 1);
});

test("rejects unprepared requests and unsupported Gateway history", async () => {
  const model = gatewayModel();
  assert.throws(
    () => encodeGatewayMessagesRequest(model, baseRequest as never),
    /requires a prepared model request/,
  );
  const identity = {
    providerId: model.providerId,
    apiDialect: model.apiDialect,
    modelId: model.modelId,
  };
  const unsupported = await prepared({
    ...baseRequest,
    messages: [
      {
        role: "assistant",
        continuation: { ...identity, itemId: "item-1" },
        content: [{ type: "text", text: "answer" }],
      },
    ],
  });
  assert.throws(
    () => encodeGatewayMessagesRequest(model, unsupported),
    /unsupported continuation metadata/,
  );
});
