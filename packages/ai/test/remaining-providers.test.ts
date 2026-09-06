// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createAmazonBedrockProvider,
  createAnthropicProvider,
  createAzureOpenAiResponsesProvider,
  createCloudflareAiGatewayProvider,
  createCloudflareWorkersAiProvider,
  createCustomProvider,
  createGitHubCopilotProvider,
  createGoogleProvider,
  createGoogleVertexProvider,
  createKimiCodingProvider,
  createMistralProvider,
  createOpenAiCodexProvider,
  createOpenAiProvider,
  createOpenCodeGoProvider,
  createOpenCodeProvider,
  createOpenRouterProvider,
  createRadiusProvider,
  getStaticModelCatalog,
  InMemoryCatalogStore,
  InMemoryCredentialStore,
  login,
  type ModelProvider,
  parseCustomProviderConfiguration,
  ProviderRegistry,
} from "../src/index.ts";

const ENVIRONMENT: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: "openai-secret",
  ANTHROPIC_API_KEY: "anthropic-secret",
  GEMINI_API_KEY: "google-secret",
  GOOGLE_CLOUD_API_KEY: "vertex-secret",
  MISTRAL_API_KEY: "mistral-secret",
  KIMI_API_KEY: "kimi-secret",
  OPENCODE_API_KEY: "opencode-secret",
  AZURE_OPENAI_API_KEY: "azure-secret",
  AZURE_OPENAI_RESOURCE_NAME: "sample-resource",
  CLOUDFLARE_API_KEY: "cloudflare-secret",
  CLOUDFLARE_ACCOUNT_ID: "account-one",
  CLOUDFLARE_GATEWAY_ID: "gateway-one",
  OPENROUTER_API_KEY: "openrouter-secret",
  COPILOT_GITHUB_TOKEN: "tid=test;proxy-ep=proxy.individual.githubcopilot.com;token=copilot-secret",
  RADIUS_API_KEY: "radius-secret",
  AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret",
  AWS_REGION: "us-east-1",
};

const context = {
  env: (name: string) => ENVIRONMENT[name],
  fileExists: () => Promise.resolve(false),
};

async function consume(provider: ModelProvider, modelId: string): Promise<void> {
  for await (const _event of provider.stream({ modelId, messages: [] })) {
    // Consume the complete normalized provider stream.
  }
}

