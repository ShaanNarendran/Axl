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

test("retains replay metadata in assistant history for the next in-process turn", async () => {
  const provider = new FakeModelProvider({
    responses: [
      [
        { type: "thinking_delta", text: "considered", contentIndex: 0 },
        {
          type: "replay_metadata",
          target: "thinking",
          contentIndex: 0,
          providerId: "fake",
          apiDialect: "fake",
          modelId: "fake-model",
          signature: "opaque-reasoning",
          redacted: true,
          responseId: "resp-1",
          itemId: "rs-1",
        },
        { type: "text_delta", text: "running", contentIndex: 1 },
        {
          type: "replay_metadata",
          target: "text",
          contentIndex: 1,
          providerId: "fake",
          apiDialect: "fake",
          modelId: "fake-model",
          signature: "opaque-text",
          responseId: "resp-1",
          itemId: "msg-1",
        },
        { type: "tool_call", contentIndex: 2, callId: "call-1", name: "shell", input: {} },
        {
          type: "replay_metadata",
          target: "tool_call",
          contentIndex: 2,
          providerId: "fake",
          apiDialect: "fake",
          modelId: "fake-model",
          callId: "call-1",
          signature: "opaque-tool",
          responseId: "resp-1",
          itemId: "fc-1",
          namespace: "dynamic",
        },
        { type: "completed", stopReason: "tool_use", usage },
      ],
      [{ type: "completed", stopReason: "stop", usage }],
      [{ type: "completed", stopReason: "stop", usage }],
    ],
  });
  const port = modelPortForSession(provider, { modelId: "fake-model" });
  await Array.fromAsync(port.stream({ messages: [], tools: [] }));
  await Array.fromAsync(
    port.stream({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "considered" },
            { type: "text", text: "running" },
          ],
          toolCalls: [{ callId: "call-1", name: "shell", input: {} }],
        },
        {
          role: "tool",
          callId: "call-1",
          name: "shell",
          content: [{ type: "text", text: "done" }],
          isError: false,
        },
      ],
      tools: [{ name: "shell", description: "Run", inputSchema: { type: "object" } }],
    }),
  );

  const assistant = provider.requests[1]?.messages[0];
  assert.equal(assistant?.role, "assistant");
  if (assistant?.role !== "assistant") assert.fail("expected replayed assistant message");
  assert.deepEqual(assistant.origin, {
    providerId: "fake",
    apiDialect: "fake",
    modelId: "fake-model",
  });
  assert.equal(
    assistant.content[0]?.type === "thinking" ? assistant.content[0].signature?.value : undefined,
    "opaque-reasoning",
  );
  assert.equal(
    assistant.content[0]?.type === "thinking" ? assistant.content[0].redacted : undefined,
    true,
  );
  assert.equal(
    assistant.content[1]?.type === "text" ? assistant.content[1].continuation?.itemId : undefined,
    "msg-1",
  );
  assert.equal(
    assistant.content[1]?.type === "text" ? assistant.content[1].signature?.value : undefined,
    "opaque-text",
  );
  assert.equal(assistant.toolCalls?.[0]?.signature?.value, "opaque-tool");
  assert.deepEqual(assistant.toolCalls?.[0]?.continuation, {
    providerId: "fake",
    apiDialect: "fake",
    modelId: "fake-model",
    responseId: "resp-1",
    itemId: "fc-1",
    namespace: "dynamic",
  });
  assert.equal(assistant.continuation?.responseId, "resp-1");

  await Array.fromAsync(
    port.stream({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "considered" },
            { type: "text", text: "running" },
          ],
          toolCalls: [{ callId: "call-1", name: "shell", input: {} }],
        },
        {
          role: "tool",
          callId: "call-1",
          name: "shell",
          content: [{ type: "text", text: "done" }],
          isError: false,
        },
        { role: "assistant", content: [{ type: "text", text: "finished" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
      tools: [{ name: "shell", description: "Run", inputSchema: { type: "object" } }],
    }),
  );
  const nextMessages = provider.requests[2]?.messages;
  const secondAssistant = nextMessages?.filter((message) => message.role === "assistant")[1];
  assert.equal(secondAssistant?.role, "assistant");
  if (secondAssistant?.role === "assistant") {
    assert.equal(secondAssistant.origin, undefined);
    assert.equal(secondAssistant.continuation, undefined);
  }
});

test("retains signature-only replay without inventing continuation state", async () => {
  const provider = new FakeModelProvider({
    responses: [
      [
        {
          type: "replay_metadata",
          target: "text",
          contentIndex: 0,
          providerId: "fake",
          apiDialect: "fake",
          modelId: "fake-model",
          signature: "text-signature",
        },
        {
          type: "replay_metadata",
          target: "tool_call",
          contentIndex: 1,
          callId: "call-1",
          providerId: "fake",
          apiDialect: "fake",
          modelId: "fake-model",
          signature: "tool-signature",
        },
        { type: "completed", stopReason: "tool_use", usage },
      ],
      [{ type: "completed", stopReason: "stop", usage }],
    ],
  });
  const port = modelPortForSession(provider, { modelId: "fake-model" });
  await Array.fromAsync(port.stream({ messages: [], tools: [] }));
  await Array.fromAsync(
    port.stream({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "running" }],
          toolCalls: [{ callId: "call-1", name: "shell", input: {} }],
        },
        {
          role: "tool",
          callId: "call-1",
          name: "shell",
          content: [{ type: "text", text: "done" }],
          isError: false,
        },
      ],
      tools: [{ name: "shell", description: "Run", inputSchema: { type: "object" } }],
    }),
  );

  const assistant = provider.requests[1]?.messages[0];
  if (assistant?.role !== "assistant") assert.fail("expected replayed assistant message");
  assert.equal(
    assistant.content[0]?.type === "text" ? assistant.content[0].signature?.value : undefined,
    "text-signature",
  );
  assert.equal(
    assistant.content[0]?.type === "text" ? assistant.content[0].continuation : undefined,
    undefined,
  );
  assert.equal(assistant.toolCalls?.[0]?.signature?.value, "tool-signature");
  assert.equal(assistant.toolCalls?.[0]?.continuation, undefined);
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
