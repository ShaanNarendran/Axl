// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ThinkingLevel } from "@axl/protocol";

import { validateEndpointPolicy, validateModelCatalog } from "../src/catalog-validation.ts";
import type { KnownApiDialect, ModelAvailability, ModelCost, ModelInfo } from "../src/model.ts";
import { PROVIDER_CATALOG_OVERLAYS, type ProviderCatalogOverlay } from "./catalog-overlays.ts";

interface SourceReasoningOption {
  readonly type?: unknown;
  readonly values?: unknown;
}

interface SourceModel {
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

interface SourceProvider {
  readonly models?: unknown;
}

interface SourceManifest {
  readonly _provenance?: unknown;
  readonly providers?: unknown;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TARGET = resolve(PACKAGE_ROOT, "src/catalog.generated.ts");
const CHECK_FLAG = `-${"-"}check`;
const EXPECTED_PROVIDER_IDS = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "baseten",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "custom",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "radius",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
] as const;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
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

function readManifest(name: "models-dev" | "ant-ling"): SourceManifest {
  return JSON.parse(
    readFileSync(resolve(PACKAGE_ROOT, `catalog/sources/${name}.json`), "utf8"),
  ) as SourceManifest;
}

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function validateOverlays(): void {
  const ids = PROVIDER_CATALOG_OVERLAYS.map((overlay) => overlay.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...EXPECTED_PROVIDER_IDS].sort())) {
    throw new Error("Provider overlays do not exactly cover the planned provider identities");
  }
  const regions = new Set<string>();
  const endpoints = new Set<string>();
  for (const overlay of PROVIDER_CATALOG_OVERLAYS) {
    if (overlay.catalogKind === "static" && overlay.source === undefined) {
      throw new Error(`Static provider ${overlay.id} has no source manifest`);
    }
    if (overlay.catalogKind !== "static" && overlay.source !== undefined) {
      throw new Error(`${overlay.id} cannot use a static source manifest`);
    }
    if (overlay.endpoint !== undefined) validateEndpointPolicy(overlay.endpoint, overlay.id);
    if ((overlay.regionFamily === undefined) !== (overlay.region === undefined)) {
      throw new Error(`${overlay.id} must define both regional fields or neither`);
    }
    if (overlay.regionFamily !== undefined && overlay.region !== undefined) {
      const regionKey = `${overlay.regionFamily}/${overlay.region}`;
      if (regions.has(regionKey)) throw new Error(`Duplicate regional catalog ${regionKey}`);
      regions.add(regionKey);
      const endpoint = JSON.stringify(overlay.endpoint);
      const endpointKey = `${overlay.regionFamily}/${endpoint}`;
      if (endpoints.has(endpointKey)) {
        throw new Error(`${overlay.regionFamily} regional catalogs share an endpoint`);
      }
      endpoints.add(endpointKey);
    }
  }
}

export function generateCatalog(): string {
  validateOverlays();
  const manifests = {
    "models-dev": readManifest("models-dev"),
    "ant-ling": readManifest("ant-ling"),
  };
  const catalogEntries: [string, readonly ModelInfo[]][] = [];
  for (const overlay of PROVIDER_CATALOG_OVERLAYS) {
    if (overlay.catalogKind !== "static" || overlay.source === undefined) continue;
    const manifestProviders = object(
      manifests[overlay.source.manifest].providers,
      `${overlay.source.manifest}.providers`,
    );
    const sourceProvider = object(
      manifestProviders[overlay.source.providerId],
      `${overlay.source.manifest}/${overlay.source.providerId}`,
    ) as SourceProvider;
    const models = object(
      sourceProvider.models,
      `${overlay.source.manifest}/${overlay.source.providerId}.models`,
    );
    const normalized = Object.entries(models)
      .filter(([modelId, model]) => {
        const sourceModel = object(
          model,
          `${overlay.source?.providerId}/${modelId}`,
        ) as SourceModel;
        return (
          sourceModel.toolCall === true &&
          selected(overlay.source as NonNullable<typeof overlay.source>, modelId)
        );
      })
      .map(([modelId, model]) => normalizeModel(overlay, modelId, model))
      .sort((left, right) => left.modelId.localeCompare(right.modelId));
    if (normalized.length === 0) throw new Error(`${overlay.id} generated an empty static catalog`);
    validateModelCatalog(normalized);
    catalogEntries.push([overlay.id, normalized]);
  }
  const staticCatalog = sortedRecord(catalogEntries);
  validateModelCatalog(Object.values(staticCatalog).flat());

  const modelsDevProvenance = object(manifests["models-dev"]._provenance, "models-dev provenance");
  const antProvenance = object(manifests["ant-ling"]._provenance, "ant-ling provenance");
  const antSourceText = readFileSync(
    resolve(PACKAGE_ROOT, "catalog/sources/ant-ling.json"),
    "utf8",
  );
  const provenance = {
    generatedAt: string(modelsDevProvenance.retrievedAt, "models-dev retrievedAt"),
    sources: [
      {
        name: "models.dev",
        location: string(modelsDevProvenance.source, "models-dev source"),
        retrievedAt: string(modelsDevProvenance.retrievedAt, "models-dev retrievedAt"),
        sha256: string(modelsDevProvenance.sourceSha256, "models-dev sourceSha256"),
        revision: string(modelsDevProvenance.repositoryCommit, "models-dev repositoryCommit"),
        license: "MIT",
      },
      {
        name: "Ant Ling official documentation",
        location: string((antProvenance.sources as unknown[] | undefined)?.[0], "ant-ling source"),
        retrievedAt: string(antProvenance.retrievedAt, "ant-ling retrievedAt"),
        sha256: createHash("sha256").update(antSourceText).digest("hex"),
        license: "factual metadata",
      },
    ],
  };
  const providers = PROVIDER_CATALOG_OVERLAYS.map(
    ({ id, displayName, catalogKind, regionFamily, region }) => ({
      id,
      displayName,
      catalogKind,
      ...(regionFamily === undefined ? {} : { regionFamily }),
      ...(region === undefined ? {} : { region }),
    }),
  ).sort((left, right) => left.id.localeCompare(right.id));

  return `// SPDX-FileCopyrightText: 2025 models.dev contributors\n// SPDX-FileCopyrightText: 2026 Kaushik Kumar\n// SPDX-License-Identifier: MIT\n// @generated by packages/ai/scripts/generate-catalog.ts; do not edit.\n\nimport type { BuiltinCatalogProvider, CatalogProvenance } from "./catalog.ts";\nimport type { ModelInfo } from "./model.ts";\n\nexport const GENERATED_CATALOG_PROVENANCE = ${JSON.stringify(provenance, null, 2)} as const satisfies CatalogProvenance;\n\nexport const BUILTIN_CATALOG_PROVIDERS = ${JSON.stringify(providers, null, 2)} as const satisfies readonly BuiltinCatalogProvider[];\n\nexport const STATIC_MODEL_CATALOG: Readonly<Record<string, readonly ModelInfo[]>> = ${JSON.stringify(staticCatalog, null, 2)};\n`;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const check = process.argv[2] === CHECK_FLAG;
  const target = check ? resolve(process.cwd(), process.argv[3] ?? DEFAULT_TARGET) : DEFAULT_TARGET;
  const output = generateCatalog();
  if (check) {
    if (readFileSync(target, "utf8") !== output) process.exitCode = 1;
  } else {
    writeFileSync(target, output);
  }
}
