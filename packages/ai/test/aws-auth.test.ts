// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  createAmazonBedrockProvider,
  InMemoryCredentialStore,
  login,
  type AuthContext,
  type ModelStreamEvent,
} from "../src/index.ts";

function context(values: Readonly<Record<string, string>>): AuthContext {
  return { env: (name) => values[name], fileExists: () => Promise.resolve(false) };
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function bedrockResponse(): Response {
  return new Response(new Uint8Array(), {
    status: 200,
    headers: { "content-type": "application/vnd.amazon.eventstream" },
  });
}

test("Bedrock signs every dispatch through the AWS default credential chain", async () => {
  let credentialCalls = 0;
  const requests: { url: string; headers: Headers; body: string }[] = [];
  const provider = createAmazonBedrockProvider({
    store: new InMemoryCredentialStore(),
    context: context({ AWS_REGION: "us-east-1" }),
    awsAuth: {
      credentials: (options) => {
        assert.deepEqual(options, {});
        return async () => {
          credentialCalls += 1;
          return {
            accessKeyId: "AKIATESTACCESS",
            secretAccessKey: "test-secret-access-key",
            sessionToken: "test-session-token",
          };
        };
      },
    },
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return bedrockResponse();
    },
  });
  const model = (await provider.listModels())[0];
  assert.ok(model);
  assert.equal(credentialCalls, 0);

  await collect(provider.stream({ modelId: model.modelId, messages: [] }));
  assert.equal(credentialCalls, 1);
  assert.equal(requests.length, 1);
  assert.match(requests[0]?.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /);
  assert.match(requests[0]?.headers.get("authorization") ?? "", /Credential=AKIATESTACCESS\//);
  assert.equal(requests[0]?.headers.get("x-amz-security-token"), "test-session-token");
  assert.ok(requests[0]?.headers.get("x-amz-date"));
  assert.equal(requests[0]?.url.includes("bedrock-runtime.us-east-1.amazonaws.com"), true);
  assert.equal(requests[0]?.body.includes("test-secret-access-key"), false);
});

test("stored AWS profile is isolated and supplied to the default chain", async () => {
  const store = new InMemoryCredentialStore();
  await login(store, "amazon-bedrock", {
    type: "api_key",
    env: { AWS_PROFILE: "engineering", AWS_REGION: "eu-west-1" },
  });
  let selectedProfile: string | undefined;
  const provider = createAmazonBedrockProvider({
    store,
    context: context({ AWS_PROFILE: "ignored", AWS_REGION: "us-east-1" }),
    awsAuth: {
      credentials: (options) => {
        selectedProfile = options.profile;
        return () =>
          Promise.resolve({
            accessKeyId: "AKIAPROFILE",
            secretAccessKey: "profile-secret",
          });
      },
    },
  });
  const resolved = await provider.authentication?.resolve();
  assert.equal(selectedProfile, "engineering");
  assert.equal(resolved?.env?.AWS_REGION, "eu-west-1");
  assert.equal(resolved?.source, "AWS profile engineering");
  assert.equal(typeof resolved?.auth.signRequest, "function");
});

test("stored Bedrock bearer credentials never fall through to AWS signing", async () => {
  const store = new InMemoryCredentialStore();
  await login(store, "amazon-bedrock", {
    type: "api_key",
    key: "bedrock-bearer",
    env: { AWS_REGION: "us-west-2" },
  });
  let chainCalls = 0;
  const provider = createAmazonBedrockProvider({
    store,
    context: context({}),
    awsAuth: {
      credentials: () => {
        chainCalls += 1;
        return () => Promise.reject(new Error("must not resolve"));
      },
    },
  });
  const resolved = await provider.authentication?.resolve();
  assert.equal(resolved?.auth.apiKey, "bedrock-bearer");
  assert.equal(resolved?.auth.signRequest, undefined);
  assert.equal(chainCalls, 0);
});

test("Bedrock credential SDK promises are bounded by cancellation", async () => {
  const provider = createAmazonBedrockProvider({
    store: new InMemoryCredentialStore(),
    context: context({ AWS_REGION: "us-east-1" }),
    awsAuth: { credentials: () => () => new Promise(() => undefined) },
  });
  assert.ok(provider.authentication);
  const controller = new AbortController();
  const resolution = provider.authentication.resolve({ signal: controller.signal });
  controller.abort();
  await assert.rejects(resolution, { name: "AbortError" });
});

test("Bedrock credential failures are explicit and do not produce unsigned requests", async () => {
  let fetches = 0;
  const provider = createAmazonBedrockProvider({
    store: new InMemoryCredentialStore(),
    context: context({ AWS_REGION: "us-east-1" }),
    awsAuth: {
      credentials: () => () => Promise.reject(new Error("no AWS identity")),
    },
    fetch: async () => {
      fetches += 1;
      return bedrockResponse();
    },
  });
  const model = (await provider.listModels())[0];
  assert.ok(model);
  const events = await collect(provider.stream({ modelId: model.modelId, messages: [] }));
  assert.equal(fetches, 0);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.equal(terminal?.type === "error" && terminal.category, "authentication");
  assert.equal(JSON.stringify(events).includes("no AWS identity"), false);
});
