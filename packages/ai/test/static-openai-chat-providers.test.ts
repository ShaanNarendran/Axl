// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ANT_LING_BASE_URL,
  BASETEN_BASE_URL,
  CEREBRAS_BASE_URL,
  collectModelStream,
  createAntLingProvider,
  createBasetenProvider,
  createCerebrasProvider,
  createFireworksProvider,
  createGroqProvider,
  createHuggingFaceProvider,
  createMiniMaxCnProvider,
  createMiniMaxProvider,
  createMoonshotAiCnProvider,
  createMoonshotAiProvider,
  createNvidiaProvider,
  createQwenTokenPlanCnProvider,
  createQwenTokenPlanIndividualProvider,
  createQwenTokenPlanProvider,
  createStaticOpenAiChatProvider,
  createTogetherProvider,
  createVercelAiGatewayProvider,
  createXaiProvider,
  createXiaomiProvider,
  createXiaomiTokenPlanAmsProvider,
  createXiaomiTokenPlanCnProvider,
  createXiaomiTokenPlanSgpProvider,
  createZaiCodingCnProvider,
  createZaiProvider,
  FIREWORKS_BASE_URL,
  GROQ_BASE_URL,
  getStaticModelCatalog,
  HUGGINGFACE_BASE_URL,
  InMemoryCredentialStore,
  listBuiltinCatalogProviders,
  MINIMAX_BASE_URL,
  MINIMAX_CN_BASE_URL,
  MOONSHOTAI_BASE_URL,
  MOONSHOTAI_CN_BASE_URL,
  NVIDIA_BASE_URL,
  ProviderRegistry,
  QWEN_TOKEN_PLAN_BASE_URL,
  QWEN_TOKEN_PLAN_CN_BASE_URL,
  QWEN_TOKEN_PLAN_INDIVIDUAL_BASE_URL,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
  TOGETHER_BASE_URL,
  VERCEL_AI_GATEWAY_BASE_URL,
  XAI_BASE_URL,
  XIAOMI_BASE_URL,
  XIAOMI_TOKEN_PLAN_AMS_BASE_URL,
  XIAOMI_TOKEN_PLAN_CN_BASE_URL,
  XIAOMI_TOKEN_PLAN_SGP_BASE_URL,
  ZAI_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
} from "../src/index.ts";

interface ProviderCase {
  readonly id: string;
  readonly displayName: string;
  readonly environmentVariable: string;
  readonly baseUrl: string;
  readonly expectedModels: number;
  readonly region?: string;
  readonly regionFamily?: string;
  readonly create: (
    options: StaticOpenAiChatProviderOptions,
  ) => ReturnType<typeof createStaticOpenAiChatProvider>;
}