test("dispatches every newly active static provider through its declared dialect endpoint", async () => {
  const requests: { providerId: string; url: string; headers: Headers }[] = [];
  const makeFetch =
    (providerId: string): typeof fetch =>
    async (input, init) => {
      requests.push({ providerId, url: String(input), headers: new Headers(init?.headers) });
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  const factories: readonly [string, (fetchImpl: typeof fetch) => ModelProvider][] = [
    [
      "openai",
      (fetchImpl) =>
        createOpenAiProvider({ store: new InMemoryCredentialStore(), context, fetch: fetchImpl }),
    ],
    [
      "anthropic",
      (fetchImpl) =>
        createAnthropicProvider({
          store: new InMemoryCredentialStore(),
          context,
          fetch: fetchImpl,
        }),
    ],
    [
      "google",
      (fetchImpl) =>
        createGoogleProvider({ store: new InMemoryCredentialStore(), context, fetch: fetchImpl }),
    ],
    [
      "google-vertex",
      (fetchImpl) =>
        createGoogleVertexProvider({
          store: new InMemoryCredentialStore(),
          context,
          fetch: fetchImpl,
        }),
    ],
    [
      "amazon-bedrock",
      (fetchImpl) =>
        createAmazonBedrockProvider({
          store: new InMemoryCredentialStore(),
          context,
          fetch: fetchImpl,
        }),
    ],
    [
      "mistral",
      (fetchImpl) =>
        createMistralProvider({ store: new InMemoryCredentialStore(), context, fetch: fetchImpl }),
    ],
    [
      "kimi-coding",
      (fetchImpl) =>
        createKimiCodingProvider({
          store: new InMemoryCredentialStore(),
          context,
          fetch: fetchImpl,
        }),
    ],
    [
      "opencode",
      (fetchImpl) =>
        createOpenCodeProvider({ store: new InMemoryCredentialStore(), context, fetch: fetchImpl }),
    ],
    [
      "opencode-go",
      (fetchImpl) =>
        createOpenCodeGoProvider({
          store: new InMemoryCredentialStore(),
          context,
          fetch: fetchImpl,
        }),
    ],
    [
      "azure-openai-responses",
      (fetchImpl) =>
        createAzureOpenAiResponsesProvider({
          store: new InMemoryCredentialStore(),
          context,
          fetch: fetchImpl,
        }),
    ],
    [
      "cloudflare-workers-ai",
      (fetchImpl) =>
        createCloudflareWorkersAiProvider({
          store: new InMemoryCredentialStore(),
          context,
          fetch: fetchImpl,
        }),
    ],
  ];

  for (const [id, factory] of factories) {
    const provider = factory(makeFetch(id));
    const models = await provider.listModels();
    const byDialect = new Map(models.map((model) => [model.apiDialect, model]));
    for (const model of byDialect.values()) await consume(provider, model.modelId);
  }

  const urls = new Map(
    requests.map((request) => [
      `${request.providerId}:${new URL(request.url).pathname.split("/").at(-1)}`,
      request,
    ]),
  );
  assert.ok(urls.has("openai:responses"));
  assert.ok(urls.has("openai:completions"));
  assert.ok(urls.has("anthropic:messages"));
  assert.ok(
    requests.some(
      (request) =>
        request.providerId === "google" && request.url.includes(":streamGenerateContent?alt=sse"),
    ),
  );
  assert.ok(
    requests.some(
      (request) =>
        request.providerId === "google-vertex" &&
        request.url.includes(":streamGenerateContent?alt=sse"),
    ),
  );
  assert.ok(
    requests.some(
      (request) =>
        request.providerId === "amazon-bedrock" &&
        request.url.includes("bedrock-runtime.us-east-1.amazonaws.com/model/"),
    ),
  );
  assert.equal(
    requests
      .find((request) => request.providerId === "amazon-bedrock")
      ?.headers.get("authorization"),
    "Bearer bedrock-secret",
  );
  assert.ok(urls.has("mistral:conversations"));
  assert.ok(urls.has("kimi-coding:completions"));
  assert.ok(urls.has("opencode:responses"));
  assert.ok(urls.has("opencode:messages"));
  assert.ok(urls.has("opencode:completions"));
  assert.ok(urls.has("azure-openai-responses:responses"));
  assert.ok(
    requests.some((request) =>
      request.url.includes("/accounts/account-one/ai/v1/chat/completions"),
    ),
  );
  assert.equal(
    requests.find((request) => request.providerId === "anthropic")?.headers.get("x-api-key"),
    "anthropic-secret",
  );
  assert.equal(
    requests
      .find((request) => request.providerId === "cloudflare-workers-ai")
      ?.headers.get("authorization"),
    "Bearer cloudflare-secret",
  );
});

test("dispatches Codex, Gateway, and image dialects through deterministic transports", async () => {
  const codexStore = new InMemoryCredentialStore();
  const codexPayload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" } }),
  ).toString("base64url");
  await login(codexStore, "openai-codex", {
    type: "oauth",
    access: `header.${codexPayload}.signature`,
    refresh: "refresh-fixture",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  let codexRequest: { url: string; headers: Headers } | undefined;
  const codex = createOpenAiCodexProvider({
    store: codexStore,
    context,
    now: () => 1_000,
    fetch: async (input, init) => {
      codexRequest = { url: String(input), headers: new Headers(init?.headers) };
      return new Response(
        'data: {"type":"response.done","response":{"id":"response-fixture","model":"gpt-5.4","status":"completed","usage":{}}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const codexModel = (await codex.listModels())[0];
  assert.ok(codexModel);
  await consume(codex, codexModel.modelId);
  assert.equal(codexModel.apiDialect, "openai-codex-responses");
  assert.match(codexRequest?.url ?? "", /\/codex\/responses$/);
  assert.equal(codexRequest?.headers.get("chatgpt-account-id"), "account-fixture");

  const radiusRequests: string[] = [];
  const radius = createRadiusProvider({
    store: new InMemoryCredentialStore(),
    context,
    baseUrl: "https://radius.pi.dev",
    fetch: async (input) => {
      const url = String(input);
      radiusRequests.push(url);
      if (url.endsWith("/v1/config")) {
        return Response.json({
          baseUrl: "https://radius.pi.dev/v1",
          models: [
            {
              id: "auto",
              name: "Auto",
              reasoning: true,
              toolUse: true,
              input: ["text"],
              cost: { input: 0, output: 0 },
              contextWindow: 128_000,
              maxTokens: 16_000,
            },
          ],
        });
      }
      return new Response(
        [
          'data: {"type":"start"}',
          'data: {"type":"text_start","contentIndex":0}',
          'data: {"type":"text_delta","contentIndex":0,"delta":"ok"}',
          'data: {"type":"text_end","contentIndex":0,"content":"ok"}',
          'data: {"type":"done","reason":"stop","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}',
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const radiusRegistry = new ProviderRegistry({ catalogStore: new InMemoryCatalogStore() });
  radiusRegistry.register(radius);
  await radiusRegistry.refresh({ providerId: "radius" });
  const radiusEvents = await Array.fromAsync(
    radiusRegistry.stream("radius", { modelId: "auto", messages: [] }),
  );
  assert.equal((await radiusRegistry.getModel("radius", "auto")).apiDialect, "gateway-messages");
  assert.equal(radiusEvents.at(-1)?.type, "completed", JSON.stringify(radiusEvents));
  assert.deepEqual(radiusRequests, [
    "https://radius.pi.dev/v1/config",
    "https://radius.pi.dev/v1/messages",
  ]);

  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const openRouterRequests: string[] = [];
  const openRouter = createOpenRouterProvider({
    store: new InMemoryCredentialStore(),
    context,
    fetch: async (input) => {
      const url = String(input);
      openRouterRequests.push(url);
      if (url.endsWith("/models")) {
        return Response.json({
          data: [
            {
              id: "image-fixture",
              name: "Image Fixture",
              architecture: { input_modalities: ["text"], output_modalities: ["image"] },
              context_length: 1_000,
              top_provider: { max_completion_tokens: 100 },
              supported_parameters: [],
            },
          ],
        });
      }
      return Response.json({
        id: "generation-fixture",
        data: [
          {
            b64_json: Buffer.from(imageBytes).toString("base64"),
            media_type: "image/png",
          },
        ],
      });
    },
  });
  const openRouterRegistry = new ProviderRegistry({ catalogStore: new InMemoryCatalogStore() });
  openRouterRegistry.register(openRouter);
  await openRouterRegistry.refresh({ providerId: "openrouter" });
  const imageModel = (await openRouterRegistry.listImageModels("openrouter"))[0];
  assert.ok(imageModel);
  assert.equal(imageModel.apiDialect, "openrouter-images");
  const imageResult = await openRouter.generateImages?.({
    modelId: imageModel.modelId,
    prompt: "deterministic fixture",
    writeBlob: async (bytes, metadata) => ({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      mediaType: metadata.mediaType,
    }),
  });
  assert.equal(imageResult?.images.length, 1);
  assert.deepEqual(openRouterRequests, [
    "https://openrouter.ai/api/v1/models",
    "https://openrouter.ai/api/v1/images",
  ]);
});

test("validates first-party custom provider configuration", () => {
  const source = getStaticModelCatalog("deepseek")[0];
  if (source === undefined) throw new Error("DeepSeek catalog is empty");
  const parsed = parseCustomProviderConfiguration({
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [{ ...source, providerId: "foreign" }],
    apiKeyEnvironmentVariables: ["CUSTOM_API_KEY"],
  });
  assert.equal(parsed.models[0]?.providerId, "custom");
  assert.throws(() =>
    parseCustomProviderConfiguration({
      baseUrl: "https://169.254.169.254/v1",
      models: [source],
    }),
  );
  assert.throws(() =>
    parseCustomProviderConfiguration({
      baseUrl: "https://example.com/v1",
      models: [source],
      apiKeyEnvironmentVariables: ["not-valid"],
    }),
  );
});

test("dispatches a keyless configured endpoint with only validated custom headers", async () => {
  const source = getStaticModelCatalog("deepseek")[0];
  if (source === undefined) throw new Error("DeepSeek catalog is empty");
  let requestUrl = "";
  let headers = new Headers();
  const provider = createCustomProvider({
    store: new InMemoryCredentialStore(),
    context,
    baseUrl: "http://127.0.0.1:11434/v1",
    headers: { "x-tenant": "local" },
    models: [{ ...source, providerId: "custom", modelId: "local-model" }],
    fetch: async (input, init) => {
      requestUrl = String(input);
      headers = new Headers(init?.headers);
      return new Response("data: [DONE]\n\n", { status: 200 });
    },
  });
  await consume(provider, "local-model");
  assert.equal(requestUrl, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(headers.get("x-tenant"), "local");
  assert.equal(headers.has("authorization"), false);
});

test("dispatches a configured Responses endpoint with explicit API key authentication", async () => {
  const source = getStaticModelCatalog("openai").find(
    (model) => model.apiDialect === "openai-responses",
  );
  if (source === undefined) throw new Error("OpenAI Responses catalog is empty");
  let requestUrl = "";
  let headers = new Headers();
  const provider = createCustomProvider({
    store: new InMemoryCredentialStore(),
    context: {
      env: (name) => (name === "CUSTOM_API_KEY" ? "custom-secret" : undefined),
      fileExists: () => Promise.resolve(false),
    },
    baseUrl: "http://127.0.0.1:11435/v1",
    headers: { "x-tenant": "configured" },
    apiKeyEnvironmentVariables: ["CUSTOM_API_KEY"],
    models: [{ ...source, providerId: "custom", modelId: "local-responses" }],
    fetch: async (input, init) => {
      requestUrl = String(input);
      headers = new Headers(init?.headers);
      return new Response(
        'data: {"type":"response.completed","response":{"id":"response-local","status":"completed","usage":{}}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const events = await Array.fromAsync(
    provider.stream({ modelId: "local-responses", messages: [] }),
  );
  assert.equal(events.at(-1)?.type, "completed", JSON.stringify(events));
  assert.equal(requestUrl, "http://127.0.0.1:11435/v1/responses");
  assert.equal(headers.get("authorization"), "Bearer custom-secret");
  assert.equal(headers.get("x-tenant"), "configured");
});

test("refreshes dynamic catalogs only when explicitly requested and keeps providers isolated", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1/config")) {
      return Response.json({
        baseUrl: "https://radius.pi.dev/v1",
        models: [
          {
            id: "auto",
            name: "Auto",
            reasoning: true,
            toolUse: true,
            input: ["text"],
            cost: { input: 0, output: 0 },
            contextWindow: 128000,
            maxTokens: 16000,
          },
        ],
      });
    }
    const data: unknown[] = [
      {
        id: "model-one",
        name: "Model One",
        apiDialect: "openai-chat",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        context_length: 128000,
        top_provider: { max_completion_tokens: 16000 },
        supported_parameters: ["tools"],
      },
    ];
    if (url.startsWith("https://openrouter.ai/"))
      data.push({
        id: "image-one",
        name: "Image One",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
        context_length: 128000,
        top_provider: { max_completion_tokens: 16000 },
        supported_parameters: [],
      });
    return Response.json({ data }, { headers: { etag: '"generation-one"' } });
  };
  const providers = [
    createOpenRouterProvider({ store: new InMemoryCredentialStore(), context, fetch: fetchImpl }),
    createGitHubCopilotProvider({
      store: new InMemoryCredentialStore(),
      context,
      fetch: fetchImpl,
    }),
    createCloudflareAiGatewayProvider({
      store: new InMemoryCredentialStore(),
      context,
      fetch: fetchImpl,
    }),
    createRadiusProvider({ store: new InMemoryCredentialStore(), context, fetch: fetchImpl }),
  ];
  const registry = new ProviderRegistry({
    catalogStore: new InMemoryCatalogStore(),
    now: () => 100,
  });
  for (const provider of providers) registry.register(provider);
  assert.equal(calls.length, 0);
  assert.equal((await registry.listModels()).models.length, 0);
  assert.equal(calls.length, 0);

  const result = await registry.refresh();
  assert.deepEqual([...result.refreshedProviderIds].sort(), [
    "cloudflare-ai-gateway",
    "github-copilot",
    "openrouter",
    "radius",
  ]);
  assert.equal(result.errors.size, 0);
  assert.equal(calls.length, 4);
  for (const provider of providers) {
    const models = (await registry.listModels({ providerId: provider.id })).models;
    assert.equal(models.length, 1, provider.id);
    assert.equal(models[0]?.providerId, provider.id);
  }
  const openrouter = providers.find((provider) => provider.id === "openrouter");
  assert.equal((await openrouter?.listImageModels?.())?.length, 1);
  assert.equal((await registry.listImageModels("openrouter")).length, 1);
});

test("dispatches a restored dynamic catalog without an implicit refresh", async () => {
  const store = new InMemoryCatalogStore();
  const first = new ProviderRegistry({ catalogStore: store, now: () => 100 });
  first.register(
    createOpenRouterProvider({
      store: new InMemoryCredentialStore(),
      context,
      fetch: async () =>
        Response.json({
          data: [
            {
              id: "restored-model",
              name: "Restored Model",
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text", "image"],
              },
              context_length: 128000,
              top_provider: { max_completion_tokens: 16000 },
              supported_parameters: ["tools"],
            },
          ],
        }),
    }),
  );
  await first.refresh({ providerId: "openrouter" });

  let requests = 0;
  const second = new ProviderRegistry({ catalogStore: store, now: () => 200 });
  second.register(
    createOpenRouterProvider({
      store: new InMemoryCredentialStore(),
      context,
      fetch: async () => {
        requests += 1;
        return new Response(
          [
            'data: {"id":"response-1","model":"restored-model","choices":[{"delta":{"content":"ok"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    }),
  );
  const restored = await second.restoreCatalogs({ providerId: "openrouter" });
  assert.deepEqual(restored.restoredProviderIds, ["openrouter"]);
  assert.equal((await second.listImageModels("openrouter")).length, 1);
  assert.equal(requests, 0);
  await consume(second.get("openrouter"), "restored-model").catch(() => undefined);
  assert.equal(requests, 0, "direct provider dispatch must not invent restored state");
  for await (const _event of second.stream("openrouter", {
    modelId: "restored-model",
    messages: [],
  })) {
    // Registry supplies the validated restored model to the provider transport.
  }
  assert.equal(requests, 1);
});

test("rejects unsafe custom endpoints and secret-shaped headers before dispatch", () => {
  const source = getStaticModelCatalog("deepseek")[0];
  assert.ok(source);
  for (const baseUrl of [
    "http://example.com/v1",
    "https://169.254.169.254/latest",
    "https://10.0.0.1/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1#fragment",
  ]) {
    assert.throws(() =>
      createCustomProvider({
        store: new InMemoryCredentialStore(),
        context,
        baseUrl,
        models: [{ ...source, providerId: "custom", modelId: "unsafe" }],
      }),
    );
  }
  for (const name of [
    "Authorization",
    "Cookie",
    "Proxy-Authorization",
    "X-Api-Key",
    "x-service-token",
  ]) {
    assert.throws(() =>
      createCustomProvider({
        store: new InMemoryCredentialStore(),
        context,
        baseUrl: "https://example.com/v1",
        headers: { [name]: "caller-secret" },
        models: [{ ...source, providerId: "custom", modelId: "unsafe" }],
      }),
    );
  }
});

test("rejects dynamic endpoint origin changes before persistence or dispatch", async () => {
  const store = new InMemoryCatalogStore();
  const requests: string[] = [];
  const provider = createRadiusProvider({
    store: new InMemoryCredentialStore(),
    context,
    fetch: async (input) => {
      requests.push(String(input));
      return Response.json({
        baseUrl: "http://169.254.169.254/latest",
        models: [
          {
            id: "unsafe",
            name: "Unsafe",
            reasoning: false,
            toolUse: false,
            input: ["text"],
            contextWindow: 1_000,
            maxTokens: 100,
          },
        ],
      });
    },
  });
  const registry = new ProviderRegistry({ catalogStore: store });
  registry.register(provider);
  const refreshed = await registry.refresh({ providerId: "radius" });
  assert.equal(refreshed.refreshedProviderIds.length, 0);
  assert.match(refreshed.errors.get("radius")?.message ?? "", /HTTPS|origin|disallowed/);
  assert.deepEqual(requests, ["https://radius.pi.dev/v1/config"]);
  assert.equal(await store.read("radius"), undefined);
});

test("rejects incomplete dynamic rows instead of guessing compatibility", async () => {
  const factories = [
    () =>
      createOpenRouterProvider({
        store: new InMemoryCredentialStore(),
        context,
        fetch: async () => Response.json({ data: [{ id: "x", name: "X" }] }),
      }),
    () =>
      createGitHubCopilotProvider({
        store: new InMemoryCredentialStore(),
        context,
        fetch: async () => Response.json({ data: [{ id: "x", name: "X" }] }),
      }),
    () =>
      createCloudflareAiGatewayProvider({
        store: new InMemoryCredentialStore(),
        context,
        fetch: async () => Response.json({ data: [{ id: "x", name: "X" }] }),
      }),
    () =>
      createRadiusProvider({
        store: new InMemoryCredentialStore(),
        context,
        fetch: async () =>
          Response.json({ baseUrl: "https://radius.pi.dev/v1", models: [{ id: "x", name: "X" }] }),
      }),
  ];
  for (const factory of factories) {
    const provider = factory();
    const registry = new ProviderRegistry();
    registry.register(provider);
    const result = await registry.refresh({ providerId: provider.id });
    assert.equal(result.refreshedProviderIds.length, 0, provider.id);
    assert.ok(result.errors.has(provider.id), provider.id);
  }
});

test("rejects dynamic model counts above the publication limit", async () => {
  const row = {
    id: "model",
    name: "Model",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    context_length: 1_000,
    top_provider: { max_completion_tokens: 100 },
    supported_parameters: [],
  };
  const provider = createOpenRouterProvider({
    store: new InMemoryCredentialStore(),
    context,
    fetch: async () => Response.json({ data: Array.from({ length: 10_001 }, () => row) }),
  });
  const registry = new ProviderRegistry();
  registry.register(provider);
  const result = await registry.refresh({ providerId: "openrouter" });
  assert.equal(result.refreshedProviderIds.length, 0);
  assert.match(result.errors.get("openrouter")?.message ?? "", /bounded model array/);
});

test("revalidates restored dynamic origins before credentialed dispatch", async () => {
  const source = getStaticModelCatalog("deepseek")[0];
  assert.ok(source);
  const store = new InMemoryCatalogStore();
  await store.write("openrouter", {
    version: 1,
    providerId: "openrouter",
    generation: 1,
    checkedAt: 1,
    updatedAt: 1,
    source: { id: "openrouter-models", kind: "provider_api" },
    models: [
      {
        ...source,
        providerId: "openrouter",
        modelId: "restored-foreign-origin",
        endpoint: { type: "fixed", baseUrl: "https://attacker.example/v1" },
      },
    ],
  });
  let fetches = 0;
  const provider = createOpenRouterProvider({
    store: new InMemoryCredentialStore(),
    context,
    fetch: async () => {
      fetches += 1;
      throw new Error("must not dispatch");
    },
  });
  const registry = new ProviderRegistry({ catalogStore: store });
  registry.register(provider);
  await registry.restoreCatalogs({ providerId: "openrouter" });
  const events = await Array.fromAsync(
    registry.stream("openrouter", { modelId: "restored-foreign-origin", messages: [] }),
  );
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(fetches, 0);
});

test("uses distinct Anthropic environment authentication headers", async () => {
  for (const [name, expected] of [
    ["ANTHROPIC_API_KEY", { apiKey: "fixture", authorization: null }],
    ["ANTHROPIC_OAUTH_TOKEN", { apiKey: null, authorization: "Bearer fixture" }],
  ] as const) {
    let headers = new Headers();
    const provider = createAnthropicProvider({
      store: new InMemoryCredentialStore(),
      context: {
        env: (key) => (key === name ? "fixture" : undefined),
        fileExists: () => Promise.resolve(false),
      },
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        return new Response('data: {"type":"message_stop"}\n\n', { status: 200 });
      },
    });
    const model = (await provider.listModels())[0];
    assert.ok(model);
    await consume(provider, model.modelId);
    assert.equal(headers.get("x-api-key"), expected.apiKey);
    assert.equal(headers.get("authorization"), expected.authorization);
    if (name === "ANTHROPIC_OAUTH_TOKEN")
      assert.match(headers.get("anthropic-beta") ?? "", /oauth/);
  }
});

test("times out non-cancellable image transport without retrying", async () => {
  let imageFetches = 0;
  const provider = createOpenRouterProvider({
    store: new InMemoryCredentialStore(),
    context,
    fetch: async (input) => {
      if (String(input).endsWith("/models")) {
        return Response.json({
          data: [
            {
              id: "image-timeout",
              name: "Image timeout",
              architecture: { input_modalities: ["text"], output_modalities: ["image"] },
              context_length: 1_000,
              top_provider: { max_completion_tokens: 100 },
              supported_parameters: [],
            },
          ],
        });
      }
      imageFetches += 1;
      return new Promise<Response>(() => undefined);
    },
  });
  const registry = new ProviderRegistry();
  registry.register(provider);
  await registry.refresh({ providerId: "openrouter" });
  assert.ok(provider.generateImages);
  const guard = setTimeout(() => undefined, 100);
  try {
    await assert.rejects(
      provider.generateImages({
        modelId: "image-timeout",
        prompt: "fixture",
        timeoutMs: 1,
        maxRetries: 0,
        writeBlob: async () => {
          throw new Error("not reached");
        },
      }),
      { name: "TimeoutError" },
    );
  } finally {
    clearTimeout(guard);
  }
  assert.equal(imageFetches, 1);
});
