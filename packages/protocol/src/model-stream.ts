// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { JsonObject } from "./event-envelope.ts";
import type {
  AssistantContent,
  AssistantStopReason,
  ThinkingLevel,
  Usage,
  UserContent,
} from "./events.ts";

export interface ModelThinkingSupport {
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string | null>>>;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function supportedThinkingLevels(model: ModelThinkingSupport): readonly ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export interface ToolCallRequest {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonObject;
}

export type ModelMessage =
  | { readonly role: "user"; readonly content: readonly UserContent[] }
  | {
      readonly role: "assistant";
      readonly content: readonly AssistantContent[];
      readonly toolCalls?: readonly ToolCallRequest[];
    }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly content: readonly UserContent[];
      readonly isError: boolean;
    };

export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ProviderRetryGuidance {
  readonly retryAfterMs?: number;
  readonly resetAtEpochMs?: number;
}

/** A deliberately bounded diagnostic shape that cannot carry headers or arbitrary provider data. */
export interface SafeProviderDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "info" | "warning" | "error";
}

/** Provider attribution safe to persist with a canonical response. */
export interface ProviderResponseMetadata {
  readonly providerId: string;
  readonly requestedModelId: string;
  readonly routedModelId?: string;
  readonly responseId?: string;
  readonly nativeStopReason?: string;
  readonly latencyMs?: number;
}

export interface ModelStreamError {
  readonly code: string;
  readonly message: string;
  /** True only when re-dispatching the identical request is known to be safe. */
  readonly retryable: boolean;
  /** True when content was emitted before this failure. */
  readonly partial?: boolean;
  readonly retry?: ProviderRetryGuidance;
  readonly response?: ProviderResponseMetadata;
  readonly diagnostics?: readonly SafeProviderDiagnostic[];
}

interface PositionedContent {
  /** Stable provider-neutral position for interleaved response blocks. */
  readonly contentIndex?: number;
}

/**
 * Canonical model stream shape. Every stream yields zero or more deltas and
 * tool calls, then exactly one terminal event: `completed`, `error`, or
 * `aborted`. Nothing follows a terminal event.
 *
 * Existing adapters may omit `contentIndex`. Adapters that can interleave
 * blocks provide it. A complete `tool_call` remains authoritative, while the
 * start and delta events are optional progress for clients.
 */
export type ModelStreamEvent =
  | ({ readonly type: "text_delta"; readonly text: string } & PositionedContent)
  | ({ readonly type: "thinking_delta"; readonly text: string } & PositionedContent)
  | ({
      readonly type: "tool_call_start";
      readonly contentIndex: number;
      readonly callId: string;
      readonly name: string;
    } & PositionedContent)
  | ({
      readonly type: "tool_call_delta";
      readonly contentIndex: number;
      readonly callId: string;
      readonly argumentsDelta: string;
    } & PositionedContent)
  | ({ readonly type: "tool_call" } & ToolCallRequest & PositionedContent)
  | {
      readonly type: "completed";
      readonly stopReason: AssistantStopReason;
      readonly usage: Usage;
      /** True when the provider intentionally returned usable but incomplete content. */
      readonly partial?: boolean;
      readonly response?: ProviderResponseMetadata;
      readonly diagnostics?: readonly SafeProviderDiagnostic[];
    }
  | ({ readonly type: "error" } & ModelStreamError)
  | { readonly type: "aborted"; readonly partial?: boolean };

export type TerminalModelStreamEvent = Extract<
  ModelStreamEvent,
  { type: "completed" | "error" | "aborted" }
>;

export function isTerminalModelStreamEvent(
  event: ModelStreamEvent,
): event is TerminalModelStreamEvent {
  return event.type === "completed" || event.type === "error" || event.type === "aborted";
}

