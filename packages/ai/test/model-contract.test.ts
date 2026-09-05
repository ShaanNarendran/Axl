// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { BlobReference } from "@axl/protocol";

import {
  collectModelStream,
  type ModelInfo,
  type ModelProvider,
  makeFakeModelInfo,
  modelCostRates,
  safeProviderDiagnostic,
  safeProviderMessage,
  usageCostUsd,
} from "../src/index.ts";

const tieredCost = {
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 2,
  tiers: [
    { inputTokensAbove: 100_000, inputUsdPerMTok: 2, outputUsdPerMTok: 3 },
    { inputTokensAbove: 200_000, inputUsdPerMTok: 4, outputUsdPerMTok: 5 },
  ],
} as const;

test("model metadata carries typed dialect policy and compatibility", () => {
  const model: ModelInfo = makeFakeModelInfo({
    apiDialect: "openai-chat",
    cache: {
      supported: true,
      defaultRetention: "short",
      supportedRetentions: ["none", "short", "long"],
    },
    endpoint: {
      type: "template",
      template: "https://{account}.example.test/{gateway}",
      variables: [
        { name: "account", setting: "accountId", required: true },
        { name: "gateway", setting: "gatewayId", required: true },
      ],
    },
    availability: { status: "preview", reason: "Limited region availability" },
    compatibility: {
      dialect: "openai-chat",
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "openrouter",
      thinkingTokenBudgetField: "thinking_budget_tokens",
      routing: {
        order: ["first", "second"],
        allowFallbacks: false,
        dataCollection: "deny",
      },
    },
  });

  assert.equal(model.apiDialect, model.compatibility?.dialect);
  assert.equal(model.endpoint?.type, "template");
  assert.equal(model.cache?.defaultRetention, "short");
  assert.equal(model.availability?.status, "preview");
});

test("request-wide pricing selects the highest matching tier", () => {
  const lowUsage = {
    inputTokens: 50_000,
    outputTokens: 1_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const tierUsage = {
    inputTokens: 90_000,
    outputTokens: 1_000,
    cacheReadTokens: 20_001,
    cacheWriteTokens: 0,
  };
  const highestUsage = {
    inputTokens: 200_001,
    outputTokens: 1_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  assert.equal(modelCostRates(tieredCost, lowUsage).inputUsdPerMTok, 1);
  assert.equal(modelCostRates(tieredCost, tierUsage).inputUsdPerMTok, 2);
  assert.equal(modelCostRates(tieredCost, highestUsage).inputUsdPerMTok, 4);
  assert.equal(usageCostUsd(tieredCost, tierUsage), (2 * 90_000 + 3 * 1_000) / 1_000_000);
});

test("normalization rejects malformed provider events through a safe terminal", async () => {
  const stream = (async function* () {
    yield { type: "text_delta", text: "partial", contentIndex: -1 } as never;
  })();
  const result = await collectModelStream(stream);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.terminal, {
    type: "error",
    code: "provider_stream_failure",
    message: "modelStreamEvent.contentIndex must be a non-negative safe integer",
    retryable: false,
  });
});

test("provider diagnostics redact known secrets and remain bounded", () => {
  const secret = "fixture-provider-secret";
  assert.equal(
    safeProviderMessage(`request failed for ${secret}`, [secret]),
    "request failed for [REDACTED]",
  );
  assert.deepEqual(safeProviderDiagnostic("request_failed", secret, "error", [secret]), {
    code: "request_failed",
    message: "[REDACTED]",
    severity: "error",
  });
  assert.equal(safeProviderMessage("x".repeat(2_500)).length, 2_000);
});

test("native image generation remains part of ModelProvider", async () => {
  const generatedBlob: BlobReference = {
    sha256: "a".repeat(64),
    mediaType: "image/png",
    sizeBytes: 3,
  };
  const provider: ModelProvider = {
    id: "image-provider",
    displayName: "Image Provider",
    authMethods: ["keyless"],
    listModels: async () => [],
    listImageModels: async () => [
      {
        providerId: "image-provider",
        modelId: "image-model",
        displayName: "Image Model",
        apiDialect: "openrouter-images",
        input: ["text"],
        output: ["image"],
      },
    ],
    stream: () => {
      throw new Error("text streaming is not configured");
    },
    generateImages: async (request) => ({
      providerId: "image-provider",
      requestedModelId: request.modelId,
      images: [await request.writeBlob(new Uint8Array([1, 2, 3]), { mediaType: "image/png" })],
    }),
  };

  const models = await provider.listImageModels?.();
  const result = await provider.generateImages?.({
    modelId: "image-model",
    prompt: "draw a test",
    writeBlob: async () => generatedBlob,
  });
  assert.equal(models?.[0]?.apiDialect, "openrouter-images");
  assert.deepEqual(result?.images, [generatedBlob]);
});
