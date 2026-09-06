// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  decodeOpenAiChatStream,
  encodeOpenAiChatRequest,
  makeFakeModelInfo,
  normalizeModelStream,
  OpenAiChatCodecError,
  prepareModelRequest,
  type ModelInfo,
  type ModelRequest,
  type ModelStreamEvent,
  type PreparedModelRequest,
  type SseFrame,
} from "../src/index.ts";

function chatModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return makeFakeModelInfo({
    providerId: "openrouter",
    modelId: "openai/gpt-test",
    apiDialect: "openai-chat",
    capabilities: { toolUse: true, structuredOutput: true, imageInput: true },
    reasoning: true,
    thinkingLevelMap: { off: "none", medium: "medium", high: "high" },
    cache: {
      supported: true,
      defaultRetention: "none",
      supportedRetentions: ["none", "short", "long"],
    },
    sampling: {
      supported: [
        "temperature",
        "topP",
        "topK",
        "minP",
        "frequencyPenalty",
        "presencePenalty",
        "repetitionPenalty",
        "seed",
      ],
      customFields: ["mirostat"],
    },
    compatibility: {
      dialect: "openai-chat",
      supportsStore: true,
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      maxTokensField: "max_completion_tokens",
      requiresToolResultName: true,
      thinkingFormat: "openrouter",
      thinkingTokenBudgetField: "thinking_budget_tokens",
      supportsGrammarTools: true,
      supportsStrictTools: true,
      cacheControlFormat: "anthropic",
      sessionAffinityFormat: "openrouter",
      supportsLongCacheRetention: true,
    },
    ...overrides,
  });
}

async function prepare(
  request: Partial<ModelRequest> = {},
  model = chatModel(),
): Promise<PreparedModelRequest> {
  return prepareModelRequest(model, {
    modelId: model.modelId,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...request,
  });
}

async function* frames(values: readonly unknown[]): AsyncGenerator<SseFrame> {
  for (const value of values) {
    yield { data: typeof value === "string" ? value : JSON.stringify(value) };
  }
}

async function decode(
  values: readonly unknown[],
  request: PreparedModelRequest,
  model = chatModel(),
): Promise<ModelStreamEvent[]> {
  return Array.fromAsync(decodeOpenAiChatStream(frames(values), { model, request }));
}

