// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  decodeMistralConversationsStream,
  encodeMistralConversationsRequest,
  getStaticModelCatalog,
  MistralConversationsCodecError,
  type ModelInfo,
  type ModelRequest,
  normalizeModelStream,
  prepareModelRequest,
  type SseFrame,
} from "../src/index.ts";

function mistralModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId: "mistral",
    modelId: "mistral-medium-2604",
    displayName: "Mistral Medium 3.5",
    apiDialect: "mistral-conversations",
    capabilities: { toolUse: true, structuredOutput: true, imageInput: true },
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    },
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    cost: { inputUsdPerMTok: 0.4, outputUsdPerMTok: 2 },
    cache: {
      supported: true,
      defaultRetention: "short",
      supportedRetentions: ["none", "short"],
    },
    compatibility: { dialect: "mistral-conversations", supportsStrictTools: true },
    ...overrides,
  };
}

const baseRequest: ModelRequest = {
  modelId: "mistral-medium-2604",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

async function prepared(request: ModelRequest = baseRequest, model = mistralModel()) {
  return prepareModelRequest(model, request);
}

async function* frames(items: readonly (string | Record<string, unknown>)[]) {
  for (const item of items) {
    yield { data: typeof item === "string" ? item : JSON.stringify(item) } satisfies SseFrame;
  }
}

test("generated Mistral catalog declares codec capabilities explicitly", () => {
  const models = getStaticModelCatalog("mistral");
  const strict = models.find((model) => model.modelId === "mistral-medium-2604");
  const ordinary = models.find((model) => model.modelId === "devstral-medium-latest");
  assert.deepEqual(strict?.compatibility, {
    dialect: "mistral-conversations",
    supportsStrictTools: true,
  });
  assert.deepEqual(ordinary?.compatibility, { dialect: "mistral-conversations" });
});

test("encodes prepared history, images, strict tools, reasoning, caching, and sampling", async () => {
  const model = mistralModel();
  const image = new Uint8Array([1, 2, 3]);
  const sha256 = createHash("sha256").update(image).digest("hex");
  const request = await prepared({
    modelId: model.modelId,
    system: "Be precise.",
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
        content: [
          { type: "thinking", text: "reason" },
          { type: "text", text: "calling" },
        ],
        toolCalls: [{ callId: "long-call-id", name: "lookup", input: { query: "pi" } }],
      },
      {
        role: "tool",
        callId: "long-call-id",
        name: "lookup",
        content: [
          { type: "text", text: "failed" },
          { type: "blob", blob: { sha256, mediaType: "image/png", sizeBytes: image.length } },
        ],
        isError: true,
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
    sampling: {
      temperature: 0.2,
      topP: 0.8,
      frequencyPenalty: 0.1,
      presencePenalty: 0.3,
      seed: 42,
    },
    cache: { retention: "short", sessionId: "session-1" },
    readBlob: async () => image,
  });
  const normalizedCallId =
    request.messages[1]?.role === "assistant"
      ? request.messages[1].toolCalls?.[0]?.callId
      : undefined;
  assert.match(normalizedCallId ?? "", /^[A-Za-z0-9]{9}$/);

  const encoded = encodeMistralConversationsRequest(model, request);
  assert.deepEqual(encoded.headers, { "x-affinity": "session-1" });
  assert.deepEqual(encoded.body, {
    model: model.modelId,
    stream: true,
    messages: [
      { role: "system", content: "Be precise." },
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image_url", image_url: "data:image/png;base64,AQID" },
        ],
      },
      {
        role: "assistant",
        prefix: false,
        content: [
          { type: "thinking", thinking: [{ type: "text", text: "reason" }] },
          { type: "text", text: "calling" },
        ],
        tool_calls: [
          {
            id: normalizedCallId,
            type: "function",
            function: { name: "lookup", arguments: '{"query":"pi"}' },
            index: 0,
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: normalizedCallId,
        name: "lookup",
        content: [
          { type: "text", text: "[tool error] failed" },
          { type: "image_url", image_url: "data:image/png;base64,AQID" },
        ],
      },
    ],
    max_tokens: 100,
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look up a value",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    ],
    tool_choice: "required",
    reasoning_effort: "high",
    temperature: 0.2,
    top_p: 0.8,
    frequency_penalty: 0.1,
    presence_penalty: 0.3,
    random_seed: 42,
    prompt_cache_key: "session-1",
  });
});

test("uses native prompt mode for reasoning models without effort metadata", async () => {
  const { thinkingLevelMap: _thinkingLevelMap, ...baseModel } = mistralModel();
  const model: ModelInfo = {
    ...baseModel,
    modelId: "magistral-medium-latest",
    capabilities: { toolUse: true, structuredOutput: false, imageInput: false },
    compatibility: { dialect: "mistral-conversations" },
  };
  const request = await prepared(
    {
      modelId: model.modelId,
      messages: baseRequest.messages,
      thinkingLevel: "medium",
      cache: { retention: "none" },
    },
    model,
  );
  const encoded = encodeMistralConversationsRequest(model, request);
  assert.equal(encoded.body.prompt_mode, "reasoning");
  assert.equal(encoded.body.reasoning_effort, undefined);
  assert.deepEqual(encoded.headers, {});
});

test("decodes native reasoning, text, fragmented tools, usage, cost, and routed identity", async () => {
  const request = await prepared();
  const decoded = await Array.fromAsync(
    decodeMistralConversationsStream(
      frames([
        {
          id: "response-1",
          model: "mistral-medium-routed",
          choices: [
            {
              finish_reason: null,
              delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "why" }] }] },
            },
          ],
        },
        {
          choices: [
            { finish_reason: null, delta: { content: [{ type: "text", text: "answer" }] } },
          ],
        },
        {
          choices: [
            {
              finish_reason: null,
              delta: {
                tool_calls: [
                  { id: "abc123456", index: 0, function: { name: "lookup", arguments: '{"q":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              finish_reason: "tool_calls",
              delta: { tool_calls: [{ index: 0, function: { name: "", arguments: '"pi"}' } }] },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        },
        "[DONE]",
      ]),
      { model: mistralModel(), request, startedAtMs: 10, now: () => 52 },
    ),
  );
  assert.deepEqual(decoded, [
    { type: "thinking_delta", text: "why", contentIndex: 0 },
    { type: "text_delta", text: "answer", contentIndex: 1 },
    {
      type: "tool_call_start",
      contentIndex: 2,
      callId: "abc123456",
      name: "lookup",
    },
    {
      type: "tool_call_delta",
      contentIndex: 2,
      callId: "abc123456",
      argumentsDelta: '{"q":',
    },
    {
      type: "tool_call_delta",
      contentIndex: 2,
      callId: "abc123456",
      argumentsDelta: '"pi"}',
    },
    {
      type: "tool_call",
      contentIndex: 2,
      callId: "abc123456",
      name: "lookup",
      input: { q: "pi" },
    },
    {
      type: "completed",
      stopReason: "tool_use",
      usage: {
        inputTokens: 7,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.0000108,
      },
      response: {
        providerId: "mistral",
        requestedModelId: baseRequest.modelId,
        routedModelId: "mistral-medium-routed",
        responseId: "response-1",
        nativeStopReason: "tool_calls",
        latencyMs: 42,
      },
    },
  ]);
});

test("maps native length and error stop reasons without losing partial output", async () => {
  const request = await prepared();
  const limited = await Array.fromAsync(
    decodeMistralConversationsStream(
      frames([
        { choices: [{ finish_reason: null, delta: { content: "partial" } }] },
        { choices: [{ finish_reason: "model_length", delta: {} }] },
      ]),
      { model: mistralModel(), request },
    ),
  );
  assert.deepEqual(limited.at(-1), {
    type: "completed",
    stopReason: "length",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    },
    partial: true,
    response: {
      providerId: "mistral",
      requestedModelId: baseRequest.modelId,
      nativeStopReason: "model_length",
    },
  });

  const failed = await Array.fromAsync(
    decodeMistralConversationsStream(
      frames([
        { choices: [{ finish_reason: null, delta: { content: "partial" } }] },
        { choices: [{ finish_reason: "error", delta: {} }] },
      ]),
      { model: mistralModel(), request },
    ),
  );
  assert.deepEqual(failed.at(-1), {
    type: "error",
    code: "error",
    message: "Provider stopped with: error",
    retryable: false,
    category: "provider_internal",
    requestPhase: "streaming",
    partial: true,
    response: {
      providerId: "mistral",
      requestedModelId: baseRequest.modelId,
      nativeStopReason: "error",
    },
  });
});

test("redacts provider failures and cancels streams with safe partial state", async () => {
  const request = await prepared();
  const secret = "secret-value";
  const failed = await Array.fromAsync(
    decodeMistralConversationsStream(
      frames([{ error: { code: "rate_limit", message: `${secret} overloaded` } }]),
      { model: mistralModel(), request, secretValues: [secret] },
    ),
  );
  assert.deepEqual(failed[0], {
    type: "error",
    code: "rate_limit",
    message: "[REDACTED] overloaded",
    retryable: true,
    category: "rate_limit",
    requestPhase: "streaming",
    response: { providerId: "mistral", requestedModelId: baseRequest.modelId },
  });

  const controller = new AbortController();
  const cancelled = await prepared({ ...baseRequest, signal: controller.signal });
  async function* cancelling(): AsyncGenerator<SseFrame> {
    yield {
      data: JSON.stringify({ choices: [{ finish_reason: null, delta: { content: "partial" } }] }),
    };
    controller.abort();
    yield { data: JSON.stringify({ choices: [{ finish_reason: "stop", delta: {} }] }) };
  }
  const aborted = await Array.fromAsync(
    decodeMistralConversationsStream(cancelling(), { model: mistralModel(), request: cancelled }),
  );
  assert.deepEqual(aborted.at(-1), { type: "aborted", partial: true });
});

test("fails malformed frames and normalizes truncated streams exactly once", async () => {
  const request = await prepared();
  await assert.rejects(
    Array.fromAsync(
      decodeMistralConversationsStream(frames(["not-json"]), {
        model: mistralModel(),
        request,
      }),
    ),
    MistralConversationsCodecError,
  );
  const normalized = await Array.fromAsync(
    normalizeModelStream(
      decodeMistralConversationsStream(
        frames([{ choices: [{ finish_reason: null, delta: { content: "partial" } }] }]),
        { model: mistralModel(), request },
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

test("rejects unprepared requests and unsupported request data", async () => {
  const model = mistralModel();
  assert.throws(
    () => encodeMistralConversationsRequest(model, baseRequest as never),
    /requires a prepared model request/,
  );
  const metadata = await prepared({ ...baseRequest, metadata: { team: "search" } });
  assert.throws(
    () => encodeMistralConversationsRequest(model, metadata),
    /cannot render request metadata/,
  );
  const identity = {
    providerId: model.providerId,
    apiDialect: model.apiDialect,
    modelId: model.modelId,
  };
  const signed = await prepared({
    ...baseRequest,
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", text: "private", signature: { ...identity, value: "sig" } }],
      },
    ],
  });
  assert.throws(
    () => encodeMistralConversationsRequest(model, signed),
    /unsupported replay signature/,
  );
});