export class ModelStreamValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path} ${message}`);
    this.name = "ModelStreamValidationError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new ModelStreamValidationError(path, message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not allowed");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  }
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(path, allowEmpty ? "must be a string" : "must be a non-empty string");
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function nonNegativeNumber(value: unknown, path: string, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  ) {
    fail(path, integer ? "must be a non-negative safe integer" : "must be a non-negative number");
  }
  return value;
}

function optionalPosition(value: Record<string, unknown>, path: string): void {
  if (value.contentIndex !== undefined) {
    nonNegativeNumber(value.contentIndex, `${path}.contentIndex`, true);
  }
}

function validateJson(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") fail(path, "must be JSON-compatible");
  if (ancestors.has(value)) fail(path, "must not contain cycles");
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateJson(item, `${path}[${index}]`, next);
    });
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "must be a plain object");
  for (const [key, item] of Object.entries(value)) validateJson(item, `${path}.${key}`, next);
}

function validateUsage(value: unknown, path: string): void {
  const usage = object(value, path);
  exact(
    usage,
    path,
    ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"],
    ["reasoningTokens", "costUsd"],
  );
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    nonNegativeNumber(usage[key], `${path}.${key}`, true);
  }
  if (usage.reasoningTokens !== undefined) {
    nonNegativeNumber(usage.reasoningTokens, `${path}.reasoningTokens`, true);
  }
  if (usage.costUsd !== undefined) nonNegativeNumber(usage.costUsd, `${path}.costUsd`);
}

function validateResponse(value: unknown, path: string): void {
  const response = object(value, path);
  exact(
    response,
    path,
    ["providerId", "requestedModelId"],
    ["routedModelId", "responseId", "nativeStopReason", "latencyMs"],
  );
  string(response.providerId, `${path}.providerId`);
  string(response.requestedModelId, `${path}.requestedModelId`);
  for (const key of ["routedModelId", "responseId", "nativeStopReason"] as const) {
    if (response[key] !== undefined) string(response[key], `${path}.${key}`);
  }
  if (response.latencyMs !== undefined) nonNegativeNumber(response.latencyMs, `${path}.latencyMs`);
}

function validateDiagnostics(value: unknown, path: string): void {
  if (!Array.isArray(value)) fail(path, "must be an array");
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const diagnostic = object(item, itemPath);
    exact(diagnostic, itemPath, ["code", "message", "severity"]);
    string(diagnostic.code, `${itemPath}.code`);
    string(diagnostic.message, `${itemPath}.message`);
    if (!new Set(["info", "warning", "error"]).has(String(diagnostic.severity))) {
      fail(`${itemPath}.severity`, "must be info, warning, or error");
    }
  }
}

function validateTerminalMetadata(event: Record<string, unknown>, path: string): void {
  if (event.partial !== undefined) boolean(event.partial, `${path}.partial`);
  if (event.response !== undefined) validateResponse(event.response, `${path}.response`);
  if (event.diagnostics !== undefined)
    validateDiagnostics(event.diagnostics, `${path}.diagnostics`);
}

/** Validates an untrusted provider event before it crosses into the kernel. */
export function parseModelStreamEvent(value: unknown, path = "modelStreamEvent"): ModelStreamEvent {
  const event = object(value, path);
  const type = string(event.type, `${path}.type`);
  if (type === "text_delta" || type === "thinking_delta") {
    exact(event, path, ["type", "text"], ["contentIndex"]);
    string(event.text, `${path}.text`, true);
    optionalPosition(event, path);
  } else if (type === "tool_call_start") {
    exact(event, path, ["type", "contentIndex", "callId", "name"]);
    nonNegativeNumber(event.contentIndex, `${path}.contentIndex`, true);
    string(event.callId, `${path}.callId`);
    string(event.name, `${path}.name`);
  } else if (type === "tool_call_delta") {
    exact(event, path, ["type", "contentIndex", "callId", "argumentsDelta"]);
    nonNegativeNumber(event.contentIndex, `${path}.contentIndex`, true);
    string(event.callId, `${path}.callId`);
    string(event.argumentsDelta, `${path}.argumentsDelta`, true);
  } else if (type === "tool_call") {
    exact(event, path, ["type", "callId", "name", "input"], ["contentIndex"]);
    string(event.callId, `${path}.callId`);
    string(event.name, `${path}.name`);
    object(event.input, `${path}.input`);
    validateJson(event.input, `${path}.input`);
    optionalPosition(event, path);
  } else if (type === "completed") {
    exact(event, path, ["type", "stopReason", "usage"], ["partial", "response", "diagnostics"]);
    if (
      !new Set(["stop", "length", "tool_use", "error", "aborted"]).has(String(event.stopReason))
    ) {
      fail(`${path}.stopReason`, "is not recognized");
    }
    validateUsage(event.usage, `${path}.usage`);
    validateTerminalMetadata(event, path);
  } else if (type === "error") {
    exact(
      event,
      path,
      ["type", "code", "message", "retryable"],
      ["partial", "retry", "response", "diagnostics"],
    );
    string(event.code, `${path}.code`);
    string(event.message, `${path}.message`);
    boolean(event.retryable, `${path}.retryable`);
    validateTerminalMetadata(event, path);
    if (event.retry !== undefined) {
      const retry = object(event.retry, `${path}.retry`);
      exact(retry, `${path}.retry`, [], ["retryAfterMs", "resetAtEpochMs"]);
      if (retry.retryAfterMs !== undefined) {
        nonNegativeNumber(retry.retryAfterMs, `${path}.retry.retryAfterMs`, true);
      }
      if (retry.resetAtEpochMs !== undefined) {
        nonNegativeNumber(retry.resetAtEpochMs, `${path}.retry.resetAtEpochMs`, true);
      }
      if (retry.retryAfterMs === undefined && retry.resetAtEpochMs === undefined) {
        fail(`${path}.retry`, "must contain retryAfterMs or resetAtEpochMs");
      }
    }
  } else if (type === "aborted") {
    exact(event, path, ["type"], ["partial"]);
    if (event.partial !== undefined) boolean(event.partial, `${path}.partial`);
  } else {
    fail(`${path}.type`, "is not recognized");
  }
  return value as ModelStreamEvent;
}
