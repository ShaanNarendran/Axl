// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { JsonObject } from "@axl/protocol";

import {
  decodeGoogleGenerativeAiStream,
  encodeGoogleGenerativeAiRequest,
  getStaticModelCatalog,
  type ModelInfo,
  type ModelRequest,
  normalizeModelStream,
  prepareModelRequest,
  type SseFrame,
} from "../src/index.ts";

function googleModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId: "google",
    modelId: "gemini-3-fixture",
    displayName: "Gemini Fixture",
    apiDialect: "google-generative-ai",
    capabilities: { toolUse: true, structuredOutput: true, imageInput: true },
    reasoning: true,
    thinkingLevelMap: {
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    },
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    cost: {
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 2,
      cacheReadUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 1.25,
    },
    cache: {
      supported: true,
      defaultRetention: "short",
      supportedRetentions: ["none", "short"],
    },
    sampling: {
      supported: ["temperature", "topP", "topK", "seed"],
      customFields: ["stopSequences"],
    },
    compatibility: { dialect: "google-generative-ai", supportsStrictTools: true },
    ...overrides,
  };
}

const baseRequest: ModelRequest = {
  modelId: "gemini-3-fixture",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

async function prepared(request: ModelRequest = baseRequest, model = googleModel()) {
  return prepareModelRequest(model, request);
}

async function* frames(events: readonly unknown[]): AsyncGenerator<SseFrame> {
  for (const event of events) {
    yield { event: "message", data: JSON.stringify(event) };
  }
}

async function decode(
  events: readonly unknown[],
  request?: Awaited<ReturnType<typeof prepared>>,
  model = googleModel(),
) {
  return Array.fromAsync(
    decodeGoogleGenerativeAiStream(frames(events), {
      model,
      request: request ?? (await prepared(baseRequest, model)),
    }),
  );
}

test("marks Gemini 3 models with explicit strict tool compatibility", () => {
  const catalog = getStaticModelCatalog("google");
  assert.ok(catalog.length > 0);
  for (const model of catalog) {
    assert.equal(model.compatibility?.dialect, "google-generative-ai");
    assert.equal(
      model.compatibility?.dialect === "google-generative-ai"
        ? model.compatibility.supportsStrictTools === true
        : false,
      model.modelId.startsWith("gemini-3"),
    );
  }
});

test("encodes prepared Google history, verified images, replay, tools, safety, cache, and controls", async () => {
  const model = googleModel();
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
          { type: "thinking", text: "checked", signature: { ...identity, value: "dGhpbms=" } },
          { type: "text", text: "calling", signature: { ...identity, value: "dGV4dA==" } },
        ],
        toolCalls: [
          {
            callId: "call-1",
            name: "lookup",
            input: { key: "a" },
            signature: { ...identity, value: "dG9vbA==" },
          },
        ],
      },
      {
        role: "tool",
        callId: "call-1",
        name: "lookup",
        content: [
          { type: "text", text: "value" },
          { type: "blob", blob: { sha256, mediaType: "image/png", sizeBytes: bytes.length } },
        ],
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
    sampling: {
      temperature: 0.2,
      topP: 0.8,
      topK: 20,
      seed: 7,
      custom: { stopSequences: ["END"] },
    },
    cache: { retention: "short", sessionId: "cachedContents/session-fixture" },
    safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }],
    readBlob: async () => bytes,
  };

  assert.throws(
    () => encodeGoogleGenerativeAiRequest(model, request as never),
    /requires a prepared model request/,
  );
  const encoded = encodeGoogleGenerativeAiRequest(model, await prepared(request, model));
  assert.deepEqual(encoded.headers, {
    accept: "text/event-stream",
    "content-type": "application/json",
  });
  assert.equal(encoded.modelId, model.modelId);
  assert.equal(encoded.body.cachedContent, "cachedContents/session-fixture");
  assert.deepEqual(encoded.body.safetySettings, request.safetySettings);
  assert.deepEqual(encoded.body.systemInstruction, { parts: [{ text: "Use evidence." }] });
  assert.deepEqual(encoded.body.generationConfig, {
    maxOutputTokens: 40,
    temperature: 0.2,
    topP: 0.8,
    topK: 20,
    seed: 7,
    stopSequences: ["END"],
    thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
  });
  assert.deepEqual(encoded.body.toolConfig, { functionCallingConfig: { mode: "ANY" } });
  const tools = encoded.body.tools as JsonObject[];
  const declaration = (tools[0]?.functionDeclarations as JsonObject[])[0];
  assert.deepEqual(declaration?.parametersJsonSchema, {
    type: "object",
    properties: {
      key: { type: "string" },
      optional: { anyOf: [{ type: "number" }, { type: "null" }] },
    },
    required: ["key", "optional"],
    additionalProperties: false,
  });

  const contents = encoded.body.contents as JsonObject[];
  assert.deepEqual(contents[0], {
    role: "user",
    parts: [{ text: "inspect" }, { inlineData: { mimeType: "image/png", data: "AQIDBA==" } }],
  });
  assert.deepEqual(contents[1], {
    role: "model",
    parts: [
      { thought: true, text: "checked", thoughtSignature: "dGhpbms=" },
      { text: "calling", thoughtSignature: "dGV4dA==" },
      {
        functionCall: { name: "lookup", args: { key: "a" }, id: "call-1" },
        thoughtSignature: "dG9vbA==",
      },
    ],
  });
  const functionResponse = (contents[2]?.parts as JsonObject[])[0]?.functionResponse as JsonObject;
  assert.equal(functionResponse.id, "call-1");
  assert.deepEqual(functionResponse.response, { output: "value" });
  assert.deepEqual(functionResponse.parts, [
    { inlineData: { mimeType: "image/png", data: "AQIDBA==" } },
  ]);
  assert.doesNotMatch(JSON.stringify(encoded), /api[_-]?key|authorization|credential/i);
});

