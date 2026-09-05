// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeModelProvider,
  isPreparedModelRequest,
  type ModelStreamEvent,
  modelPortForRegistry,
  modelPortForSession,
  ProviderRegistry,
} from "../src/index.ts";

const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

test("binds model choice and thinking level into kernel-shaped turns", async () => {
  const provider = new FakeModelProvider({
    responses: [
      [
        { type: "text_delta", text: "ok" },
        { type: "completed", stopReason: "stop", usage },
      ],
    ],
  });
  const readBlob = async () => new Uint8Array([1]);
  const modelPort = modelPortForSession(provider, {
    modelId: "fake-model",
    thinkingLevel: "high",
    readBlob,
  });

  const events: ModelStreamEvent[] = [];
  for await (const event of modelPort.stream({
    system: "You are Axl.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
  })) {
    events.push(event);
  }

  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "completed");
  const request = provider.requests[0];
  assert.equal(request?.modelId, "fake-model");
  assert.equal(request?.thinkingLevel, "high");
  assert.equal(request?.system, "You are Axl.");
  assert.equal(request?.readBlob, readBlob);
  assert.ok(request);
  assert.equal(isPreparedModelRequest(request), true);
});

test("binds provider and model identity through the registry coordinator", async () => {
  const provider = new FakeModelProvider({
    id: "mixed",
    models: [
      {
        providerId: "mixed",
        modelId: "chat",
        displayName: "Chat",
        apiDialect: "openai-chat",
        capabilities: { toolUse: true, structuredOutput: true, imageInput: false },
        reasoning: false,
        contextWindow: 10_000,
        maxOutputTokens: 1_000,
      },
    ],
    responses: [[{ type: "completed", stopReason: "stop", usage }]],
  });
  const registry = new ProviderRegistry();
  registry.register(provider);
  const modelPort = modelPortForRegistry(registry, {
    providerId: "mixed",
    modelId: "chat",
  });

  const result: ModelStreamEvent[] = [];
  for await (const event of modelPort.stream({ messages: [], tools: [] })) result.push(event);
  assert.equal(result.at(-1)?.type, "completed");
  assert.equal(provider.requests[0]?.modelId, "chat");
});

test("normalization guarantees a terminal even when the provider misbehaves", async () => {
  const provider = new FakeModelProvider({
    responses: [[{ type: "text_delta", text: "cut off" }]], // no terminal
  });
  const modelPort = modelPortForSession(provider, { modelId: "fake-model" });

  const events: ModelStreamEvent[] = [];
  for await (const event of modelPort.stream({ messages: [], tools: [] })) events.push(event);
  assert.equal(events[1]?.type, "error");
});
