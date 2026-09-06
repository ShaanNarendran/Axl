// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  type CatalogSnapshot,
  type CatalogStore,
  InMemoryCatalogStore,
  validateCatalogSnapshot,
  validateCatalogSource,
} from "./catalog-store.ts";
import { validateModelCatalog } from "./catalog-validation.ts";
import type {
  ImageModelInfo,
  ModelInfo,
  ModelRequest,
  ModelStreamEvent,
  SafeProviderDiagnostic,
} from "./model.ts";
import type { ModelCatalogRefreshResult, ModelProvider } from "./provider.ts";
import { isPreparedModelRequest, prepareModelRequest } from "./request-preparation.ts";

export type ProviderRegistryErrorCode =
  | "registry_disposed"
  | "provider_duplicate"
  | "provider_missing"
  | "provider_disabled"
  | "model_duplicate"
  | "model_missing"
  | "model_unavailable"
  | "catalog_failure";

export class ProviderRegistryError extends Error {
  readonly code: ProviderRegistryErrorCode;
  readonly providerId: string | undefined;
  readonly modelId: string | undefined;

  constructor(
    code: ProviderRegistryErrorCode,
    message: string,
    options: { providerId?: string; modelId?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderRegistryError";
    this.code = code;
    this.providerId = options.providerId;
    this.modelId = options.modelId;
  }
}

export interface ProviderRegistrationOptions {
  readonly enabled?: boolean;
}

export interface RegisteredProvider {
  readonly provider: ModelProvider;
  readonly enabled: boolean;
}

export interface ModelCatalogResult {
  readonly models: readonly ModelInfo[];
  /** Failures remain visible without preventing healthy providers from listing models. */
  readonly errors: ReadonlyMap<string, Error>;
}

export interface ModelCatalogOptions {
  readonly providerId?: string;
  readonly includeUnavailable?: boolean;
}

export interface RestoreCatalogsOptions {
  readonly providerId?: string;
  readonly signal?: AbortSignal;
}

export interface RestoreCatalogsResult extends ModelCatalogResult {
  readonly restoredProviderIds: readonly string[];
  readonly snapshots: ReadonlyMap<string, CatalogSnapshot>;
}

export interface RefreshProvidersOptions extends RestoreCatalogsOptions {}

export interface RefreshProvidersResult extends ModelCatalogResult {
  readonly refreshedProviderIds: readonly string[];
  readonly restoredProviderIds: readonly string[];
  readonly supersededProviderIds: readonly string[];
  readonly snapshots: ReadonlyMap<string, CatalogSnapshot>;
  readonly diagnostics: ReadonlyMap<string, readonly SafeProviderDiagnostic[]>;
}

export interface ProviderRegistryOptions {
  readonly catalogStore?: CatalogStore;
  readonly now?: () => number;
}

interface RegistryEntry {
  readonly provider: ModelProvider;
  enabled: boolean;
}

interface ProviderRefreshState {
  readonly generation: number;
  readonly controller: AbortController;
}

interface ProviderRefreshSuccess {
  readonly providerId: string;
  readonly refreshed: boolean;
  readonly restored: boolean;
  readonly superseded: boolean;
  readonly models: readonly ModelInfo[];
  readonly snapshot?: CatalogSnapshot;
  readonly diagnostics?: readonly SafeProviderDiagnostic[];
}

interface ProviderRefreshFailure {
  readonly providerId: string;
  readonly error: Error;
}

type RefreshableProvider = ModelProvider &
  (
    | Required<Pick<ModelProvider, "refreshModelCatalog">>
    | Required<Pick<ModelProvider, "refreshModels">>
  );

function available(model: ModelInfo): boolean {
  return model.availability?.status !== "unavailable";
}

function asError(error: unknown, providerId: string, operation: string): Error {
  if (error instanceof Error) return error;
  return new ProviderRegistryError(
    "catalog_failure",
    `Provider ${providerId} ${operation} failed with a non-Error value`,
    { providerId, cause: error },
  );
}

function raceWithSignal<Result>(operation: Promise<Result>, signal: AbortSignal): Promise<Result> {
  signal.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function validateDiagnostics(
  diagnostics: readonly SafeProviderDiagnostic[] | undefined,
  providerId: string,
): readonly SafeProviderDiagnostic[] | undefined {
  if (diagnostics === undefined) return undefined;
  if (!Array.isArray(diagnostics)) {
    throw new ProviderRegistryError(
      "catalog_failure",
      `Provider ${providerId} returned invalid catalog diagnostics`,
      { providerId },
    );
  }
  for (const diagnostic of diagnostics) {
    if (
      typeof diagnostic !== "object" ||
      diagnostic === null ||
      Array.isArray(diagnostic) ||
      Object.keys(diagnostic).some((key) => !["code", "message", "severity"].includes(key)) ||
      typeof diagnostic.code !== "string" ||
      !/^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/i.test(diagnostic.code) ||
      diagnostic.code.length > 128 ||
      typeof diagnostic.message !== "string" ||
      diagnostic.message.length > 2_000 ||
      !["info", "warning", "error"].includes(diagnostic.severity)
    ) {
      throw new ProviderRegistryError(
        "catalog_failure",
        `Provider ${providerId} returned invalid catalog diagnostics`,
        { providerId },
      );
    }
  }
  return structuredClone(diagnostics);
}

/**
 * Owns registered provider lifecycles and coordinates model lookup, persisted
 * dynamic catalogs, explicit refresh, availability, and dispatch. Registration
 * itself performs no model, credential, network, or background work.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, RegistryEntry>();
  private readonly disposal = new WeakMap<ModelProvider, Promise<void>>();
  private readonly catalogStore: CatalogStore;
  private readonly now: () => number;
  private readonly snapshots = new Map<string, CatalogSnapshot>();
  private readonly refreshGenerations = new Map<string, number>();
  private readonly refreshControllers = new Map<string, AbortController>();
  private readonly publicationChains = new Map<string, Promise<unknown>>();
  private disposed = false;

  constructor(options: ProviderRegistryOptions = {}) {
    this.catalogStore = options.catalogStore ?? new InMemoryCatalogStore();
    this.now = options.now ?? Date.now;
  }

  register(
    provider: ModelProvider,
    options: ProviderRegistrationOptions = {},
  ): () => Promise<void> {
    this.assertActive();
    if (this.providers.has(provider.id)) {
      throw new ProviderRegistryError(
        "provider_duplicate",
        `Provider ${provider.id} is already registered`,
        { providerId: provider.id },
      );
    }
    const entry: RegistryEntry = { provider, enabled: options.enabled ?? true };
    this.providers.set(provider.id, entry);
    return async () => {
      if (this.providers.get(provider.id) !== entry) return;
      this.supersedeRefresh(provider.id);
      this.providers.delete(provider.id);
      this.snapshots.delete(provider.id);
      await this.disposeProvider(provider);
    };
  }

  get(id: string): ModelProvider {
    return this.entry(id).provider;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  isEnabled(id: string): boolean {
    return this.registeredEntry(id).enabled;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.assertActive();
    const entry = this.registeredEntry(id);
    entry.enabled = enabled;
    if (!enabled) this.supersedeRefresh(id);
  }

  /** Lists enabled providers. Disabled providers are visible through `registrations()`. */
  list(): readonly ModelProvider[] {
    this.assertActive();
    return [...this.providers.values()]
      .filter((entry) => entry.enabled)
      .map((entry) => entry.provider);
  }

  registrations(): readonly RegisteredProvider[] {
    this.assertActive();
    return [...this.providers.values()].map((entry) => ({
      provider: entry.provider,
      enabled: entry.enabled,
    }));
  }

  catalogSnapshot(providerId: string): CatalogSnapshot | undefined {
    this.entry(providerId);
    const snapshot = this.snapshots.get(providerId);
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }

  async listModels(options: ModelCatalogOptions = {}): Promise<ModelCatalogResult> {
    this.assertActive();
    const entries =
      options.providerId === undefined ? this.enabledEntries() : [this.entry(options.providerId)];
    const results = await Promise.all(
      entries.map(async ({ provider }) => {
        try {
          const providerModels = (await this.modelsFor(provider)).filter(
            (model) => options.includeUnavailable || available(model),
          );
          return { providerId: provider.id, models: providerModels };
        } catch (error) {
          return { providerId: provider.id, error: asError(error, provider.id, "model listing") };
        }
      }),
    );
    const models: ModelInfo[] = [];
    const errors = new Map<string, Error>();
    for (const result of results) {
      if (result.error === undefined) models.push(...(result.models ?? []));
      else errors.set(result.providerId, result.error);
    }
    return { models, errors };
  }

  async listImageModels(providerId: string): Promise<readonly ImageModelInfo[]> {
    const provider = this.get(providerId);
    const baseline = (await provider.listImageModels?.()) ?? [];
    const snapshot = this.snapshots.get(providerId);
    return structuredClone(snapshot?.imageModels ?? baseline);
  }

  async getModel(
    providerId: string,
    modelId: string,
    options: { includeUnavailable?: boolean } = {},
  ): Promise<ModelInfo> {
    const provider = this.get(providerId);
    let models: readonly ModelInfo[];
    try {
      models = await this.modelsFor(provider);
    } catch (error) {
      if (error instanceof ProviderRegistryError) throw error;
      throw new ProviderRegistryError(
        "catalog_failure",
        `Provider ${providerId} model listing failed`,
        { providerId, modelId, cause: error },
      );
    }
    const model = models.find((candidate) => candidate.modelId === modelId);
    if (model === undefined) {
      throw new ProviderRegistryError(
        "model_missing",
        `Provider ${providerId} has no model ${modelId}`,
        { providerId, modelId },
      );
    }
    if (!options.includeUnavailable && !available(model)) {
      throw new ProviderRegistryError(
        "model_unavailable",
        `Model ${providerId}/${modelId} is unavailable${
          model.availability?.reason ? `: ${model.availability.reason}` : ""
        }`,
        { providerId, modelId },
      );
    }
    return model;
  }

  stream(providerId: string, request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const registry = this;
    return (async function* () {
      const provider = registry.get(providerId);
      const model = await registry.getModel(providerId, request.modelId);
      const prepared = isPreparedModelRequest(request)
        ? request
        : await prepareModelRequest(model, request);
      yield* provider.streamModel?.(model, prepared) ?? provider.stream(prepared);
    })();
  }

  /** Restore last-known-good dynamic catalogs without credentials or network access. */
  async restoreCatalogs(options: RestoreCatalogsOptions = {}): Promise<RestoreCatalogsResult> {
    this.assertActive();
    options.signal?.throwIfAborted();
    const entries = this.refreshableEntries(options.providerId);
    const results = await Promise.all(
      entries.map(async ({ provider }) => {
        const state = this.beginRefresh(provider.id);
        const signal =
          options.signal === undefined
            ? state.controller.signal
            : AbortSignal.any([options.signal, state.controller.signal]);
        try {
          const snapshot = await this.restoreProvider(provider, state.generation, signal);
          return { providerId: provider.id, snapshot };
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (state.controller.signal.aborted) return { providerId: provider.id };
          return { providerId: provider.id, error: asError(error, provider.id, "catalog restore") };
        } finally {
          this.finishRefresh(provider.id, state.controller);
        }
      }),
    );
    const models: ModelInfo[] = [];
    const errors = new Map<string, Error>();
    const snapshots = new Map<string, CatalogSnapshot>();
    const restoredProviderIds: string[] = [];
    for (const result of results) {
      if (result.error !== undefined) errors.set(result.providerId, result.error);
      else if (result.snapshot !== undefined) {
        restoredProviderIds.push(result.providerId);
        snapshots.set(result.providerId, result.snapshot);
        models.push(...result.snapshot.models);
      }
    }
    return { models, errors, restoredProviderIds, snapshots };
  }

  async refresh(options: RefreshProvidersOptions = {}): Promise<RefreshProvidersResult> {
    this.assertActive();
    options.signal?.throwIfAborted();
    const entries = this.refreshableEntries(options.providerId);
    const results = await Promise.all(
      entries.map(async ({ provider }) => this.refreshProvider(provider, options.signal)),
    );
    const refreshedProviderIds: string[] = [];
    const restoredProviderIds: string[] = [];
    const supersededProviderIds: string[] = [];
    const models: ModelInfo[] = [];
    const errors = new Map<string, Error>();
    const snapshots = new Map<string, CatalogSnapshot>();
    const diagnostics = new Map<string, readonly SafeProviderDiagnostic[]>();
    for (const result of results) {
      if ("error" in result) {
        errors.set(result.providerId, result.error);
        continue;
      }
      if (result.refreshed) refreshedProviderIds.push(result.providerId);
      if (result.restored) restoredProviderIds.push(result.providerId);
      if (result.superseded) supersededProviderIds.push(result.providerId);
      models.push(...result.models);
      if (result.snapshot !== undefined) snapshots.set(result.providerId, result.snapshot);
      if (result.diagnostics !== undefined) diagnostics.set(result.providerId, result.diagnostics);
    }
    return {
      models,
      errors,
      refreshedProviderIds,
      restoredProviderIds,
      supersededProviderIds,
      snapshots,
      diagnostics,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.refreshControllers.keys()) this.supersedeRefresh(id);
    const providers = [...this.providers.values()].map((entry) => entry.provider);
    this.providers.clear();
    this.snapshots.clear();
    const results = await Promise.allSettled(
      providers.map((provider) => this.disposeProvider(provider)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) throw new AggregateError(errors, "Provider registry disposal failed");
  }

  private async refreshProvider(
    provider: RefreshableProvider,
    callerSignal: AbortSignal | undefined,
  ): Promise<ProviderRefreshSuccess | ProviderRefreshFailure> {
    const state = this.beginRefresh(provider.id);
    const signal =
      callerSignal === undefined
        ? state.controller.signal
        : AbortSignal.any([callerSignal, state.controller.signal]);
    let restored = false;
    try {
      const previous = await this.restoreProvider(provider, state.generation, signal);
      restored = previous !== undefined;
      signal.throwIfAborted();
      const operation =
        provider.refreshModelCatalog !== undefined
          ? provider.refreshModelCatalog({
              providerId: provider.id,
              generation: state.generation,
              ...(previous === undefined ? {} : { previous: structuredClone(previous) }),
              signal,
            })
          : (provider.refreshModels as () => Promise<readonly ModelInfo[]>)().then(
              (models): ModelCatalogRefreshResult => ({
                status: "updated",
                providerId: provider.id,
                generation: state.generation,
                source: { id: `${provider.id}-legacy`, kind: "provider_api" },
                models,
              }),
            );
      const result = await raceWithSignal(operation, signal);
      signal.throwIfAborted();
      const diagnostics = validateDiagnostics(result.diagnostics, provider.id);
      const snapshot = await this.snapshotFromResult(
        provider,
        state.generation,
        previous,
        result,
        signal,
      );
      if (snapshot === undefined) {
        return {
          providerId: provider.id,
          refreshed: false,
          restored,
          superseded: true,
          models: [],
        };
      }
      return {
        providerId: provider.id,
        refreshed: true,
        restored,
        superseded: false,
        models: snapshot.models,
        snapshot,
        ...(diagnostics === undefined ? {} : { diagnostics }),
      };
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      if (state.controller.signal.aborted) {
        return {
          providerId: provider.id,
          refreshed: false,
          restored,
          superseded: true,
          models: [],
        };
      }
      return { providerId: provider.id, error: asError(error, provider.id, "model refresh") };
    } finally {
      this.finishRefresh(provider.id, state.controller);
    }
  }

  private async snapshotFromResult(
    provider: ModelProvider,
    refreshGeneration: number,
    previous: CatalogSnapshot | undefined,
    result: ModelCatalogRefreshResult,
    signal: AbortSignal,
  ): Promise<CatalogSnapshot | undefined> {
    if (result.providerId !== provider.id || result.generation !== refreshGeneration) {
      throw new ProviderRegistryError(
        "catalog_failure",
        `Provider ${provider.id} returned mismatched catalog refresh metadata`,
        { providerId: provider.id },
      );
    }
    validateCatalogSource(result.source, provider.id);
    const checkedAt = this.now();
    let candidate: CatalogSnapshot;
    if (result.status === "not_modified") {
      if (previous === undefined) {
        throw new ProviderRegistryError(
          "catalog_failure",
          `Provider ${provider.id} returned not_modified without a previous catalog`,
          { providerId: provider.id },
        );
      }
      candidate = {
        ...previous,
        checkedAt,
        source: structuredClone(result.source),
      };
    } else {
      const models = this.validateModels(provider, result.models);
      candidate = {
        version: 1,
        providerId: provider.id,
        generation:
          Math.max(previous?.generation ?? 0, this.snapshots.get(provider.id)?.generation ?? 0) + 1,
        checkedAt,
        updatedAt: checkedAt,
        ...(result.sourceUpdatedAt === undefined
          ? {}
          : { sourceUpdatedAt: result.sourceUpdatedAt }),
        ...(result.etag === undefined ? {} : { etag: result.etag }),
        source: structuredClone(result.source),
        models: structuredClone(models),
        ...(result.imageModels === undefined
          ? {}
          : { imageModels: structuredClone(result.imageModels) }),
      };
    }
    const validated = validateCatalogSnapshot(candidate, provider.id);
    return (await this.publishSnapshot(provider.id, refreshGeneration, validated, signal, true))
      ? validated
      : undefined;
  }

  private async restoreProvider(
    provider: ModelProvider,
    generation: number,
    signal: AbortSignal,
  ): Promise<CatalogSnapshot | undefined> {
    const stored = await this.catalogStore.read(provider.id, { signal });
    signal.throwIfAborted();
    if (stored === undefined) return this.snapshots.get(provider.id);
    const validated = validateCatalogSnapshot(stored, provider.id);
    const current = this.snapshots.get(provider.id);
    const selected =
      current !== undefined && current.generation > validated.generation ? current : validated;
    const published = await this.publishSnapshot(provider.id, generation, selected, signal, false);
    return published ? structuredClone(selected) : undefined;
  }

  private publishSnapshot(
    providerId: string,
    generation: number,
    snapshot: CatalogSnapshot,
    signal: AbortSignal,
    persist: boolean,
  ): Promise<boolean> {
    const previous = this.publicationChains.get(providerId) ?? Promise.resolve();
    const queued = (async () => {
      await previous.catch(() => undefined);
      if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) return false;
      const previousSnapshot = this.snapshots.get(providerId);
      if (persist) await this.catalogStore.write(providerId, snapshot, { signal });
      if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) {
        // A store implementation may complete its atomic replacement at the same
        // instant this generation is superseded. Roll that rejected generation
        // back while the provider publication queue still excludes newer writes.
        if (persist) {
          if (previousSnapshot === undefined) await this.catalogStore.delete(providerId);
          else await this.catalogStore.write(providerId, previousSnapshot);
        }
        return false;
      }
      this.snapshots.set(providerId, structuredClone(snapshot));
      return true;
    })();
    const tail = queued.catch(() => undefined);
    this.publicationChains.set(providerId, tail);
    void tail.then(() => {
      if (this.publicationChains.get(providerId) === tail)
        this.publicationChains.delete(providerId);
    });
    return raceWithSignal(queued, signal);
  }

