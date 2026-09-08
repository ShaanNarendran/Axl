// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { generateCatalog } from "../scripts/generate-catalog.ts";
import {
  GENERATED_CATALOG_PROVENANCE,
  getStaticModelCatalog,
  listBuiltinCatalogProviders,
  ModelCatalogValidationError,
  type ModelInfo,
  STATIC_MODEL_CATALOG,
  validateModelCatalog,
} from "../src/index.ts";

const validModel: ModelInfo = {
  providerId: "test-provider",
  modelId: "model-1",
  displayName: "Model 1",
  apiDialect: "openai-chat",
  capabilities: { toolUse: true, structuredOutput: true, imageInput: false },
  reasoning: true,
  thinkingLevelMap: { off: "none", high: "high", xhigh: null },
  contextWindow: 128_000,
  maxOutputTokens: 16_000,
  cost: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
  cache: {
    supported: true,
    defaultRetention: "short",
    supportedRetentions: ["none", "short"],
  },
  endpoint: { type: "fixed", baseUrl: "https://example.test/v1" },
  availability: { status: "available" },
  compatibility: { dialect: "openai-chat", supportsStrictTools: true },
};

test("generated catalog covers every planned provider identity", () => {
  const providers = listBuiltinCatalogProviders();
  assert.equal(providers.length, 41);
  assert.equal(new Set(providers.map((provider) => provider.id)).size, providers.length);

  const staticProviders = providers.filter((provider) => provider.catalogKind === "static");
  assert.deepEqual(
    Object.keys(STATIC_MODEL_CATALOG).sort(),
    staticProviders.map((provider) => provider.id).sort(),
  );
  for (const provider of staticProviders) {
    const models = getStaticModelCatalog(provider.id);
    assert.ok(models.length > 0, `${provider.id} has no generated models`);
    assert.equal(
      models.every((model) => model.providerId === provider.id),
      true,
    );
    assert.equal(
      models.every((model) => model.endpoint !== undefined),
      true,
    );
  }
  assert.deepEqual(getStaticModelCatalog("openrouter"), []);
  assert.deepEqual(getStaticModelCatalog("radius"), []);
  assert.doesNotThrow(() => validateModelCatalog(Object.values(STATIC_MODEL_CATALOG).flat()));

  const openAiDialects = new Set(getStaticModelCatalog("openai").map((model) => model.apiDialect));
  assert.equal(openAiDialects.has("openai-chat"), true);
  assert.equal(openAiDialects.has("openai-responses"), true);

  const azureModels = getStaticModelCatalog("azure-openai-responses");
  assert.equal(
    azureModels.every(
      (model) =>
        model.endpoint?.type === "template" &&
        model.endpoint.template === "https://{resource}.openai.azure.com/openai/v1" &&
        model.endpoint.variables.length === 1 &&
        model.endpoint.variables[0]?.name === "resource",
    ),
    true,
  );
});

test("static catalog access performs no network or credential work", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("network access is forbidden during static catalog reads");
  }) as typeof fetch;
  try {
    assert.ok(getStaticModelCatalog("openai").length > 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generated catalog matches the reviewed semantic baseline", () => {
  const baseline = JSON.parse(
    readFileSync(new URL("../catalog/semantic-baseline.json", import.meta.url), "utf8"),
  ) as {
    readonly providerCount: number;
    readonly staticProviderCount: number;
    readonly modelCount: number;
    readonly stableSerializationSha256: string;
  };
  const stableSerialization = JSON.stringify({
    provenance: GENERATED_CATALOG_PROVENANCE,
    providers: listBuiltinCatalogProviders(),
    catalog: STATIC_MODEL_CATALOG,
  });

  assert.equal(listBuiltinCatalogProviders().length, baseline.providerCount);
  assert.equal(Object.keys(STATIC_MODEL_CATALOG).length, baseline.staticProviderCount);
  assert.equal(Object.values(STATIC_MODEL_CATALOG).flat().length, baseline.modelCount);
  assert.equal(
    createHash("sha256").update(stableSerialization).digest("hex"),
    baseline.stableSerializationSha256,
  );
});