test("encodes every prepared Chat request control without reloading blobs", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let reads = 0;
  const model = chatModel();
  const identity = {
    providerId: model.providerId,
    apiDialect: model.apiDialect,
    modelId: model.modelId,
  };
  const details = [{ type: "reasoning.encrypted", id: "reasoning-1", data: "opaque" }];
  const request = await prepare(
    {
      system: "Stable system prompt",
      messages: [
        { role: "user", content: [{ type: "text", text: "inspect" }] },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              text: "",
              signature: { ...identity, value: JSON.stringify(details) },
            },
            { type: "text", text: "Using the reader." },
          ],
          toolCalls: [{ callId: "call-1", name: "files.read", input: { path: "image.png" } }],
        },
        {
          role: "tool",
          callId: "call-1",
          name: "files.read",
          content: [
            { type: "text", text: "image" },
            {
              type: "blob",
              blob: { sha256, mediaType: "image/png", sizeBytes: bytes.byteLength },
            },
          ],
          isError: false,
        },
      ],
      tools: [
        {
          name: "files.read",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          constraint: { type: "json-schema", strict: "require" },
        },
        {
          name: "code.expression",
          description: "Evaluate an expression",
          inputSchema: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
          constraint: { type: "grammar", variants: { lark: "start: NUMBER" } },
        },
      ],
      thinkingLevel: "medium",
      thinkingBudgets: { medium: 2_000 },
      maxOutputTokens: 3_000,
      toolChoice: "auto",
      sampling: {
        temperature: 0.2,
        topP: 0.9,
        topK: 20,
        minP: 0.1,
        frequencyPenalty: -0.5,
        presencePenalty: 0.5,
        repetitionPenalty: 1.1,
        seed: 7,
        custom: { mirostat: 2 },
      },
      cache: { retention: "long", sessionId: "session-1" },
      readBlob: async () => {
        reads += 1;
        return bytes;
      },
    },
    model,
  );

  assert.equal(reads, 1);
  const encoded = encodeOpenAiChatRequest(model, request, "routed-model");
  assert.equal(reads, 1);
  assert.equal(encoded.body.model, "routed-model");
  assert.equal(encoded.body.stream, true);
  assert.deepEqual(encoded.body.stream_options, { include_usage: true });
  assert.equal(encoded.body.store, false);
  assert.equal(encoded.body.max_completion_tokens, 5_000);
  assert.equal(encoded.body.thinking_budget_tokens, 2_000);
  assert.deepEqual(encoded.body.reasoning, { effort: "medium" });
  assert.equal(encoded.body.tool_choice, "auto");
  assert.equal(encoded.body.temperature, 0.2);
  assert.equal(encoded.body.top_p, 0.9);
  assert.equal(encoded.body.top_k, 20);
  assert.equal(encoded.body.min_p, 0.1);
  assert.equal(encoded.body.frequency_penalty, -0.5);
  assert.equal(encoded.body.presence_penalty, 0.5);
  assert.equal(encoded.body.repetition_penalty, 1.1);
  assert.equal(encoded.body.seed, 7);
  assert.equal(encoded.body.mirostat, 2);
  assert.equal(encoded.body.prompt_cache_key, "session-1");
  assert.equal(encoded.body.prompt_cache_retention, "24h");
  assert.deepEqual(encoded.headers, { "x-session-id": "session-1" });

  const messages = encoded.body.messages as Record<string, unknown>[];
  assert.equal(messages[0]?.role, "developer");
  assert.deepEqual(messages[0]?.content, [
    {
      type: "text",
      text: "Stable system prompt",
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ]);
  assert.deepEqual(messages[2]?.reasoning_details, details);
  assert.deepEqual(messages[2]?.tool_calls, [
    {
      id: "call-1",
      type: "function",
      function: { name: "files_read", arguments: '{"path":"image.png"}' },
    },
  ]);
  assert.deepEqual(messages[3], {
    role: "tool",
    tool_call_id: "call-1",
    name: "files_read",
    content: "image",
  });
  assert.deepEqual(messages[4], {
    role: "user",
    content: [
      { type: "text", text: "Attached image(s) from tool result:" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AQID" },
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
  });

  const tools = encoded.body.tools as Record<string, unknown>[];
  assert.deepEqual(tools[0], {
    type: "function",
    function: {
      name: "files_read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
    },
  });
  assert.deepEqual(tools[1], {
    type: "custom",
    custom: {
      name: "code_expression",
      description: "Evaluate an expression",
      format: { type: "grammar", grammar: { syntax: "lark", definition: "start: NUMBER" } },
    },
    cache_control: { type: "ephemeral", ttl: "1h" },
  });
});

test("preserves a prepared cache marker on plain text content", async () => {
  const model = chatModel();
  const request = await prepare(
    {
      cache: { retention: "short" },
      messages: [{ role: "user", content: [{ type: "text", text: "cache me" }] }],
    },
    model,
  );
  const messages = encodeOpenAiChatRequest(model, request).body.messages as Record<
    string,
    unknown
  >[];
  assert.deepEqual(messages[0], {
    role: "user",
    content: [{ type: "text", text: "cache me", cache_control: { type: "ephemeral" } }],
  });
});

test("encodes prepared grammar history and maps provider-visible names", async () => {
  const model = chatModel();
  const request = await prepare(
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "calculate" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          toolCalls: [
            { callId: "call-grammar", name: "code.expression", input: { expression: "1+1" } },
          ],
        },
        {
          role: "tool",
          callId: "call-grammar",
          name: "code.expression",
          content: [{ type: "text", text: "2" }],
          isError: false,
        },
      ],
      tools: [
        {
          name: "code.expression",
          description: "Evaluate",
          inputSchema: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
          constraint: { type: "grammar", variants: { regex: ".+" } },
        },
      ],
    },
    model,
  );
  const messages = encodeOpenAiChatRequest(model, request).body.messages as Record<
    string,
    unknown
  >[];
  assert.deepEqual(messages[1]?.tool_calls, [
    {
      id: "call-grammar",
      type: "custom",
      custom: { name: "code_expression", input: "1+1" },
    },
  ]);
});

