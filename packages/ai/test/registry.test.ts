// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectModelStream,
  FakeModelProvider,
  type ModelInfo,
  type ModelProvider,
  makeFakeModelInfo,
  ProviderRegistry,
  ProviderRegistryError,
} from "../src/index.ts";

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

function makeProvider(id: string, models?: readonly ModelInfo[]): FakeModelProvider {
  return new FakeModelProvider({ id, ...(models === undefined ? {} : { models }), responses: [] });
}

test("registers, resolves, and lists enabled providers", () => {
  const registry = new ProviderRegistry();
  const provider = makeProvider("azure");
  registry.register(provider);

  assert.equal(registry.get("azure"), provider);
  assert.equal(registry.has("azure"), true);
  assert.equal(registry.isEnabled("azure"), true);
  assert.deepEqual(registry.list(), [provider]);
  assert.deepEqual(registry.registrations(), [{ provider, enabled: true }]);
});

test("rejects duplicate provider IDs and unknown lookups loudly", () => {
  const registry = new ProviderRegistry();
  registry.register(makeProvider("azure"));

  assert.throws(
    () => registry.register(makeProvider("azure")),
    (error) =>
      error instanceof ProviderRegistryError &&
      error.code === "provider_duplicate" &&
      /already registered/.test(error.message),
  );
  assert.throws(
    () => registry.get("missing"),
    (error) =>
      error instanceof ProviderRegistryError &&
      error.code === "provider_missing" &&
      /not registered/.test(error.message),
  );
});

test("looks models up by provider and model identity", async () => {
  const registry = new ProviderRegistry();
  const first = makeProvider("first", [
    makeFakeModelInfo({ providerId: "first", modelId: "shared", apiDialect: "openai-chat" }),
  ]);
  const second = makeProvider("second", [
    makeFakeModelInfo({
      providerId: "second",
      modelId: "shared",
      apiDialect: "anthropic-messages",
    }),
  ]);
  registry.register(first);
  registry.register(second);

  assert.equal((await registry.getModel("first", "shared")).apiDialect, "openai-chat");
  assert.equal((await registry.getModel("second", "shared")).apiDialect, "anthropic-messages");
  const catalog = await registry.listModels();
  assert.deepEqual(
    catalog.models.map((model) => `${model.providerId}/${model.modelId}`),
    ["first/shared", "second/shared"],
  );
  assert.equal(catalog.errors.size, 0);
});

test("dispatches mixed dialect models through their owning provider", async () => {
  const models = [
    makeFakeModelInfo({ providerId: "mixed", modelId: "chat", apiDialect: "openai-chat" }),
    makeFakeModelInfo({
      providerId: "mixed",
      modelId: "responses",
      apiDialect: "openai-responses",
    }),
  ];
  const provider = new FakeModelProvider({
    id: "mixed",
    models,
    responses: [
      [
        { type: "text_delta", text: "selected" },
        { type: "completed", stopReason: "stop", usage },
      ],
    ],
  });
  const registry = new ProviderRegistry();
  registry.register(provider);

  const result = await collectModelStream(
    registry.stream("mixed", { modelId: "responses", messages: [] }),
  );
  assert.equal(result.terminal.type, "completed");
  assert.equal(provider.requests[0]?.modelId, "responses");
  assert.equal((await registry.getModel("mixed", "responses")).apiDialect, "openai-responses");
});

test("filters unavailable models and rejects their dispatch", async () => {
  const registry = new ProviderRegistry();
  registry.register(
    makeProvider("availability", [
      makeFakeModelInfo({ providerId: "availability", modelId: "ready" }),
      makeFakeModelInfo({
        providerId: "availability",
        modelId: "blocked",
        availability: { status: "unavailable", reason: "region disabled" },
      }),
    ]),
  );

  assert.deepEqual(
    (await registry.listModels()).models.map((model) => model.modelId),
    ["ready"],
  );
  assert.deepEqual(
    (await registry.listModels({ includeUnavailable: true })).models.map((model) => model.modelId),
    ["ready", "blocked"],
  );
  await assert.rejects(
    registry.getModel("availability", "blocked"),
    (error) => error instanceof ProviderRegistryError && error.code === "model_unavailable",
  );
});

