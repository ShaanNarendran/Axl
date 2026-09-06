// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  BedrockConverseStreamCodecError,
  decodeBedrockConverseStream,
  encodeBedrockConverseStreamRequest,
  getStaticModelCatalog,
  type ModelInfo,
  type ModelRequest,
  normalizeModelStream,
  prepareModelRequest,
} from "../src/index.ts";

function bedrockModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId: "amazon-bedrock",
    modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    displayName: "Claude Sonnet 4.5",
    apiDialect: "bedrock-converse-stream",
    capabilities: { toolUse: true, structuredOutput: true, imageInput: true },
    reasoning: true,
    thinkingLevelMap: {
      minimal: "1024",
      low: "2048",
      medium: "8192",
      high: "16384",
      xhigh: "16384",
      max: "16384",
    },
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
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
    sampling: { supported: ["temperature", "topP"], customFields: ["stopSequences"] },
    compatibility: {
      dialect: "bedrock-converse-stream",
      supportsStrictTools: true,
      supportsPromptCacheMarkers: true,
      supportsThinkingSignatures: true,
    },
    ...overrides,
  };
}

const baseRequest: ModelRequest = {
  modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

async function prepared(request: ModelRequest = baseRequest, model = bedrockModel()) {
  return prepareModelRequest(model, request);
}

async function* events(items: readonly unknown[]) {
  for (const item of items) yield item as Readonly<Record<string, unknown>>;
}

test("generated Bedrock catalog declares codec capabilities explicitly", () => {
  const models = getStaticModelCatalog("amazon-bedrock");
  const claude = models.find(
    (model) => model.modelId === "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  );
  const adaptive = models.find((model) => model.modelId === "global.anthropic.claude-sonnet-4-6");
  const nova = models.find((model) => model.modelId === "amazon.nova-lite-v1:0");
  assert.deepEqual(claude?.compatibility, {
    dialect: "bedrock-converse-stream",
    supportsStrictTools: true,
    supportsPromptCacheMarkers: true,
    supportsThinkingSignatures: true,
  });
  assert.equal(
    adaptive?.compatibility?.dialect === "bedrock-converse-stream" &&
      adaptive.compatibility.forceAdaptiveThinking,
    true,
  );
  assert.deepEqual(nova?.compatibility, { dialect: "bedrock-converse-stream" });
});

test("encodes prepared history, images, tools, caching, reasoning, and signing inputs", async () => {
  const model = bedrockModel();
  const image = new Uint8Array([1, 2, 3, 4]);
  const sha256 = createHash("sha256").update(image).digest("hex");
  const identity = {
    providerId: model.providerId,
    apiDialect: model.apiDialect,
    modelId: model.modelId,
  };
  const request = await prepared(
    {
      modelId: model.modelId,
      system: "Use evidence.",
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
            { type: "thinking", text: "checked", signature: { ...identity, value: "sig-1" } },
            {
              type: "thinking",
              text: "",
              signature: { ...identity, value: "AQID" },
              redacted: true,
            },
            { type: "text", text: "calling" },
          ],
          toolCalls: [{ callId: "call-1", name: "lookup", input: { key: "a", "": "removed" } }],
        },
        {
          role: "tool",
          callId: "call-1",
          name: "lookup",
          content: [{ type: "text", text: "value" }],
          isError: false,
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          inputSchema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
          constraint: { type: "json-schema", strict: "require" },
        },
      ],
      thinkingLevel: "medium",
      maxOutputTokens: 100,
      toolChoice: "required",
      sampling: { temperature: 0.2, topP: 0.8, custom: { stopSequences: ["END"] } },
      cache: { retention: "long" },
      metadata: { team: "search" },
      readBlob: async () => image,
    },
    model,
  );
  assert.equal(request.maxOutputTokens, 8_292);
  const encoded = encodeBedrockConverseStreamRequest(model, request, {
    region: "us-west-2",
    authentication: { type: "sigv4" },
  });
  assert.equal(
    encoded.url,
    "https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse-stream",
  );
  assert.deepEqual(encoded.signing, { service: "bedrock", region: "us-west-2" });
  assert.deepEqual(encoded.headers, {
    accept: "application/vnd.amazon.eventstream",
    "content-type": "application/json",
  });
  assert.deepEqual(encoded.body, {
    messages: [
      {
        role: "user",
        content: [{ text: "inspect" }, { image: { format: "png", source: { bytes: "AQIDBA==" } } }],
      },
      {
        role: "assistant",
        content: [
          { reasoningContent: { reasoningText: { text: "checked", signature: "sig-1" } } },
          { reasoningContent: { redactedContent: "AQID" } },
          { text: "calling" },
          { toolUse: { toolUseId: "call-1", name: "lookup", input: { key: "a" } } },
        ],
      },
      {
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: "call-1",
              content: [{ text: "value" }],
              status: "success",
            },
          },
          { cachePoint: { type: "default", ttl: "1h" } },
        ],
      },
    ],
    system: [{ text: "Use evidence." }, { cachePoint: { type: "default", ttl: "1h" } }],
    inferenceConfig: { maxTokens: 8_292, temperature: 0.2, topP: 0.8 },
    toolConfig: {
      tools: [
        {
          toolSpec: {
            name: "lookup",
            description: "Look up a value",
            inputSchema: {
              json: {
                type: "object",
                properties: { key: { type: "string" } },
                required: ["key"],
                additionalProperties: false,
              },
            },
            strict: true,
          },
        },
      ],
      toolChoice: { any: {} },
    },
    additionalModelRequestFields: {
      stopSequences: ["END"],
      thinking: { type: "enabled", budget_tokens: 7_268, display: "summarized" },
      anthropic_beta: ["interleaved-thinking-2025-05-14"],
    },
    requestMetadata: { team: "search" },
  });
});