test("renders every declared Chat reasoning format from prepared controls", async () => {
  const cases: readonly [
    NonNullable<Extract<ModelInfo["compatibility"], { dialect: "openai-chat" }>["thinkingFormat"]>,
    Record<string, unknown>,
  ][] = [
    ["openai", { reasoning_effort: "medium" }],
    ["openrouter", { reasoning: { effort: "medium" } }],
    ["deepseek", { thinking: { type: "enabled" }, reasoning_effort: "medium" }],
    ["together", { reasoning: { enabled: true }, reasoning_effort: "medium" }],
    ["zai", { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "medium" }],
    ["qwen", { enable_thinking: true, reasoning_effort: "medium" }],
    ["chat-template", { chat_template_kwargs: { enable_thinking: true } }],
    ["baseten", { chat_template_args: { enable_thinking: true }, reasoning_effort: "medium" }],
    ["string-thinking", { thinking: "medium" }],
    ["ant-ling", { reasoning: { effort: "medium" } }],
  ];

  for (const [thinkingFormat, expected] of cases) {
    const model = chatModel({
      compatibility: {
        dialect: "openai-chat",
        thinkingFormat,
        supportsReasoningEffort: true,
      },
    });
    const request = await prepare({ thinkingLevel: "medium" }, model);
    const body = encodeOpenAiChatRequest(model, request).body;
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(body[key], value);
  }
});

test("rejects unprepared input and prepared controls Chat cannot render", async () => {
  const model = chatModel();
  assert.throws(
    () => encodeOpenAiChatRequest(model, { modelId: model.modelId, messages: [] } as never),
    /prepared model request/,
  );
  const metadata = await prepare({ metadata: { trace: "safe" } }, model);
  assert.throws(() => encodeOpenAiChatRequest(model, metadata), /cannot render request metadata/);

  const identity = {
    providerId: model.providerId,
    apiDialect: model.apiDialect,
    modelId: model.modelId,
  };
  const continuation = await prepare(
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "prior" }],
          continuation: { ...identity, responseId: "response-1" },
        },
      ],
    },
    model,
  );
  assert.throws(() => encodeOpenAiChatRequest(model, continuation), /continuation metadata/);
});

test("decodes interleaved reasoning, text, tools, usage, and routed identity", async () => {
  const model = chatModel({
    cost: {
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 2,
      cacheReadUsdPerMTok: 0.5,
      cacheWriteUsdPerMTok: 0.75,
    },
  });
  const request = await prepare(
    {
      tools: [
        {
          name: "files.read",
          description: "Read",
          inputSchema: { type: "object" },
        },
      ],
    },
    model,
  );
  const events = await Array.fromAsync(
    decodeOpenAiChatStream(
      frames([
        { id: "chat-1", model: "routed/model", choices: [{ delta: { reasoning: "plan" } }] },
        { choices: [{ delta: { content: "answer" } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-9",
                    type: "function",
                    function: { name: "files_read", arguments: '{"path"' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: ':"README.md"}' } }] },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
            completion_tokens_details: { reasoning_tokens: 8 },
          },
        },
        "[DONE]",
      ]),
      { model, request, startedAtMs: 10, now: () => 25 },
    ),
  );

  assert.deepEqual(events.slice(0, 6), [
    { type: "thinking_delta", text: "plan", contentIndex: 0 },
    { type: "text_delta", text: "answer", contentIndex: 1 },
    { type: "tool_call_start", contentIndex: 2, callId: "call-9", name: "files.read" },
    {
      type: "tool_call_delta",
      contentIndex: 2,
      callId: "call-9",
      argumentsDelta: '{"path"',
    },
    {
      type: "tool_call_delta",
      contentIndex: 2,
      callId: "call-9",
      argumentsDelta: ':"README.md"}',
    },
    {
      type: "tool_call",
      contentIndex: 2,
      callId: "call-9",
      name: "files.read",
      input: { path: "README.md" },
    },
  ]);
  const terminal = events[6];
  assert.equal(terminal?.type, "completed");
  if (terminal?.type !== "completed") assert.fail("expected completion");
  assert.equal(terminal.stopReason, "tool_use");
  assert.deepEqual(terminal.usage, {
    inputTokens: 90,
    outputTokens: 30,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    reasoningTokens: 8,
    costUsd: 0.0001675,
  });
  assert.deepEqual(terminal.response, {
    providerId: "openrouter",
    requestedModelId: "openai/gpt-test",
    routedModelId: "routed/model",
    responseId: "chat-1",
    nativeStopReason: "tool_calls",
    latencyMs: 15,
  });
});