  private beginRefresh(providerId: string): ProviderRefreshState {
    const generation = this.supersedeRefresh(providerId);
    const controller = new AbortController();
    this.refreshControllers.set(providerId, controller);
    return { generation, controller };
  }

  private supersedeRefresh(providerId: string): number {
    const generation = (this.refreshGenerations.get(providerId) ?? 0) + 1;
    this.refreshGenerations.set(providerId, generation);
    const controller = this.refreshControllers.get(providerId);
    if (controller !== undefined) {
      this.refreshControllers.delete(providerId);
      controller.abort(new DOMException("Catalog refresh superseded", "AbortError"));
    }
    return generation;
  }

  private finishRefresh(providerId: string, controller: AbortController): void {
    if (this.refreshControllers.get(providerId) === controller) {
      this.refreshControllers.delete(providerId);
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new ProviderRegistryError("registry_disposed", "Provider registry is disposed");
    }
  }

  private registeredEntry(id: string): RegistryEntry {
    const entry = this.providers.get(id);
    if (entry === undefined) {
      throw new ProviderRegistryError("provider_missing", `Provider ${id} is not registered`, {
        providerId: id,
      });
    }
    return entry;
  }

  private entry(id: string): RegistryEntry {
    this.assertActive();
    const entry = this.registeredEntry(id);
    if (!entry.enabled) {
      throw new ProviderRegistryError("provider_disabled", `Provider ${id} is disabled`, {
        providerId: id,
      });
    }
    return entry;
  }