test("encodes Gemini 2 token budgets, separate tool images, and disabled thinking", async () => {
  const model = googleModel({
    modelId: "gemini-2.5-flash",
    thinkingLevelMap: { minimal: "1024", low: "2048", medium: "8192", high: "24576" },
    compatibility: { dialect: "google-generative-ai" },
  });
  const enabled = await prepared(
    {
      modelId: model.modelId,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      thinkingLevel: "low",
      thinkingBudgets: { low: 1234 },
      maxOutputTokens: 100,
    },
    model,
  );
  assert.deepEqual(encodeGoogleGenerativeAiRequest(model, enabled).body.generationConfig, {
    maxOutputTokens: 1334,
    thinkingConfig: { includeThoughts: true, thinkingBudget: 1234 },
  });

  const disabled = await prepared(
    {
      modelId: model.modelId,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      thinkingLevel: "off",
    },
    model,
  );
  assert.deepEqual(encodeGoogleGenerativeAiRequest(model, disabled).body.generationConfig, {
    thinkingConfig: { thinkingBudget: 0 },
  });

  const bytes = new Uint8Array([5, 6]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const toolImage = await prepared(
    {
      modelId: model.modelId,
      messages: [
        { role: "user", content: [{ type: "text", text: "inspect" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "reading" }],
          toolCalls: [{ callId: "call-1", name: "read", input: {} }],
        },
        {
          role: "tool",
          callId: "call-1",
          name: "read",
          content: [{ type: "blob", blob: { sha256, mediaType: "image/png", sizeBytes: 2 } }],
          isError: false,
        },
      ],
      tools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }],
      readBlob: async () => bytes,
    },
    model,
  );
  const contents = encodeGoogleGenerativeAiRequest(model, toolImage).body.contents as JsonObject[];
  assert.equal(contents.length, 4);
  assert.deepEqual(contents[3], {
    role: "user",
    parts: [
      { text: "Tool result image:" },
      { inlineData: { mimeType: "image/png", data: "BQY=" } },
    ],
  });
});

test("uses minimum hidden thinking levels when Gemini 3 cannot disable thinking", async () => {
  for (const [modelId, thinkingLevel] of [
    ["gemini-3.1-pro-preview", "LOW"],
    ["gemini-3-flash-preview", "MINIMAL"],
    ["gemma-4-26b", "MINIMAL"],
  ] as const) {
    const model = googleModel({ modelId });
    const request = await prepared(
      {
        modelId,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        thinkingLevel: "off",
      },
      model,
    );
    assert.deepEqual(encodeGoogleGenerativeAiRequest(model, request).body.generationConfig, {
      thinkingConfig: { thinkingLevel },
    });
  }
});

