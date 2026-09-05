// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

// Transport-neutral codec for OpenRouter's buffered image generation API.

import { createHash } from "node:crypto";

import {
  parseBlobReference,
  type BlobReference,
  type JsonObject,
  type JsonValue,
  type ModelErrorCategory,
  type Usage,
} from "@axl/protocol";

import { safeProviderMessage } from "./diagnostics.ts";
import type { ImageGenerationRequest, ImageGenerationResult, ImageModelInfo } from "./model.ts";
import { withUsageCost } from "./usage.ts";

const OPENROUTER_IMAGE_DIALECT = "openrouter-images";
const MAX_INPUT_REFERENCES = 16;
const MAX_OUTPUT_IMAGES = 10;
const ASPECT_RATIOS = new Set([
  "1:1",
  "1:2",
  "1:4",
  "1:8",
  "2:1",
  "2:3",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:4",
  "8:1",
  "9:16",
  "16:9",
  "9:19.5",
  "19.5:9",
  "9:20",
  "20:9",
  "9:21",
  "21:9",
  "auto",
]);

export class OpenRouterImageCodecError extends Error {
  readonly code: string;
  readonly category: ModelErrorCategory;
  readonly retryable: boolean;
  readonly aborted: boolean;

  constructor(
    code: string,
    message: string,
    options: {
      readonly category?: ModelErrorCategory;
      readonly retryable?: boolean;
      readonly aborted?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "OpenRouterImageCodecError";
    this.code = code;
    this.category = options.category ?? "provider_internal";
    this.retryable = options.retryable ?? false;
    this.aborted = options.aborted ?? false;
  }
}

export interface EncodedOpenRouterImageRequest {
  readonly body: JsonObject;
}

export interface OpenRouterImageDecodeOptions {
  readonly model: ImageModelInfo;
  readonly request: ImageGenerationRequest;
  readonly secretValues?: readonly string[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function inputError(message: string): never {
  throw new OpenRouterImageCodecError("invalid_image_request", message, {
    category: "invalid_request",
  });
}

function responseError(message: string): never {
  throw new OpenRouterImageCodecError("malformed_image_response", message);
}

function checkCancellation(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new OpenRouterImageCodecError("request_aborted", "Image generation was cancelled", {
      aborted: true,
    });
  }
}

function validateModel(model: ImageModelInfo, request: ImageGenerationRequest): void {
  if (model.apiDialect !== OPENROUTER_IMAGE_DIALECT) {
    inputError(`Model ${model.modelId} does not use the OpenRouter image dialect`);
  }
  if (model.providerId !== "openrouter") {
    inputError(`Model ${model.modelId} is not owned by OpenRouter`);
  }
  if (request.modelId !== model.modelId) {
    inputError(`Request model ${request.modelId} does not match ${model.modelId}`);
  }
  if (!model.input.includes("text") || !model.output.includes("image")) {
    inputError(`Model ${model.modelId} does not support text to image generation`);
  }
  if (model.availability?.status === "unavailable") {
    inputError(`Model ${model.modelId} is unavailable`);
  }
}

function validateRequest(request: ImageGenerationRequest): void {
  if (typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
    inputError("Image prompt must be a non-empty string");
  }
  if (
    request.count !== undefined &&
    (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > MAX_OUTPUT_IMAGES)
  ) {
    inputError(`Image count must be an integer from 1 to ${MAX_OUTPUT_IMAGES}`);
  }
  if (request.size !== undefined) {
    if (
      !Number.isSafeInteger(request.size.width) ||
      request.size.width <= 0 ||
      !Number.isSafeInteger(request.size.height) ||
      request.size.height <= 0
    ) {
      inputError("Image size must contain positive safe integer dimensions");
    }
  }
  if (request.aspectRatio !== undefined && !ASPECT_RATIOS.has(request.aspectRatio)) {
    inputError(`Image aspect ratio ${request.aspectRatio} is unsupported`);
  }
  if (
    request.size !== undefined &&
    request.aspectRatio !== undefined &&
    request.aspectRatio !== "auto"
  ) {
    const [width, height] = request.aspectRatio.split(":").map(Number);
    const requestedRatio = request.size.width / request.size.height;
    if (
      width === undefined ||
      height === undefined ||
      Math.abs(requestedRatio - width / height) > 1e-9
    ) {
      inputError("Image size and aspect ratio are inconsistent");
    }
  }
  if (request.inputImages !== undefined && request.inputImages.length > MAX_INPUT_REFERENCES) {
    inputError(`OpenRouter accepts at most ${MAX_INPUT_REFERENCES} input images`);
  }
  if (request.metadata !== undefined) {
    inputError("OpenRouter image generation cannot render request metadata");
  }
  if (typeof request.writeBlob !== "function") inputError("Image blob writer must be a function");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function encodeInputReferences(
  model: ImageModelInfo,
  request: ImageGenerationRequest,
): Promise<JsonValue[] | undefined> {
  const references = request.inputImages;
  if (references === undefined || references.length === 0) return undefined;
  if (!model.input.includes("image"))
    inputError(`Model ${model.modelId} does not support image input`);
  if (request.readBlob === undefined) inputError("Image blob reader is required for input images");

  const encoded: JsonValue[] = [];
  for (const [index, rawReference] of references.entries()) {
    checkCancellation(request.signal);
    let reference: BlobReference;
    try {
      reference = parseBlobReference(rawReference, `request.inputImages[${index}]`);
    } catch (error) {
      inputError(error instanceof Error ? error.message : `Input image ${index} is malformed`);
    }
    if (!reference.mediaType.startsWith("image/")) {
      inputError(`Input image ${index} must have an image media type`);
    }
    const bytes = await request.readBlob(reference);
    checkCancellation(request.signal);
    if (!(bytes instanceof Uint8Array)) inputError(`Input image ${index} loader must return bytes`);
    if (bytes.byteLength !== reference.sizeBytes || digest(bytes) !== reference.sha256) {
      inputError(`Input image ${index} does not match its content address`);
    }
    encoded.push({
      type: "image_url",
      image_url: {
        url: `data:${reference.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
      },
    });
  }
  return encoded;
}

/** Encodes one validated request for the buffered OpenRouter image endpoint. */
export async function encodeOpenRouterImageRequest(
  model: ImageModelInfo,
  request: ImageGenerationRequest,
): Promise<EncodedOpenRouterImageRequest> {
  checkCancellation(request.signal);
  validateModel(model, request);
  validateRequest(request);
  const inputReferences = await encodeInputReferences(model, request);
  const body: Record<string, JsonValue> = {
    model: model.modelId,
    prompt: request.prompt,
  };
  if (request.count !== undefined) body.n = request.count;
  if (request.size !== undefined) body.size = `${request.size.width}x${request.size.height}`;
  if (request.aspectRatio !== undefined) body.aspect_ratio = request.aspectRatio;
  if (inputReferences !== undefined) body.input_references = inputReferences;
  return { body };
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    responseError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    responseError(`${label} must be a non-negative number`);
  }
  return value;
}

function parseUsage(raw: unknown, model: ImageModelInfo): Usage | undefined {
  if (raw === undefined) return undefined;
  const value = object(raw);
  if (value === undefined) responseError("OpenRouter image usage must be an object");
  const prompt =
    value.prompt_tokens === undefined
      ? 0
      : nonNegativeInteger(value.prompt_tokens, "OpenRouter prompt tokens");
  const output =
    value.completion_tokens === undefined
      ? 0
      : nonNegativeInteger(value.completion_tokens, "OpenRouter completion tokens");
  const promptDetails = object(value.prompt_tokens_details);
  if (value.prompt_tokens_details !== undefined && promptDetails === undefined) {
    responseError("OpenRouter prompt token details must be an object");
  }
  const completionDetails = object(value.completion_tokens_details);
  if (value.completion_tokens_details !== undefined && completionDetails === undefined) {
    responseError("OpenRouter completion token details must be an object");
  }
  const reportedCached =
    promptDetails?.cached_tokens === undefined
      ? 0
      : nonNegativeInteger(promptDetails.cached_tokens, "OpenRouter cached tokens");
  const cacheWrite =
    promptDetails?.cache_write_tokens === undefined
      ? 0
      : nonNegativeInteger(promptDetails.cache_write_tokens, "OpenRouter cache write tokens");
  const cacheRead = cacheWrite > 0 ? Math.max(0, reportedCached - cacheWrite) : reportedCached;
  const reasoning =
    completionDetails?.reasoning_tokens === undefined
      ? 0
      : nonNegativeInteger(completionDetails.reasoning_tokens, "OpenRouter reasoning tokens");
  if (value.total_tokens !== undefined) {
    nonNegativeInteger(value.total_tokens, "OpenRouter total tokens");
  }
  const usage: Usage = {
    inputTokens: Math.max(0, prompt - cacheRead - cacheWrite),
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
  };
  if (value.cost !== undefined) {
    return { ...usage, costUsd: nonNegativeNumber(value.cost, "OpenRouter image cost") };
  }
  return model.cost === undefined ? usage : withUsageCost(model.cost, usage);
}

function decodeBase64(value: unknown, index: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    responseError(`OpenRouter image ${index} has no base64 data`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    responseError(`OpenRouter image ${index} has malformed base64 data`);
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (bytes.length === 0) responseError(`OpenRouter image ${index} decoded to empty data`);
  const normalizedInput = value.replace(/=+$/, "");
  const normalizedOutput = Buffer.from(bytes).toString("base64").replace(/=+$/, "");
  if (normalizedInput !== normalizedOutput) {
    responseError(`OpenRouter image ${index} has malformed base64 data`);
  }
  return bytes;
}

function inferredMediaType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const prefix = Buffer.from(bytes.subarray(0, 16)).toString("ascii");
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "image/webp";
  const textPrefix = Buffer.from(bytes.subarray(0, 256)).toString("utf8").trimStart();
  if (textPrefix.startsWith("<svg") || /^<\?xml[^>]*>\s*<svg/.test(textPrefix)) {
    return "image/svg+xml";
  }
  return undefined;
}

function mediaType(value: unknown, bytes: Uint8Array, index: number): string {
  if (value === undefined) {
    const inferred = inferredMediaType(bytes);
    if (inferred === undefined)
      responseError(`OpenRouter image ${index} has no identifiable media type`);
    return inferred;
  }
  if (typeof value !== "string" || !/^image\/[A-Za-z0-9.+-]+$/.test(value)) {
    responseError(`OpenRouter image ${index} has an invalid media type`);
  }
  return value;
}

function providerFailure(
  raw: Record<string, unknown>,
  secretValues: readonly string[] | undefined,
): never {
  const details = object(raw.error);
  const rawCode = details?.code ?? details?.type ?? raw.code ?? "openrouter_image_error";
  const code =
    typeof rawCode === "string" && rawCode.length > 0 ? rawCode : "openrouter_image_error";
  const rawMessage =
    typeof details?.message === "string"
      ? details.message
      : typeof raw.error === "string"
        ? raw.error
        : typeof raw.message === "string"
          ? raw.message
          : "OpenRouter image generation failed";
  const normalizedCode = code.toLowerCase();
  const category: ModelErrorCategory = normalizedCode.includes("rate")
    ? "rate_limit"
    : normalizedCode.includes("overload")
      ? "overloaded"
      : normalizedCode.includes("auth")
        ? "authentication"
        : normalizedCode.includes("permission") || normalizedCode.includes("forbidden")
          ? "authorization"
          : normalizedCode.includes("invalid")
            ? "invalid_request"
            : normalizedCode.includes("content") || normalizedCode.includes("safety")
              ? "content_policy"
              : normalizedCode.includes("timeout")
                ? "timeout"
                : normalizedCode.includes("network")
                  ? "network"
                  : "provider_internal";
  throw new OpenRouterImageCodecError(code, safeProviderMessage(rawMessage, secretValues), {
    category,
    retryable:
      category === "rate_limit" ||
      category === "overloaded" ||
      category === "timeout" ||
      category === "network",
  });
}

async function validateWrittenBlob(
  rawReference: BlobReference,
  bytes: Uint8Array,
  expectedMediaType: string,
  index: number,
): Promise<BlobReference> {
  let reference: BlobReference;
  try {
    reference = parseBlobReference(rawReference, `imageResult.images[${index}]`);
  } catch (error) {
    responseError(error instanceof Error ? error.message : `Stored image ${index} is malformed`);
  }
  if (
    reference.sizeBytes !== bytes.length ||
    reference.sha256 !== digest(bytes) ||
    reference.mediaType !== expectedMediaType
  ) {
    responseError(`Stored image ${index} does not match the generated bytes`);
  }
  return reference;
}

/** Decodes and stores one buffered OpenRouter image response. */
export async function decodeOpenRouterImageResponse(
  rawResponse: unknown,
  options: OpenRouterImageDecodeOptions,
): Promise<ImageGenerationResult> {
  checkCancellation(options.request.signal);
  validateModel(options.model, options.request);
  validateRequest(options.request);
  const response = object(rawResponse);
  if (response === undefined) responseError("OpenRouter image response must be an object");
  if (response.error !== undefined) providerFailure(response, options.secretValues);
  if (!Array.isArray(response.data) || response.data.length === 0) {
    responseError("OpenRouter image response contains no images");
  }
  if (response.data.length > MAX_OUTPUT_IMAGES) {
    responseError(`OpenRouter image response exceeds ${MAX_OUTPUT_IMAGES} images`);
  }

  const responseId = response.id ?? response.response_id;
  if (responseId !== undefined && (typeof responseId !== "string" || responseId.length === 0)) {
    responseError("OpenRouter image response ID must be a non-empty string");
  }
  const routedModelId = response.model;
  if (
    routedModelId !== undefined &&
    (typeof routedModelId !== "string" || routedModelId.length === 0)
  ) {
    responseError("OpenRouter routed model must be a non-empty string");
  }

  const images: BlobReference[] = [];
  const revisedPrompts = new Set<string>();
  for (const [index, rawImage] of response.data.entries()) {
    checkCancellation(options.request.signal);
    const image = object(rawImage);
    if (image === undefined) responseError(`OpenRouter image ${index} must be an object`);
    const bytes = decodeBase64(image.b64_json, index);
    const imageMediaType = mediaType(image.media_type, bytes, index);
    if (image.revised_prompt !== undefined) {
      if (typeof image.revised_prompt !== "string" || image.revised_prompt.length === 0) {
        responseError(`OpenRouter image ${index} has an invalid revised prompt`);
      }
      revisedPrompts.add(image.revised_prompt);
    }
    const written = await options.request.writeBlob(bytes, { mediaType: imageMediaType });
    checkCancellation(options.request.signal);
    images.push(await validateWrittenBlob(written, bytes, imageMediaType, index));
  }
  if (revisedPrompts.size > 1) {
    responseError("OpenRouter returned conflicting revised prompts");
  }

  const usage = parseUsage(response.usage, options.model);
  return {
    providerId: options.model.providerId,
    requestedModelId: options.request.modelId,
    ...(routedModelId === undefined || routedModelId === options.request.modelId
      ? {}
      : { routedModelId }),
    ...(responseId === undefined ? {} : { responseId }),
    images,
    ...(revisedPrompts.size === 0 ? {} : { revisedPrompt: [...revisedPrompts][0] }),
    ...(usage === undefined ? {} : { usage }),
  };
}
