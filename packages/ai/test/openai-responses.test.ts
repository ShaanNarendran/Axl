// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeResponsesStream,
  encodeResponsesRequest,
  type ModelInfo,
  type ModelRequest,
  type ModelStreamEvent,
  normalizeModelStream,
  OpenAiResponsesProvider,
  prepareModelRequest,
  ResponsesCodecError,
  type SseFrame,
} from "../src/index.ts";

function responsesModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId: "openai",
    modelId: "gpt-5",
    displayName: "GPT-5",
    apiDialect: "openai-responses",
    capabilities: { toolUse: true, structuredOutput: true, imageInput: true },
    reasoning: true,
    thinkingLevelMap: { off: null, xhigh: "xhigh" },
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    cost: {
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 2,
      cacheReadUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 1.25,
    },
    cache: { supported: true, defaultRetention: "none", supportedRetentions: ["short", "long"] },
    sampling: { supported: ["temperature", "topP"], customFields: ["service_tier"] },
    compatibility: {
      dialect: "openai-responses",
      supportsStrictTools: true,
      supportsGrammarTools: true,
      supportsLongCacheRetention: true,
      supportsMaxOutputTokens: true,
      sessionAffinityFormat: "openai",
    },
    ...overrides,
  };
}

const baseRequest: ModelRequest = {
  modelId: "gpt-5",
  system: "You are Axl.",
  messages: [{ role: "user", content: [{ type: "text", text: "run the tests" }] }],
  tools: [
    {
      name: "shell",
      description: "Run a command",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      constraint: { type: "json-schema", strict: "require" },
    },
  ],
  thinkingLevel: "xhigh",
  maxOutputTokens: 4,
  sampling: { temperature: 0.3, topP: 0.9, custom: { service_tier: "flex" } },
  cache: { retention: "long", sessionId: "session-1" },
};

async function prepared(request: ModelRequest = baseRequest, model = responsesModel()) {
  return prepareModelRequest(model, request);
}

async function* frames(events: readonly unknown[]): AsyncGenerator<SseFrame> {
  for (const event of events) yield { data: JSON.stringify(event) };
}

async function decode(
  events: readonly unknown[],
  request?: Awaited<ReturnType<typeof prepared>>,
  model = responsesModel(),
): Promise<ModelStreamEvent[]> {
  return Array.fromAsync(
    decodeResponsesStream(frames(events), { model, request: request ?? (await prepared()) }),
  );
}

