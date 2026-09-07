// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type AuthContext,
  AuthError,
  AZURE_OPENAI_MODELS,
  azureOpenAiAuthMethod,
  clampThinkingLevel,
  collectModelStream,
  createAzureOpenAiProvider,
  encodeAzureOpenAiResponsesRequest,
  FakeModelProvider,
  getStaticModelCatalog,
  InMemoryCredentialStore,
  login,
  type ModelStreamEvent,
  makeFakeModelInfo,
  normalizeAzureBaseUrl,
  parseDeploymentMap,
  prepareModelRequest,
  THINKING_LEVELS,
} from "../src/index.ts";

const usage = { inputTokens: 20, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 };

function makeContext(env: Record<string, string> = {}): AuthContext {
  return { env: (name) => env[name], fileExists: () => Promise.resolve(false) };
}

function sseBody(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

const transcript = [
  { type: "response.reasoning_text.delta", delta: "hmm" },
  { type: "response.output_text.delta", delta: "Hello" },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", call_id: "call-1", name: "shell" },
  },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command":"ls"}' },
  { type: "response.output_item.done", output_index: 0, item: { type: "function_call" } },
  {
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        input_tokens_details: { cached_tokens: 100 },
      },
    },
  },
];

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function makeFakeFetch(events: readonly unknown[]): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(sseBody(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, requests };
}

async function makeProvider(events: readonly unknown[], env: Record<string, string>) {
  const store = new InMemoryCredentialStore();
  await login(store, "azure-openai", { type: "api_key", key: "azure-secret-key" });
  const { fetch, requests } = makeFakeFetch(events);
  const provider = createAzureOpenAiProvider({ store, context: makeContext(env), fetch });
  return { provider, requests };
}

test("normalizes Azure base URLs and passes gateways through", () => {
  assert.equal(
    normalizeAzureBaseUrl("https://myres.openai.azure.com"),
    "https://myres.openai.azure.com/openai/v1",
  );
  assert.equal(
    normalizeAzureBaseUrl("https://myres.cognitiveservices.azure.com/openai/"),
    "https://myres.cognitiveservices.azure.com/openai/v1",
  );
  assert.equal(
    normalizeAzureBaseUrl("https://myres.openai.azure.com/openai/v1/responses"),
    "https://myres.openai.azure.com/openai/v1",
  );
  assert.equal(
    normalizeAzureBaseUrl("https://gateway.example.com/azure/"),
    "https://gateway.example.com/azure",
  );
  assert.equal(
    normalizeAzureBaseUrl(`https://gateway.example.com/azure${"/".repeat(10_000)}`),
    "https://gateway.example.com/azure",
  );
  assert.throws(() => normalizeAzureBaseUrl("not a url"), AuthError);
});

test("exported Azure settings override values saved by interactive login", async () => {
  const resolved = await azureOpenAiAuthMethod.resolve({
    context: makeContext({
      AZURE_OPENAI_BASE_URL: "https://exported.openai.azure.com",
      AZURE_OPENAI_API_VERSION: "2026-01-01",
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=exported",
    }),
    credential: {
      type: "api_key",
      key: "stored-key",
      env: {
        AZURE_OPENAI_BASE_URL: "https://stored.openai.azure.com",
        AZURE_OPENAI_API_VERSION: "2025-01-01",
        AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=stored",
      },
    },
    signal: new AbortController().signal,
  });

  assert.equal(resolved?.auth.apiKey, "stored-key");
  assert.deepEqual(resolved?.env, {
    AZURE_OPENAI_BASE_URL: "https://exported.openai.azure.com/openai/v1",
    AZURE_OPENAI_API_VERSION: "2026-01-01",
    AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=exported",
  });
});

test("parses the model-to-deployment map format", () => {
  assert.deepEqual(parseDeploymentMap("gpt-5=gpt-5.6-sol, gpt-4o = prod-4o"), {
    "gpt-5": "gpt-5.6-sol",
    "gpt-4o": "prod-4o",
  });
  assert.deepEqual(parseDeploymentMap(undefined), {});
  assert.deepEqual(parseDeploymentMap("malformed,also=ok"), { also: "ok" });
});

test("composes a prepared Azure request with deployment, headers, and API version", async () => {
  const model = AZURE_OPENAI_MODELS.find((candidate) => candidate.modelId === "gpt-5");
  assert.ok(model);
  const request = await prepareModelRequest(model, {
    modelId: "gpt-5",
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
    toolChoice: "required",
    thinkingLevel: "xhigh",
    maxOutputTokens: 8,
  });
  const encoded = encodeAzureOpenAiResponsesRequest(model, request, {
    auth: { apiKey: "fixture-key", headers: { "x-azure-client": "fixture" } },
    source: "fixture",
    env: {
      AZURE_OPENAI_BASE_URL: "https://fixture.services.ai.azure.com/openai/v1/responses",
      AZURE_OPENAI_API_VERSION: "2026-01-01-preview",
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=production-gpt-5",
    },
    secretValues: ["fixture-key"],
  });

  assert.equal(
    encoded.url,
    "https://fixture.services.ai.azure.com/openai/v1/responses?api-version=2026-01-01-preview",
  );
  assert.deepEqual(encoded.headers, {
    "api-key": "fixture-key",
    "x-azure-client": "fixture",
  });
  assert.deepEqual(encoded.body, {
    model: "production-gpt-5",
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
        strict: false,
      },
    ],
    tool_choice: "required",
    reasoning: { effort: "high", summary: "auto" },
    include: ["reasoning.encrypted_content"],
  });
});

