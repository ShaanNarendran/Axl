// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  AuthError,
  type AuthenticationState,
  type AuthInteraction,
  listBuiltinCatalogProviders,
  type ModelInfo,
  type ModelProvider,
  type ProviderRegistry,
  ProviderRegistryError,
} from "@axl/ai";
import { ProviderManagementError, type ProviderManagementService } from "@axl/daemon";
import type {
  ProviderAuthenticationStatus,
  ProviderCatalogRefreshResult,
  ProviderErrorAction,
  ProviderErrorCategory,
  ProviderInventoryGroup,
  ProviderLoginMethod,
  ProviderRpcErrorCode,
  ProviderTextModel,
  ThinkingLevel,
} from "@axl/protocol";

export interface TrustedProviderLoginAdapter {
  createInteraction(input: {
    readonly providerId: string;
    readonly method: ProviderLoginMethod;
    readonly signal: AbortSignal;
  }): AuthInteraction;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function authenticationStatus(
  provider: ModelProvider,
  state: AuthenticationState = provider.authentication?.state() ?? { phase: "idle" },
): ProviderAuthenticationStatus {
  if (provider.authentication === undefined && provider.authMethods.includes("keyless")) {
    return { providerId: provider.id, phase: "authenticated", source: "keyless" };
  }
  return {
    providerId: provider.id,
    phase: state.phase,
    ...(state.method === undefined ? {} : { method: state.method }),
    ...(state.source === undefined ? {} : { source: state.source }),
  };
}

function loginMethods(provider: ModelProvider): readonly ProviderLoginMethod[] {
  return provider.authentication?.loginMethods ?? [];
}

function supportedThinkingLevels(model: ModelInfo): readonly ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    if (level === "off") return model.thinkingLevelMap?.off !== null;
    if ((level === "xhigh" || level === "max") && model.thinkingLevelMap?.[level] === undefined) {
      return false;
    }
    return model.thinkingLevelMap?.[level] !== null;
  });
}

function textModel(model: ModelInfo): ProviderTextModel {
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    apiDialect: model.apiDialect,
    capabilities: { ...model.capabilities },
    reasoning: model.reasoning,
    supportedThinkingLevels: supportedThinkingLevels(model),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    ...(model.cost === undefined
      ? {}
      : {
          cost: {
            inputUsdPerMTok: model.cost.inputUsdPerMTok,
            outputUsdPerMTok: model.cost.outputUsdPerMTok,
            ...(model.cost.cacheReadUsdPerMTok === undefined
              ? {}
              : { cacheReadUsdPerMTok: model.cost.cacheReadUsdPerMTok }),
            ...(model.cost.cacheWriteUsdPerMTok === undefined
              ? {}
              : { cacheWriteUsdPerMTok: model.cost.cacheWriteUsdPerMTok }),
          },
        }),
    availability: model.availability ?? { status: "available" },
  };
}

function errorDetails(
  category: ProviderErrorCategory,
  action: ProviderErrorAction,
  providerId?: string,
  modelId?: string,
) {
  return {
    category,
    action,
    ...(providerId === undefined ? {} : { providerId }),
    ...(modelId === undefined ? {} : { modelId }),
  };
}

function providerFailure(
  code: ProviderRpcErrorCode,
  message: string,
  category: ProviderErrorCategory,
  action: ProviderErrorAction,
  providerId?: string,
  modelId?: string,
): ProviderManagementError {
  return new ProviderManagementError(
    code,
    message,
    errorDetails(category, action, providerId, modelId),
  );
}