test("requires PreparedModelRequest and encodes prepared controls deterministically", async () => {
  assert.throws(
    () => encodeResponsesRequest(responsesModel(), baseRequest as never),
    /requires a prepared model request/,
  );
  const request = await prepared();
  const encoded = encodeResponsesRequest(responsesModel(), request, "deployment-gpt-5");
  assert.deepEqual(encoded.headers, {
    session_id: "session-1",
    "x-client-request-id": "session-1",
    "x-session-affinity": "session-1",
  });
  assert.deepEqual(encoded.body, {
    model: "deployment-gpt-5",
    input: [{ role: "user", content: [{ type: "input_text", text: "run the tests" }] }],
    stream: true,
    store: false,
    instructions: "You are Axl.",
    max_output_tokens: 16,
    tools: [
      {
        type: "function",
        name: "shell",
        description: "Run a command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    reasoning: { effort: "xhigh", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    temperature: 0.3,
    top_p: 0.9,
    service_tier: "flex",
    prompt_cache_retention: "24h",
    prompt_cache_key: "session-1",
  });
});

test("encodes verified images, grammar tools, and same-model replay metadata", async () => {
  const bytes = new TextEncoder().encode("abc");
  const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const model = responsesModel();
  const request = await prepared(
    {
      modelId: "gpt-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            { type: "blob", blob: { sha256: digest, mediaType: "image/png", sizeBytes: 3 } },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              text: "considered",
              signature: {
                providerId: "openai",
                apiDialect: "openai-responses",
                modelId: "gpt-5",
                value: '{"type":"reasoning","id":"rs-1","encrypted_content":"opaque"}',
              },
            },
            {
              type: "text",
              text: "Using a query.",
              continuation: {
                providerId: "openai",
                apiDialect: "openai-responses",
                modelId: "gpt-5",
                responseId: "resp-1",
                itemId: "msg-1",
              },
            },
          ],
          toolCalls: [
            {
              callId: "call-1",
              name: "query",
              input: { expression: "x + 1" },
              continuation: {
                providerId: "openai",
                apiDialect: "openai-responses",
                modelId: "gpt-5",
                responseId: "resp-1",
                itemId: "ctc-1",
                namespace: "dynamic",
              },
            },
          ],
        },
        {
          role: "tool",
          callId: "call-1",
          name: "query",
          content: [{ type: "text", text: "2" }],
          isError: false,
        },
      ],
      tools: [
        {
          name: "query",
          description: "Evaluate",
          inputSchema: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
          constraint: { type: "grammar", variants: { lark: "start: /.+/" } },
        },
      ],
      readBlob: () => Promise.resolve(bytes),
    },
    model,
  );
  const body = encodeResponsesRequest(model, request).body;
  assert.deepEqual(body.tools, [
    {
      type: "custom",
      name: "query",
      description: "Evaluate",
      format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
    },
  ]);
  assert.deepEqual(body.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "inspect" },
        { type: "input_image", detail: "auto", image_url: "data:image/png;base64,YWJj" },
      ],
    },
    { type: "reasoning", id: "rs-1", encrypted_content: "opaque" },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      id: "msg-1",
      content: [{ type: "output_text", text: "Using a query.", annotations: [] }],
    },
    {
      type: "custom_tool_call",
      call_id: "call-1",
      name: "query",
      input: "x + 1",
      id: "ctc-1",
      namespace: "dynamic",
    },
    { type: "custom_tool_call_output", call_id: "call-1", output: "2" },
  ]);
});

test("decodes interleaved blocks, replay metadata, usage, cost, and exact completion", async () => {
  const events = await decode([
    { type: "response.created", response: { id: "resp-1", model: "gpt-5-routed" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs-1" },
    },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "think" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs-1", encrypted_content: "opaque", summary: [] },
    },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg-1" } },
    { type: "response.output_text.delta", output_index: 1, delta: "Hello" },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: { type: "message", id: "msg-1", phase: "final_answer", content: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: { type: "function_call", id: "fc-1", call_id: "call-9", name: "shell" },
    },
    { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"command":"ls"}' },
    {
      type: "response.output_item.done",
      output_index: 2,
      item: {
        type: "function_call",
        id: "fc-1",
        call_id: "call-9",
        name: "shell",
        arguments: '{"command":"ls"}',
        namespace: "dynamic",
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp-1",
        model: "gpt-5-routed",
        status: "completed",
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          input_tokens_details: { cached_tokens: 100, cache_write_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 8 },
        },
      },
    },
    { type: "response.output_text.delta", output_index: 1, delta: "never" },
  ]);

  assert.deepEqual(events, [
    { type: "thinking_delta", text: "think", contentIndex: 0 },
    {
      type: "replay_metadata",
      target: "thinking",
      contentIndex: 0,
      providerId: "openai",
      apiDialect: "openai-responses",
      modelId: "gpt-5",
      signature: '{"type":"reasoning","id":"rs-1","encrypted_content":"opaque","summary":[]}',
      responseId: "resp-1",
      itemId: "rs-1",
    },
    { type: "text_delta", text: "Hello", contentIndex: 1 },
    {
      type: "replay_metadata",
      target: "text",
      contentIndex: 1,
      providerId: "openai",
      apiDialect: "openai-responses",
      modelId: "gpt-5",
      responseId: "resp-1",
      itemId: "msg-1",
      namespace: "final_answer",
    },
    { type: "tool_call_start", contentIndex: 2, callId: "call-9", name: "shell" },
    {
      type: "tool_call_delta",
      contentIndex: 2,
      callId: "call-9",
      argumentsDelta: '{"command":"ls"}',
    },
    {
      type: "tool_call",
      contentIndex: 2,
      callId: "call-9",
      name: "shell",
      input: { command: "ls" },
    },
    {
      type: "replay_metadata",
      target: "tool_call",
      contentIndex: 2,
      providerId: "openai",
      apiDialect: "openai-responses",
      modelId: "gpt-5",
      callId: "call-9",
      responseId: "resp-1",
      itemId: "fc-1",
      namespace: "dynamic",
    },
    {
      type: "completed",
      stopReason: "tool_use",
      usage: {
        inputTokens: 15,
        outputTokens: 30,
        cacheReadTokens: 100,
        cacheWriteTokens: 5,
        reasoningTokens: 8,
        costUsd: 0.00009125,
      },
      response: {
        providerId: "openai",
        requestedModelId: "gpt-5",
        routedModelId: "gpt-5-routed",
        responseId: "resp-1",
        nativeStopReason: "completed",
      },
    },
  ]);
});

