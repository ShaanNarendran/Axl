// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type CatalogSnapshot,
  CatalogStoreError,
  FileCatalogStore,
  InMemoryCatalogStore,
  makeFakeModelInfo,
} from "../src/index.ts";

function snapshot(providerId: string, generation = 1): CatalogSnapshot {
  return {
    version: 1,
    providerId,
    generation,
    checkedAt: 200,
    updatedAt: 100,
    sourceUpdatedAt: 50,
    etag: 'W/"catalog-1"',
    source: { id: `${providerId}-models`, kind: "provider_api", revision: "2026-09-01" },
    models: [makeFakeModelInfo({ providerId, modelId: `model-${generation}` })],
  };
}

test("in-memory catalog storage validates and clones provider snapshots", async () => {
  const store = new InMemoryCatalogStore();
  const original = snapshot("dynamic");
  await store.write("dynamic", original);

  const first = await store.read("dynamic");
  assert.deepEqual(first, original);
  assert.notEqual(first, original);
  assert.notEqual(first?.models, original.models);

  const unsafe = {
    ...original,
    credential: "must-not-persist",
  } as unknown as CatalogSnapshot;
  await assert.rejects(
    store.write("dynamic", unsafe),
    (error) => error instanceof CatalogStoreError && /unknown field/.test(error.message),
  );
  assert.deepEqual(await store.read("dynamic"), original);
});

test("file catalog storage keeps provider snapshots isolated and atomic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axl-catalog-store-"));
  try {
    const store = new FileCatalogStore(directory);
    await store.write("first", snapshot("first"));
    await store.write("second", snapshot("second", 2));

    const reloaded = new FileCatalogStore(directory);
    assert.deepEqual(await reloaded.read("first"), snapshot("first"));
    assert.deepEqual(await reloaded.read("second"), snapshot("second", 2));

    const invalid = {
      ...snapshot("first", 3),
      models: [{ ...snapshot("first", 3).models[0], authorization: "secret" }],
    } as unknown as CatalogSnapshot;
    await assert.rejects(reloaded.write("first", invalid), CatalogStoreError);
    assert.deepEqual(await reloaded.read("first"), snapshot("first"));
    assert.deepEqual(await reloaded.read("second"), snapshot("second", 2));

    const mode = (await stat(join(directory, "first.json"))).mode & 0o777;
    if (process.platform !== "win32") assert.equal(mode, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt provider files fail loudly without affecting healthy providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axl-catalog-corrupt-"));
  try {
    const store = new FileCatalogStore(directory);
    await store.write("healthy", snapshot("healthy"));
    await writeFile(join(directory, "broken.json"), "{not-json\n", { mode: 0o600 });

    await assert.rejects(
      store.read("broken"),
      (error) => error instanceof CatalogStoreError && /not valid JSON/.test(error.message),
    );
    assert.deepEqual(await store.read("healthy"), snapshot("healthy"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelled lock waits never publish a delayed catalog write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axl-catalog-cancel-"));
  try {
    const store = new FileCatalogStore(directory);
    await store.write("dynamic", snapshot("dynamic"));
    const lockPath = join(directory, "dynamic.json.lock");
    await writeFile(lockPath, `${process.pid} ${Date.now()}\n`, { mode: 0o600 });
    const controller = new AbortController();
    const pending = store.write("dynamic", snapshot("dynamic", 2), {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 40);
    await assert.rejects(pending, { name: "AbortError" });
    await rm(lockPath, { force: true });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));

    const persisted = JSON.parse(
      await readFile(join(directory, "dynamic.json"), "utf8"),
    ) as CatalogSnapshot;
    assert.equal(persisted.generation, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
