// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeGoogleVertexStream,
  encodeGoogleGenerativeAiRequest,
  encodeGoogleVertexRequest,
  getStaticModelCatalog,
  googleVertexOAuthScope,
  googleVertexStreamUrl,
  type ModelInfo,
  normalizeModelStream,
  prepareModelRequest,
  type SseFrame,
} from "../src/index.ts";

function vertexModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId: "google-vertex",
    modelId: "gemini-3-fixture",
    displayName: "Vertex Gemini Fixture",
    apiDialect: "google-vertex",
    capabilities: { toolUse: true, structuredOutput: true, imageInput: true },
    reasoning: true,
    thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high" },
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    cost: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
    cache: {
      supported: true,
      defaultRetention: "short",
      supportedRetentions: ["none", "short"],
    },
    sampling: { supported: ["temperature", "topP", "topK", "seed"] },
    compatibility: { dialect: "google-vertex", supportsStrictTools: true },
    ...overrides,
  };
}

async function prepared(model = vertexModel()) {
  return prepareModelRequest(model, {
    modelId: model.modelId,
    system: "Be concise.",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [
      {
        name: "lookup",
        description: "Look up a value",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
        constraint: { type: "json-schema", strict: "require" },
      },
    ],
    thinkingLevel: "medium",
    toolChoice: "required",
    sampling: { temperature: 0.2, topP: 0.8, topK: 20, seed: 7 },
  });
}

async function* frames(events: readonly unknown[]): AsyncGenerator<SseFrame> {
  for (const event of events) yield { event: "message", data: JSON.stringify(event) };
}

test("marks Vertex Gemini 3 models with strict Google tool compatibility", () => {
  const catalog = getStaticModelCatalog("google-vertex");
  assert.ok(catalog.length > 0);
  const gemini3 = catalog.filter((model) => model.modelId.startsWith("gemini-3"));
  assert.ok(gemini3.length > 0);
  assert.equal(
    gemini3.every(
      (model) =>
        model.compatibility?.dialect === "google-vertex" &&
        model.compatibility.supportsStrictTools === true,
    ),
    true,
  );
  assert.equal(
    catalog.every((model) => model.compatibility?.dialect === "google-vertex"),
    true,
  );
});

test("reuses Google request conversion while preserving dialect boundaries", async () => {
  const model = vertexModel();
  const request = await prepared(model);
  const encoded = encodeGoogleVertexRequest(model, request, {
    credential: { type: "api_key", apiKey: "fixture-api-key" },
  });

  assert.equal(
    encoded.url,
    "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3-fixture:streamGenerateContent?alt=sse",
  );
  assert.deepEqual(encoded.headers, {
    accept: "text/event-stream",
    "content-type": "application/json",
    "x-goog-api-key": "fixture-api-key",
  });
  assert.deepEqual(encoded.body.systemInstruction, { parts: [{ text: "Be concise." }] });
  assert.deepEqual(encoded.body.generationConfig, {
    temperature: 0.2,
    topP: 0.8,
    topK: 20,
    seed: 7,
    thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
  });
  assert.deepEqual(encoded.body.toolConfig, { functionCallingConfig: { mode: "ANY" } });
  assert.doesNotMatch(JSON.stringify(encoded.body), /fixture-api-key/);
  assert.doesNotMatch(encoded.url, /fixture-api-key/);
  assert.throws(
    () => encodeGoogleGenerativeAiRequest(model, request),
    /does not use the google-generative-ai dialect/,
  );
});

