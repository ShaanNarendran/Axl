// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { normalizeCatalogModels, object } from "./catalog-normalization.ts";
import { PROVIDER_CATALOG_OVERLAYS } from "./catalog-overlays.ts";
import type { ModelProvider } from "./provider.ts";
import { readBoundedJson, safeFetch } from "./transport-safety.ts";

/** Live facts use the same reviewed policy as the offline catalog generator. */
export function enableStaticCatalogRefresh(
  provider: ModelProvider,
  fetchImpl?: typeof fetch,
): void {
  const overlay = PROVIDER_CATALOG_OVERLAYS.find((entry) => entry.id === provider.id);
  if (overlay?.source?.manifest !== "models-dev") return;
  const sourceProviderId = overlay.source.providerId;
  const streamModel = provider.streamModel?.bind(provider);
  if (streamModel === undefined) throw new Error(`${provider.id} cannot dispatch refreshed models`);
  provider.streamModel = (model, request) => {
    const dialect =
      overlay.dialectRules?.find((rule) => model.modelId.startsWith(rule.prefix))?.dialect ??
      overlay.dialect;
    if (
      JSON.stringify(model.endpoint) !== JSON.stringify(overlay.endpoint) ||
      model.apiDialect !== dialect
    ) {
      throw new Error(
        `${provider.id} cached model does not match reviewed endpoint and dialect policy`,
      );
    }
    return streamModel(model, request);
  };
  provider.refreshModelCatalog = async (context) => {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
    const response = await safeFetch(
      "https://models.dev/api.json",
      { signal },
      {
        label: "Model metadata source",
        expectedOrigin: "https://models.dev",
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Model metadata source returned HTTP ${response.status}`);
    }
    const catalog = object(await readBoundedJson(response, 32 * 1024 * 1024, signal), "catalog");
    const source = object(catalog[sourceProviderId], "source provider");
    const models = Object.fromEntries(
      Object.entries(object(source.models, "models")).map(([id, value]) => {
        const model = object(value, "model");
        const limits = object(model.limit, "model limits");
        const modalities = object(model.modalities, "model modalities");
        return [
          id,
          {
            id: model.id,
            name: model.name,
            toolCall: model.tool_call,
            structuredOutput: model.structured_output,
            imageInput: Array.isArray(modalities.input) && modalities.input.includes("image"),
            reasoning: model.reasoning,
            reasoningOptions: model.reasoning_options,
            contextWindow: limits.context,
            maxOutputTokens: limits.output,
            cost: model.cost,
            status: model.status,
          },
        ];
      }),
    );
    return {
      status: "updated",
      providerId: provider.id,
      generation: context.generation,
      source: { id: "models.dev", kind: "provider_api" },
      models: normalizeCatalogModels(overlay, models),
    };
  };
}
