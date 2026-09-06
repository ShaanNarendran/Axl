// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AnthropicMessagesCodecError,
  decodeAnthropicMessagesStream,
  encodeAnthropicMessagesRequest,
  getStaticModelCatalog,
  type ModelInfo,
  type ModelRequest,
  normalizeModelStream,
  prepareModelRequest,
  type SseFrame,
} from "../src/index.ts";

function anthropicModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId: "anthropic",
    modelId: "claude-fixture",
    displayName: "Claude Fixture",
    apiDialect: "anthropic-messages",
    capabilities: { toolUse: true, structuredOutput: true, imageInput: true },
    reasoning: true,
    thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high" },
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    cost: {
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 2,
      cacheReadUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 1.25,
    },
    cache: {
      supported: true,
      defaultRetention: "short",
      supportedRetentions: ["none", "short", "long"],
    },
    sampling: {
      supported: ["temperature", "topP", "topK"],
      customFields: ["stop_sequences"],
    },
    compatibility: {
      dialect: "anthropic-messages",
      supportsLongCacheRetention: true,
      supportsCacheControlOnTools: true,
      supportsTemperature: true,
      supportsStrictTools: true,
      forceAdaptiveThinking: true,
    },
    ...overrides,
  };
}

const baseRequest: ModelRequest = {
  modelId: "claude-fixture",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

async function prepared(request: ModelRequest = baseRequest, model = anthropicModel()) {
  return prepareModelRequest(model, request);
}

async function* frames(events: readonly unknown[]): AsyncGenerator<SseFrame> {
  for (const event of events) {
    const value = event as { type?: string };
    yield {
      ...(value.type === undefined ? {} : { event: value.type }),
      data: JSON.stringify(event),
    };
  }
}

async function decode(events: readonly unknown[], request?: Awaited<ReturnType<typeof prepared>>) {
  return Array.fromAsync(
    decodeAnthropicMessagesStream(frames(events), {
      model: anthropicModel(),
      request: request ?? (await prepared()),
    }),
  );
}

function terminalEvents(reason: string, details?: Record<string, unknown>): unknown[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg-fixture",
        model: "claude-routed",
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 6,
          cache_creation: { ephemeral_1h_input_tokens: 2 },
        },
      },
    },
    {
      type: "message_delta",
      delta: { stop_reason: reason, ...(details === undefined ? {} : { stop_details: details }) },
      usage: { output_tokens: 8, output_tokens_details: { thinking_tokens: 3 } },
    },
    { type: "message_stop" },
  ];
}

test("marks current adaptive Anthropic models explicitly in the generated catalog", () => {
  const adaptive = getStaticModelCatalog("anthropic")
    .filter(
      (model) =>
        model.compatibility?.dialect === "anthropic-messages" &&
        model.compatibility.forceAdaptiveThinking === true,
    )
    .map((model) => model.modelId)
    .sort();
  assert.deepEqual(adaptive, [
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-sonnet-5",
  ]);
});

test("encodes prepared Anthropic history, images, thinking, tools, cache, and controls", async () => {
  const model = anthropicModel();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identity = {
    providerId: model.providerId,
    apiDialect: model.apiDialect,
    modelId: model.modelId,
  };
  const request: ModelRequest = {
    modelId: model.modelId,
    system: "Use evidence.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "blob", blob: { sha256, mediaType: "image/png", sizeBytes: bytes.length } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "checked", signature: { ...identity, value: "signed-1" } },
          {
            type: "thinking",
            text: "",
            signature: { ...identity, value: "redacted-1" },
            redacted: true,
          },
          { type: "text", text: "calling" },
        ],
        toolCalls: [{ callId: "call-1", name: "lookup", input: { key: "a" } }],
      },
      {
        role: "tool",
        callId: "call-1",
        name: "lookup",
        content: [{ type: "text", text: "value" }],
        isError: false,
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ],
    tools: [
      {
        name: "lookup",
        description: "Look up a value",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, optional: { type: "number" } },
          required: ["key"],
        },
        constraint: { type: "json-schema", strict: "require" },
      },
    ],
    thinkingLevel: "medium",
    maxOutputTokens: 40,
    toolChoice: "required",
    sampling: { topP: 0.8, topK: 20, custom: { stop_sequences: ["END"] } },
    cache: { retention: "long" },
    metadata: { user_id: "user-fixture" },
    readBlob: async () => bytes,
  };
  assert.throws(
    () => encodeAnthropicMessagesRequest(model, request as never),
    /requires a prepared model request/,
  );

  const encoded = encodeAnthropicMessagesRequest(model, await prepared(request, model));
  assert.deepEqual(encoded.headers, {
    accept: "text/event-stream",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  });
  assert.deepEqual(encoded.body, {
    model: "claude-fixture",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AQIDBA==" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checked", signature: "signed-1" },
          { type: "redacted_thinking", data: "redacted-1" },
          { type: "text", text: "calling" },
          { type: "tool_use", id: "call-1", name: "lookup", input: { key: "a" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: [{ type: "text", text: "value" }],
            is_error: false,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "continue",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
    ],
    max_tokens: 40,
    stream: true,
    system: [
      {
        type: "text",
        text: "Use evidence.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    tools: [
      {
        name: "lookup",
        description: "Look up a value",
        input_schema: {
          type: "object",
          properties: {
            key: { type: "string" },
            optional: { anyOf: [{ type: "number" }, { type: "null" }] },
          },
          required: ["key", "optional"],
          additionalProperties: false,
        },
        strict: true,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    tool_choice: { type: "any" },
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "medium" },
    top_p: 0.8,
    top_k: 20,
    stop_sequences: ["END"],
    metadata: { user_id: "user-fixture" },
  });
});