test("composes regional ADC and service-account requests without exposing credential files", async () => {
  const model = vertexModel({ modelId: "anthropic/claude-sonnet-fixture@default" });
  const request = await prepared(model);
  const adc = encodeGoogleVertexRequest(model, request, {
    credential: { type: "adc", accessToken: "adc-access-token" },
    project: "fixture-project",
    location: "us-central1",
  });
  assert.equal(
    adc.url,
    "https://us-central1-aiplatform.googleapis.com/v1/projects/fixture-project/locations/us-central1/publishers/anthropic/models/claude-sonnet-fixture@default:streamGenerateContent?alt=sse",
  );
  assert.equal(adc.headers.authorization, "Bearer adc-access-token");

  const serviceAccount = encodeGoogleVertexRequest(model, request, {
    credential: {
      type: "service_account",
      accessToken: "service-account-token",
      credentialsFile: "/private/service-account.json",
    },
    project: "fixture-project",
    location: "eu",
  });
  assert.match(serviceAccount.url, /^https:\/\/aiplatform\.eu\.rep\.googleapis\.com\/v1\//);
  assert.equal(serviceAccount.headers.authorization, "Bearer service-account-token");
  assert.doesNotMatch(JSON.stringify(serviceAccount), /service-account\.json/);
  assert.equal(googleVertexOAuthScope(), "https://www.googleapis.com/auth/cloud-platform");
});

test("supports global and custom collection endpoints with explicit API versions", () => {
  assert.equal(
    googleVertexStreamUrl("gemini-3-fixture", {
      credential: { type: "adc", accessToken: "token" },
      project: "fixture-project",
      location: "global",
    }),
    "https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-3-fixture:streamGenerateContent?alt=sse",
  );
  assert.equal(
    googleVertexStreamUrl("gemini-3-fixture", {
      credential: { type: "adc", accessToken: "token" },
      project: "fixture-project",
      location: "us-central1",
      baseUrl: "https://proxy.example.com/vertex?route=primary",
      apiVersion: "v1beta1",
    }),
    "https://proxy.example.com/vertex/v1beta1/publishers/google/models/gemini-3-fixture:streamGenerateContent?route=primary&alt=sse",
  );
  assert.equal(
    googleVertexStreamUrl("gemini-3-fixture", {
      credential: { type: "adc", accessToken: "token" },
      project: "fixture-project",
      location: "us-central1",
      baseUrl: "https://proxy.example.com/v1/projects/fixture-project/locations/global",
    }),
    "https://proxy.example.com/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-3-fixture:streamGenerateContent?alt=sse",
  );
});

test("fails explicitly for incomplete or malformed Vertex policy", async () => {
  const model = vertexModel();
  const request = await prepared(model);
  assert.throws(
    () =>
      encodeGoogleVertexRequest(model, request, {
        credential: { type: "adc", accessToken: "token" },
        location: "us-central1",
      }),
    /project is required/,
  );
  assert.throws(
    () =>
      encodeGoogleVertexRequest(model, request, {
        credential: { type: "service_account", accessToken: "token", credentialsFile: "" },
        project: "fixture-project",
        location: "us-central1",
      }),
    /credentials file is required/,
  );
  assert.throws(
    () =>
      encodeGoogleVertexRequest(model, request, {
        credential: { type: "api_key", apiKey: "bad\nkey" },
      }),
    /invalid characters/,
  );
  assert.throws(
    () =>
      encodeGoogleVertexRequest(model, request, {
        credential: { type: "api_key", apiKey: "<authenticated>" },
      }),
    /API key is a placeholder/,
  );
  assert.throws(
    () =>
      googleVertexStreamUrl("../other", {
        credential: { type: "api_key", apiKey: "key" },
      }),
    /model ID is invalid/,
  );
});

test("decodes Vertex streams with Vertex replay provenance and exact termination", async () => {
  const model = vertexModel();
  const request = await prepared(model);
  const events = await Array.fromAsync(
    normalizeModelStream(
      decodeGoogleVertexStream(
        frames([
          {
            responseId: "vertex-response",
            modelVersion: "gemini-routed",
            candidates: [
              {
                content: {
                  parts: [{ thought: true, text: "plan", thoughtSignature: "dGhpbms=" }],
                },
              },
            ],
          },
          {
            candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 1 },
          },
        ]),
        { model, request },
      ),
    ),
  );

  assert.deepEqual(events[1], {
    type: "replay_metadata",
    target: "thinking",
    contentIndex: 0,
    providerId: "google-vertex",
    apiDialect: "google-vertex",
    modelId: "gemini-3-fixture",
    signature: "dGhpbms=",
  });
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "completed");
  if (terminal?.type !== "completed") assert.fail("expected completion");
  assert.equal(terminal.stopReason, "stop");
  assert.deepEqual(terminal.response, {
    providerId: "google-vertex",
    requestedModelId: "gemini-3-fixture",
    routedModelId: "gemini-routed",
    responseId: "vertex-response",
    nativeStopReason: "STOP",
  });
});
