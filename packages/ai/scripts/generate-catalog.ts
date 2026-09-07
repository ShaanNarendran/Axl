// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeCatalogModels,
  object,
  positiveInteger,
  type SourceModel,
  string,
} from "../src/catalog-normalization.ts";
import { PROVIDER_CATALOG_OVERLAYS } from "../src/catalog-overlays.ts";
import { validateEndpointPolicy, validateModelCatalog } from "../src/catalog-validation.ts";
import type { ModelInfo } from "../src/model.ts";

interface SourceProvider {
  readonly models?: unknown;
}

interface SourceManifest {
  readonly _provenance?: unknown;
  readonly providers?: unknown;
}

interface SourceProviderIndex {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly documentation?: unknown;
  readonly file?: unknown;
  readonly modelCount?: unknown;
  readonly sha256?: unknown;
}

interface SourceManifestIndex {
  readonly schemaVersion?: unknown;
  readonly _provenance?: unknown;
  readonly providers?: unknown;
}

export interface GeneratedCatalogFiles {
  readonly files: ReadonlyMap<string, string>;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TARGET = resolve(PACKAGE_ROOT, "src/catalog.generated.ts");
const GENERATED_SHARD_DIRECTORY = resolve(PACKAGE_ROOT, "src/catalog.generated");
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

function readManifest(name: "models-dev" | "ant-ling"): SourceManifest {
  const sourceRoot = resolve(PACKAGE_ROOT, `catalog/sources/${name}`);
  const manifestText = readFileSync(resolve(sourceRoot, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as SourceManifestIndex;
  if (`${JSON.stringify(manifest, null, 2)}\n` !== manifestText) {
    throw new Error(`${name} manifest is not canonical JSON`);
  }
  if (manifest.schemaVersion !== 1) throw new Error(`${name} has an unsupported schema version`);
  if (!Array.isArray(manifest.providers)) throw new Error(`${name}.providers must be an array`);

  const providers = new Map<string, SourceProvider>();
  let previousProviderId: string | undefined;
  const indexedFiles = new Set<string>();
  for (const [providerIndex, value] of manifest.providers.entries()) {
    const entry = object(value, `${name}.providers[${providerIndex}]`) as SourceProviderIndex;
    const providerId = string(entry.id, `${name}.providers[${providerIndex}].id`);
    if (previousProviderId !== undefined && previousProviderId.localeCompare(providerId) >= 0) {
      throw new Error(`${name} provider index is not strictly ordered`);
    }
    previousProviderId = providerId;
    string(entry.name, `${name}/${providerId}.name`);
    string(entry.documentation, `${name}/${providerId}.documentation`);
    const file = string(entry.file, `${name}/${providerId}.file`);
    if (file !== `providers/${providerId}.jsonl`) {
      throw new Error(`${name}/${providerId} has a noncanonical shard path`);
    }
    const shardText = readFileSync(resolve(sourceRoot, file), "utf8");
    if (!shardText.endsWith("\n") || shardText.includes("\n\n")) {
      throw new Error(`${name}/${providerId} shard must contain one model per line`);
    }
    const digest = createHash("sha256").update(shardText).digest("hex");
    if (digest !== string(entry.sha256, `${name}/${providerId}.sha256`)) {
      throw new Error(`${name}/${providerId} shard checksum does not match its index`);
    }
    const models = new Map<string, unknown>();
    let previousModelId: string | undefined;
    for (const [lineIndex, line] of shardText.trimEnd().split("\n").entries()) {
      const model = object(
        JSON.parse(line),
        `${name}/${providerId}:${lineIndex + 1}`,
      ) as SourceModel;
      const modelId = string(model.id, `${name}/${providerId}:${lineIndex + 1}.id`);
      if (JSON.stringify(model) !== line) {
        throw new Error(`${name}/${providerId}:${lineIndex + 1} is not canonical JSON`);
      }
      if (previousModelId !== undefined && previousModelId.localeCompare(modelId) >= 0) {
        throw new Error(`${name}/${providerId} models are not strictly ordered`);
      }
      previousModelId = modelId;
      models.set(modelId, model);
    }
    if (models.size !== positiveInteger(entry.modelCount, `${name}/${providerId}.modelCount`)) {
      throw new Error(`${name}/${providerId} model count does not match its index`);
    }
    providers.set(providerId, { models: Object.fromEntries(models) });
    indexedFiles.add(`${providerId}.jsonl`);
  }

  const actualFiles = readdirSync(resolve(sourceRoot, "providers")).sort();
  const expectedFiles = [...indexedFiles].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`${name} provider shards do not exactly match the index`);
  }
  return { _provenance: manifest._provenance, providers: Object.fromEntries(providers) };
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

const GENERATED_HEADER = `// SPDX-FileCopyrightText: 2025 models.dev contributors
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: MIT
// @generated by packages/ai/scripts/generate-catalog.ts; do not edit.
`;

function modelConstant(providerId: string): string {
  return `${providerId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_MODELS`;
}

function lines<T>(values: readonly T[]): string {
  return values.map((value) => `  ${JSON.stringify(value)},`).join("\n");
}

export function generateCatalog(): GeneratedCatalogFiles {
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
    const normalized = normalizeCatalogModels(overlay, models);
    catalogEntries.push([overlay.id, normalized]);
  }
  const staticCatalog = sortedRecord(catalogEntries);
  validateModelCatalog(Object.values(staticCatalog).flat());

  const modelsDevProvenance = object(manifests["models-dev"]._provenance, "models-dev provenance");
  const antProvenance = object(manifests["ant-ling"]._provenance, "ant-ling provenance");
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
        sha256: string(antProvenance.sourceSha256, "ant-ling sourceSha256"),
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

  const files = new Map<string, string>();
  const imports: string[] = [];
  const catalogProperties: string[] = [];
  for (const [providerId, models] of Object.entries(staticCatalog)) {
    const constant = modelConstant(providerId);
    const target = resolve(GENERATED_SHARD_DIRECTORY, `${providerId}.generated.ts`);
    imports.push(
      `import { MODELS as ${constant} } from "./catalog.generated/${providerId}.generated.ts";`,
    );
    catalogProperties.push(`  ${JSON.stringify(providerId)}: ${constant},`);
    files.set(
      target,
      `${GENERATED_HEADER}\nimport type { ModelInfo } from "../model.ts";\n\nexport const MODELS: readonly ModelInfo[] = [\n${lines(models)}\n];\n`,
    );
  }

  files.set(
    DEFAULT_TARGET,
    `${GENERATED_HEADER}\nimport type { BuiltinCatalogProvider, CatalogProvenance } from "./catalog.ts";\nimport type { ModelInfo } from "./model.ts";\n${imports.join("\n")}\n\nexport const GENERATED_CATALOG_PROVENANCE = ${JSON.stringify(provenance)} as const satisfies CatalogProvenance;\n\nexport const BUILTIN_CATALOG_PROVIDERS = [\n${lines(providers)}\n] as const satisfies readonly BuiltinCatalogProvider[];\n\nexport const STATIC_MODEL_CATALOG: Readonly<Record<string, readonly ModelInfo[]>> = {\n${catalogProperties.join("\n")}\n};\n`,
  );
  return { files };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const check = process.argv[2] === CHECK_FLAG;
  const target = check ? resolve(process.cwd(), process.argv[3] ?? DEFAULT_TARGET) : undefined;
  const output = generateCatalog();
  if (check) {
    const expected = target === undefined ? undefined : output.files.get(target);
    if (expected === undefined || target === undefined) {
      throw new Error(
        `No generated catalog output exists for ${relative(process.cwd(), target ?? "")}`,
      );
    }
    const filesToCheck = target === DEFAULT_TARGET ? output.files : new Map([[target, expected]]);
    for (const [path, source] of filesToCheck) {
      if (readFileSync(path, "utf8") !== source) process.exitCode = 1;
    }
  } else {
    rmSync(GENERATED_SHARD_DIRECTORY, { recursive: true, force: true });
    mkdirSync(GENERATED_SHARD_DIRECTORY, { recursive: true });
    for (const [path, source] of output.files) writeFileSync(path, source);
  }
}
