// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  createBuiltinProviders,
  InMemoryCatalogStore,
  InMemoryCredentialStore,
  ProviderRegistry,
} from "../src/index.ts";

function source(context = 128_000) {
  return {
    openai: {
      models: {
        "gpt-5-refresh-test": {
          id: "gpt-5-refresh-test",
          name: "Refreshed model",
          tool_call: true,
          structured_output: true,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
          modalities: { input: ["text", "image"] },
          limit: { context, output: 16_000 },
          cost: { input: 1, output: 2 },
          // Remote endpoint and headers must never become credential-routing policy.
          baseUrl: "https://attacker.example",
          headers: { Authorization: "injected" },
        },
      },
    },
  };
}

test("explicit static refresh validates live facts, pins policy, and restores offline", async () => {
  const store = new InMemoryCatalogStore();
  let requests = 0;
  let body = source();
  const providers = createBuiltinProviders({
    store: new InMemoryCredentialStore(),
    context: {
      env: (name) => (name === "OPENAI_API_KEY" ? "obviously-fake-key" : undefined),
      fileExists: async () => false,
    },
    fetch: async (url, init) => {
      requests++;
      assert.equal(String(url), "https://models.dev/api.json");
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return Response.json(body);
    },
  });
  const registry = new ProviderRegistry({ catalogStore: store });
  const provider = providers.find((p) => p.id === "openai");
  assert.ok(provider);
  registry.register(provider);
  const deepseek = providers.find((p) => p.id === "deepseek");
  assert.ok(deepseek);
  registry.register(deepseek);
  await registry.listModels();
  assert.equal(requests, 0);
  const refreshed = await registry.refresh({ configuredOnly: true });
  assert.deepEqual(refreshed.refreshedProviderIds, ["openai"]);
  assert.equal(requests, 1);
  const model = await registry.getModel("openai", "gpt-5-refresh-test");
  assert.deepEqual(model.endpoint, { type: "fixed", baseUrl: "https://api.openai.com/v1" });
  assert.equal(model.apiDialect, "openai-responses");
  assert.equal(model.headers, undefined);
  assert.equal(model.thinkingLevelMap?.medium, null);
  const snapshot = registry.catalogSnapshot("openai");
  assert.ok(snapshot);
  body = source(1);
  assert.equal((await registry.refresh({ providerId: "openai" })).errors.size, 1);
  assert.deepEqual(registry.catalogSnapshot("openai"), snapshot);
  const restored = new ProviderRegistry({ catalogStore: store });
  restored.register(provider);
  await restored.restoreCatalogs();
  assert.deepEqual(await restored.getModel("openai", model.modelId), model);
  assert.equal(requests, 2);
  const dispatch = provider.streamModel?.bind(provider);
  assert.ok(dispatch);
  assert.throws(
    () =>
      dispatch(
        { ...model, endpoint: { type: "fixed", baseUrl: "https://attacker.example" } },
        {} as never,
      ),
    /reviewed endpoint/,
  );
  await registry.dispose();
  await restored.dispose();
});

test("cancelling a static refresh does not publish a candidate", async () => {
  const controller = new AbortController();
  const provider = createBuiltinProviders({
    store: new InMemoryCredentialStore(),
    context: { env: () => undefined, fileExists: async () => false },
    fetch: async () => {
      controller.abort();
      return Response.json(source());
    },
  }).find((p) => p.id === "openai");
  assert.ok(provider);
  const registry = new ProviderRegistry();
  registry.register(provider);
  await assert.rejects(
    registry.refresh({ providerId: "openai", signal: controller.signal }),
    /abort/i,
  );
  assert.equal(registry.catalogSnapshot("openai"), undefined);
  await registry.dispose();
});

test("a newly refreshed Chat model dispatches through the registry", async () => {
  let dispatched = false;
  const model = source().openai.models["gpt-5-refresh-test"];
  const provider = createBuiltinProviders({
    store: new InMemoryCredentialStore(),
    context: {
      env: (name) => (name === "XAI_API_KEY" ? "obviously-fake-xai-key" : undefined),
      fileExists: async () => false,
    },
    fetch: async (url, init) => {
      if (String(url) === "https://models.dev/api.json") {
        return Response.json({
          xai: {
            models: {
              "grok-refresh-test": { ...model, id: "grok-refresh-test", reasoning: false },
            },
          },
        });
      }
      assert.equal(String(url), "https://api.x.ai/v1/chat/completions");
      assert.equal(JSON.parse(String(init?.body)).model, "grok-refresh-test");
      dispatched = true;
      return new Response(
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    },
  }).find((p) => p.id === "xai");
  assert.ok(provider);
  const registry = new ProviderRegistry();
  registry.register(provider);
  assert.equal((await registry.refresh({ providerId: "xai" })).errors.size, 0);
  const events = await Array.fromAsync(
    registry.stream("xai", { modelId: "grok-refresh-test", messages: [] }),
  );
  assert.equal(dispatched, true);
  assert.equal(events.at(-1)?.type, "completed");
  await registry.dispose();
});
