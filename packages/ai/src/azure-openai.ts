// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

// Axl-native Azure OpenAI endpoint, authentication, and deployment mapping.

import {
  AuthError,
  type ApiKeyAuthMethod,
  type AuthContext,
  createProviderAuthentication,
  type ResolvedAuth,
} from "./auth.ts";
import type { CredentialStore } from "./credentials.ts";
import type { ModelInfo } from "./model.ts";
import {
  type EncodedResponsesRequest,
  encodeResponsesRequest,
  OpenAiResponsesProvider,
  type ResponsesEndpoint,
} from "./openai-responses.ts";
import type { PreparedModelRequest } from "./request-preparation.ts";

export const AZURE_OPENAI_PROVIDER_ID = "azure-openai";

import { AZURE_OPENAI_MODELS } from "./azure-openai-models.ts";

export { AZURE_OPENAI_MODELS };
export const DEFAULT_AZURE_OPENAI_API_VERSION = "v1";

/**
 * Normalizes an Azure OpenAI base URL. Azure hosts get the `/openai/v1` base
 * path; non-Azure hosts (gateways, proxies) pass through untouched.
 */
export function normalizeAzureBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (cause) {
    throw new AuthError(
      "not_configured",
      AZURE_OPENAI_PROVIDER_ID,
      `Invalid Azure OpenAI base URL: ${baseUrl}`,
      cause,
    );
  }
  const isAzureHost =
    url.hostname.endsWith(".openai.azure.com") ||
    url.hostname.endsWith(".cognitiveservices.azure.com") ||
    url.hostname.endsWith(".ai.azure.com");
  const path = url.pathname.replace(/\/+$/, "");
  if (isAzureHost && (path === "" || path === "/openai" || path === "/openai/v1/responses")) {
    url.pathname = "/openai/v1";
    url.search = "";
  }
  return url.toString().replace(/\/+$/, "");
}

/** Parses the `model=deployment,...` map from AZURE_OPENAI_DEPLOYMENT_NAME_MAP. */
export function parseDeploymentMap(value: string | undefined): Readonly<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const entry of (value ?? "").split(",")) {
    const [modelId, deployment] = entry.split("=", 2).map((part) => part.trim());
    if (modelId && deployment) map[modelId] = deployment;
  }
  return map;
}

/**
 * Azure api-key auth: the stored credential owns the provider, the
 * AZURE_OPENAI_* environment is the ambient fallback. Endpoint configuration
 * (base URL, resource name, api version, deployment map) resolves alongside
 * the key so the endpoint policy needs nothing else.
 */
export const azureOpenAiAuthMethod: ApiKeyAuthMethod = {
  displayName: "Azure OpenAI API key",
  resolve: async ({ context, credential }) => {
    // Exported Azure configuration is live and
    // takes precedence over values captured by an earlier interactive login.
    const env = (name: string): string | undefined => context.env(name) || credential?.env?.[name];
    const key = credential?.key ?? context.env("AZURE_OPENAI_API_KEY");
    if (!key) return undefined;

    const explicitBase = env("AZURE_OPENAI_BASE_URL");
    const resourceName = env("AZURE_OPENAI_RESOURCE_NAME");
    const baseUrl =
      explicitBase !== undefined
        ? normalizeAzureBaseUrl(explicitBase)
        : resourceName !== undefined
          ? `https://${resourceName}.openai.azure.com/openai/v1`
          : undefined;
    if (baseUrl === undefined) {
      throw new AuthError(
        "not_configured",
        AZURE_OPENAI_PROVIDER_ID,
        "Azure OpenAI needs AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME",
      );
    }

    const resolvedEnv: Record<string, string> = { AZURE_OPENAI_BASE_URL: baseUrl };
    for (const name of ["AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP"]) {
      const value = env(name);
      if (value !== undefined) resolvedEnv[name] = value;
    }
    return {
      auth: { apiKey: key },
      source: credential?.key !== undefined ? "stored Azure OpenAI key" : "AZURE_OPENAI_API_KEY",
      env: resolvedEnv,
      secretValues: [key],
    };
  },
};