  private enabledEntries(): readonly RegistryEntry[] {
    return [...this.providers.values()].filter((entry) => entry.enabled);
  }

  private refreshableEntries(
    providerId: string | undefined,
  ): readonly (RegistryEntry & { provider: RefreshableProvider })[] {
    const entries = providerId === undefined ? this.enabledEntries() : [this.entry(providerId)];
    return entries.filter(
      (entry): entry is RegistryEntry & { provider: RefreshableProvider } =>
        entry.provider.refreshModelCatalog !== undefined ||
        entry.provider.refreshModels !== undefined,
    );
  }

  private async modelsFor(provider: ModelProvider): Promise<readonly ModelInfo[]> {
    const baseline = this.validateModels(provider, await provider.listModels());
    const snapshot = this.snapshots.get(provider.id);
    if (snapshot === undefined) return baseline;
    const merged = [...baseline];
    for (const model of snapshot.models) {
      const index = merged.findIndex((candidate) => candidate.modelId === model.modelId);
      if (index < 0) merged.push(model);
      else merged[index] = model;
    }
    return this.validateModels(provider, merged);
  }

  private validateModels(
    provider: ModelProvider,
    models: readonly ModelInfo[],
  ): readonly ModelInfo[] {
    const ids = new Set<string>();
    for (const model of models) {
      if (model.providerId !== provider.id) {
        throw new ProviderRegistryError(
          "catalog_failure",
          `Provider ${provider.id} returned model ${model.modelId} owned by ${model.providerId}`,
          { providerId: provider.id, modelId: model.modelId },
        );
      }
      if (ids.has(model.modelId)) {
        throw new ProviderRegistryError(
          "model_duplicate",
          `Provider ${provider.id} returned duplicate model ${model.modelId}`,
          { providerId: provider.id, modelId: model.modelId },
        );
      }
      ids.add(model.modelId);
    }
    try {
      validateModelCatalog(models);
    } catch (error) {
      throw new ProviderRegistryError(
        "catalog_failure",
        `Provider ${provider.id} returned an invalid model catalog`,
        { providerId: provider.id, cause: error },
      );
    }
    return models;
  }

  private disposeProvider(provider: ModelProvider): Promise<void> {
    const existing = this.disposal.get(provider);
    if (existing !== undefined) return existing;
    const operation = Promise.resolve().then(() => provider.dispose?.());
    this.disposal.set(provider, operation);
    return operation;
  }
}