test("uses prepared budgets for legacy thinking and supports explicit thinking disable", async () => {
  const model = anthropicModel({
    thinkingLevelMap: {},
    compatibility: {
      dialect: "anthropic-messages",
      supportsLongCacheRetention: true,
      supportsCacheControlOnTools: true,
      supportsTemperature: true,
      supportsStrictTools: true,
    },
  });
  const enabledRequest = await prepared(
    { ...baseRequest, thinkingLevel: "medium", maxOutputTokens: 100, cache: { retention: "none" } },
    model,
  );
  assert.equal(enabledRequest.maxOutputTokens, 8_292);
  assert.deepEqual(encodeAnthropicMessagesRequest(model, enabledRequest), {
    body: {
      model: "claude-fixture",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 8_292,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 7_268, display: "summarized" },
    },
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    },
  });

  const disabled = await prepared(
    {
      ...baseRequest,
      thinkingLevel: "off",
      sampling: { temperature: 0 },
      cache: { retention: "none" },
    },
    model,
  );
  const disabledBody = encodeAnthropicMessagesRequest(model, disabled).body;
  assert.deepEqual(disabledBody.thinking, { type: "disabled" });
  assert.equal(disabledBody.temperature, 0);
});

test("fails unsupported Anthropic request behavior without compatibility fallback", async () => {
  const model = anthropicModel({
    cache: { supported: true, defaultRetention: "short", supportedRetentions: ["none", "short"] },
    compatibility: {
      dialect: "anthropic-messages",
      supportsLongCacheRetention: false,
      supportsCacheControlOnTools: true,
      supportsTemperature: true,
      supportsStrictTools: true,
      forceAdaptiveThinking: true,
    },
  });
  await assert.rejects(
    prepareModelRequest(model, { ...baseRequest, cache: { retention: "long" } }),
    /long is unsupported/,
  );
  await assert.rejects(
    prepareModelRequest(model, {
      ...baseRequest,
      thinkingLevel: "high",
      sampling: { temperature: 0 },
    }),
    /cannot be combined with Anthropic reasoning/,
  );
  const metadata = await prepared({ ...baseRequest, metadata: { trace: "safe" } });
  assert.throws(
    () => encodeAnthropicMessagesRequest(anthropicModel(), metadata),
    /supports only metadata.user_id/,
  );
});

test("decodes interleaved thinking, redaction, text, tools, usage, and provenance", async () => {
  const events = await decode([
    terminalEvents("tool_use")[0],
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "start", signature: "sig-" },
    },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "end" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "one" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "redacted_thinking", data: "redacted-sig" },
    },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "hello " } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "world" } },
    { type: "content_block_stop", index: 2 },
    {
      type: "content_block_start",
      index: 3,
      content_block: { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
    },
    {
      type: "content_block_delta",
      index: 3,
      delta: { type: "input_json_delta", partial_json: '{"key":"a"}' },
    },
    { type: "content_block_stop", index: 3 },
    terminalEvents("tool_use")[1],
    terminalEvents("tool_use")[2],
    { type: "future_event", ignored: true },
  ]);

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "thinking_delta",
      "thinking_delta",
      "replay_metadata",
      "thinking_delta",
      "replay_metadata",
      "text_delta",
      "text_delta",
      "tool_call_start",
      "tool_call_delta",
      "tool_call",
      "completed",
    ],
  );
  assert.deepEqual(events[2], {
    type: "replay_metadata",
    target: "thinking",
    contentIndex: 0,
    providerId: "anthropic",
    apiDialect: "anthropic-messages",
    modelId: "claude-fixture",
    signature: "sig-one",
  });
  assert.deepEqual(events[4], {
    type: "replay_metadata",
    target: "thinking",
    contentIndex: 1,
    providerId: "anthropic",
    apiDialect: "anthropic-messages",
    modelId: "claude-fixture",
    signature: "redacted-sig",
    redacted: true,
  });
  assert.deepEqual(events[9], {
    type: "tool_call",
    contentIndex: 3,
    callId: "tool-1",
    name: "lookup",
    input: { key: "a" },
  });
  assert.deepEqual(events[10], {
    type: "completed",
    stopReason: "tool_use",
    usage: {
      inputTokens: 10,
      outputTokens: 8,
      cacheReadTokens: 4,
      cacheWriteTokens: 6,
      reasoningTokens: 3,
      costUsd: 0.0000354,
    },
    response: {
      providerId: "anthropic",
      requestedModelId: "claude-fixture",
      routedModelId: "claude-routed",
      responseId: "msg-fixture",
      nativeStopReason: "tool_use",
    },
  });
});

