// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeOpenAiCodexResponsesStream,
  encodeOpenAiCodexResponsesRequest,
  extractOpenAiCodexAccountId,
  type ModelInfo,
  type ModelRequest,
  normalizeModelStream,
  OpenAiCodexResponsesCodecError,
  openAiCodexResponsesUrl,
  prepareModelRequest,
  type SseFrame,
} from "../src/index.ts";

function codexModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId: "openai-codex",
    modelId: "gpt-5.4",
    displayName: "GPT-5.4",
    apiDialect: "openai-codex-responses",
    capabilities: { toolUse: true, structuredOutput: true, imageInput: true },
    reasoning: true,
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh" },
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    cost: {
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 2,
      cacheReadUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 1.25,
    },
    cache: { supported: true, defaultRetention: "short", supportedRetentions: ["none", "short"] },
    sampling: { supported: ["temperature", "topP"], customFields: ["service_tier"] },
    endpoint: { type: "fixed", baseUrl: "https://chatgpt.com/backend-api/codex" },
    headers: { "x-public-client": "fixture" },
    compatibility: {
      dialect: "openai-codex-responses",
      supportsStrictTools: true,
      supportsGrammarTools: true,
      supportsMaxOutputTokens: true,
    },
    ...overrides,
  };
}

function token(accountId = "account-fixture"): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

const baseRequest: ModelRequest = {
  modelId: "gpt-5.4",
  system: "Be concise.",
  messages: [{ role: "user", content: [{ type: "text", text: "inspect" }] }],
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
  thinkingLevel: "minimal",
  maxOutputTokens: 8,
  sampling: { temperature: 0.2, custom: { service_tier: "flex" } },
  cache: { retention: "short", sessionId: "session-1" },
};

async function prepared(request: ModelRequest = baseRequest, model = codexModel()) {
  return prepareModelRequest(model, request);
}

async function* frames(events: readonly unknown[]): AsyncGenerator<SseFrame> {
  for (const event of events) yield { data: JSON.stringify(event) };
}

async function decode(events: readonly unknown[], request?: Awaited<ReturnType<typeof prepared>>) {
  return Array.fromAsync(
    decodeOpenAiCodexResponsesStream(frames(events), {
      model: codexModel(),
      request: request ?? (await prepared()),
    }),
  );
}

test("composes required subscription headers and Codex request policy", async () => {
  const model = codexModel();
  assert.throws(
    () =>
      encodeOpenAiCodexResponsesRequest(model, baseRequest as never, {
        auth: { apiKey: token() },
        source: "fixture",
        secretValues: [],
      }),
    /requires a prepared model request/,
  );

  const accessToken = token();
  const encoded = encodeOpenAiCodexResponsesRequest(model, await prepared(), {
    auth: {
      apiKey: accessToken,
      headers: { Authorization: "untrusted override", "x-resolved-client": "fixture" },
    },
    source: "fixture",
    secretValues: [accessToken],
  });

  assert.equal(encoded.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.deepEqual(encoded.headers, {
    "x-public-client": "fixture",
    "x-resolved-client": "fixture",
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": "account-fixture",
    originator: "axl",
    "user-agent": "axl",
    "openai-beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
    "session-id": "session-1",
    "x-client-request-id": "session-1",
  });
  assert.deepEqual(encoded.body, {
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "inspect" }] }],
    stream: true,
    store: false,
    instructions: "Be concise.",
    max_output_tokens: 16,
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        strict: null,
      },
    ],
    reasoning: { effort: "low", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    temperature: 0.2,
    service_tier: "flex",
    prompt_cache_key: "session-1",
    text: { verbosity: "low" },
    tool_choice: "auto",
    parallel_tool_calls: true,
  });
  assert.equal(JSON.stringify(encoded.body).includes(accessToken), false);
});

test("validates subscription identity, endpoint policy, and cache header limits", async () => {
  assert.equal(extractOpenAiCodexAccountId(token("account-2")), "account-2");
  assert.throws(() => extractOpenAiCodexAccountId("not-a-token"), OpenAiCodexResponsesCodecError);
  assert.equal(
    openAiCodexResponsesUrl("https://proxy.example.test/custom?route=one"),
    "https://proxy.example.test/custom/codex/responses?route=one",
  );
  assert.throws(() => openAiCodexResponsesUrl("not a URL"), /Invalid OpenAI Codex base URL/);

  const model = codexModel();
  const sessionId = "x".repeat(70);
  const request = await prepared({ ...baseRequest, cache: { retention: "short", sessionId } });
  const encoded = encodeOpenAiCodexResponsesRequest(model, request, {
    auth: { apiKey: token() },
    source: "fixture",
    secretValues: [],
  });
  assert.equal(encoded.headers["session-id"], "x".repeat(64));
  assert.equal(encoded.headers["x-client-request-id"], "x".repeat(64));
  assert.equal(encoded.body.prompt_cache_key, "x".repeat(64));
  assert.throws(
    () =>
      encodeOpenAiCodexResponsesRequest(model, request, {
        auth: {},
        source: "fixture",
        secretValues: [],
      }),
    /requires a resolved subscription token/,
  );
});

