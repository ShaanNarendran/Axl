// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import type { Usage } from "@axl/protocol";

import type { ModelCost, ModelCostRates } from "./model.ts";

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  };
}

/** Accumulates usage across requests; absent optional fields count as zero. */
export function addUsage(total: Usage, delta: Usage): Usage {
  return {
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    cacheReadTokens: total.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + delta.cacheWriteTokens,
    reasoningTokens: (total.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0),
    costUsd: (total.costUsd ?? 0) + (delta.costUsd ?? 0),
  };
}

/** Selects the highest request-wide price tier matching total input usage. */
export function modelCostRates(cost: ModelCost, usage: Usage): ModelCostRates {
  const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  let selected: ModelCostRates = cost;
  let selectedThreshold = -1;
  for (const tier of cost.tiers ?? []) {
    if (tier.inputTokensAbove < totalInput && tier.inputTokensAbove > selectedThreshold) {
      selected = tier;
      selectedThreshold = tier.inputTokensAbove;
    }
  }
  return selected;
}

/**
 * Cost of one usage under the matching request-wide rates. Cache rates a
 * provider does not publish count as zero; providers with cache pricing must
 * supply them.
 */
export function usageCostUsd(cost: ModelCost, usage: Usage): number {
  const rates = modelCostRates(cost, usage);
  return (
    (rates.inputUsdPerMTok * usage.inputTokens +
      rates.outputUsdPerMTok * usage.outputTokens +
      (rates.cacheReadUsdPerMTok ?? 0) * usage.cacheReadTokens +
      (rates.cacheWriteUsdPerMTok ?? 0) * usage.cacheWriteTokens) /
    1_000_000
  );
}

/** The usage with `costUsd` computed from the model's rates. */
export function withUsageCost(cost: ModelCost, usage: Usage): Usage {
  return { ...usage, costUsd: usageCostUsd(cost, usage) };
}