test("maps native completion limits and refusal details", async () => {
  const stopped = await decode(terminalEvents("end_turn"));
  const stoppedTerminal = stopped.at(-1);
  assert.equal(stoppedTerminal?.type, "completed");
  if (stoppedTerminal?.type === "completed") assert.equal(stoppedTerminal.stopReason, "stop");

  const limited = await decode(terminalEvents("max_tokens"));
  assert.deepEqual(limited.at(-1), {
    type: "completed",
    stopReason: "length",
    partial: true,
    usage: {
      inputTokens: 10,
      outputTokens: 8,
      cacheReadTokens: 4,
      cacheWriteTokens: 6,
      reasoningTokens: 3,
      costUsd: 0.0000354,
    },
    response: {
      providerId: "anthropic",
      requestedModelId: "claude-fixture",
      routedModelId: "claude-routed",
      responseId: "msg-fixture",
      nativeStopReason: "max_tokens",
    },
  });

  const refused = await decode(terminalEvents("refusal", { explanation: "request rejected" }));
  assert.deepEqual(refused.at(-1), {
    type: "error",
    code: "refusal",
    message: "request rejected",
    retryable: false,
    response: {
      providerId: "anthropic",
      requestedModelId: "claude-fixture",
      routedModelId: "claude-routed",
      responseId: "msg-fixture",
      nativeStopReason: "refusal",
    },
  });
});

test("redacts provider errors and reports cancellation after partial output", async () => {
  const secret = "credential-fixture-value";
  const failed = await Array.fromAsync(
    decodeAnthropicMessagesStream(
      frames([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "safe" } },
        { type: "content_block_stop", index: 0 },
        { type: "error", error: { type: "overloaded_error", message: `${secret} overloaded` } },
      ]),
      { model: anthropicModel(), request: await prepared(), secretValues: [secret] },
    ),
  );
  const terminal = failed.at(-1);
  assert.equal(terminal?.type, "error");
  if (terminal?.type === "error") {
    assert.equal(terminal.retryable, true);
    assert.equal(terminal.partial, true);
    assert.equal(terminal.message.includes(secret), false);
  }

  const controller = new AbortController();
  const request = await prepared({ ...baseRequest, signal: controller.signal });
  async function* cancellingFrames(): AsyncGenerator<SseFrame> {
    yield {
      event: "content_block_start",
      data: JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "partial" },
      }),
    };
    controller.abort();
    yield { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) };
  }
  const aborted = await Array.fromAsync(
    decodeAnthropicMessagesStream(cancellingFrames(), { model: anthropicModel(), request }),
  );
  assert.deepEqual(aborted.at(-1), { type: "aborted", partial: true });
});

test("fails malformed input and normalizes truncation exactly once while ignoring unknown events", async () => {
  await assert.rejects(
    decode([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{bad" },
      },
      { type: "content_block_stop", index: 0 },
    ]),
    AnthropicMessagesCodecError,
  );

  const malformed = await Array.fromAsync(
    normalizeModelStream(
      decodeAnthropicMessagesStream(
        (async function* () {
          yield { event: "message_start", data: "{bad json" };
        })(),
        { model: anthropicModel(), request: await prepared() },
      ),
    ),
  );
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0]?.type, "error");

  const truncated = await Array.fromAsync(
    normalizeModelStream(
      decodeAnthropicMessagesStream(
        frames([
          { type: "vendor.future.event", detail: "ignored" },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "partial" },
          },
          { type: "content_block_stop", index: 0 },
        ]),
        { model: anthropicModel(), request: await prepared() },
      ),
    ),
  );
  assert.deepEqual(
    truncated.map((event) => event.type),
    ["text_delta", "error"],
  );
  const truncatedTerminal = truncated.at(-1);
  assert.equal(truncatedTerminal?.type, "error");
  if (truncatedTerminal?.type === "error") assert.equal(truncatedTerminal.partial, true);
});
