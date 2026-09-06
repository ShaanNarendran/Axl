// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { createEnvironmentApiKeyAuth } from "./api-key-auth.ts";
import {
  type AuthContext,
  AuthError,
  createProviderAuthentication,
  type ResolvedAuth,
} from "./auth.ts";
import { getStaticModelCatalog } from "./catalog.ts";
import type { CredentialStore } from "./credentials.ts";
import type { ModelInfo } from "./model.ts";
import { type OpenAiChatEndpoint, OpenAiChatProvider } from "./openai-chat-provider.ts";
import { stripTrailingSlashes } from "./transport-safety.ts";

export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_DISPLAY_NAME = "DeepSeek";
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export const DEEPSEEK_MODELS = getStaticModelCatalog(DEEPSEEK_PROVIDER_ID);

export const deepSeekApiKeyAuth = createEnvironmentApiKeyAuth({
  providerId: DEEPSEEK_PROVIDER_ID,
  displayName: "DeepSeek API key",
  environmentVariables: [DEEPSEEK_API_KEY_ENV],
});

function endpointBaseUrl(model: ModelInfo): string {
  if (model.endpoint?.type !== "fixed") {
    throw new TypeError(`DeepSeek model ${model.modelId} requires a fixed endpoint`);
  }
  const url = new URL(model.endpoint.baseUrl);
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new TypeError(`DeepSeek model ${model.modelId} has an invalid endpoint`);
  }
  const baseUrl = stripTrailingSlashes(url.toString());
  if (baseUrl !== DEEPSEEK_BASE_URL) {
    throw new TypeError(`DeepSeek model ${model.modelId} has an unexpected endpoint`);
  }
  return baseUrl;
}

export const deepSeekEndpoint: OpenAiChatEndpoint = {
  url: (model) => `${endpointBaseUrl(model)}/chat/completions`,
  headers: (model, resolved) => {
    endpointBaseUrl(model);
    const key = resolved.auth.apiKey;
    if (key === undefined || key.length === 0) {
      throw new AuthError(
        "invalid_auth",
        DEEPSEEK_PROVIDER_ID,
        "DeepSeek API key missing from resolved authentication",
      );
    }
    return { ...model.headers, Authorization: `Bearer ${key}` };
  },
};

export interface DeepSeekProviderOptions {
  readonly store: CredentialStore;
  readonly context: AuthContext;
  readonly models?: readonly ModelInfo[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Creates the built in DeepSeek provider without credential or network work. */
export function createDeepSeekProvider(options: DeepSeekProviderOptions): OpenAiChatProvider {
  const authentication = createProviderAuthentication({
    providerId: DEEPSEEK_PROVIDER_ID,
    declaredMethods: ["environment", "file"],
    methods: { apiKey: deepSeekApiKeyAuth },
    store: options.store,
    context: options.context,
  });
  return new OpenAiChatProvider({
    id: DEEPSEEK_PROVIDER_ID,
    displayName: DEEPSEEK_DISPLAY_NAME,
    authMethods: authentication.methods,
    authentication,
    endpoint: deepSeekEndpoint,
    models: options.models ?? DEEPSEEK_MODELS,
    resolveAuth: (signal: AbortSignal): Promise<ResolvedAuth> => authentication.resolve({ signal }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
