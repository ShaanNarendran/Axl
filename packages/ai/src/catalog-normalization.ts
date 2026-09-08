// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { ThinkingLevel } from "@axl/protocol";
import { AZURE_OPENAI_MODELS } from "./azure-openai-models.ts";
import type { ProviderCatalogOverlay } from "./catalog-overlays.ts";
import { validateModelCatalog } from "./catalog-validation.ts";
import type { KnownApiDialect, ModelAvailability, ModelCost, ModelInfo } from "./model.ts";

interface SourceReasoningOption {
  readonly type?: unknown;
  readonly values?: unknown;
}

export interface SourceModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly toolCall?: unknown;
  readonly structuredOutput?: unknown;
  readonly imageInput?: unknown;
  readonly reasoning?: unknown;
  readonly reasoningOptions?: unknown;
  readonly contextWindow?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly cost?: unknown;
  readonly status?: unknown;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

export function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function optionalRate(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative finite number`);
  }
  return value;
}

function sourceCost(value: unknown, label: string): ModelCost | undefined {
  if (value === undefined) return undefined;
  const input = object(value, label);
  const inputRate = optionalRate(input.input, `${label}.input`) ?? 0;
  const outputRate = optionalRate(input.output, `${label}.output`) ?? 0;
  const cacheRead = optionalRate(input.cache_read, `${label}.cache_read`);
  const cacheWrite = optionalRate(input.cache_write, `${label}.cache_write`);
  const rawTiers = input.tiers;
  const tiers = Array.isArray(rawTiers)
    ? rawTiers
        .map((entry, index) => {
          const tier = object(entry, `${label}.tiers[${index}]`);
          const condition = object(tier.tier, `${label}.tiers[${index}].tier`);
          if (condition.type !== "context") return undefined;
          const tierCacheRead = optionalRate(
            tier.cache_read,
            `${label}.tiers[${index}].cache_read`,
          );
          const tierCacheWrite = optionalRate(
            tier.cache_write,
            `${label}.tiers[${index}].cache_write`,
          );
          return {
            inputTokensAbove: positiveInteger(condition.size, `${label}.tiers[${index}].tier.size`),
            inputUsdPerMTok: optionalRate(tier.input, `${label}.tiers[${index}].input`) ?? 0,
            outputUsdPerMTok: optionalRate(tier.output, `${label}.tiers[${index}].output`) ?? 0,
            ...(tierCacheRead === undefined ? {} : { cacheReadUsdPerMTok: tierCacheRead }),
            ...(tierCacheWrite === undefined ? {} : { cacheWriteUsdPerMTok: tierCacheWrite }),
          };
        })
        .filter((tier) => tier !== undefined)
        .sort((left, right) => left.inputTokensAbove - right.inputTokensAbove)
    : [];
  return {
    inputUsdPerMTok: inputRate,
    outputUsdPerMTok: outputRate,
    ...(cacheRead === undefined ? {} : { cacheReadUsdPerMTok: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteUsdPerMTok: cacheWrite }),
    ...(tiers.length === 0 ? {} : { tiers }),
  };
}

function reasoningMap(model: SourceModel, label: string): ModelInfo["thinkingLevelMap"] {
  if (model.reasoning !== true) return undefined;
  if (model.reasoningOptions === undefined) return undefined;
  if (!Array.isArray(model.reasoningOptions)) {
    throw new Error(`${label}.reasoningOptions must be an array`);
  }
  const options = model.reasoningOptions.map((value, index) =>
    object(value, `${label}.reasoningOptions[${index}]`),
  ) as SourceReasoningOption[];
  const effort = options.find((option) => option.type === "effort");
  if (effort !== undefined) {
    if (!Array.isArray(effort.values) || effort.values.some((value) => typeof value !== "string")) {
      throw new Error(`${label} has invalid effort values`);
    }
    const values = new Set(effort.values as string[]);
    const map: Partial<Record<ThinkingLevel, string | null>> = {};
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      map[level] = values.has(level) ? level : null;
    }
    if (values.has("none")) map.off = "none";
    else if (values.has("off")) map.off = "off";
    return map;
  }
  if (options.some((option) => option.type === "budget_tokens")) {
    return {
      minimal: "1024",
      low: "2048",
      medium: "8192",
      high: "16384",
      xhigh: "16384",
      max: "16384",
    };
  }
  if (options.some((option) => option.type === "toggle")) {
    return { off: "disabled", minimal: null, low: null, medium: null, high: "enabled" };
  }
  return undefined;
}

function availability(status: unknown, label: string): ModelAvailability {
  if (status === undefined || status === "active") return { status: "available" };
  if (status === "alpha" || status === "beta" || status === "preview") {
    return { status: "preview", reason: `Source catalog status: ${status}` };
  }
  if (status === "deprecated") {
    return { status: "deprecated", reason: "Deprecated by the source catalog" };
  }
  throw new Error(`${label}.status has unsupported value ${JSON.stringify(status)}`);
}

function dialectFor(overlay: ProviderCatalogOverlay, modelId: string): KnownApiDialect {
  for (const rule of overlay.dialectRules ?? []) {
    if (modelId.startsWith(rule.prefix)) return rule.dialect;
  }
  if (overlay.dialect === undefined) throw new Error(`${overlay.id} has no default dialect`);
  return overlay.dialect;
}

function selected(source: NonNullable<ProviderCatalogOverlay["source"]>, modelId: string): boolean {
  if (
    source.includePrefixes &&
    !source.includePrefixes.some((prefix) => modelId.startsWith(prefix))
  ) {
    return false;
  }
  if (source.excludeModelIds?.includes(modelId)) return false;
  return !source.excludeSuffixes?.some((suffix) => modelId.endsWith(suffix));
}

function normalizeModel(
  overlay: ProviderCatalogOverlay,
  modelId: string,
  value: unknown,
): ModelInfo {
  const label = `${overlay.source?.providerId}/${modelId}`;
  const source = object(value, label) as SourceModel;
  if (source.id !== modelId) throw new Error(`${label} source identity does not match its key`);
  const dialect = dialectFor(overlay, modelId);
  const contextWindow = positiveInteger(source.contextWindow, `${label}.contextWindow`);
  const maxOutputTokens = positiveInteger(source.maxOutputTokens, `${label}.maxOutputTokens`);
  if (maxOutputTokens > contextWindow) {
    throw new Error(`${label} output limit exceeds its context window`);
  }
  const thinkingLevelMap = reasoningMap(source, label);
  const cost = sourceCost(source.cost, `${label}.cost`);
  const baseCompatibility = overlay.compatibilityByDialect?.[dialect];
  let compatibility = baseCompatibility;
  if (
    baseCompatibility?.dialect === "anthropic-messages" &&
    overlay.anthropicAdaptiveThinkingPrefixes?.some((prefix) => modelId.startsWith(prefix))
  ) {
    compatibility = { ...baseCompatibility, forceAdaptiveThinking: true };
  }
  if (
    (baseCompatibility?.dialect === "google-generative-ai" ||
      baseCompatibility?.dialect === "google-vertex") &&
    overlay.googleStrictToolPrefixes?.some((prefix) => modelId.startsWith(prefix))
  ) {
    compatibility = { ...baseCompatibility, supportsStrictTools: true };
  }
  if (baseCompatibility?.dialect === "bedrock-converse-stream") {
    const isClaude = modelId.includes("anthropic.claude");
    const adaptive =
      isClaude &&
      ["opus-4-6", "opus-4-7", "opus-4-8", "opus-5", "sonnet-4-6", "sonnet-5", "fable-5"].some(
        (name) => modelId.includes(name),
      );
    compatibility = {
      ...baseCompatibility,
      ...(source.structuredOutput === true ? { supportsStrictTools: true } : {}),
      ...(isClaude
        ? {
            supportsPromptCacheMarkers: true,
            supportsThinkingSignatures: true,
            ...(adaptive ? { forceAdaptiveThinking: true } : {}),
          }
        : {}),
    };
  }
  if (baseCompatibility?.dialect === "mistral-conversations") {
    compatibility = {
      ...baseCompatibility,
      ...(source.structuredOutput === true ? { supportsStrictTools: true } : {}),
    };
  }
  return {
    providerId: overlay.id,
    modelId,
    displayName: string(source.name, `${label}.name`).trim(),
    apiDialect: dialect,
    capabilities: {
      toolUse: source.toolCall === true,
      structuredOutput: source.structuredOutput === true,
      imageInput: source.imageInput === true,
    },
    reasoning: source.reasoning === true,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    contextWindow,
    maxOutputTokens,
    ...(cost === undefined ? {} : { cost }),
    ...(overlay.cache === undefined ? {} : { cache: overlay.cache }),
    ...(overlay.endpoint === undefined ? {} : { endpoint: overlay.endpoint }),
    availability: availability(source.status, label),
    ...(compatibility === undefined ? {} : { compatibility }),
  };
}

export function normalizeCatalogModels(
  overlay: ProviderCatalogOverlay,
  models: Record<string, unknown>,
): readonly ModelInfo[] {
  const source = overlay.source;
  if (!source) throw new Error(`${overlay.id} has no catalog source`);
  const normalized = Object.entries(models)
    .filter(([id, model]) => object(model, id).toolCall === true && selected(source, id))
    .map(([id, model]) => normalizeModel(overlay, id, model))
    .sort((left, right) => left.modelId.localeCompare(right.modelId));
  if (normalized.length === 0) throw new Error(`${overlay.id} returned an empty catalog`);
  if (overlay.id === "azure-openai-responses") {
    // Keep Axl's curated Azure IDs when upstream omits them. Explicit upstream facts win,
    // including tool-capability exclusions. Use the same policy for generation and refresh.
    for (const model of AZURE_OPENAI_MODELS) {
      if (Object.hasOwn(models, model.modelId)) continue;
      normalized.push({
        ...model,
        providerId: overlay.id,
        ...(overlay.endpoint === undefined ? {} : { endpoint: overlay.endpoint }),
        ...(overlay.cache === undefined ? {} : { cache: overlay.cache }),
        ...(overlay.compatibilityByDialect?.["azure-openai-responses"] === undefined
          ? {}
          : { compatibility: overlay.compatibilityByDialect["azure-openai-responses"] }),
        availability: { status: "available" },
      });
    }
    normalized.sort((left, right) => left.modelId.localeCompare(right.modelId));
  }
  validateModelCatalog(normalized);
  return normalized;
}