test("disabled providers perform no catalog, refresh, or dispatch work", async () => {
  let catalogCalls = 0;
  let refreshCalls = 0;
  let streamCalls = 0;
  const model = makeFakeModelInfo({ providerId: "disabled" });
  const provider: ModelProvider = {
    id: "disabled",
    displayName: "Disabled",
    authMethods: ["keyless"],
    listModels: async () => {
      catalogCalls += 1;
      return [model];
    },
    refreshModels: async () => {
      refreshCalls += 1;
      return [model];
    },
    stream: () => {
      streamCalls += 1;
      return (async function* () {
        yield { type: "completed", stopReason: "stop", usage } as const;
      })();
    },
  };
  const registry = new ProviderRegistry();
  registry.register(provider, { enabled: false });

  assert.deepEqual(await registry.listModels(), { models: [], errors: new Map() });
  assert.deepEqual(await registry.refresh(), {
    models: [],
    errors: new Map(),
    refreshedProviderIds: [],
  });
  await assert.rejects(
    registry.getModel("disabled", model.modelId),
    (error) => error instanceof ProviderRegistryError && error.code === "provider_disabled",
  );
  assert.deepEqual(
    { catalogCalls, refreshCalls, streamCalls },
    { catalogCalls: 0, refreshCalls: 0, streamCalls: 0 },
  );

  registry.setEnabled("disabled", true);
  assert.equal((await registry.listModels()).models.length, 1);
});

test("explicit refresh isolates provider failures", async () => {
  const refreshed = makeFakeModelInfo({ providerId: "healthy", modelId: "new" });
  const healthy: ModelProvider = {
    id: "healthy",
    displayName: "Healthy",
    authMethods: ["keyless"],
    listModels: async () => [refreshed],
    refreshModels: async () => [refreshed],
    stream: () => {
      throw new Error("not used");
    },
  };
  const failed: ModelProvider = {
    id: "failed",
    displayName: "Failed",
    authMethods: ["keyless"],
    listModels: async () => [],
    refreshModels: async () => {
      throw new Error("catalog unavailable");
    },
    stream: () => {
      throw new Error("not used");
    },
  };
  const registry = new ProviderRegistry();
  registry.register(healthy);
  registry.register(failed);

  const result = await registry.refresh();
  assert.deepEqual(result.models, [refreshed]);
  assert.deepEqual(result.refreshedProviderIds, ["healthy"]);
  assert.match(result.errors.get("failed")?.message ?? "", /catalog unavailable/);
});

test("explicit refresh honors cancellation before provider work", async () => {
  let refreshCalls = 0;
  const provider: ModelProvider = {
    id: "cancelled",
    displayName: "Cancelled",
    authMethods: ["keyless"],
    listModels: async () => [],
    refreshModels: async () => {
      refreshCalls += 1;
      return [];
    },
    stream: () => {
      throw new Error("not used");
    },
  };
  const registry = new ProviderRegistry();
  registry.register(provider);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(registry.refresh({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(refreshCalls, 0);
});

test("rejects malformed provider catalogs", async () => {
  const registry = new ProviderRegistry();
  registry.register(
    makeProvider("wrong-owner", [makeFakeModelInfo({ providerId: "another-provider" })]),
  );
  await assert.rejects(
    registry.getModel("wrong-owner", "fake-model"),
    (error) => error instanceof ProviderRegistryError && error.code === "catalog_failure",
  );

  const duplicates = new ProviderRegistry();
  duplicates.register(
    makeProvider("duplicates", [
      makeFakeModelInfo({ providerId: "duplicates", modelId: "same" }),
      makeFakeModelInfo({ providerId: "duplicates", modelId: "same" }),
    ]),
  );
  await assert.rejects(
    duplicates.getModel("duplicates", "same"),
    (error) => error instanceof ProviderRegistryError && error.code === "model_duplicate",
  );
});

test("disposer unregisters once, disposes the provider, and never removes a successor", async () => {
  const registry = new ProviderRegistry();
  const first = makeProvider("azure");
  const dispose = registry.register(first);

  await dispose();
  assert.equal(registry.has("azure"), false);
  assert.throws(() => first.stream({ modelId: "fake-model", messages: [] }), /disposed/);

  const second = makeProvider("azure");
  registry.register(second);
  await dispose();
  assert.equal(registry.get("azure"), second);
});

test("registry disposal owns every provider lifecycle and is idempotent", async () => {
  const disposed: string[] = [];
  const provider = (id: string): ModelProvider => ({
    id,
    displayName: id,
    authMethods: ["keyless"],
    listModels: async () => [],
    stream: () => {
      throw new Error("not used");
    },
    dispose: async () => {
      disposed.push(id);
    },
  });
  const registry = new ProviderRegistry();
  registry.register(provider("first"));
  registry.register(provider("second"));

  await registry.dispose();
  await registry.dispose();
  assert.deepEqual(disposed.sort(), ["first", "second"]);
  assert.throws(
    () => registry.list(),
    (error) => error instanceof ProviderRegistryError && error.code === "registry_disposed",
  );
});