function mapRegistryError(error: ProviderRegistryError): ProviderManagementError {
  switch (error.code) {
    case "provider_missing":
      return providerFailure(
        "provider_not_found",
        "The requested provider is not registered",
        "provider",
        "configure_provider",
        error.providerId,
      );
    case "provider_disabled":
      return providerFailure(
        "provider_disabled",
        "The requested provider is disabled",
        "provider",
        "configure_provider",
        error.providerId,
      );
    case "model_missing":
      return providerFailure(
        "model_not_found",
        "The requested model is not present in the provider catalog",
        "model",
        "select_model",
        error.providerId,
        error.modelId,
      );
    case "model_unavailable":
      return providerFailure(
        "model_unavailable",
        "The requested model is currently unavailable",
        "model",
        "select_model",
        error.providerId,
        error.modelId,
      );
    case "catalog_failure":
    case "model_duplicate":
      return providerFailure(
        "catalog_refresh_failed",
        "The provider catalog could not be validated",
        "catalog",
        "refresh_catalog",
        error.providerId,
        error.modelId,
      );
    case "provider_duplicate":
    case "registry_disposed":
      return providerFailure(
        "provider_configuration_required",
        "Provider management is not available",
        "configuration",
        "configure_provider",
        error.providerId,
      );
  }
}

function mapAuthError(error: AuthError): ProviderManagementError {
  const lower = error.message.toLowerCase();
  if (lower.includes("region") || lower.includes("location")) {
    const unsupported = lower.includes("invalid") || lower.includes("unsupported");
    return providerFailure(
      unsupported ? "region_unsupported" : "region_required",
      `Provider ${error.providerId} requires a valid region or location`,
      "region",
      "select_region",
      error.providerId,
    );
  }
  if (
    lower.includes("project") ||
    lower.includes("account") ||
    lower.includes("gateway") ||
    lower.includes("base url") ||
    lower.includes("resource")
  ) {
    return providerFailure(
      "provider_configuration_required",
      `Provider ${error.providerId} requires additional configuration`,
      "configuration",
      "configure_provider",
      error.providerId,
    );
  }
  if (error.code === "not_configured") {
    return providerFailure(
      "authentication_required",
      `Provider ${error.providerId} requires authentication`,
      "authentication",
      "login",
      error.providerId,
    );
  }
  return providerFailure(
    "authentication_failed",
    error.code === "refresh_failed"
      ? `Provider ${error.providerId} requires login again`
      : `Provider ${error.providerId} authentication failed`,
    "authentication",
    error.code === "refresh_failed" ? "logout_then_login" : "login",
    error.providerId,
  );
}

export function mapProviderManagementError(error: unknown): ProviderManagementError {
  if (error instanceof ProviderManagementError) return error;
  if (error instanceof ProviderRegistryError) return mapRegistryError(error);
  if (error instanceof AuthError) return mapAuthError(error);
  if (error instanceof DOMException && error.name === "AbortError") {
    return providerFailure(
      "authentication_failed",
      "Provider operation was cancelled",
      "provider",
      "retry",
    );
  }
  return providerFailure(
    "provider_configuration_required",
    "Provider operation failed",
    "configuration",
    "configure_provider",
  );
}

function refreshFailure(
  providerId: string,
  error: Error,
): ProviderCatalogRefreshResult["providers"][number] {
  const mapped = mapProviderManagementError(error);
  if (providerId === "github-copilot" && /(?:403|exhausted|quota)/i.test(error.message)) {
    return {
      providerId,
      status: "failed",
      modelCount: 0,
      error: {
        code: "entitlement_exhausted",
        message: "GitHub Copilot access is unavailable for the current entitlement",
        action: "configure_provider",
      },
    };
  }
  if (mapped.code === "authentication_required") {
    return {
      providerId,
      status: "failed",
      modelCount: 0,
      error: { code: "authentication_required", message: mapped.message, action: "login" },
    };
  }
  if (providerId === "github-copilot") {
    return {
      providerId,
      status: "failed",
      modelCount: 0,
      error: {
        code: "entitlement_required",
        message: "GitHub Copilot catalog access requires an active entitlement",
        action: "login",
      },
    };
  }
  return {
    providerId,
    status: "failed",
    modelCount: 0,
    error: {
      code: "catalog_refresh_failed",
      message: "The provider catalog could not be refreshed",
      action: "retry",
    },
  };
}

