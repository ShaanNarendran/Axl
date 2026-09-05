// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  isTerminalModelStreamEvent,
  ModelStreamValidationError,
  parseModelStreamEvent,
} from "../src/index.ts";

const usage = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 };

test("validates positioned content and partial tool progress", () => {
  assert.deepEqual(parseModelStreamEvent({ type: "text_delta", text: "answer", contentIndex: 2 }), {
    type: "text_delta",
    text: "answer",
    contentIndex: 2,
  });
  assert.deepEqual(
    parseModelStreamEvent({
      type: "tool_call_start",
      contentIndex: 3,
      callId: "call-1",
      name: "read",
    }),
    { type: "tool_call_start", contentIndex: 3, callId: "call-1", name: "read" },
  );
  assert.deepEqual(
    parseModelStreamEvent({
      type: "tool_call_delta",
      contentIndex: 3,
      callId: "call-1",
      argumentsDelta: '{"path":',
    }),
    {
      type: "tool_call_delta",
      contentIndex: 3,
      callId: "call-1",
      argumentsDelta: '{"path":',
    },
  );
});

test("validates provenance-bound replay metadata", () => {
  const replay = parseModelStreamEvent({
    type: "replay_metadata",
    target: "thinking",
    contentIndex: 1,
    providerId: "openai",
    apiDialect: "openai-responses",
    modelId: "gpt-5",
    signature: '{"type":"reasoning","encrypted_content":"opaque"}',
    responseId: "resp-1",
    itemId: "rs-1",
  });
  assert.deepEqual(replay, {
    type: "replay_metadata",
    target: "thinking",
    contentIndex: 1,
    providerId: "openai",
    apiDialect: "openai-responses",
    modelId: "gpt-5",
    signature: '{"type":"reasoning","encrypted_content":"opaque"}',
    responseId: "resp-1",
    itemId: "rs-1",
  });
  assert.equal(isTerminalModelStreamEvent(replay), false);

  assert.deepEqual(
    parseModelStreamEvent({
      type: "replay_metadata",
      target: "thinking",
      contentIndex: 0,
      providerId: "anthropic",
      apiDialect: "anthropic-messages",
      modelId: "claude-fixture",
      signature: "opaque-redacted-thinking",
      redacted: true,
    }),
    {
      type: "replay_metadata",
      target: "thinking",
      contentIndex: 0,
      providerId: "anthropic",
      apiDialect: "anthropic-messages",
      modelId: "claude-fixture",
      signature: "opaque-redacted-thinking",
      redacted: true,
    },
  );

  assert.deepEqual(
    parseModelStreamEvent({
      type: "replay_metadata",
      target: "tool_call",
      contentIndex: 2,
      providerId: "openai",
      apiDialect: "openai-responses",
      modelId: "gpt-5",
      callId: "call-1",
      itemId: "fc-1",
      namespace: "tools",
    }),
    {
      type: "replay_metadata",
      target: "tool_call",
      contentIndex: 2,
      providerId: "openai",
      apiDialect: "openai-responses",
      modelId: "gpt-5",
      callId: "call-1",
      itemId: "fc-1",
      namespace: "tools",
    },
  );
});

test("validates safe response attribution and retry guidance", () => {
  const completed = parseModelStreamEvent({
    type: "completed",
    stopReason: "stop",
    usage,
    partial: true,
    response: {
      providerId: "gateway",
      requestedModelId: "auto",
      routedModelId: "vendor/model",
      responseId: "response-1",
      nativeStopReason: "end_turn",
      latencyMs: 12.5,
    },
    diagnostics: [
      { code: "route_changed", message: "A routed model served the request", severity: "info" },
    ],
  });
  assert.equal(isTerminalModelStreamEvent(completed), true);

  const failed = parseModelStreamEvent({
    type: "error",
    code: "rate_limited",
    message: "Try later",
    retryable: true,
    partial: false,
    retry: { retryAfterMs: 500, resetAtEpochMs: 2_000 },
  });
  assert.equal(isTerminalModelStreamEvent(failed), true);
});

test("rejects malformed stream data and unbounded diagnostic fields", () => {
  assert.throws(
    () => parseModelStreamEvent({ type: "text_delta", text: "x", contentIndex: -1 }),
    ModelStreamValidationError,
  );
  assert.throws(
    () =>
      parseModelStreamEvent({
        type: "error",
        code: "failed",
        message: "failed",
        retryable: false,
        diagnostics: [
          {
            code: "unsafe",
            message: "unsafe",
            severity: "error",
            authorization: "Bearer secret",
          },
        ],
      }),
    /authorization is not allowed/,
  );
  assert.throws(
    () =>
      parseModelStreamEvent({
        type: "error",
        code: "rate_limited",
        message: "wait",
        retryable: true,
        retry: {},
      }),
    /must contain retryAfterMs or resetAtEpochMs/,
  );
  assert.throws(
    () =>
      parseModelStreamEvent({
        type: "tool_call",
        callId: "call-1",
        name: "read",
        input: { invalid: Number.NaN },
      }),
    /JSON-compatible/,
  );
  assert.throws(
    () =>
      parseModelStreamEvent({
        type: "replay_metadata",
        target: "thinking",
        contentIndex: 0,
        providerId: "openai",
        apiDialect: "openai-responses",
        modelId: "gpt-5",
      }),
    /must contain replay data/,
  );
  assert.throws(
    () =>
      parseModelStreamEvent({
        type: "replay_metadata",
        target: "text",
        contentIndex: 0,
        providerId: "anthropic",
        apiDialect: "anthropic-messages",
        modelId: "claude-fixture",
        signature: "opaque",
        redacted: true,
      }),
    /redacted is allowed only/,
  );
  assert.throws(
    () =>
      parseModelStreamEvent({
        type: "replay_metadata",
        target: "tool_call",
        contentIndex: 0,
        providerId: "openai",
        apiDialect: "openai-responses",
        modelId: "gpt-5",
        itemId: "fc-1",
      }),
    /callId is required/,
  );
  assert.throws(
    () =>
      parseModelStreamEvent({
        type: "replay_metadata",
        target: "text",
        contentIndex: 0,
        providerId: "openai",
        apiDialect: "openai-responses",
        modelId: "gpt-5",
        callId: "call-1",
        itemId: "msg-1",
      }),
    /callId is allowed only/,
  );
});

test("preserves the existing terminal event forms", () => {
  assert.deepEqual(parseModelStreamEvent({ type: "completed", stopReason: "stop", usage }), {
    type: "completed",
    stopReason: "stop",
    usage,
  });
  assert.deepEqual(parseModelStreamEvent({ type: "aborted" }), { type: "aborted" });
});
