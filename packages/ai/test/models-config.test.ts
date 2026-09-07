// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getStaticModelCatalog,
  InMemoryCredentialStore,
  loadConfiguredProviders,
} from "../src/index.ts";

const context = { env: () => undefined, fileExists: async () => false };

test("models.json loads named providers with isolated credentials and keyless endpoints", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "axl-model-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new InMemoryCredentialStore();
  assert.deepEqual(await loadConfiguredProviders(home, { store, context }), []);
  const model = getStaticModelCatalog("deepseek")[0];
  await writeFile(
    join(home, "models.json"),
    JSON.stringify({
      providers: {
        local: { baseUrl: "http://127.0.0.1:11434/v1", models: [model] },
        work: {
          displayName: "Work proxy",
          baseUrl: "https://example.com/v1",
          apiKeyEnvironmentVariables: ["WORK_API_KEY"],
          models: [model],
        },
      },
    }),
  );
  const providers = await loadConfiguredProviders(home, { store, context });
  assert.deepEqual(
    providers.map((p) => p.id),
    ["local", "work"],
  );
  const [local, work] = providers;
  assert.ok(local);
  assert.ok(work?.authentication);
  assert.equal((await local.listModels())[0]?.providerId, "local");
  assert.deepEqual(providers[0]?.authMethods, ["keyless"]);
  await work.authentication.login("api_key", {
    prompt: async () => "obviously-fake-work-key",
    notify: () => {},
  });
  assert.equal((await store.read("work"))?.type, "api_key");
  assert.equal(await store.read("local"), undefined);
  assert.equal(await store.read("custom"), undefined);
});

test("models.json rejects unsafe configuration and explicitly rejects the retired filename", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "axl-model-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { store: new InMemoryCredentialStore(), context };
  const model = getStaticModelCatalog("deepseek")[0];
  const valid = { baseUrl: "https://example.com/v1", models: [model] };
  for (const providers of [
    { openai: valid },
    { "../escape": valid },
    { local: { ...valid, apiKey: "misplaced-secret" } },
    { local: { ...valid, baseUrl: "https://user:secret@example.com" } },
    { local: { ...valid, headers: { Authorization: "misplaced-secret" } } },
    { local: { ...valid, models: [null] } },
    { local: { ...valid, models: [{ ...model, reasoning: "yes" }] } },
    { local: { ...valid, models: [{ ...model, thinkingLevelMap: 42 }] } },
    { local: { ...valid, models: [{ ...model, thinkingLevelMap: [] }] } },
    { local: { ...valid, models: [{ ...model, maxOutputTokens: -1 }] } },
    { local: { ...valid, models: [{ ...model, compatibility: {} }] } },
    { local: { ...valid, models: [{ ...model, compatibility: [] }] } },
  ]) {
    await writeFile(join(home, "models.json"), JSON.stringify({ providers }));
    await assert.rejects(loadConfiguredProviders(home, options), (error: Error) => {
      assert.doesNotMatch(error.message, /misplaced-secret/);
      return /Invalid model configuration/.test(error.message);
    });
  }
  await writeFile(join(home, "custom-provider.json"), "{}");
  await assert.rejects(loadConfiguredProviders(home, options), /replaced.*models.json/);
});