const PROVIDERS: readonly ProviderCase[] = [
  {
    id: "groq",
    displayName: "Groq",
    environmentVariable: "GROQ_API_KEY",
    baseUrl: GROQ_BASE_URL,
    expectedModels: 7,
    create: createGroqProvider,
  },
  {
    id: "cerebras",
    displayName: "Cerebras",
    environmentVariable: "CEREBRAS_API_KEY",
    baseUrl: CEREBRAS_BASE_URL,
    expectedModels: 2,
    create: createCerebrasProvider,
  },
  {
    id: "nvidia",
    displayName: "NVIDIA NIM",
    environmentVariable: "NVIDIA_API_KEY",
    baseUrl: NVIDIA_BASE_URL,
    expectedModels: 64,
    create: createNvidiaProvider,
  },
  {
    id: "baseten",
    displayName: "Baseten",
    environmentVariable: "BASETEN_API_KEY",
    baseUrl: BASETEN_BASE_URL,
    expectedModels: 22,
    create: createBasetenProvider,
  },
  {
    id: "huggingface",
    displayName: "Hugging Face",
    environmentVariable: "HF_TOKEN",
    baseUrl: HUGGINGFACE_BASE_URL,
    expectedModels: 70,
    create: createHuggingFaceProvider,
  },
  {
    id: "zai",
    displayName: "Z.AI",
    environmentVariable: "ZAI_API_KEY",
    baseUrl: ZAI_BASE_URL,
    expectedModels: 16,
    region: "global",
    regionFamily: "zai",
    create: createZaiProvider,
  },
  {
    id: "zai-coding-cn",
    displayName: "Z.AI Coding China",
    environmentVariable: "ZAI_CODING_CN_API_KEY",
    baseUrl: ZAI_CODING_CN_BASE_URL,
    expectedModels: 10,
    region: "cn",
    regionFamily: "zai",
    create: createZaiCodingCnProvider,
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    environmentVariable: "MINIMAX_API_KEY",
    baseUrl: MINIMAX_BASE_URL,
    expectedModels: 7,
    region: "global",
    regionFamily: "minimax",
    create: createMiniMaxProvider,
  },
  {
    id: "minimax-cn",
    displayName: "MiniMax China",
    environmentVariable: "MINIMAX_CN_API_KEY",
    baseUrl: MINIMAX_CN_BASE_URL,
    expectedModels: 7,
    region: "cn",
    regionFamily: "minimax",
    create: createMiniMaxCnProvider,
  },
  {
    id: "moonshotai",
    displayName: "Moonshot AI",
    environmentVariable: "MOONSHOT_API_KEY",
    baseUrl: MOONSHOTAI_BASE_URL,
    expectedModels: 10,
    region: "global",
    regionFamily: "moonshotai",
    create: createMoonshotAiProvider,
  },
  {
    id: "moonshotai-cn",
    displayName: "Moonshot AI China",
    environmentVariable: "MOONSHOT_API_KEY",
    baseUrl: MOONSHOTAI_CN_BASE_URL,
    expectedModels: 10,
    region: "cn",
    regionFamily: "moonshotai",
    create: createMoonshotAiCnProvider,
  },
  {
    id: "qwen-token-plan",
    displayName: "Qwen Token Plan",
    environmentVariable: "QWEN_TOKEN_PLAN_API_KEY",
    baseUrl: QWEN_TOKEN_PLAN_BASE_URL,
    expectedModels: 19,
    region: "sgp",
    regionFamily: "qwen-token-plan",
    create: createQwenTokenPlanProvider,
  },
  {
    id: "qwen-token-plan-cn",
    displayName: "Qwen Token Plan China",
    environmentVariable: "QWEN_TOKEN_PLAN_CN_API_KEY",
    baseUrl: QWEN_TOKEN_PLAN_CN_BASE_URL,
    expectedModels: 19,
    region: "cn",
    regionFamily: "qwen-token-plan",
    create: createQwenTokenPlanCnProvider,
  },
  {
    id: "vercel-ai-gateway",
    displayName: "Vercel AI Gateway",
    environmentVariable: "AI_GATEWAY_API_KEY",
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    expectedModels: 229,
    create: createVercelAiGatewayProvider,
  },
  {
    id: "fireworks",
    displayName: "Fireworks AI",
    environmentVariable: "FIREWORKS_API_KEY",
    baseUrl: FIREWORKS_BASE_URL,
    expectedModels: 20,
    create: createFireworksProvider,
  },
  {
    id: "together",
    displayName: "Together AI",
    environmentVariable: "TOGETHER_API_KEY",
    baseUrl: TOGETHER_BASE_URL,
    expectedModels: 32,
    create: createTogetherProvider,
  },
  {
    id: "qwen-token-plan-individual",
    displayName: "Qwen Token Plan Individual",
    environmentVariable: "QWEN_TOKEN_PLAN_API_KEY",
    baseUrl: QWEN_TOKEN_PLAN_INDIVIDUAL_BASE_URL,
    expectedModels: 19,
    create: createQwenTokenPlanIndividualProvider,
  },
  {
    id: "xiaomi",
    displayName: "Xiaomi MiMo",
    environmentVariable: "XIAOMI_API_KEY",
    baseUrl: XIAOMI_BASE_URL,
    expectedModels: 6,
    region: "global",
    regionFamily: "xiaomi",
    create: createXiaomiProvider,
  },
  {
    id: "xiaomi-token-plan-cn",
    displayName: "Xiaomi Token Plan China",
    environmentVariable: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    baseUrl: XIAOMI_TOKEN_PLAN_CN_BASE_URL,
    expectedModels: 3,
    region: "cn",
    regionFamily: "xiaomi",
    create: createXiaomiTokenPlanCnProvider,
  },
  {
    id: "xiaomi-token-plan-ams",
    displayName: "Xiaomi Token Plan Amsterdam",
    environmentVariable: "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    baseUrl: XIAOMI_TOKEN_PLAN_AMS_BASE_URL,
    expectedModels: 3,
    region: "ams",
    regionFamily: "xiaomi",
    create: createXiaomiTokenPlanAmsProvider,
  },
  {
    id: "xiaomi-token-plan-sgp",
    displayName: "Xiaomi Token Plan Singapore",
    environmentVariable: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
    baseUrl: XIAOMI_TOKEN_PLAN_SGP_BASE_URL,
    expectedModels: 3,
    region: "sgp",
    regionFamily: "xiaomi",
    create: createXiaomiTokenPlanSgpProvider,
  },
  {
    id: "ant-ling",
    displayName: "Ant Ling",
    environmentVariable: "ANT_LING_API_KEY",
    baseUrl: ANT_LING_BASE_URL,
    expectedModels: 4,
    create: createAntLingProvider,
  },
  {
    id: "xai",
    displayName: "xAI",
    environmentVariable: "XAI_API_KEY",
    baseUrl: XAI_BASE_URL,
    expectedModels: 6,
    create: createXaiProvider,
  },
];

function context(environment: Readonly<Record<string, string>> = {}) {
  return {
    env: (name: string) => environment[name],
    fileExists: () => Promise.resolve(false),
  };
}