test("uses ARN region routing and bearer authentication without signing", async () => {
  const model = bedrockModel({
    modelId:
      "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:application-inference-profile/example",
  });
  const request = await prepared({ ...baseRequest, modelId: model.modelId }, model);
  const encoded = encodeBedrockConverseStreamRequest(model, request, {
    region: "us-east-1",
    baseUrl: "https://private.example.test/runtime?route=one",
    authentication: { type: "bearer", token: "token-value" },
  });
  assert.equal(encoded.signing, undefined);
  assert.equal(encoded.headers.authorization, "Bearer token-value");
  assert.equal(
    encoded.url,
    "https://private.example.test/runtime/model/arn%3Aaws-us-gov%3Abedrock%3Aus-gov-west-1%3A123456789012%3Aapplication-inference-profile%2Fexample/converse-stream?route=one",
  );
});

test("encodes adaptive Claude reasoning without a token budget", async () => {
  const model = bedrockModel({
    modelId: "global.anthropic.claude-sonnet-4-6",
    thinkingLevelMap: { high: "high", xhigh: null, max: "max" },
    compatibility: {
      dialect: "bedrock-converse-stream",
      supportsStrictTools: true,
      supportsPromptCacheMarkers: true,
      supportsThinkingSignatures: true,
      forceAdaptiveThinking: true,
    },
  });
  const request = await prepared(
    { modelId: model.modelId, messages: baseRequest.messages, thinkingLevel: "high" },
    model,
  );
  const encoded = encodeBedrockConverseStreamRequest(model, request, {
    region: "eu-central-1",
    authentication: { type: "sigv4" },
  });
  assert.deepEqual(encoded.body.additionalModelRequestFields, {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
  });
});