test("preserves proxy query settings while adding the Azure API version", async () => {
  const { provider, requests } = await makeProvider(transcript, {
    AZURE_OPENAI_BASE_URL: "https://gateway.example.com/azure?route=primary",
    AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
  });
  await collectModelStream(provider.stream({ modelId: "gpt-5", messages: [] }));
  assert.equal(
    requests[0]?.url,
    "https://gateway.example.com/azure/responses?route=primary&api-version=2025-04-01-preview",
  );
});

test("streams from Azure with api-key header, versioned URL, and mapped deployment", async () => {
  const { provider, requests } = await makeProvider(transcript, {
    AZURE_OPENAI_RESOURCE_NAME: "myres",
    AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5=gpt-5.6-sol",
  });

  const { events, terminal } = await collectModelStream(
    provider.stream({
      modelId: "gpt-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinkingLevel: "xhigh",
    }),
  );

  const request = requests[0];
  assert.equal(request?.url, "https://myres.openai.azure.com/openai/v1/responses?api-version=v1");
  assert.equal(request?.headers["api-key"], "azure-secret-key");
  assert.equal(request?.body.model, "gpt-5.6-sol");
  assert.deepEqual(request?.body.reasoning, { effort: "high", summary: "auto" });

  assert.equal(events.length, 6);
  assert.equal(terminal.type, "completed");
  if (terminal.type === "completed") {
    assert.equal(terminal.stopReason, "tool_use");
    assert.deepEqual(terminal.usage, { ...usage, reasoningTokens: 0 });
  }
});

test("retains Azure-specific replay provenance from the shared Responses stream", async () => {
  const { provider } = await makeProvider(
    [
      { type: "response.created", response: { id: "resp-azure" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs-azure" },
      },
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "think" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs-azure",
          encrypted_content: "opaque-azure",
          summary: [],
        },
      },
      {
        type: "response.completed",
        response: { id: "resp-azure", status: "completed", usage: {} },
      },
    ],
    { AZURE_OPENAI_RESOURCE_NAME: "myres" },
  );
  const { events } = await collectModelStream(provider.stream({ modelId: "gpt-5", messages: [] }));
  assert.deepEqual(events[1], {
    type: "replay_metadata",
    target: "thinking",
    contentIndex: 0,
    providerId: "azure-openai",
    apiDialect: "azure-openai-responses",
    modelId: "gpt-5",
    signature:
      '{"type":"reasoning","id":"rs-azure","encrypted_content":"opaque-azure","summary":[]}',
    responseId: "resp-azure",
    itemId: "rs-azure",
  });
  assert.equal(events.at(-1)?.type, "completed");
});

test("exit gate: Azure and the fake provider produce identical canonical stream shapes", async () => {
  const canonical: readonly ModelStreamEvent[] = [
    { type: "thinking_delta", text: "hmm" },
    { type: "text_delta", text: "Hello" },
    { type: "tool_call_start", contentIndex: 0, callId: "call-1", name: "shell" },
    {
      type: "tool_call_delta",
      contentIndex: 0,
      callId: "call-1",
      argumentsDelta: '{"command":"ls"}',
    },
    {
      type: "tool_call",
      contentIndex: 0,
      callId: "call-1",
      name: "shell",
      input: { command: "ls" },
    },
    {
      type: "completed",
      stopReason: "tool_use",
      usage: { ...usage, reasoningTokens: 0 },
      response: { providerId: "azure-openai", requestedModelId: "gpt-5" },
    },
  ];
  const fake = new FakeModelProvider({
    models: [makeFakeModelInfo({ modelId: "gpt-5" })],
    responses: [canonical],
  });
  const { provider: azure } = await makeProvider(transcript, {
    AZURE_OPENAI_RESOURCE_NAME: "myres",
  });

  const request = {
    modelId: "gpt-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  } as const;
  const fromFake = await collectModelStream(fake.stream(request));
  const fromAzure = await collectModelStream(azure.stream(request));
  assert.deepEqual(fromAzure.events, fromFake.events);
});

test("capability mismatches fail before any request is dispatched", async () => {
  const { provider, requests } = await makeProvider(transcript, {
    AZURE_OPENAI_RESOURCE_NAME: "myres",
  });
  const models = await provider.listModels();
  assert.equal(
    models.some((model) => model.modelId === "gpt-5"),
    true,
  );

  assert.throws(() => provider.stream({ modelId: "unknown-model", messages: [] }), /no model/);
  assert.equal(requests.length, 0);
});

test("HTTP failures terminate through the stream contract without leaking the key", async () => {
  const store = new InMemoryCredentialStore();
  await login(store, "azure-openai", { type: "api_key", key: "azure-secret-key" });
  const failingFetch = (async () =>
    new Response('{"error":{"message":"azure-secret-key deployment not found"}}', {
      status: 404,
    })) as typeof fetch;
  const provider = createAzureOpenAiProvider({
    store,
    context: makeContext({ AZURE_OPENAI_RESOURCE_NAME: "myres" }),
    fetch: failingFetch,
  });

  const { terminal } = await collectModelStream(
    provider.stream({ modelId: "gpt-5", messages: [] }),
  );
  assert.equal(terminal.type, "error");
  if (terminal.type === "error") {
    assert.equal(terminal.code, "http_404");
    assert.equal(terminal.retryable, false);
    assert.equal(terminal.message, "Provider azure-openai returned 404");
    assert.equal(terminal.message.includes("azure-secret-key"), false);
  }
});

test("cancellation terminates cleanly with an aborted terminal", async () => {
  const controller = new AbortController();
  const store = new InMemoryCredentialStore();
  await login(store, "azure-openai", { type: "api_key", key: "azure-secret-key" });
  const abortingFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    controller.abort();
    (init?.signal as AbortSignal).throwIfAborted();
    throw new Error("unreachable");
  }) as typeof fetch;
  const provider = createAzureOpenAiProvider({
    store,
    context: makeContext({ AZURE_OPENAI_RESOURCE_NAME: "myres" }),
    fetch: abortingFetch,
  });

  const { terminal } = await collectModelStream(
    provider.stream({ modelId: "gpt-5", messages: [], signal: controller.signal }),
    controller.signal,
  );
  assert.deepEqual(terminal, { type: "aborted" });
});

