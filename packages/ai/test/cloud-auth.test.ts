// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  createAzureOpenAiResponsesProvider,
  createGoogleVertexProvider,
  InMemoryCredentialStore,
  login,
  type AuthContext,
  vertexRequestPolicy,
} from "../src/index.ts";

function context(
  values: Readonly<Record<string, string>>,
  files: readonly string[] = [],
): AuthContext {
  return {
    env: (name) => values[name],
    fileExists: (path) => Promise.resolve(files.includes(path)),
  };
}

test("Azure Entra acquires a scoped token lazily and asks again on later resolution", async () => {
  let calls = 0;
  const provider = createAzureOpenAiResponsesProvider({
    store: new InMemoryCredentialStore(),
    context: context({ AZURE_OPENAI_RESOURCE_NAME: "sample" }),
    cloudAuth: {
      azureCredential: () => ({
        getToken: async (scope, options) => {
          calls += 1;
          assert.equal(scope, "https://cognitiveservices.azure.com/.default");
          assert.equal(options?.abortSignal?.aborted, false);
          return { token: `entra-token-${calls}`, expiresOnTimestamp: Date.now() + 3_600_000 };
        },
      }),
    },
  });

  assert.equal(calls, 0);
  const first = await provider.authentication?.resolve();
  const second = await provider.authentication?.resolve();
  assert.equal(first?.auth.headers?.authorization, "Bearer entra-token-1");
  assert.equal(second?.auth.headers?.authorization, "Bearer entra-token-2");
  assert.equal(first?.env?.AZURE_OPENAI_BASE_URL, "https://sample.openai.azure.com/openai/v1");
  assert.deepEqual(first?.secretValues, ["entra-token-1"]);
});

test("Azure exposes interactive API-key login with endpoint settings", async () => {
  const store = new InMemoryCredentialStore();
  const provider = createAzureOpenAiResponsesProvider({
    store,
    context: context({}),
  });
  assert.ok(provider.authentication);
  const answers = ["azure-login-key", "https://sample.openai.azure.com/openai/v1"];
  const state = await provider.authentication.login("api_key", {
    signal: new AbortController().signal,
    prompt: async () => answers.shift() ?? "",
    notify: () => undefined,
  });
  assert.equal(state.phase, "authenticated");
  const stored = await store.read("azure-openai-responses");
  assert.equal(stored?.type, "api_key");
  assert.equal(
    stored?.type === "api_key" ? stored.env?.AZURE_OPENAI_BASE_URL : undefined,
    "https://sample.openai.azure.com/openai/v1",
  );
});

test("stored Azure credentials never fall through to Entra", async () => {
  const store = new InMemoryCredentialStore();
  await login(store, "azure-openai-responses", { type: "api_key", key: "bad-stored-key" });
  let entraCalls = 0;
  const provider = createAzureOpenAiResponsesProvider({
    store,
    context: context({ AZURE_OPENAI_RESOURCE_NAME: "sample" }),
    cloudAuth: {
      azureCredential: () => ({
        getToken: async () => {
          entraCalls += 1;
          return { token: "entra-token" };
        },
      }),
    },
  });
  const resolved = await provider.authentication?.resolve();
  assert.equal(resolved?.auth.apiKey, "bad-stored-key");
  assert.equal(entraCalls, 0);
});

test("Vertex credential SDK promises are bounded by cancellation", async () => {
  const provider = createGoogleVertexProvider({
    store: new InMemoryCredentialStore(),
    context: context({ GOOGLE_CLOUD_LOCATION: "us-central1" }),
    cloudAuth: {
      googleAuth: () => ({
        getProjectId: () => new Promise<string>(() => undefined),
        getClient: () => new Promise(() => undefined),
      }),
    },
  });
  assert.ok(provider.authentication);
  const controller = new AbortController();
  const resolution = provider.authentication.resolve({ signal: controller.signal });
  controller.abort();
  await assert.rejects(resolution, { name: "AbortError" });
});

