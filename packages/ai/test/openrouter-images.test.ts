// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { BlobReference } from "@axl/protocol";

import {
  decodeOpenRouterImageResponse,
  encodeOpenRouterImageRequest,
  OpenRouterImageCodecError,
  type ImageGenerationRequest,
  type ImageModelInfo,
} from "../src/index.ts";

function imageModel(overrides: Partial<ImageModelInfo> = {}): ImageModelInfo {
  return {
    providerId: "openrouter",
    modelId: "google/gemini-image",
    displayName: "Gemini Image",
    apiDialect: "openrouter-images",
    input: ["text", "image"],
    output: ["image"],
    cost: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
    ...overrides,
  };
}

function blob(bytes: Uint8Array, mediaType = "image/png"): BlobReference {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mediaType,
    sizeBytes: bytes.length,
  };
}

function request(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    modelId: "google/gemini-image",
    prompt: "Paint a quiet harbor",
    writeBlob: async (bytes, metadata) => blob(bytes, metadata.mediaType),
    ...overrides,
  };
}

const pngOne = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const pngTwo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);

test("encodes prompt, verified image inputs, count, size, and aspect ratio", async () => {
  const input = new Uint8Array([1, 2, 3]);
  const reference = blob(input, "image/jpeg");
  let reads = 0;
  const encoded = await encodeOpenRouterImageRequest(
    imageModel(),
    request({
      inputImages: [reference],
      count: 2,
      size: { width: 1024, height: 1024 },
      aspectRatio: "1:1",
      readBlob: async (requested) => {
        reads += 1;
        assert.deepEqual(requested, reference);
        return input;
      },
    }),
  );

  assert.equal(reads, 1);
  assert.deepEqual(encoded.body, {
    model: "google/gemini-image",
    prompt: "Paint a quiet harbor",
    n: 2,
    size: "1024x1024",
    aspect_ratio: "1:1",
    input_references: [
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,AQID" },
      },
    ],
  });
});

test("encodes text-only requests without optional image fields", async () => {
  const encoded = await encodeOpenRouterImageRequest(imageModel({ input: ["text"] }), request());
  assert.deepEqual(encoded.body, {
    model: "google/gemini-image",
    prompt: "Paint a quiet harbor",
  });
});

test("stores multiple images and returns usage, cost, revised prompt, and response identity", async () => {
  const writes: Array<{ bytes: Uint8Array; mediaType: string }> = [];
  const imageRequest = request({
    count: 2,
    writeBlob: async (bytes, metadata) => {
      writes.push({ bytes: new Uint8Array(bytes), mediaType: metadata.mediaType });
      return blob(bytes, metadata.mediaType);
    },
  });
  const raw = {
    id: "generation-1",
    model: "google/gemini-image-routed",
    created: 1_748_372_400,
    data: [
      {
        b64_json: Buffer.from(pngOne).toString("base64"),
        media_type: "image/png",
        revised_prompt: "A detailed quiet harbor",
      },
      {
        b64_json: Buffer.from(pngTwo).toString("base64"),
        revised_prompt: "A detailed quiet harbor",
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 20,
      total_tokens: 32,
      prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 },
      completion_tokens_details: { reasoning_tokens: 2 },
      cost: 0.25,
    },
  };

  const result = await decodeOpenRouterImageResponse(raw, {
    model: imageModel(),
    request: imageRequest,
  });

  assert.deepEqual(writes, [
    { bytes: pngOne, mediaType: "image/png" },
    { bytes: pngTwo, mediaType: "image/png" },
  ]);
  assert.deepEqual(result, {
    providerId: "openrouter",
    requestedModelId: "google/gemini-image",
    routedModelId: "google/gemini-image-routed",
    responseId: "generation-1",
    images: [blob(pngOne), blob(pngTwo)],
    revisedPrompt: "A detailed quiet harbor",
    usage: {
      inputTokens: 8,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      reasoningTokens: 2,
      costUsd: 0.25,
    },
  });
});

test("computes catalog cost only when OpenRouter omits authoritative cost", async () => {
  const result = await decodeOpenRouterImageResponse(
    {
      data: [{ b64_json: Buffer.from(pngOne).toString("base64"), media_type: "image/png" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    { model: imageModel(), request: request() },
  );
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.00002,
  });
});

test("redacts provider failures and preserves their retry classification", async () => {
  const secret = "openrouter-secret";
  await assert.rejects(
    decodeOpenRouterImageResponse(
      { error: { code: "rate_limit_exceeded", message: `${secret} has no credits` } },
      { model: imageModel(), request: request(), secretValues: [secret] },
    ),
    (error: unknown) => {
      assert.ok(error instanceof OpenRouterImageCodecError);
      assert.equal(error.code, "rate_limit_exceeded");
      assert.equal(error.message, "[REDACTED] has no credits");
      assert.equal(error.category, "rate_limit");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("honors cancellation before input reads and after generated blob writes", async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    encodeOpenRouterImageRequest(imageModel(), request({ signal: before.signal })),
    (error: unknown) => error instanceof OpenRouterImageCodecError && error.aborted,
  );

  const during = new AbortController();
  await assert.rejects(
    decodeOpenRouterImageResponse(
      { data: [{ b64_json: Buffer.from(pngOne).toString("base64"), media_type: "image/png" }] },
      {
        model: imageModel(),
        request: request({
          signal: during.signal,
          writeBlob: async (bytes, metadata) => {
            during.abort();
            return blob(bytes, metadata.mediaType);
          },
        }),
      },
    ),
    (error: unknown) => error instanceof OpenRouterImageCodecError && error.aborted,
  );
});

test("rejects malformed requests, responses, and blob boundary violations", async () => {
  await assert.rejects(
    encodeOpenRouterImageRequest(imageModel(), request({ count: 11 })),
    /count must be an integer from 1 to 10/,
  );
  await assert.rejects(
    encodeOpenRouterImageRequest(
      imageModel(),
      request({ size: { width: 1024, height: 512 }, aspectRatio: "1:1" }),
    ),
    /size and aspect ratio are inconsistent/,
  );
  await assert.rejects(
    encodeOpenRouterImageRequest(
      imageModel(),
      request({
        inputImages: [blob(new Uint8Array([1]))],
        readBlob: async () => new Uint8Array([2]),
      }),
    ),
    /does not match its content address/,
  );
  await assert.rejects(
    decodeOpenRouterImageResponse(
      { data: [{ b64_json: "not base64" }] },
      {
        model: imageModel(),
        request: request(),
      },
    ),
    /malformed base64 data/,
  );
  await assert.rejects(
    decodeOpenRouterImageResponse(
      { data: [{ b64_json: Buffer.from(pngOne).toString("base64"), media_type: "image/png" }] },
      {
        model: imageModel(),
        request: request({
          writeBlob: async () => ({
            sha256: "a".repeat(64),
            mediaType: "image/png",
            sizeBytes: pngOne.length,
          }),
        }),
      },
    ),
    /does not match the generated bytes/,
  );
  await assert.rejects(
    decodeOpenRouterImageResponse({ data: [] }, { model: imageModel(), request: request() }),
    /contains no images/,
  );
});