/** Adapts the AI registry to the daemon's credential-free provider contract. */
export function createProviderManagementService(
  registry: ProviderRegistry,
  options: { readonly loginAdapter?: TrustedProviderLoginAdapter } = {},
): ProviderManagementService {
  const registration = (providerId: string) => {
    const found = registry.registrations().find((entry) => entry.provider.id === providerId);
    if (found === undefined) {
      throw providerFailure(
        "provider_not_found",
        "The requested provider is not registered",
        "provider",
        "configure_provider",
        providerId,
      );
    }
    if (!found.enabled) {
      throw providerFailure(
        "provider_disabled",
        "The requested provider is disabled",
        "provider",
        "configure_provider",
        providerId,
      );
    }
    return found;
  };

  return {
    list: async (params, signal) => {
      signal?.throwIfAborted();
      const metadata = new Map(listBuiltinCatalogProviders().map((item) => [item.id, item]));
      const registrations =
        params.providerId === undefined
          ? registry.registrations()
          : [registration(params.providerId)];
      const providers: ProviderInventoryGroup[] = [];
      for (const entry of registrations) {
        signal?.throwIfAborted();
        const provider = entry.provider;
        const snapshot = registry.catalogSnapshot(provider.id);
        let models: readonly ModelInfo[] = [];
        let catalogError: ProviderInventoryGroup["catalogError"];
        if (entry.enabled) {
          const listed = await registry.listModels({
            providerId: provider.id,
            includeUnavailable: true,
          });
          models = listed.models;
          if (listed.errors.has(provider.id)) {
            catalogError = {
              code: "catalog_failure",
              message: "The provider catalog could not be listed",
              action:
                provider.refreshModelCatalog === undefined && provider.refreshModels === undefined
                  ? "configure_provider"
                  : "refresh_catalog",
            };
          }
        }
        const catalogMetadata = metadata.get(provider.id);
        providers.push({
          providerId: provider.id,
          displayName: provider.displayName,
          enabled: entry.enabled,
          ...(catalogMetadata?.regionFamily === undefined
            ? {}
            : { regionFamily: catalogMetadata.regionFamily }),
          ...(catalogMetadata?.region === undefined ? {} : { region: catalogMetadata.region }),
          authMethods: [...provider.authMethods],
          loginMethods: loginMethods(provider),
          authentication: authenticationStatus(provider),
          catalog: {
            refreshable:
              provider.refreshModelCatalog !== undefined || provider.refreshModels !== undefined,
            ...(snapshot === undefined
              ? {}
              : {
                  generation: snapshot.generation,
                  checkedAt: snapshot.checkedAt,
                  updatedAt: snapshot.updatedAt,
                  source: { ...snapshot.source },
                }),
          },
          models: models.map(textModel),
          ...(catalogError === undefined ? {} : { catalogError }),
        });
      }
      return { providers };
    },
    refresh: async (params, signal) => {
      signal?.throwIfAborted();
      if (params.providerId !== undefined) {
        const { provider } = registration(params.providerId);
        if (provider.refreshModelCatalog === undefined && provider.refreshModels === undefined) {
          throw providerFailure(
            "catalog_refresh_unsupported",
            `Provider ${provider.id} has a static catalog`,
            "catalog",
            "configure_provider",
            provider.id,
          );
        }
      }
      try {
        const result = await registry.refresh({
          configuredOnly: params.providerId === undefined,
          ...(params.providerId === undefined ? {} : { providerId: params.providerId }),
          ...(signal === undefined ? {} : { signal }),
        });
        signal?.throwIfAborted();
        const selected =
          params.providerId === undefined
            ? registry
                .registrations()
                .filter(
                  (entry) =>
                    entry.enabled &&
                    (entry.provider.refreshModelCatalog !== undefined ||
                      entry.provider.refreshModels !== undefined),
                )
            : [registration(params.providerId)];
        const providers = selected
          .filter(
            ({ provider }) =>
              result.errors.has(provider.id) ||
              result.refreshedProviderIds.includes(provider.id) ||
              result.supersededProviderIds.includes(provider.id),
          )
          .map(({ provider }) => {
            const error = result.errors.get(provider.id);
            if (error !== undefined) return refreshFailure(provider.id, error);
            const snapshot =
              result.snapshots.get(provider.id) ?? registry.catalogSnapshot(provider.id);
            return {
              providerId: provider.id,
              status: result.supersededProviderIds.includes(provider.id)
                ? ("superseded" as const)
                : result.refreshedProviderIds.includes(provider.id)
                  ? ("refreshed" as const)
                  : ("not_modified" as const),
              modelCount: snapshot?.models.length ?? 0,
            };
          });
        if (params.providerId !== undefined) {
          const failure = providers[0];
          if (failure?.status === "failed" && failure.error !== undefined) {
            const failureError = failure.error;
            throw providerFailure(
              failureError.code,
              failureError.message,
              failureError.code === "entitlement_required" ||
                failureError.code === "entitlement_exhausted"
                ? "entitlement"
                : "catalog",
              failureError.action,
              failure.providerId,
            );
          }
        }
        return { providers };
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        throw mapProviderManagementError(error);
      }
    },
    authenticationStatus: async (params, signal) => {
      signal?.throwIfAborted();
      const registrations =
        params.providerId === undefined
          ? registry.registrations().filter((entry) => entry.enabled)
          : [registration(params.providerId)];
      const providers: ProviderAuthenticationStatus[] = [];
      for (const { provider } of registrations) {
        signal?.throwIfAborted();
        try {
          const state = await provider.authentication?.check(
            signal === undefined ? {} : { signal },
          );
          providers.push(authenticationStatus(provider, state));
        } catch (error) {
          if (signal?.aborted) signal.throwIfAborted();
          if (params.providerId !== undefined) throw mapProviderManagementError(error);
          providers.push({
            providerId: provider.id,
            phase: "reauthentication_required",
          });
        }
      }
      return { providers };
    },
    login: async (params, signal) => {
      const { provider } = registration(params.providerId);
      const authentication = provider.authentication;
      if (authentication === undefined || !loginMethods(provider).includes(params.method)) {
        throw providerFailure(
          "authentication_unavailable",
          `Provider ${provider.id} does not support ${params.method} login`,
          "authentication",
          "configure_provider",
          provider.id,
        );
      }
      if (options.loginAdapter === undefined) {
        throw providerFailure(
          "authentication_unavailable",
          "Interactive login requires a trusted process-host adapter",
          "authentication",
          "configure_provider",
          provider.id,
        );
      }
      const effectiveSignal = signal ?? new AbortController().signal;
      try {
        const interaction = options.loginAdapter.createInteraction({
          providerId: provider.id,
          method: params.method,
          signal: effectiveSignal,
        });
        const state = await authentication.login(params.method, {
          ...interaction,
          signal: effectiveSignal,
        });
        return authenticationStatus(provider, state);
      } catch (error) {
        if (effectiveSignal.aborted) effectiveSignal.throwIfAborted();
        throw mapProviderManagementError(error);
      }
    },
    logout: async (params, signal) => {
      const { provider } = registration(params.providerId);
      if (provider.authentication === undefined) {
        throw providerFailure(
          "authentication_unavailable",
          `Provider ${provider.id} has no stored authentication lifecycle`,
          "authentication",
          "configure_provider",
          provider.id,
        );
      }
      try {
        return authenticationStatus(
          provider,
          await provider.authentication.logout({ ...(signal === undefined ? {} : { signal }) }),
        );
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        throw mapProviderManagementError(error);
      }
    },
    dispose: () => registry.dispose(),
  };
}

/** Validates a selection and configured authentication before it becomes session state. */
export async function validateProviderSelection(
  registry: ProviderRegistry,
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<ModelInfo> {
  try {
    const model = await registry.getModel(providerId, modelId);
    const authentication = registry.get(providerId).authentication;
    if (authentication !== undefined) {
      const status = await authentication.check({ ...(signal === undefined ? {} : { signal }) });
      if (status.phase !== "authenticated") {
        throw providerFailure(
          "authentication_required",
          `Provider ${providerId} requires authentication before selecting ${modelId}`,
          "authentication",
          "login",
          providerId,
          modelId,
        );
      }
    }
    return model;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw mapProviderManagementError(error);
  }
}
