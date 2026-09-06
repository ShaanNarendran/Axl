// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { createEnvironmentApiKeyAuth } from "./api-key-auth.ts";
import {
  type AuthContext,
  AuthError,
  createProviderAuthentication,
  type OAuthAuthMethod,
  type ResolvedAuth,
} from "./auth.ts";
import { getStaticModelCatalog } from "./catalog.ts";
import { validateModelCatalog } from "./catalog-validation.ts";
import type { CredentialStore } from "./credentials.ts";
import type { ModelInfo } from "./model.ts";
import { type OpenAiChatEndpoint, OpenAiChatProvider } from "./openai-chat-provider.ts";

export interface StaticOpenAiChatProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly apiKeyDisplayName: string;
  readonly environmentVariables: readonly string[];
  readonly baseUrl: string;
  readonly oauth?: OAuthAuthMethod;
}

export interface StaticOpenAiChatProviderOptions {
  readonly store: CredentialStore;
  readonly context: AuthContext;
  readonly models?: readonly ModelInfo[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

function normalizedBaseUrl(value: string, providerId: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new TypeError(`Provider ${providerId} has an invalid fixed endpoint`, { cause });
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError(`Provider ${providerId} has an unsafe fixed endpoint`);
  }
  return url.toString().replace(/\/+$/, "");
}

function validateModels(
  definition: StaticOpenAiChatProviderDefinition,
  models: readonly ModelInfo[],
): readonly ModelInfo[] {
  if (models.length === 0) {
    throw new TypeError(`Provider ${definition.id} has no static models`);
  }
  const expectedBaseUrl = normalizedBaseUrl(definition.baseUrl, definition.id);
  for (const model of models) {
    if (model.providerId !== definition.id) {
      throw new TypeError(
        `Provider ${definition.id} cannot register model ${model.modelId} owned by ${model.providerId}`,
      );
    }
    if (model.apiDialect !== "openai-chat") {
      throw new TypeError(
        `Provider ${definition.id} model ${model.modelId} does not use openai-chat`,
      );
    }
    if (
      model.endpoint?.type !== "fixed" ||
      normalizedBaseUrl(model.endpoint.baseUrl, definition.id) !== expectedBaseUrl
    ) {
      throw new TypeError(
        `Provider ${definition.id} model ${model.modelId} has an unexpected endpoint`,
      );
    }
  }
  validateModelCatalog(models);
  return models;
}

/** Creates one static bearer-authenticated OpenAI Chat provider without side effects. */
export function createStaticOpenAiChatProvider(
  definition: StaticOpenAiChatProviderDefinition,
  options: StaticOpenAiChatProviderOptions,
): OpenAiChatProvider {
  const models = validateModels(definition, options.models ?? getStaticModelCatalog(definition.id));
  const apiKey = createEnvironmentApiKeyAuth({
    providerId: definition.id,
    displayName: definition.apiKeyDisplayName,
    environmentVariables: definition.environmentVariables,
  });
  const authentication = createProviderAuthentication({
    providerId: definition.id,
    declaredMethods:
      definition.oauth === undefined ? ["environment", "file"] : ["environment", "file", "oauth"],
    methods: { apiKey, ...(definition.oauth === undefined ? {} : { oauth: definition.oauth }) },
    store: options.store,
    context: options.context,
  });
  const expectedBaseUrl = normalizedBaseUrl(definition.baseUrl, definition.id);
  const endpoint: OpenAiChatEndpoint = {
    url: (model) => {
      if (
        model.endpoint?.type !== "fixed" ||
        normalizedBaseUrl(model.endpoint.baseUrl, definition.id) !== expectedBaseUrl
      ) {
        throw new TypeError(
          `Provider ${definition.id} model ${model.modelId} has an unexpected endpoint`,
        );
      }
      return `${expectedBaseUrl}/chat/completions`;
    },
    headers: (model, resolved) => {
      const key = resolved.auth.apiKey;
      if (key === undefined || key.length === 0) {
        throw new AuthError(
          "invalid_auth",
          definition.id,
          `${definition.displayName} API key missing from resolved authentication`,
        );
      }
      return { ...model.headers, Authorization: `Bearer ${key}` };
    },
  };
  return new OpenAiChatProvider({
    id: definition.id,
    displayName: definition.displayName,
    authMethods: authentication.methods,
    authentication,
    endpoint,
    models,
    resolveAuth: (signal: AbortSignal): Promise<ResolvedAuth> => authentication.resolve({ signal }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
