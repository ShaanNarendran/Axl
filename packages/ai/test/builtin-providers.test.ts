// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_PROVIDER_IDS,
  createBuiltinProviders,
  getStaticModelCatalog,
  InMemoryCredentialStore,
  listBuiltinCatalogProviders,
  ProviderRegistry,
} from "../src/index.ts";

function context(read?: () => void) {
  return {
    env: () => {
      read?.();
      return undefined;
    },
    fileExists: () => {
      read?.();
      return Promise.resolve(false);
    },
  };
}

test("registers exactly all 41 planned provider identities", async () => {
  let credentialReads = 0;
  let fetches = 0;
  const providers = createBuiltinProviders({
    store: new InMemoryCredentialStore(),
    context: context(() => {
      credentialReads += 1;
    }),
    fetch: async () => {
      fetches += 1;
      throw new Error("unexpected network request");
    },
  });
  const ids = providers.map((provider) => provider.id);
  assert.equal(ids.length, 41);
  assert.equal(new Set(ids).size, 41);
  assert.deepEqual([...ids].sort(), [...BUILTIN_PROVIDER_IDS].sort());
  assert.deepEqual(
    [...ids].sort(),
    listBuiltinCatalogProviders()
      .map((provider) => provider.id)
      .sort(),
  );

  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  for (const provider of providers) {
    const models = await provider.listModels();
    assert.equal(
      models.every((model) => model.providerId === provider.id),
      true,
      provider.id,
    );
    const catalog = listBuiltinCatalogProviders().find((entry) => entry.id === provider.id);
    assert.ok(catalog, provider.id);
    if (catalog.catalogKind === "static") {
      assert.ok(models.length > 0, provider.id);
      assert.equal(models.length, getStaticModelCatalog(provider.id).length, provider.id);
    } else {
      assert.deepEqual(models, [], provider.id);
    }
    assert.equal(registry.get(provider.id), provider);
  }
  assert.equal(credentialReads, 0);
  assert.equal(fetches, 0);
});

test("preserves catalog selected dialects and exact endpoint policies", async () => {
  const providers = createBuiltinProviders({
    store: new InMemoryCredentialStore(),
    context: context(),
  });
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  assert.deepEqual(
    new Set((await byId.get("openai")?.listModels())?.map((model) => model.apiDialect)),
    new Set(["openai-chat", "openai-responses"]),
  );
  assert.deepEqual(
    new Set((await byId.get("opencode")?.listModels())?.map((model) => model.apiDialect)),
    new Set(["openai-chat", "openai-responses", "anthropic-messages", "google-generative-ai"]),
  );
  assert.deepEqual(
    new Set((await byId.get("opencode-go")?.listModels())?.map((model) => model.apiDialect)),
    new Set(["openai-chat", "openai-responses", "anthropic-messages"]),
  );
  for (const provider of providers) {
    for (const model of await provider.listModels()) {
      assert.equal(
        model.compatibility?.dialect,
        model.apiDialect,
        `${provider.id}/${model.modelId}`,
      );
      assert.ok(model.endpoint, `${provider.id}/${model.modelId}`);
    }
  }
});

test("keeps dynamic refresh explicit and enables Codex only with OAuth", async () => {
  let fetches = 0;
  const providers = createBuiltinProviders({
    store: new InMemoryCredentialStore(),
    context: context(),
    fetch: async () => {
      fetches += 1;
      throw new Error("network should require explicit refresh");
    },
  });
  for (const id of ["github-copilot", "openrouter", "cloudflare-ai-gateway", "radius"]) {
    const provider = providers.find((candidate) => candidate.id === id);
    assert.ok(provider?.refreshModelCatalog, id);
    assert.deepEqual(await provider.listModels(), [], id);
  }
  assert.equal(fetches, 0);

  const codex = providers.find((candidate) => candidate.id === "openai-codex");
  assert.ok(codex);
  const codexModels = await codex.listModels();
  assert.ok(codexModels.length > 0);
  assert.equal(
    codexModels.every((model) => model.availability?.status !== "unavailable"),
    true,
  );
  assert.deepEqual(codex.authMethods, ["oauth"]);
  assert.ok(codex.authentication);

  const bedrock = providers.find((candidate) => candidate.id === "amazon-bedrock");
  assert.ok(bedrock);
  assert.deepEqual(bedrock.authMethods, ["environment", "file", "ambient"]);
  assert.equal(
    (await bedrock.listModels()).every((model) => model.availability?.status !== "unavailable"),
    true,
  );
});

test("isolates regional provider registrations and credential ownership", async () => {
  const providers = createBuiltinProviders({
    store: new InMemoryCredentialStore(),
    context: context(),
  });
  const regional = listBuiltinCatalogProviders().filter(
    (provider) => provider.regionFamily !== undefined,
  );
  const identities = new Set<string>();
  const endpoints = new Set<string>();
  for (const entry of regional) {
    const provider = providers.find((candidate) => candidate.id === entry.id);
    assert.ok(provider, entry.id);
    assert.ok(provider.authentication, entry.id);
    const key = `${entry.regionFamily}/${entry.region}`;
    assert.equal(identities.has(key), false, key);
    identities.add(key);
    const model = (await provider.listModels())[0];
    assert.ok(model?.endpoint, entry.id);
    const endpoint = JSON.stringify(model.endpoint);
    assert.equal(endpoints.has(`${entry.regionFamily}/${endpoint}`), false, entry.id);
    endpoints.add(`${entry.regionFamily}/${endpoint}`);
  }
});
