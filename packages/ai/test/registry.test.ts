// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type CatalogSnapshot,
  collectModelStream,
  FakeModelProvider,
  InMemoryCatalogStore,
  type ModelCatalogRefreshResult,
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
    refreshModels: async (context) => {
      refreshCalls += 1;
      return {
        status: "updated",
        providerId: context.providerId,
        generation: context.generation,
        source: { id: "disabled-api", kind: "provider_api" },
        models: [model],
      };
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
    restoredProviderIds: [],
    supersededProviderIds: [],
    snapshots: new Map(),
    diagnostics: new Map(),
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
    refreshModels: async (context) => ({
      status: "updated",
      providerId: context.providerId,
      generation: context.generation,
      source: { id: "healthy-api", kind: "provider_api", revision: "catalog-7" },
      sourceUpdatedAt: 900,
      etag: '"healthy-7"',
      diagnostics: [{ code: "catalog.current", message: "Catalog is current", severity: "info" }],
      models: [refreshed],
    }),
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
  const registry = new ProviderRegistry({ now: () => 1_000 });
  registry.register(healthy);
  registry.register(failed);

  const result = await registry.refresh();
  assert.deepEqual(result.models, [refreshed]);
  assert.deepEqual(result.refreshedProviderIds, ["healthy"]);
  assert.deepEqual(result.snapshots.get("healthy"), {
    version: 1,
    providerId: "healthy",
    generation: 1,
    checkedAt: 1_000,
    updatedAt: 1_000,
    sourceUpdatedAt: 900,
    etag: '"healthy-7"',
    source: { id: "healthy-api", kind: "provider_api", revision: "catalog-7" },
    models: [refreshed],
  });
  assert.deepEqual(result.diagnostics.get("healthy"), [
    { code: "catalog.current", message: "Catalog is current", severity: "info" },
  ]);
  assert.match(result.errors.get("failed")?.message ?? "", /catalog unavailable/);
});

