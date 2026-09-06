// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
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
  createOpenAiProvider,
  createOpenCodeGoProvider,
  createOpenCodeProvider,
  createOpenRouterProvider,
  createRadiusProvider,
  getStaticModelCatalog,
  InMemoryCatalogStore,
  InMemoryCredentialStore,
  ProviderRegistry,
  type ModelProvider,
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
  COPILOT_GITHUB_TOKEN: "copilot-secret",
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

test("refreshes dynamic catalogs only when explicitly requested and keeps providers isolated", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1/config")) {
      return Response.json({
        baseUrl: "https://radius.example/v1",
        models: [
          {
            id: "auto",
            name: "Auto",
            reasoning: true,
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