test("missing configuration surfaces a typed auth state through the stream", async () => {
  const provider = createAzureOpenAiProvider({
    store: new InMemoryCredentialStore(),
    context: makeContext({}),
    fetch: (async () => new Response("")) as typeof fetch,
  });
  assert.deepEqual(provider.authentication?.methods, ["environment", "file"]);
  const { terminal } = await collectModelStream(
    provider.stream({ modelId: "gpt-5", messages: [] }),
  );
  assert.equal(terminal.type, "error");
  if (terminal.type === "error") {
    assert.equal(/not configured/.test(terminal.message), true);
    assert.equal(terminal.retryable, false);
    assert.equal(terminal.category, "authentication");
    assert.equal(terminal.requestPhase, "before_dispatch");
  }
});

test("publishes the complete built-in Azure OpenAI model catalog", async () => {
  const { AZURE_OPENAI_MODELS } = await import("../src/index.ts");
  assert.deepEqual(
    AZURE_OPENAI_MODELS.map((model) => model.modelId),
    [
      "gpt-4",
      "gpt-4-turbo",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-2024-05-13",
      "gpt-4o-2024-08-06",
      "gpt-4o-2024-11-20",
      "gpt-4o-mini",
      "gpt-5",
      "gpt-5-chat-latest",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-5-pro",
      "gpt-5.1",
      "gpt-5.2",
      "gpt-5.2-chat-latest",
      "gpt-5.2-pro",
      "gpt-5.3-chat-latest",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.4-pro",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-realtime-2.1",
      "o1",
      "o1-pro",
      "o3",
      "o3-mini",
      "o3-pro",
      "o4-mini",
    ],
  );
  assert.equal(new Set(AZURE_OPENAI_MODELS.map((model) => model.modelId)).size, 38);
  assert.equal(
    AZURE_OPENAI_MODELS.every(
      (model) =>
        model.providerId === "azure-openai" && model.apiDialect === "azure-openai-responses",
    ),
    true,
  );
  assert.equal(
    AZURE_OPENAI_MODELS.find((model) => model.modelId === "gpt-4")?.capabilities.imageInput,
    false,
  );
  assert.deepEqual(
    AZURE_OPENAI_MODELS.find((model) => model.modelId === "gpt-5.6-sol")?.thinkingLevelMap,
    { off: null, xhigh: "xhigh", max: "max" },
  );
});

test("every generated Azure model encodes its declared reasoning map", async () => {
  const models = getStaticModelCatalog("azure-openai-responses");
  for (const model of models) {
    for (const requested of THINKING_LEVELS) {
      const prepared = await prepareModelRequest(model, {
        modelId: model.modelId,
        messages: [],
        thinkingLevel: requested,
      });
      const encoded = encodeAzureOpenAiResponsesRequest(model, prepared, {
        auth: { apiKey: "obviously-fake-key" },
        env: { AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1" },
        source: "test",
        secretValues: ["obviously-fake-key"],
      });
      const clamp = clampThinkingLevel(model, requested);
      assert.equal(prepared.thinkingLevel, clamp.effective);
      if (clamp.effective === "off") {
        assert.equal(encoded.body.reasoning, undefined, `${model.modelId}/${requested}`);
      } else {
        assert.deepEqual(
          encoded.body.reasoning,
          { effort: model.thinkingLevelMap?.[clamp.effective] ?? clamp.effective, summary: "auto" },
          `${model.modelId}/${requested}`,
        );
      }
      if (!model.reasoning) assert.equal(clamp.effective, "off");
    }
  }
});