test("decodes grammar tool input into its canonical object", async () => {
  const model = chatModel();
  const request = await prepare(
    {
      tools: [
        {
          name: "code.expression",
          description: "Evaluate",
          inputSchema: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
          constraint: { type: "grammar", variants: { regex: ".+" } },
        },
      ],
    },
    model,
  );
  const events = await decode(
    [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "custom-1",
                  type: "custom",
                  custom: { name: "code_expression", input: "1+" },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, custom: { input: "1" } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ],
    request,
    model,
  );
  assert.deepEqual(events.at(-2), {
    type: "tool_call",
    contentIndex: 0,
    callId: "custom-1",
    name: "code.expression",
    input: { expression: "1+1" },
  });
});

test("fails malformed streams and provider errors without false completion", async () => {
  const model = chatModel();
  const request = await prepare({}, model);
  await assert.rejects(
    Array.fromAsync(decodeOpenAiChatStream(frames(["{bad json"]), { model, request })),
    OpenAiChatCodecError,
  );
  await assert.rejects(
    decode(
      [{ choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted" }] } }] }],
      request,
      model,
    ),
    /canonical stream cannot retain/,
  );
  await assert.rejects(
    decode(
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-bad",
                    function: { name: "files_read", arguments: "[]" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        "[DONE]",
      ],
      request,
      model,
    ),
    /undecodable arguments/,
  );

  const failed = await Array.fromAsync(
    decodeOpenAiChatStream(
      frames([
        {
          error: {
            code: "rate_limit_exceeded",
            message: "credential secret-value was rejected",
          },
        },
      ]),
      { model, request, secretValues: ["secret-value"] },
    ),
  );
  assert.deepEqual(failed, [
    {
      type: "error",
      code: "rate_limit_exceeded",
      message: "credential [REDACTED] was rejected",
      retryable: true,
      response: { providerId: "openrouter", requestedModelId: "openai/gpt-test" },
    },
  ]);
});

test("unknown and truncated frames normalize to one error terminal", async () => {
  const model = chatModel();
  const request = await prepare({}, model);
  const events = await Array.fromAsync(
    normalizeModelStream(
      decodeOpenAiChatStream(frames([{ vendor_extension: true }, "[DONE]"]), {
        model,
        request,
      }),
    ),
  );
  assert.deepEqual(events, [
    {
      type: "error",
      code: "provider_stream_truncated",
      message: "provider ended the stream without a terminal event",
      retryable: false,
      category: "stream_interrupted",
      requestPhase: "streaming",
    },
  ]);

  const partial = await Array.fromAsync(
    normalizeModelStream(
      decodeOpenAiChatStream(frames([{ choices: [{ delta: { content: "safe" } }] }, "{bad json"]), {
        model,
        request,
      }),
    ),
  );
  assert.deepEqual(partial[0], { type: "text_delta", text: "safe", contentIndex: 0 });
  assert.deepEqual(partial[1], {
    type: "error",
    code: "provider_stream_failure",
    message: "Provider sent an undecodable Chat stream frame",
    retryable: false,
    category: "stream_interrupted",
    requestPhase: "streaming",
    partial: true,
  });
});

test("cancellation terminates once and marks emitted content partial", async () => {
  const controller = new AbortController();
  const model = chatModel();
  const request = await prepare({ signal: controller.signal }, model);
  async function* cancellingFrames(): AsyncGenerator<SseFrame> {
    yield { data: JSON.stringify({ choices: [{ delta: { content: "partial" } }] }) };
    controller.abort();
    yield { data: JSON.stringify({ choices: [{ delta: { content: "ignored" } }] }) };
  }
  const events = await Array.fromAsync(
    normalizeModelStream(
      decodeOpenAiChatStream(cancellingFrames(), { model, request }),
      controller.signal,
    ),
  );
  assert.deepEqual(events, [
    { type: "text_delta", text: "partial", contentIndex: 0 },
    { type: "aborted", partial: true },
  ]);
});