test("rejects malformed and unsupported Google request behavior", async () => {
  const model = googleModel();
  await assert.rejects(
    prepareModelRequest(model, {
      ...baseRequest,
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
      ],
    }),
    /category is duplicated/,
  );
  await assert.rejects(
    prepareModelRequest(googleModel({ compatibility: { dialect: "google-generative-ai" } }), {
      ...baseRequest,
      tools: [
        {
          name: "strict",
          description: "Strict",
          inputSchema: { type: "object" },
          constraint: { type: "json-schema", strict: "require" },
        },
      ],
    }),
    /strict schemas unsupported/,
  );
  const metadata = await prepared({ ...baseRequest, metadata: { tenant: "safe" } });
  assert.throws(
    () => encodeGoogleGenerativeAiRequest(model, metadata),
    /request metadata is unsupported/,
  );
  const invalidCache = await prepared({ ...baseRequest, cache: { sessionId: "not-a-resource" } });
  assert.throws(
    () => encodeGoogleGenerativeAiRequest(model, invalidCache),
    /cachedContents resource name/,
  );

  const bytes = new Uint8Array([9]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const unsupportedImage = await prepared({
    modelId: model.modelId,
    messages: [
      {
        role: "user",
        content: [
          { type: "blob", blob: { sha256, mediaType: "image/bmp", sizeBytes: bytes.length } },
        ],
      },
    ],
    readBlob: async () => bytes,
  });
  assert.throws(
    () => encodeGoogleGenerativeAiRequest(model, unsupportedImage),
    /does not support image media type image\/bmp/,
  );

  const invalidSignature = await prepared({
    modelId: model.modelId,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "signed",
            signature: {
              providerId: model.providerId,
              apiDialect: model.apiDialect,
              modelId: model.modelId,
              value: "not-base64!",
            },
          },
        ],
      },
    ],
  });
  assert.throws(
    () => encodeGoogleGenerativeAiRequest(model, invalidSignature),
    /not a valid Google thought signature/,
  );
});

test("decodes interleaved Google output, replay signatures, tools, usage, cost, and identity", async () => {
  const request = await prepared({
    ...baseRequest,
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        inputSchema: { type: "object", properties: { key: { type: "string" } } },
      },
    ],
  });
  const events = await decode(
    [
      {
        responseId: "resp-google",
        modelVersion: "gemini-routed",
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "plan", thoughtSignature: "dGhpbms=" },
                { text: "answer", thoughtSignature: "dGV4dA==" },
                {
                  functionCall: { id: "call-1", name: "lookup", args: { key: "a" } },
                  thoughtSignature: "dG9vbA==",
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 20,
          cachedContentTokenCount: 5,
          candidatesTokenCount: 7,
          thoughtsTokenCount: 3,
          totalTokenCount: 30,
        },
      },
    ],
    request,
  );

  assert.deepEqual(events.slice(0, 3), [
    { type: "thinking_delta", text: "plan", contentIndex: 0 },
    {
      type: "replay_metadata",
      target: "thinking",
      contentIndex: 0,
      providerId: "google",
      apiDialect: "google-generative-ai",
      modelId: "gemini-3-fixture",
      signature: "dGhpbms=",
    },
    { type: "text_delta", text: "answer", contentIndex: 1 },
  ]);
  assert.deepEqual(events.slice(3, 7), [
    {
      type: "replay_metadata",
      target: "text",
      contentIndex: 1,
      providerId: "google",
      apiDialect: "google-generative-ai",
      modelId: "gemini-3-fixture",
      signature: "dGV4dA==",
    },
    { type: "tool_call_start", contentIndex: 2, callId: "call-1", name: "lookup" },
    {
      type: "tool_call_delta",
      contentIndex: 2,
      callId: "call-1",
      argumentsDelta: '{"key":"a"}',
    },
    {
      type: "tool_call",
      contentIndex: 2,
      callId: "call-1",
      name: "lookup",
      input: { key: "a" },
    },
  ]);
  assert.equal(events[7]?.type, "replay_metadata");
  assert.equal(events[7]?.type === "replay_metadata" ? events[7].signature : undefined, "dG9vbA==");
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "completed");
  if (terminal?.type !== "completed") assert.fail("expected completion");
  assert.equal(terminal.stopReason, "tool_use");
  assert.deepEqual(terminal.usage, {
    inputTokens: 15,
    outputTokens: 10,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    reasoningTokens: 3,
    costUsd: 35.5 / 1_000_000,
  });
  assert.deepEqual(terminal.response, {
    providerId: "google",
    requestedModelId: "gemini-3-fixture",
    routedModelId: "gemini-routed",
    responseId: "resp-google",
    nativeStopReason: "STOP",
  });
});

test("maps output limits and deterministic generated tool call identifiers", async () => {
  const events = await decode([
    {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: "first", args: {} } },
              { functionCall: { name: "second", args: {} } },
            ],
          },
          finishReason: "MAX_TOKENS",
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    },
  ]);
  const calls = events.filter((event) => event.type === "tool_call");
  assert.deepEqual(
    calls.map((event) => event.callId),
    ["google_call_1", "google_call_2"],
  );
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "completed");
  assert.equal(terminal?.type === "completed" ? terminal.stopReason : undefined, "length");
  assert.equal(terminal?.type === "completed" ? terminal.partial : undefined, true);
  assert.equal(
    terminal?.type === "completed" ? terminal.response?.nativeStopReason : undefined,
    "MAX_TOKENS",
  );
});

