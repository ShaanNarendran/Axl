// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

// OpenAI Codex subscription policy around the shared Responses codec.

import type { JsonObject, JsonValue } from "@axl/protocol";

import type { ResolvedAuth } from "./auth.ts";
import type { ModelInfo } from "./model.ts";
import {
  decodeResponsesStream,
  encodeResponsesRequest,
  ResponsesCodecError,
  type ResponsesDecodeOptions,
} from "./openai-responses.ts";
import { isPreparedModelRequest, type PreparedModelRequest } from "./request-preparation.ts";
import type { SseFrame } from "./sse.ts";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const REQUIRED_CODEX_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "originator",
  "user-agent",
  "openai-beta",
  "accept",
  "content-type",
  "session-id",
  "x-client-request-id",
]);

export class OpenAiCodexResponsesCodecError extends ResponsesCodecError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpenAiCodexResponsesCodecError";
  }
}

export interface EncodedOpenAiCodexResponsesRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonObject;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireCodex(model: ModelInfo, request: PreparedModelRequest): void {
  if (model.apiDialect !== "openai-codex-responses") {
    throw new OpenAiCodexResponsesCodecError(
      `Model ${model.modelId} does not use the OpenAI Codex Responses dialect`,
    );
  }
  if (!isPreparedModelRequest(request)) {
    throw new OpenAiCodexResponsesCodecError(
      "OpenAI Codex Responses requires a prepared model request",
    );
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

/** Extracts the subscription account identity from an OpenAI access token. */
export function extractOpenAiCodexAccountId(token: string): string {
  try {
    const segments = token.split(".");
    if (segments.length !== 3 || segments[1] === undefined) throw new Error("invalid JWT");
    const payload = record(JSON.parse(decodeBase64Url(segments[1])) as unknown);
    const auth = record(payload?.[CODEX_ACCOUNT_CLAIM]);
    const accountId = auth?.chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.trim().length === 0) {
      throw new Error("missing account claim");
    }
    return accountId;
  } catch (cause) {
    throw new OpenAiCodexResponsesCodecError(
      "OpenAI Codex access token has no valid ChatGPT account identity",
      { cause },
    );
  }
}

/** Resolves the Codex Responses endpoint without guessing proxy path rewrites. */
export function openAiCodexResponsesUrl(baseUrl?: string): string {
  const base = (baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(base);
  } catch (cause) {
    throw new OpenAiCodexResponsesCodecError(`Invalid OpenAI Codex base URL: ${baseUrl}`, {
      cause,
    });
  }
  if (url.pathname.endsWith("/codex/responses")) return url.toString();
  if (url.pathname.endsWith("/codex")) url.pathname = `${url.pathname}/responses`;
  else url.pathname = `${url.pathname}/codex/responses`;
  return url.toString();
}

function modelBaseUrl(model: ModelInfo): string | undefined {
  return model.endpoint?.type === "fixed" ? model.endpoint.baseUrl : undefined;
}

function composeHeaders(
  model: ModelInfo,
  request: PreparedModelRequest,
  resolved: ResolvedAuth,
): Readonly<Record<string, string>> {
  const token = resolved.auth.apiKey;
  if (token === undefined || token.length === 0) {
    throw new OpenAiCodexResponsesCodecError("OpenAI Codex requires a resolved subscription token");
  }
  const headers: Record<string, string> = {};
  for (const source of [model.headers, resolved.auth.headers]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      const normalized = name.toLowerCase();
      if (!REQUIRED_CODEX_HEADERS.has(normalized)) headers[normalized] = value;
    }
  }
  headers.authorization = `Bearer ${token}`;
  headers["chatgpt-account-id"] = extractOpenAiCodexAccountId(token);
  headers.originator = "axl";
  headers["user-agent"] = "axl";
  headers["openai-beta"] = "responses=experimental";
  headers.accept = "text/event-stream";
  headers["content-type"] = "application/json";

  const sessionId = request.preparation.cache.sessionId;
  if (sessionId !== undefined) {
    const clamped = Array.from(sessionId).slice(0, 64).join("");
    headers["session-id"] = clamped;
    headers["x-client-request-id"] = clamped;
  }
  return headers;
}

function codexTools(tools: JsonValue | undefined): JsonValue | undefined {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool): JsonValue => {
    const value = record(tool);
    if (value?.type !== "function" || value.strict === true) return tool;
    return { ...(tool as JsonObject), strict: null };
  });
}

/** Composes a stateless Codex request from one immutable prepared request. */
export function encodeOpenAiCodexResponsesRequest(
  model: ModelInfo,
  request: PreparedModelRequest,
  resolved: ResolvedAuth,
): EncodedOpenAiCodexResponsesRequest {
  requireCodex(model, request);
  const shared = encodeResponsesRequest(model, request);
  const body: Record<string, JsonValue> = {
    ...shared.body,
    instructions: request.system || "You are a helpful assistant.",
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
    tool_choice: request.toolChoice ?? "auto",
    parallel_tool_calls: true,
  };
  const tools = codexTools(body.tools);
  if (tools !== undefined) body.tools = tools;

  return {
    url: openAiCodexResponsesUrl(resolved.auth.baseUrl ?? modelBaseUrl(model)),
    headers: composeHeaders(model, request, resolved),
    body,
  };
}

async function* mapCodexFrames(frames: AsyncIterable<SseFrame>): AsyncGenerator<SseFrame> {
  for await (const frame of frames) {
    if (frame.data === "[DONE]") {
      yield frame;
      continue;
    }
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(frame.data) as unknown);
    } catch {
      yield frame;
      continue;
    }
    if (event?.type !== "response.done") {
      yield frame;
      continue;
    }
    const response = record(event.response);
    const status = response?.status;
    if (status === "completed") {
      yield { ...frame, data: JSON.stringify({ ...event, type: "response.completed" }) };
      return;
    }
    if (status === "incomplete") {
      yield { ...frame, data: JSON.stringify({ ...event, type: "response.incomplete" }) };
      return;
    }
    if (status === "failed" || status === "cancelled") {
      yield { ...frame, data: JSON.stringify({ ...event, type: "response.failed" }) };
      return;
    }
    throw new OpenAiCodexResponsesCodecError(
      "OpenAI Codex response.done has no supported terminal status",
    );
  }
}

/** Decodes Codex event aliases through the canonical shared Responses decoder. */
export async function* decodeOpenAiCodexResponsesStream(
  frames: AsyncIterable<SseFrame>,
  options: ResponsesDecodeOptions,
): AsyncGenerator<import("@axl/protocol").ModelStreamEvent, void, undefined> {
  requireCodex(options.model, options.request);
  yield* decodeResponsesStream(mapCodexFrames(frames), options);
}