test("decodes custom tools and retains their item namespace", async () => {
  const model = responsesModel();
  const request = await prepared(
    {
      modelId: "gpt-5",
      messages: [{ role: "user", content: [{ type: "text", text: "query" }] }],
      tools: [
        {
          name: "query",
          description: "Query",
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
      { type: "response.created", response: { id: "resp-2" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "custom_tool_call", id: "ctc-2", call_id: "call-2", name: "query" },
      },
      { type: "response.custom_tool_call_input.delta", output_index: 0, delta: "x" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "custom_tool_call",
          id: "ctc-2",
          call_id: "call-2",
          name: "query",
          input: "x + 1",
          namespace: "loaded",
        },
      },
      { type: "response.completed", response: { id: "resp-2", status: "completed" } },
    ],
    request,
    model,
  );
  assert.deepEqual(events.at(-3), {
    type: "tool_call",
    contentIndex: 0,
    callId: "call-2",
    name: "query",
    input: { expression: "x + 1" },
  });
  assert.deepEqual(events.at(-2), {
    type: "replay_metadata",
    target: "tool_call",
    contentIndex: 0,
    providerId: "openai",
    apiDialect: "openai-responses",
    modelId: "gpt-5",
    callId: "call-2",
    responseId: "resp-2",
    itemId: "ctc-2",
    namespace: "loaded",
  });
});

test("maps incomplete, provider failure, cancellation, and truncation terminals", async () => {
  const request = await prepared();
  const incomplete = await decode(
    [
      { type: "response.created", response: { id: "resp-partial" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg-p" },
      },
      { type: "response.output_text.delta", output_index: 0, delta: "partial" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg-p" },
      },
      {
        type: "response.incomplete",
        response: {
          id: "resp-partial",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ],
    request,
  );
  assert.equal(incomplete.at(-1)?.type, "completed");
  assert.deepEqual(incomplete.at(-1), {
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
      providerId: "openai",
      requestedModelId: "gpt-5",
      responseId: "resp-partial",
      nativeStopReason: "max_output_tokens",
    },
  });

  const failure = await decode(
    [
      {
        type: "response.failed",
        response: {
          id: "resp-f",
          status: "failed",
          error: { code: "server_error", message: "boom" },
        },
      },
    ],
    request,
  );
  assert.equal(failure[0]?.type, "error");
  if (failure[0]?.type === "error") {
    assert.equal(failure[0].retryable, true);
    assert.equal(failure[0].category, "overloaded");
    assert.equal(failure[0].requestPhase, "streaming");
  }

  const controller = new AbortController();
  controller.abort();
  const abortedRequest = await prepared({ ...baseRequest, signal: controller.signal });
  assert.deepEqual(
    await decode([{ type: "response.created", response: { id: "unused" } }], abortedRequest),
    [{ type: "aborted" }],
  );

  const truncated = await Array.fromAsync(
    normalizeModelStream(
      decodeResponsesStream(
        frames([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "m" },
          },
          { type: "response.output_text.delta", output_index: 0, delta: "cut" },
        ]),
        { model: responsesModel(), request },
      ),
    ),
  );
  const truncatedTerminal = truncated.at(-1);
  assert.equal(truncatedTerminal?.type, "error");
  if (truncatedTerminal?.type === "error") assert.equal(truncatedTerminal.partial, true);
});

function responsesProvider(fetchImpl: typeof fetch): OpenAiResponsesProvider {
  return new OpenAiResponsesProvider({
    id: "responses",
    displayName: "Responses",
    authMethods: ["keyless"],
    endpoint: {
      url: () => "https://example.test/responses",
      headers: () => ({}),
      deploymentFor: (modelId) => modelId,
    },
    models: [responsesModel()],
    resolveAuth: () => Promise.resolve({ auth: {}, source: "test", secretValues: [] }),
    fetch: fetchImpl,
  });
}

test("classifies HTTP throttling and preserves retry guidance", async () => {
  const provider = responsesProvider(() =>
    Promise.resolve(new Response("busy", { status: 429, headers: { "retry-after": "2" } })),
  );
  assert.deepEqual(await Array.fromAsync(provider.stream({ modelId: "gpt-5", messages: [] })), [
    {
      type: "error",
      code: "http_429",
      message: "Provider responses returned 429",
      retryable: true,
      category: "rate_limit",
      requestPhase: "awaiting_response",
      retryAfterMs: 2_000,
    },
  ]);
});

test("fails closed on an empty successful response", async () => {
  const provider = responsesProvider(() => Promise.resolve(new Response(null, { status: 200 })));
  assert.deepEqual(await Array.fromAsync(provider.stream({ modelId: "gpt-5", messages: [] })), [
    {
      type: "error",
      code: "empty_response",
      message: "Provider responses returned no response body",
      retryable: false,
      category: "provider_internal",
      requestPhase: "awaiting_response",
    },
  ]);
});

test("retries only fetch failures known to precede dispatch", async () => {
  const networkCause = Object.assign(new Error("dns unavailable"), { code: "EAI_AGAIN" });
  const safe = responsesProvider(() =>
    Promise.reject(new TypeError("fetch failed", { cause: networkCause })),
  );
  const safeEvents = await Array.fromAsync(safe.stream({ modelId: "gpt-5", messages: [] }));
  assert.equal(safeEvents[0]?.type === "error" && safeEvents[0].retryable, true);
  assert.equal(safeEvents[0]?.type === "error" && safeEvents[0].requestPhase, "before_dispatch");

  const unknown = responsesProvider(() => Promise.reject(new TypeError("fetch failed")));
  const unknownEvents = await Array.fromAsync(unknown.stream({ modelId: "gpt-5", messages: [] }));
  assert.equal(unknownEvents[0]?.type === "error" && unknownEvents[0].retryable, false);
  assert.equal(unknownEvents[0]?.type === "error" && unknownEvents[0].requestPhase, "unknown");
});

test("classifies a terminated response stream as unsafe to redispatch", async () => {
  const provider = responsesProvider(() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200 },
      ),
    ),
  );
  assert.deepEqual(await Array.fromAsync(provider.stream({ modelId: "gpt-5", messages: [] })), [
    {
      type: "error",
      code: "provider_stream_failed",
      message: "terminated",
      retryable: false,
      category: "stream_interrupted",
      requestPhase: "streaming",
    },
  ]);
});

test("rejects malformed frames, orphaned deltas, and invalid tool arguments", async () => {
  const request = await prepared();
  await assert.rejects(
    Array.fromAsync(
      decodeResponsesStream(
        (async function* () {
          yield { data: "{not json" };
        })(),
        { model: responsesModel(), request },
      ),
    ),
    ResponsesCodecError,
  );
  await assert.rejects(
    decode([{ type: "response.output_text.delta", output_index: 7, delta: "orphan" }], request),
    /no message item/,
  );
  await assert.rejects(
    decode(
      [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", id: "fc", call_id: "call", name: "shell" },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call", id: "fc", arguments: "[]" },
        },
      ],
      request,
    ),
    /undecodable arguments/,
  );
});