function resolvedAzureBaseUrl(resolved: ResolvedAuth): string {
  const base = resolved.auth.baseUrl ?? resolved.env?.AZURE_OPENAI_BASE_URL;
  if (base === undefined) {
    throw new AuthError(
      "not_configured",
      AZURE_OPENAI_PROVIDER_ID,
      "Azure OpenAI base URL missing from resolved auth",
    );
  }
  return normalizeAzureBaseUrl(base);
}

function resolvedAzureApiVersion(resolved: ResolvedAuth): string {
  const version =
    resolved.env?.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
  return version;
}

function azureResourceUrl(resolved: ResolvedAuth, resource: "responses" | "models"): string {
  const url = new URL(resolvedAzureBaseUrl(resolved));
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${resource}`;
  url.searchParams.set("api-version", resolvedAzureApiVersion(resolved));
  return url.toString();
}

/** Azure endpoint policy over the resolved auth: URL, api-key header, deployments. */
export const azureEndpoint: ResponsesEndpoint = {
  url: (resolved: ResolvedAuth): string => azureResourceUrl(resolved, "responses"),
  headers: (resolved: ResolvedAuth): Readonly<Record<string, string>> => ({
    ...(resolved.auth.apiKey === undefined ? {} : { "api-key": resolved.auth.apiKey }),
    ...resolved.auth.headers,
  }),
  deploymentFor: (modelId: string, resolved: ResolvedAuth): string =>
    parseDeploymentMap(resolved.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP)[modelId] ?? modelId,
};

export interface EncodedAzureOpenAiResponsesRequest extends EncodedResponsesRequest {
  readonly url: string;
}

/** Composes one prepared request with Azure deployment, version, and header policy. */
export function encodeAzureOpenAiResponsesRequest(
  model: ModelInfo,
  request: PreparedModelRequest,
  resolved: ResolvedAuth,
): EncodedAzureOpenAiResponsesRequest {
  if (model.apiDialect !== "azure-openai-responses") {
    throw new TypeError(`Model ${model.modelId} does not use the Azure OpenAI Responses dialect`);
  }
  const encoded = encodeResponsesRequest(
    model,
    request,
    azureEndpoint.deploymentFor(model.modelId, resolved),
  );
  return {
    url: azureEndpoint.url(resolved),
    headers: { ...encoded.headers, ...azureEndpoint.headers(resolved) },
    body: encoded.body,
  };
}

export interface AzureVerification {
  readonly ok: boolean;
  readonly status?: number;
  readonly detail?: string;
}

/**
 * Verifies resolved credentials against the live endpoint with a token-free
 * `GET /models`. "Verified" must mean Azure accepted the key, not merely that
 * a credential could be read from the store.
 */
export async function verifyAzureOpenAiAuth(
  resolved: ResolvedAuth,
  fetchImpl: typeof fetch = fetch,
): Promise<AzureVerification> {
  const base = resolved.auth.baseUrl ?? resolved.env?.AZURE_OPENAI_BASE_URL;
  if (base === undefined) return { ok: false, detail: "no base URL resolved" };
  try {
    const response = await fetchImpl(azureResourceUrl(resolved, "models"), {
      headers: azureEndpoint.headers(resolved),
    });
    if (response.ok) return { ok: true, status: response.status };
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    return { ok: false, status: response.status, ...(detail ? { detail } : {}) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "request failed" };
  }
}

export interface AzureOpenAiProviderOptions {
  readonly store: CredentialStore;
  readonly context: AuthContext;
  readonly models?: readonly ModelInfo[];
  readonly fetch?: typeof fetch;
}

/** The Azure OpenAI provider: the generic Responses provider plus Azure policy. */
export function createAzureOpenAiProvider(
  options: AzureOpenAiProviderOptions,
): OpenAiResponsesProvider {
  const authentication = createProviderAuthentication({
    providerId: AZURE_OPENAI_PROVIDER_ID,
    declaredMethods: ["environment", "file"],
    methods: { apiKey: azureOpenAiAuthMethod },
    store: options.store,
    context: options.context,
  });
  return new OpenAiResponsesProvider({
    id: AZURE_OPENAI_PROVIDER_ID,
    displayName: "Azure OpenAI",
    authMethods: authentication.methods,
    authentication,
    endpoint: azureEndpoint,
    models: options.models ?? AZURE_OPENAI_MODELS,
    resolveAuth: () => authentication.resolve(),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