test("maps prompt and candidate safety failures with safe partial behavior", async () => {
  const blockedPrompt = await decode([
    {
      promptFeedback: {
        blockReason: "SAFETY",
        blockReasonMessage: "unsafe prompt secret-value",
      },
    },
  ]);
  assert.equal(blockedPrompt[0]?.type, "error");

  const request = await prepared();
  const candidateEvents = Array.fromAsync(
    decodeGoogleGenerativeAiStream(
      frames([
        {
          candidates: [
            {
              content: { parts: [{ text: "partial" }] },
              finishReason: "PROHIBITED_CONTENT",
              finishMessage: "blocked secret-value",
            },
          ],
        },
      ]),
      { model: googleModel(), request, secretValues: ["secret-value"] },
    ),
  );
  const candidate = await candidateEvents;
  const terminal = candidate.at(-1);
  assert.equal(terminal?.type, "error");
  if (terminal?.type !== "error") assert.fail("expected safety error");
  assert.equal(terminal.code, "prohibited_content");
  assert.equal(terminal.partial, true);
  assert.doesNotMatch(terminal.message, /secret-value/);
  assert.equal(terminal.response?.nativeStopReason, "PROHIBITED_CONTENT");
});

test("handles provider errors, cancellation, malformed usage, and safe partial output", async () => {
  const request = await prepared();
  const providerEvents = await Array.fromAsync(
    decodeGoogleGenerativeAiStream(
      frames([{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "retry secret" } }]),
      { model: googleModel(), request, secretValues: ["secret"] },
    ),
  );
  assert.deepEqual(providerEvents[0], {
    type: "error",
    code: "RESOURCE_EXHAUSTED",
    message: "retry [REDACTED]",
    retryable: true,
    response: { providerId: "google", requestedModelId: "gemini-3-fixture" },
  });

  const controller = new AbortController();
  async function* abortingFrames(): AsyncGenerator<SseFrame> {
    yield {
      event: "message",
      data: JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }),
    };
    controller.abort();
    yield { event: "message", data: JSON.stringify({ candidates: [{ finishReason: "STOP" }] }) };
  }
  const abortedRequest = await prepared({ ...baseRequest, signal: controller.signal });
  const aborted = await Array.fromAsync(
    decodeGoogleGenerativeAiStream(abortingFrames(), {
      model: googleModel(),
      request: abortedRequest,
    }),
  );
  assert.deepEqual(aborted.at(-1), { type: "aborted", partial: true });

  await assert.rejects(
    decode([
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, cachedContentTokenCount: 2 },
      },
    ]),
    /cached input tokens exceed prompt tokens/,
  );
});

test("ignores unknown events and normalization supplies one terminal for malformed or truncated streams", async () => {
  const request = await prepared();
  async function* unknownThenStop(): AsyncGenerator<SseFrame> {
    yield { event: "future_google_event", data: "not-json" };
    yield {
      event: "message",
      data: JSON.stringify({ candidates: [{ finishReason: "STOP" }] }),
    };
    yield {
      event: "message",
      data: JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
    };
  }
  const exact = await Array.fromAsync(
    normalizeModelStream(
      decodeGoogleGenerativeAiStream(unknownThenStop(), { model: googleModel(), request }),
    ),
  );
  assert.equal(exact.filter((event) => event.type === "completed").length, 1);
  assert.equal(exact.at(-1)?.type, "completed");

  const truncated = await Array.fromAsync(
    normalizeModelStream(
      decodeGoogleGenerativeAiStream(
        frames([{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }]),
        { model: googleModel(), request },
      ),
    ),
  );
  assert.deepEqual(truncated.at(-1), {
    type: "error",
    code: "provider_stream_truncated",
    message: "provider ended the stream without a terminal event",
    retryable: false,
    category: "stream_interrupted",
    requestPhase: "streaming",
    partial: true,
  });

  async function* malformed(): AsyncGenerator<SseFrame> {
    yield { event: "message", data: "{" };
  }
  const malformedEvents = await Array.fromAsync(
    normalizeModelStream(
      decodeGoogleGenerativeAiStream(malformed(), { model: googleModel(), request }),
    ),
  );
  assert.equal(malformedEvents.length, 1);
  assert.equal(malformedEvents[0]?.type, "error");
  assert.equal(
    malformedEvents[0]?.type === "error" ? malformedEvents[0].code : undefined,
    "provider_stream_failure",
  );
});