test("replays only provenance-bound Codex continuation metadata with full stateless history", async () => {
  const model = codexModel();
  const request = await prepared(
    {
      modelId: model.modelId,
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              text: "considered",
              signature: {
                providerId: model.providerId,
                apiDialect: model.apiDialect,
                modelId: model.modelId,
                value: '{"type":"reasoning","id":"rs-1","encrypted_content":"opaque"}',
              },
            },
            {
              type: "text",
              text: "answer",
              continuation: {
                providerId: model.providerId,
                apiDialect: model.apiDialect,
                modelId: model.modelId,
                responseId: "resp-1",
                itemId: "msg-1",
              },
            },
          ],
          continuation: {
            providerId: model.providerId,
            apiDialect: model.apiDialect,
            modelId: model.modelId,
            responseId: "resp-1",
          },
        },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
    },
    model,
  );
  const encoded = encodeOpenAiCodexResponsesRequest(model, request, {
    auth: { apiKey: token() },
    source: "fixture",
    secretValues: [],
  });
  assert.equal("previous_response_id" in encoded.body, false);
  assert.deepEqual(encoded.body.input, [
    { role: "user", content: [{ type: "input_text", text: "first" }] },
    { type: "reasoning", id: "rs-1", encrypted_content: "opaque" },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      id: "msg-1",
      content: [{ type: "output_text", text: "answer", annotations: [] }],
    },
    { role: "user", content: [{ type: "input_text", text: "second" }] },
  ]);
});

test("maps Codex response.done to canonical interleaved output and exact completion", async () => {
  const events = await decode([
    { type: "codex.rate_limits", rate_limits: { allowed: true } },
    { type: "response.created", response: { id: "resp-1", model: "gpt-5.4-routed" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs-1" },
    },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "think" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs-1", encrypted_content: "opaque" },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", id: "msg-1" },
    },
    { type: "response.output_text.delta", output_index: 1, delta: "done" },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: { type: "message", id: "msg-1", phase: "final_answer" },
    },
    {
      type: "response.done",
      response: {
        id: "resp-1",
        model: "gpt-5.4-routed",
        status: "completed",
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 10 },
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
    },
    { type: "response.output_text.delta", output_index: 1, delta: "never" },
  ]);

  assert.deepEqual(
    events.map((event) => event.type),
    ["thinking_delta", "replay_metadata", "text_delta", "replay_metadata", "completed"],
  );
  assert.deepEqual(events.at(-1), {
    type: "completed",
    stopReason: "stop",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      reasoningTokens: 2,
      costUsd: 0.000021,
    },
    response: {
      providerId: "openai-codex",
      requestedModelId: "gpt-5.4",
      routedModelId: "gpt-5.4-routed",
      responseId: "resp-1",
      nativeStopReason: "completed",
    },
  });
  assert.equal(
    events.some((event) => JSON.stringify(event).includes(token())),
    false,
  );
});

test("maps Codex incomplete, provider errors, and cancellation with partial output", async () => {
  const incomplete = await decode([
    {
      type: "response.done",
      response: {
        id: "resp-short",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: {},
      },
    },
  ]);
  assert.equal(incomplete[0]?.type, "completed");
  if (incomplete[0]?.type === "completed") {
    assert.equal(incomplete[0].stopReason, "length");
    assert.equal(incomplete[0].partial, true);
  }

  const secret = "credential-fixture-value";
  const failed = await Array.fromAsync(
    decodeOpenAiCodexResponsesStream(
      frames([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg-p" },
        },
        { type: "response.output_text.delta", output_index: 0, delta: "safe" },
        { type: "error", error: { code: "server_error", message: `${secret} failed` } },
      ]),
      { model: codexModel(), request: await prepared(), secretValues: [secret] },
    ),
  );
  const failedTerminal = failed.at(-1);
  assert.equal(failedTerminal?.type, "error");
  if (failedTerminal?.type === "error") {
    assert.equal(failedTerminal.partial, true);
    assert.equal(failedTerminal.message.includes(secret), false);
  }

  const controller = new AbortController();
  const request = await prepared({ ...baseRequest, signal: controller.signal });
  async function* cancellingFrames(): AsyncGenerator<SseFrame> {
    yield {
      data: JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg-a" },
      }),
    };
    yield {
      data: JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "part" }),
    };
    controller.abort();
    yield { data: JSON.stringify({ type: "response.done", response: { status: "completed" } }) };
  }
  const aborted = await Array.fromAsync(
    decodeOpenAiCodexResponsesStream(cancellingFrames(), { model: codexModel(), request }),
  );
  assert.deepEqual(aborted.at(-1), { type: "aborted", partial: true });
});

test("fails malformed terminals and normalizes malformed or truncated streams exactly once", async () => {
  await assert.rejects(
    decode([{ type: "response.done", response: { status: "in_progress" } }]),
    /no supported terminal status/,
  );

  const malformed = await Array.fromAsync(
    normalizeModelStream(
      decodeOpenAiCodexResponsesStream(
        (async function* () {
          yield { data: "{bad json" };
        })(),
        { model: codexModel(), request: await prepared() },
      ),
    ),
  );
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0]?.type, "error");

  const truncated = await Array.fromAsync(
    normalizeModelStream(
      decodeOpenAiCodexResponsesStream(
        frames([
          { type: "vendor.future.event", detail: "ignored" },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "msg-t" },
          },
          { type: "response.output_text.delta", output_index: 0, delta: "partial" },
        ]),
        { model: codexModel(), request: await prepared() },
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