function streamResponse(modelId: string): Response {
  const body = [
    { id: "response-1", model: modelId, choices: [{ delta: { content: "ok" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ]
    .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("constructs and lists static Chat providers without credential or network work", async () => {
  for (const providerCase of PROVIDERS) {
    let environmentReads = 0;
    let fetches = 0;
    const provider = providerCase.create({
      store: new InMemoryCredentialStore(),
      context: {
        env: () => {
          environmentReads += 1;
          return undefined;
        },
        fileExists: () => Promise.resolve(false),
      },
      fetch: async () => {
        fetches += 1;
        throw new Error("unexpected network request");
      },
    });

    const models = await provider.listModels();
    assert.equal(provider.id, providerCase.id);
    assert.equal(provider.displayName, providerCase.displayName);
    assert.deepEqual(provider.authMethods, ["environment", "file"]);
    const catalogProvider = listBuiltinCatalogProviders().find(
      (candidate) => candidate.id === providerCase.id,
    );
    assert.equal(catalogProvider?.catalogKind, "static");
    assert.equal(catalogProvider?.region, providerCase.region);
    assert.equal(catalogProvider?.regionFamily, providerCase.regionFamily);
    assert.equal("refreshModels" in provider, false);
    assert.equal(models.length, providerCase.expectedModels);
    assert.equal(
      models.every((model) => model.providerId === providerCase.id),
      true,
    );
    assert.equal(
      models.every((model) => model.apiDialect === "openai-chat"),
      true,
    );
    assert.equal(
      models.every(
        (model) =>
          model.endpoint?.type === "fixed" && model.endpoint.baseUrl === providerCase.baseUrl,
      ),
      true,
    );
    assert.equal(environmentReads, 0);
    assert.equal(fetches, 0);
  }
});

test("resolves each provider environment key through provider-owned authentication", async () => {
  for (const providerCase of PROVIDERS) {
    const provider = providerCase.create({
      store: new InMemoryCredentialStore(),
      context: context({ [providerCase.environmentVariable]: `${providerCase.id}-secret` }),
    });
    const authentication = provider.authentication;
    if (authentication === undefined) throw new Error(`${providerCase.id} authentication missing`);

    assert.deepEqual(await authentication.resolve(), {
      auth: { apiKey: `${providerCase.id}-secret` },
      source: providerCase.environmentVariable,
      secretValues: [`${providerCase.id}-secret`],
    });
  }
});

test("registers and dispatches every provider through the shared Chat transport", async () => {
  for (const providerCase of PROVIDERS) {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const models = getStaticModelCatalog(providerCase.id);
    const model = models[0];
    if (model === undefined) throw new Error(`${providerCase.id} catalog is empty`);
    const provider = providerCase.create({
      store: new InMemoryCredentialStore(),
      context: context({ [providerCase.environmentVariable]: `${providerCase.id}-secret` }),
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return streamResponse(model.modelId);
      },
      now: () => 100,
    });
    const registry = new ProviderRegistry();
    registry.register(provider);

    const result = await collectModelStream(
      registry.stream(providerCase.id, { modelId: model.modelId, messages: [] }),
    );

    assert.equal(requestUrl, `${providerCase.baseUrl}/chat/completions`);
    assert.equal(
      new Headers(requestInit?.headers).get("authorization"),
      `Bearer ${providerCase.id}-secret`,
    );
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      model: model.modelId,
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.deepEqual(result.events[0], { type: "text_delta", text: "ok", contentIndex: 0 });
    assert.equal(result.terminal.type, "completed");
    assert.equal(result.terminal.response?.providerId, providerCase.id);
    assert.equal(result.terminal.response?.requestedModelId, model.modelId);
  }
});

test("rejects empty, foreign, wrong-dialect, unsafe-header, and mismatched catalogs", () => {
  const definition: StaticOpenAiChatProviderDefinition = {
    id: "strict-provider",
    displayName: "Strict Provider",
    apiKeyDisplayName: "Strict Provider API key",
    environmentVariables: ["STRICT_PROVIDER_API_KEY"],
    baseUrl: "https://strict.example/v1",
  };
  const source = getStaticModelCatalog("groq")[0];
  if (source === undefined) throw new Error("Groq catalog is empty");
  const valid = {
    ...source,
    providerId: definition.id,
    endpoint: { type: "fixed", baseUrl: definition.baseUrl } as const,
  };
  const options = {
    store: new InMemoryCredentialStore(),
    context: context(),
  };

  assert.throws(
    () => createStaticOpenAiChatProvider(definition, { ...options, models: [] }),
    /no static models/,
  );
  assert.throws(
    () => createStaticOpenAiChatProvider(definition, { ...options, models: [source] }),
    /owned by groq/,
  );
  assert.throws(
    () =>
      createStaticOpenAiChatProvider(definition, {
        ...options,
        models: [{ ...valid, apiDialect: "anthropic-messages" }],
      }),
    /does not use openai-chat/,
  );
  assert.throws(
    () =>
      createStaticOpenAiChatProvider(definition, {
        ...options,
        models: [{ ...valid, endpoint: { type: "fixed", baseUrl: "https://other.example/v1" } }],
      }),
    /unexpected endpoint/,
  );
  assert.throws(
    () =>
      createStaticOpenAiChatProvider(definition, {
        ...options,
        models: [{ ...valid, headers: { authorization: "unsafe" } }],
      }),
    /unsafe static header/,
  );
  assert.doesNotThrow(() =>
    createStaticOpenAiChatProvider(definition, { ...options, models: [valid] }),
  );
});