test("generated catalog retains independent source provenance", () => {
  assert.equal(GENERATED_CATALOG_PROVENANCE.sources[0]?.name, "models.dev");
  assert.match(GENERATED_CATALOG_PROVENANCE.sources[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    GENERATED_CATALOG_PROVENANCE.sources.some((source) =>
      source.location.startsWith("https://developer.ant-ling.com/"),
    ),
    true,
  );
});

test("regional catalog identities and endpoints remain separated", () => {
  const providers = listBuiltinCatalogProviders().filter(
    (provider) => provider.regionFamily !== undefined,
  );
  const identities = new Set(
    providers.map((provider) => `${provider.regionFamily}/${provider.region}`),
  );
  assert.equal(identities.size, providers.length);

  for (const family of new Set(providers.map((provider) => provider.regionFamily))) {
    const endpoints = providers
      .filter((provider) => provider.regionFamily === family)
      .map((provider) => JSON.stringify(getStaticModelCatalog(provider.id)[0]?.endpoint));
    assert.equal(new Set(endpoints).size, endpoints.length, `${family} reuses a regional endpoint`);
  }
});

test("catalog validation rejects unsafe and inconsistent metadata", () => {
  assert.throws(
    () => validateModelCatalog([validModel, validModel]),
    (error) =>
      error instanceof ModelCatalogValidationError && error.message.includes("is duplicated"),
  );
  assert.throws(
    () =>
      validateModelCatalog([
        {
          ...validModel,
          apiDialect: "unknown-dialect",
          capabilities: { ...validModel.capabilities, toolUse: "yes" },
        } as unknown as ModelInfo,
      ]),
    (error) => {
      assert.ok(error instanceof ModelCatalogValidationError);
      assert.match(error.message, /API dialect/);
      assert.match(error.message, /capabilities/);
      return true;
    },
  );
  assert.throws(
    () =>
      validateModelCatalog([
        {
          ...validModel,
          compatibility: { dialect: "anthropic-messages" },
          cost: { inputUsdPerMTok: -1, outputUsdPerMTok: 2 },
          cache: {
            supported: false,
            defaultRetention: "short",
            supportedRetentions: ["short"],
          },
          endpoint: {
            type: "template",
            template: "https://{account}.example.test",
            variables: [
              { name: "account", setting: "apiKey", required: true },
              { name: "unused", setting: "unused", required: true },
            ],
          },
          headers: { Authorization: "secret" },
        },
      ]),
    (error) => {
      assert.ok(error instanceof ModelCatalogValidationError);
      assert.match(error.message, /pricing/);
      assert.match(error.message, /cache/);
      assert.match(error.message, /unsafe setting/);
      assert.match(error.message, /does not use variable/);
      assert.match(error.message, /compatibility dialect/);
      assert.match(error.message, /unsafe static header/);
      return true;
    },
  );
});

test("catalog artifacts deterministically match provider shards and overlays", () => {
  const generated = generateCatalog();
  assert.equal(generated.files.size, 37);
  for (const [path, expected] of generated.files) {
    assert.equal(readFileSync(path, "utf8"), expected, path);
  }
});

test("reasoning maps require an object with valid values and a supported level", () => {
  for (const thinkingLevelMap of [
    42,
    [],
    false,
    { low: 1 },
    { high: " " },
    { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
  ]) {
    assert.throws(
      () => validateModelCatalog([{ ...validModel, thinkingLevelMap } as unknown as ModelInfo]),
      ModelCatalogValidationError,
    );
  }
  assert.doesNotThrow(() => validateModelCatalog([{ ...validModel, thinkingLevelMap: {} }]));
  assert.doesNotThrow(() =>
    validateModelCatalog([
      { ...validModel, thinkingLevelMap: { off: null, low: "low", high: "high", xhigh: null } },
    ]),
  );
});