test("explicit refresh honors cancellation before provider work", async () => {
  let refreshCalls = 0;
  const provider: ModelProvider = {
    id: "cancelled",
    displayName: "Cancelled",
    authMethods: ["keyless"],
    listModels: async () => [],
    refreshModels: async (context) => {
      refreshCalls += 1;
      return {
        status: "updated",
        providerId: context.providerId,
        generation: context.generation,
        source: { id: "cancelled-api", kind: "provider_api" },
        models: [],
      };
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

test("restores a persisted dynamic catalog before network refresh", async () => {
  const store = new InMemoryCatalogStore();
  const storedModel = makeFakeModelInfo({ providerId: "dynamic", modelId: "stored" });
  await store.write("dynamic", {
    version: 1,
    providerId: "dynamic",
    generation: 4,
    checkedAt: 100,
    updatedAt: 90,
    source: { id: "dynamic-api", kind: "provider_api" },
    models: [storedModel],
  });
  let registry!: ProviderRegistry;
  let restoredBeforeRefresh = false;
  let refreshCalls = 0;
  const provider: ModelProvider = {
    id: "dynamic",
    displayName: "Dynamic",
    authMethods: ["keyless"],
    listModels: async () => [],
    refreshModels: async (context) => {
      refreshCalls += 1;
      restoredBeforeRefresh =
        context.previous?.generation === 4 &&
        (await registry.getModel("dynamic", "stored")).modelId === "stored";
      return {
        status: "not_modified",
        providerId: context.providerId,
        generation: context.generation,
        source: { id: "dynamic-api", kind: "provider_api" },
      };
    },
    stream: () => {
      throw new Error("not used");
    },
  };
  registry = new ProviderRegistry({ catalogStore: store, now: () => 200 });
  registry.register(provider);

  const offline = await registry.restoreCatalogs();
  assert.deepEqual(offline.restoredProviderIds, ["dynamic"]);
  assert.equal(refreshCalls, 0);
  assert.equal((await registry.getModel("dynamic", "stored")).modelId, "stored");

  const result = await registry.refresh();
  assert.equal(restoredBeforeRefresh, true);
  assert.deepEqual(result.restoredProviderIds, ["dynamic"]);
  assert.deepEqual(result.refreshedProviderIds, ["dynamic"]);
  assert.equal(result.snapshots.get("dynamic")?.checkedAt, 200);
  assert.equal(result.snapshots.get("dynamic")?.generation, 4);
  assert.deepEqual(
    (await registry.listModels()).models.map((model) => model.modelId),
    ["stored"],
  );
  assert.equal((await store.read("dynamic"))?.checkedAt, 200);
});

test("failed and malformed refreshes retain the previous valid catalog", async () => {
  const store = new InMemoryCatalogStore();
  const previous = makeFakeModelInfo({ providerId: "retained", modelId: "previous" });
  await store.write("retained", {
    version: 1,
    providerId: "retained",
    generation: 2,
    checkedAt: 100,
    updatedAt: 100,
    etag: '"previous"',
    source: { id: "retained-api", kind: "provider_api" },
    models: [previous],
  });
  let malformed = false;
  const provider: ModelProvider = {
    id: "retained",
    displayName: "Retained",
    authMethods: ["keyless"],
    listModels: async () => [],
    refreshModels: async (context) => {
      if (!malformed) throw new Error("remote unavailable");
      return {
        status: "updated",
        providerId: context.providerId,
        generation: context.generation,
        source: { id: "retained-api", kind: "provider_api" },
        models: [{ ...previous, maxOutputTokens: 0 }],
      };
    },
    stream: () => {
      throw new Error("not used");
    },
  };
  const registry = new ProviderRegistry({ catalogStore: store });
  registry.register(provider);

  const failed = await registry.refresh();
  assert.match(failed.errors.get("retained")?.message ?? "", /remote unavailable/);
  assert.equal((await registry.getModel("retained", "previous")).modelId, "previous");
  assert.equal((await store.read("retained"))?.etag, '"previous"');

  malformed = true;
  const invalid = await registry.refresh();
  assert.match(invalid.errors.get("retained")?.message ?? "", /invalid model catalog/);
  assert.equal((await registry.getModel("retained", "previous")).modelId, "previous");
  assert.equal((await store.read("retained"))?.generation, 2);
});

test("cancelled and superseded refreshes cannot replace the last-known-good catalog", async () => {
  const store = new InMemoryCatalogStore();
  const previous = makeFakeModelInfo({ providerId: "racing", modelId: "previous" });
  await store.write("racing", {
    version: 1,
    providerId: "racing",
    generation: 1,
    checkedAt: 10,
    updatedAt: 10,
    source: { id: "racing-api", kind: "provider_api" },
    models: [previous],
  });
  let call = 0;
  let finishFirst: ((result: ModelCatalogRefreshResult) => void) | undefined;
  let finishCancelled: ((result: ModelCatalogRefreshResult) => void) | undefined;
  let markStarted: (() => void) | undefined;
  let markCancelledStarted: (() => void) | undefined;
  const started = new Promise<void>((resolvePromise) => {
    markStarted = resolvePromise;
  });
  const cancelledStarted = new Promise<void>((resolvePromise) => {
    markCancelledStarted = resolvePromise;
  });
  const provider: ModelProvider = {
    id: "racing",
    displayName: "Racing",
    authMethods: ["keyless"],
    listModels: async () => [],
    refreshModels: (context) => {
      call += 1;
      if (call === 1) {
        markStarted?.();
        return new Promise((resolvePromise) => {
          finishFirst = resolvePromise;
        });
      }
      if (call === 3) {
        markCancelledStarted?.();
        return new Promise((resolvePromise) => {
          finishCancelled = resolvePromise;
        });
      }
      return Promise.resolve({
        status: "updated",
        providerId: context.providerId,
        generation: context.generation,
        source: { id: "racing-api", kind: "provider_api" },
        etag: '"newer"',
        models: [makeFakeModelInfo({ providerId: "racing", modelId: "newer" })],
      });
    },
    stream: () => {
      throw new Error("not used");
    },
  };
  const registry = new ProviderRegistry({ catalogStore: store });
  registry.register(provider);

  const first = registry.refresh();
  await started;
  const second = await registry.refresh();
  const firstResult = await first;
  assert.deepEqual(second.refreshedProviderIds, ["racing"]);
  assert.deepEqual(firstResult.supersededProviderIds, ["racing"]);

  finishFirst?.({
    status: "updated",
    providerId: "racing",
    generation: 1,
    source: { id: "racing-api", kind: "provider_api" },
    etag: '"older"',
    models: [makeFakeModelInfo({ providerId: "racing", modelId: "older" })],
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(
    (await registry.listModels()).models.map((model) => model.modelId),
    ["newer"],
  );
  assert.equal((await store.read("racing"))?.etag, '"newer"');

  const controller = new AbortController();
  const pending = registry.refresh({ signal: controller.signal });
  await cancelledStarted;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  finishCancelled?.({
    status: "updated",
    providerId: "racing",
    generation: 3,
    source: { id: "racing-api", kind: "provider_api" },
    models: [makeFakeModelInfo({ providerId: "racing", modelId: "cancelled" })],
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(
    (await registry.listModels()).models.map((model) => model.modelId),
    ["newer"],
  );
  assert.equal((await store.read("racing"))?.generation, 2);
});

test("dynamic refresh isolates corrupt persisted providers from healthy providers", async () => {
  class IsolatedStore extends InMemoryCatalogStore {
    override read(providerId: string): Promise<CatalogSnapshot | undefined> {
      if (providerId === "broken") return Promise.reject(new Error("corrupt snapshot"));
      return super.read(providerId);
    }
  }
  const source = { id: "catalog-api", kind: "provider_api" } as const;
  const dynamicProvider = (id: string): ModelProvider => ({
    id,
    displayName: id,
    authMethods: ["keyless"],
    listModels: async () => [],
    refreshModels: async (context) => ({
      status: "updated",
      providerId: context.providerId,
      generation: context.generation,
      source,
      models: [makeFakeModelInfo({ providerId: id })],
    }),
    stream: () => {
      throw new Error("not used");
    },
  });
  const registry = new ProviderRegistry({ catalogStore: new IsolatedStore() });
  registry.register(dynamicProvider("healthy"));
  registry.register(dynamicProvider("broken"));

  const result = await registry.refresh();
  assert.deepEqual(result.refreshedProviderIds, ["healthy"]);
  assert.match(result.errors.get("broken")?.message ?? "", /corrupt snapshot/);
  assert.equal((await registry.getModel("healthy", "fake-model")).providerId, "healthy");
});
