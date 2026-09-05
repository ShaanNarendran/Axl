// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { ModelInfo, ModelRequest, ModelStreamEvent } from "./model.ts";
import type { ModelProvider } from "./provider.ts";

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

export interface RefreshProvidersOptions {
  readonly providerId?: string;
  readonly signal?: AbortSignal;
}

export interface RefreshProvidersResult extends ModelCatalogResult {
  readonly refreshedProviderIds: readonly string[];
}

interface RegistryEntry {
  readonly provider: ModelProvider;
  enabled: boolean;
}

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

/**
 * Owns registered provider lifecycles and coordinates model lookup, catalog
 * refresh, availability, and dispatch. Registration itself performs no model,
 * credential, network, or background work.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, RegistryEntry>();
  private readonly disposal = new WeakMap<ModelProvider, Promise<void>>();
  private disposed = false;

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
      this.providers.delete(provider.id);
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
    this.registeredEntry(id).enabled = enabled;
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

  async listModels(options: ModelCatalogOptions = {}): Promise<ModelCatalogResult> {
    this.assertActive();
    const entries =
      options.providerId === undefined ? this.enabledEntries() : [this.entry(options.providerId)];
    const results = await Promise.all(
      entries.map(async ({ provider }) => {
        try {
          const providerModels = this.validateModels(provider, await provider.listModels()).filter(
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

  async getModel(
    providerId: string,
    modelId: string,
    options: { includeUnavailable?: boolean } = {},
  ): Promise<ModelInfo> {
    const provider = this.get(providerId);
    let models: readonly ModelInfo[];
    try {
      models = this.validateModels(provider, await provider.listModels());
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
      await registry.getModel(providerId, request.modelId);
      yield* provider.stream(request);
    })();
  }

  async refresh(options: RefreshProvidersOptions = {}): Promise<RefreshProvidersResult> {
    this.assertActive();
    options.signal?.throwIfAborted();
    const entries =
      options.providerId === undefined ? this.enabledEntries() : [this.entry(options.providerId)];
    const results = await Promise.all(
      entries.map(async ({ provider }) => {
        if (provider.refreshModels === undefined) return { providerId: provider.id };
        try {
          options.signal?.throwIfAborted();
          const refreshed = await provider.refreshModels(
            options.signal === undefined ? {} : { signal: options.signal },
          );
          options.signal?.throwIfAborted();
          return { providerId: provider.id, models: this.validateModels(provider, refreshed) };
        } catch (error) {
          if (options.signal?.aborted) throw error;
          return { providerId: provider.id, error: asError(error, provider.id, "model refresh") };
        }
      }),
    );
    const refreshedProviderIds: string[] = [];
    const models: ModelInfo[] = [];
    const errors = new Map<string, Error>();
    for (const result of results) {
      if (result.error !== undefined) errors.set(result.providerId, result.error);
      else if (result.models !== undefined) {
        refreshedProviderIds.push(result.providerId);
        models.push(...result.models);
      }
    }
    return { models, errors, refreshedProviderIds };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const providers = [...this.providers.values()].map((entry) => entry.provider);
    this.providers.clear();
    const results = await Promise.allSettled(
      providers.map((provider) => this.disposeProvider(provider)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) throw new AggregateError(errors, "Provider registry disposal failed");
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