test("Vertex ADC acquires tokens and discovers a project without persisting them", async () => {
  let tokenCalls = 0;
  let optionsSeen: Readonly<Record<string, unknown>> | undefined;
  const provider = createGoogleVertexProvider({
    store: new InMemoryCredentialStore(),
    context: context({ GOOGLE_CLOUD_LOCATION: "us-central1" }),
    cloudAuth: {
      googleAuth: (options) => {
        optionsSeen = options;
        return {
          getProjectId: () => Promise.resolve("discovered-project"),
          getClient: () =>
            Promise.resolve({
              getAccessToken: () => {
                tokenCalls += 1;
                return Promise.resolve({ token: `google-token-${tokenCalls}` });
              },
            }),
        };
      },
    },
  });

  assert.equal(tokenCalls, 0);
  const first = await provider.authentication?.resolve();
  const second = await provider.authentication?.resolve();
  assert.equal(first?.auth.headers?.authorization, "Bearer google-token-1");
  assert.equal(second?.auth.headers?.authorization, "Bearer google-token-2");
  assert.equal(first?.env?.GOOGLE_CLOUD_PROJECT, "discovered-project");
  assert.equal(first?.env?.GOOGLE_VERTEX_CREDENTIAL_TYPE, "adc");
  assert.deepEqual(optionsSeen, {
    scopes: "https://www.googleapis.com/auth/cloud-platform",
  });
  assert.ok(first);
  assert.deepEqual(vertexRequestPolicy(first), {
    credential: { type: "adc", accessToken: "google-token-1" },
    project: "discovered-project",
    location: "us-central1",
  });
});

test("Vertex service account selection validates its file and remains provider scoped", async () => {
  const store = new InMemoryCredentialStore();
  await login(store, "google-vertex", {
    type: "api_key",
    env: {
      GOOGLE_VERTEX_CREDENTIAL_TYPE: "service_account",
      GOOGLE_APPLICATION_CREDENTIALS: "/secure/service-account.json",
      GOOGLE_CLOUD_PROJECT: "stored-project",
      GOOGLE_CLOUD_LOCATION: "global",
    },
  });
  let optionsSeen: Readonly<Record<string, unknown>> | undefined;
  const provider = createGoogleVertexProvider({
    store,
    context: context({}, ["/secure/service-account.json"]),
    cloudAuth: {
      googleAuth: (options) => {
        optionsSeen = options;
        return {
          getProjectId: () => Promise.resolve("ignored-project"),
          getClient: () =>
            Promise.resolve({ getAccessToken: () => Promise.resolve("service-token") }),
        };
      },
    },
  });
  const resolved = await provider.authentication?.resolve();
  assert.deepEqual(optionsSeen, {
    scopes: "https://www.googleapis.com/auth/cloud-platform",
    keyFilename: "/secure/service-account.json",
    projectId: "stored-project",
  });
  assert.ok(resolved);
  assert.deepEqual(vertexRequestPolicy(resolved), {
    credential: {
      type: "service_account",
      accessToken: "service-token",
      credentialsFile: "/secure/service-account.json",
    },
    project: "stored-project",
    location: "global",
  });
  assert.equal(JSON.stringify(provider.authentication?.state()).includes("service-token"), false);
});

test("Vertex file source fails explicitly when its configured credential file is missing", async () => {
  const provider = createGoogleVertexProvider({
    store: new InMemoryCredentialStore(),
    context: context({
      GOOGLE_APPLICATION_CREDENTIALS: "/missing.json",
      GOOGLE_CLOUD_PROJECT: "project",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    }),
    cloudAuth: {
      googleAuth: () => {
        throw new Error("must not instantiate GoogleAuth");
      },
    },
  });
  assert.ok(provider.authentication);
  await assert.rejects(provider.authentication.resolve(), /does not identify a readable file/);
});