test("decodes interleaved thinking, redaction, text, tools, usage, and routing", async () => {
  const request = await prepared();
  const decoded = await Array.fromAsync(
    decodeBedrockConverseStream(
      events([
        { messageStart: { role: "assistant" } },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { text: "think", signature: "sig-" } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { signature: "one" } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        {
          contentBlockDelta: {
            contentBlockIndex: 1,
            delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 1 } },
        { contentBlockDelta: { contentBlockIndex: 2, delta: { text: "done" } } },
        { contentBlockStop: { contentBlockIndex: 2 } },
        {
          contentBlockStart: {
            contentBlockIndex: 3,
            start: { toolUse: { toolUseId: "call-1", name: "lookup" } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 3,
            delta: { toolUse: { input: '{"key":"a"}' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 3 } },
        { messageStop: { stopReason: "tool_use" } },
        {
          metadata: {
            usage: {
              inputTokens: 10,
              outputTokens: 8,
              cacheReadInputTokens: 4,
              cacheWriteInputTokens: 2,
              totalTokens: 18,
            },
            metrics: { latencyMs: 42 },
          },
        },
      ]),
      {
        model: bedrockModel(),
        request,
        responseId: "request-1",
        routedModelId: "profile/model",
      },
    ),
  );
  assert.deepEqual(
    decoded.map((event) => event.type),
    [
      "thinking_delta",
      "replay_metadata",
      "thinking_delta",
      "replay_metadata",
      "text_delta",
      "tool_call_start",
      "tool_call_delta",
      "tool_call",
      "completed",
    ],
  );
  assert.deepEqual(decoded[1], {
    type: "replay_metadata",
    target: "thinking",
    contentIndex: 0,
    providerId: "amazon-bedrock",
    apiDialect: "bedrock-converse-stream",
    modelId: baseRequest.modelId,
    signature: "sig-one",
  });
  assert.deepEqual(decoded[3], {
    type: "replay_metadata",
    target: "thinking",
    contentIndex: 1,
    providerId: "amazon-bedrock",
    apiDialect: "bedrock-converse-stream",
    modelId: baseRequest.modelId,
    signature: "AQID",
    redacted: true,
  });
  assert.deepEqual(decoded.at(-1), {
    type: "completed",
    stopReason: "tool_use",
    usage: {
      inputTokens: 10,
      outputTokens: 8,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      reasoningTokens: 0,
      costUsd: 0.000028899999999999998,
    },
    response: {
      providerId: "amazon-bedrock",
      requestedModelId: baseRequest.modelId,
      routedModelId: "profile/model",
      responseId: "request-1",
      nativeStopReason: "tool_use",
      latencyMs: 42,
    },
  });
});

test("maps limits, policy stops, provider failures, and cancellation safely", async () => {
  const request = await prepared();
  const limited = await Array.fromAsync(
    decodeBedrockConverseStream(
      events([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: "max_tokens" } },
      ]),
      { model: bedrockModel(), request },
    ),
  );
  const limitedTerminal = limited.at(-1);
  assert.equal(limitedTerminal?.type, "completed");
  if (limitedTerminal?.type === "completed") assert.equal(limitedTerminal.partial, true);

  const policy = await Array.fromAsync(
    decodeBedrockConverseStream(events([{ messageStop: { stopReason: "guardrail_intervened" } }]), {
      model: bedrockModel(),
      request,
    }),
  );
  assert.equal(policy[0]?.type === "error" && policy[0].category, "content_policy");

  const secret = "secret-value";
  const failed = await Array.fromAsync(
    decodeBedrockConverseStream(events([{ throttlingException: { message: `${secret} busy` } }]), {
      model: bedrockModel(),
      request,
      secretValues: [secret],
    }),
  );
  assert.deepEqual(failed[0], {
    type: "error",
    code: "throttlingException",
    message: "[REDACTED] busy",
    retryable: true,
    category: "rate_limit",
    requestPhase: "streaming",
    response: { providerId: "amazon-bedrock", requestedModelId: baseRequest.modelId },
  });

  const controller = new AbortController();
  const cancelled = await prepared({ ...baseRequest, signal: controller.signal });
  async function* cancelling() {
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } };
    controller.abort();
    yield { messageStop: { stopReason: "end_turn" } };
  }
  const aborted = await Array.fromAsync(
    decodeBedrockConverseStream(cancelling(), { model: bedrockModel(), request: cancelled }),
  );
  assert.deepEqual(aborted.at(-1), { type: "aborted", partial: true });
});

test("finalizes reasoning when Bedrock omits a content block stop", async () => {
  const request = await prepared();
  const decoded = await Array.fromAsync(
    decodeBedrockConverseStream(
      events([
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { redactedContent: "AQID" } },
          },
        },
        { messageStop: { stopReason: "end_turn" } },
      ]),
      { model: bedrockModel(), request },
    ),
  );
  assert.equal(decoded[1]?.type, "replay_metadata");
  if (decoded[1]?.type === "replay_metadata") {
    assert.equal(decoded[1].signature, "AQID");
    assert.equal(decoded[1].redacted, true);
  }
  assert.equal(decoded[2]?.type, "completed");
});

test("fails malformed events and normalizes truncation exactly once", async () => {
  const request = await prepared();
  await assert.rejects(
    Array.fromAsync(
      decodeBedrockConverseStream(events([{ contentBlockStop: { contentBlockIndex: 4 } }]), {
        model: bedrockModel(),
        request,
      }),
    ),
    BedrockConverseStreamCodecError,
  );
  const normalized = await Array.fromAsync(
    normalizeModelStream(
      decodeBedrockConverseStream(
        events([{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } }]),
        { model: bedrockModel(), request },
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
});

test("rejects unprepared requests and unsafe endpoint, auth, and metadata values", async () => {
  const model = bedrockModel();
  assert.throws(
    () =>
      encodeBedrockConverseStreamRequest(model, baseRequest as never, {
        region: "us-east-1",
        authentication: { type: "sigv4" },
      }),
    /requires a prepared model request/,
  );
  const request = await prepared({ ...baseRequest, metadata: { count: 2 } });
  assert.throws(
    () =>
      encodeBedrockConverseStreamRequest(model, request, {
        region: "us-east-1",
        authentication: { type: "sigv4" },
      }),
    /must be a string/,
  );
  const safe = await prepared();
  assert.throws(
    () =>
      encodeBedrockConverseStreamRequest(model, safe, {
        region: "not-a-region",
        authentication: { type: "sigv4" },
      }),
    /region is invalid/,
  );
  assert.throws(
    () =>
      encodeBedrockConverseStreamRequest(model, safe, {
        region: "us-east-1",
        baseUrl: "https://user:pass@example.test",
        authentication: { type: "sigv4" },
      }),
    /unsupported URL data/,
  );
});
