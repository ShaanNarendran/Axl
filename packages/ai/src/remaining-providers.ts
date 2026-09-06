// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { createEnvironmentApiKeyAuth } from "./api-key-auth.ts";
import { decodeAwsEventStream } from "./aws-event-stream.ts";
import {
  decodeBedrockConverseStream,
  encodeBedrockConverseStreamRequest,
} from "./bedrock-converse-stream.ts";
import {
  type ApiKeyAuthMethod,
  type AuthContext,
  AuthError,
  createProviderAuthentication,
  type ResolvedAuth,
} from "./auth.ts";
import { encodeAzureOpenAiResponsesRequest } from "./azure-openai.ts";
import {
  decodeAnthropicMessagesStream,
  encodeAnthropicMessagesRequest,
} from "./anthropic-messages.ts";
import { getStaticModelCatalog } from "./catalog.ts";
import type { CredentialStore } from "./credentials.ts";
import { decodeGatewayMessagesStream, encodeGatewayMessagesRequest } from "./gateway-messages.ts";
import {
  decodeGoogleGenerativeAiStream,
  encodeGoogleGenerativeAiRequest,
} from "./google-generative-ai.ts";
import { decodeGoogleVertexStream, encodeGoogleVertexRequest } from "./google-vertex.ts";
import { HttpSseProvider, type HttpSseCodec } from "./http-sse-provider.ts";
import {
  decodeMistralConversationsStream,
  encodeMistralConversationsRequest,
} from "./mistral-conversations.ts";
import type { ApiDialect, ImageGenerationRequest, ImageModelInfo, ModelInfo } from "./model.ts";
import { decodeOpenAiChatStream, encodeOpenAiChatRequest } from "./openai-chat.ts";
import { decodeResponsesStream, encodeResponsesRequest } from "./openai-responses.ts";
import {
  decodeOpenRouterImageResponse,
  encodeOpenRouterImageRequest,
} from "./openrouter-images.ts";
import type { ModelCatalogRefreshContext, ModelProvider } from "./provider.ts";
import { createStaticOpenAiChatProvider } from "./static-openai-chat-provider.ts";

export interface ProviderFactoryOptions {
  readonly store: CredentialStore;
  readonly context: AuthContext;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

const fixedBase = (model: ModelInfo): string => {
  if (model.endpoint?.type !== "fixed")
    throw new TypeError(`Model ${model.modelId} has no fixed endpoint`);
  return model.endpoint.baseUrl.replace(/\/+$/, "");
};

function bearer(resolved: ResolvedAuth, providerId: string): string {
  const key = resolved.auth.apiKey;
  if (!key)
    throw new AuthError(
      "invalid_auth",
      providerId,
      `Provider ${providerId} has no resolved API key`,
    );
  return `Bearer ${key}`;
}

function codecs(
  providerId: string,
  options: { anthropicBearer?: boolean; keyless?: boolean } = {},
): (model: ModelInfo) => HttpSseCodec {
  const authorization = (resolved: ResolvedAuth): Readonly<Record<string, string>> =>
    options.keyless === true && !resolved.auth.apiKey
      ? { ...resolved.auth.headers }
      : { ...resolved.auth.headers, authorization: bearer(resolved, providerId) };
  return (model) => {
    if (model.apiDialect === "openai-chat") {
      return {
        encode: (selected, request, resolved) => ({
          url: `${fixedBase(selected)}/chat/completions`,
          headers: { ...selected.headers, ...authorization(resolved) },
          body: encodeOpenAiChatRequest(selected, request).body,
        }),
        decode: (frames, decodeOptions) => decodeOpenAiChatStream(frames, decodeOptions),
      };
    }
    if (model.apiDialect === "openai-responses") {
      return {
        encode: (selected, request, resolved) => ({
          url: `${fixedBase(selected)}/responses`,
          headers: { ...selected.headers, ...authorization(resolved) },
          body: encodeResponsesRequest(selected, request).body,
        }),
        decode: (frames, decodeOptions) => decodeResponsesStream(frames, decodeOptions),
      };
    }
    if (model.apiDialect === "anthropic-messages") {
      return {
        encode: (selected, request, resolved) => {
          const encoded = encodeAnthropicMessagesRequest(selected, request);
          const authorization = bearer(resolved, providerId);
          return {
            url: `${fixedBase(selected)}${fixedBase(selected).endsWith("/v1") ? "" : "/v1"}/messages`,
            headers: {
              ...selected.headers,
              ...encoded.headers,
              ...(options.anthropicBearer
                ? { authorization }
                : { "x-api-key": resolved.auth.apiKey ?? "" }),
            },
            body: encoded.body,
          };
        },
        decode: (frames, decodeOptions) => decodeAnthropicMessagesStream(frames, decodeOptions),
      };
    }
    if (model.apiDialect === "google-generative-ai") {
      return {
        encode: (selected, request, resolved) => {
          const encoded = encodeGoogleGenerativeAiRequest(selected, request);
          return {
            url: `${fixedBase(selected)}/models/${encodeURIComponent(selected.modelId)}:streamGenerateContent?alt=sse`,
            headers: {
              ...selected.headers,
              ...encoded.headers,
              "x-goog-api-key": resolved.auth.apiKey ?? "",
            },
            body: encoded.body,
          };
        },
        decode: (frames, decodeOptions) => decodeGoogleGenerativeAiStream(frames, decodeOptions),
      };
    }
    if (model.apiDialect === "mistral-conversations") {
      return {
        encode: (selected, request, resolved) => {
          const encoded = encodeMistralConversationsRequest(selected, request);
          return {
            url: `${fixedBase(selected)}/conversations`,
            headers: { ...selected.headers, ...encoded.headers, ...authorization(resolved) },
            body: encoded.body,
          };
        },
        decode: (frames, decodeOptions) => decodeMistralConversationsStream(frames, decodeOptions),
      };
    }
    if (model.apiDialect === "gateway-messages") {
      return {
        encode: (selected, request, resolved) => ({
          url: `${fixedBase(selected)}/messages`,
          headers: { ...selected.headers, ...authorization(resolved) },
          body: encodeGatewayMessagesRequest(selected, request).body,
        }),
        decode: (frames, decodeOptions) => decodeGatewayMessagesStream(frames, decodeOptions),
      };
    }
    throw new TypeError(`Provider ${providerId} has no transport for ${model.apiDialect}`);
  };
}

function apiKeyProvider(input: {
  id: string;
  displayName: string;
  environmentVariables: readonly string[];
  options: ProviderFactoryOptions;
  models?: readonly ModelInfo[];
  codecFor?: (model: ModelInfo) => HttpSseCodec;
}): HttpSseProvider {
  const method = createEnvironmentApiKeyAuth({
    providerId: input.id,
    displayName: `${input.displayName} API key`,
    environmentVariables: input.environmentVariables,
  });
  const authentication = createProviderAuthentication({
    providerId: input.id,
    declaredMethods: ["environment", "file"],
    methods: { apiKey: method },
    store: input.options.store,
    context: input.options.context,
  });
  return new HttpSseProvider({
    id: input.id,
    displayName: input.displayName,
    authMethods: authentication.methods,
    authentication,
    models: input.models ?? getStaticModelCatalog(input.id),
    resolveAuth: (signal) => authentication.resolve({ signal }),
    codecFor: input.codecFor ?? codecs(input.id),
    ...(input.options.fetch === undefined ? {} : { fetch: input.options.fetch }),
    ...(input.options.now === undefined ? {} : { now: input.options.now }),
  });
}

export const createOpenAiProvider = (options: ProviderFactoryOptions): ModelProvider =>
  apiKeyProvider({
    id: "openai",
    displayName: "OpenAI",
    environmentVariables: ["OPENAI_API_KEY"],
    options,
  });

export const createAnthropicProvider = (options: ProviderFactoryOptions): ModelProvider => {
  const provider = apiKeyProvider({
    id: "anthropic",
    displayName: "Anthropic",
    environmentVariables: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
    options,
  });
  Object.defineProperty(provider, "authMethods", { value: ["environment", "file", "oauth"] });
  return provider;
};

export const createGoogleProvider = (options: ProviderFactoryOptions): ModelProvider =>
  apiKeyProvider({
    id: "google",
    displayName: "Google Generative AI",
    environmentVariables: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    options,
  });

export const createMistralProvider = (options: ProviderFactoryOptions): ModelProvider =>
  apiKeyProvider({
    id: "mistral",
    displayName: "Mistral",
    environmentVariables: ["MISTRAL_API_KEY"],
    options,
  });

export const createKimiCodingProvider = (options: ProviderFactoryOptions): ModelProvider =>
  createStaticOpenAiChatProvider(
    {
      id: "kimi-coding",
      displayName: "Kimi For Coding",
      apiKeyDisplayName: "Kimi API key",
      environmentVariables: ["KIMI_API_KEY"],
      baseUrl: "https://api.kimi.com/coding/v1",
    },
    options,
  );

export const createOpenCodeProvider = (options: ProviderFactoryOptions): ModelProvider =>
  apiKeyProvider({
    id: "opencode",
    displayName: "OpenCode Zen",
    environmentVariables: ["OPENCODE_API_KEY"],
    options,
    codecFor: codecs("opencode", { anthropicBearer: true }),
  });

export const createOpenCodeGoProvider = (options: ProviderFactoryOptions): ModelProvider =>
  apiKeyProvider({
    id: "opencode-go",
    displayName: "OpenCode Go",
    environmentVariables: ["OPENCODE_API_KEY"],
    options,
    codecFor: codecs("opencode-go", { anthropicBearer: true }),
  });

const unavailable = (providerId: string, reason: string): readonly ModelInfo[] =>
  getStaticModelCatalog(providerId).map((model) => ({
    ...model,
    availability: { status: "unavailable", reason },
  }));

function deferredProvider(input: {
  id: string;
  displayName: string;
  methods: readonly ("oauth" | "ambient" | "environment")[];
  reason: string;
}): ModelProvider {
  const models = unavailable(input.id, input.reason);
  return {
    id: input.id,
    displayName: input.displayName,
    authMethods: input.methods,
    listModels: () => Promise.resolve(models),
    stream: async function* () {
      yield {
        type: "error",
        code: "provider_auth_deferred",
        message: input.reason,
        retryable: false,
        category: "authentication",
        requestPhase: "before_dispatch",
      };
    },
  };
}

export const createOpenAiCodexProvider = (): ModelProvider =>
  deferredProvider({
    id: "openai-codex",
    displayName: "OpenAI Codex",
    methods: ["oauth"],
    reason: "OpenAI Codex OAuth acquisition is deferred to Step 10",
  });

export function createAmazonBedrockProvider(options?: ProviderFactoryOptions): ModelProvider {
  if (options === undefined) {
    return deferredProvider({
      id: "amazon-bedrock",
      displayName: "Amazon Bedrock",
      methods: ["environment", "ambient"],
      reason: "AWS credential acquisition and SigV4 authentication are deferred to Step 10",
    });
  }
  const id = "amazon-bedrock";
  const method: ApiKeyAuthMethod = {
    displayName: "Amazon Bedrock bearer token",
    resolve: async ({ context, credential, signal }) => {
      signal.throwIfAborted();
      const token = credential?.key ?? context.env("AWS_BEARER_TOKEN_BEDROCK");
      if (!token) return undefined;
      const region =
        credential?.env?.AWS_REGION ??
        context.env("AWS_REGION") ??
        context.env("AWS_DEFAULT_REGION");
      if (!region)
        throw new AuthError(
          "not_configured",
          id,
          "Amazon Bedrock bearer authentication requires AWS_REGION",
        );
      return {
        auth: { apiKey: token },
        env: { AWS_REGION: region },
        source: credential?.key ? "stored credential" : "AWS_BEARER_TOKEN_BEDROCK",
        secretValues: [token],
      };
    },
  };
  const authentication = createProviderAuthentication({
    providerId: id,
    declaredMethods: ["environment", "file", "ambient"],
    methods: { apiKey: method },
    store: options.store,
    context: options.context,
  });
  return new HttpSseProvider({
    id,
    displayName: "Amazon Bedrock",
    authMethods: authentication.methods,
    authentication,
    models: getStaticModelCatalog(id),
    resolveAuth: (signal) => authentication.resolve({ signal }),
    codecFor: () => ({
      encode: (model, request, resolved) => {
        const region = resolved.env?.AWS_REGION;
        if (region === undefined)
          throw new AuthError("not_configured", id, "Amazon Bedrock region is missing");
        return encodeBedrockConverseStreamRequest(model, request, {
          region,
          authentication: { type: "bearer", token: resolved.auth.apiKey ?? "" },
        });
      },
      decode: () => {
        throw new TypeError("Bedrock requires AWS event stream framing");
      },
      decodeBody: (body, decodeOptions) =>
        decodeBedrockConverseStream(decodeAwsEventStream(body), decodeOptions),
    }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

const azureAuth = (providerId: string): ApiKeyAuthMethod => ({
  displayName: "Azure OpenAI API key",
  resolve: async ({ context, credential, signal }) => {
    signal.throwIfAborted();
    const key = credential?.key ?? context.env("AZURE_OPENAI_API_KEY");
    const baseUrl = credential?.env?.AZURE_OPENAI_BASE_URL ?? context.env("AZURE_OPENAI_BASE_URL");
    const resource =
      credential?.env?.AZURE_OPENAI_RESOURCE_NAME ?? context.env("AZURE_OPENAI_RESOURCE_NAME");
    if (!key) return undefined;
    if (!baseUrl && !resource)
      throw new AuthError(
        "not_configured",
        providerId,
        "Azure OpenAI requires a base URL or resource name",
      );
    return {
      auth: { apiKey: key },
      env: {
        AZURE_OPENAI_BASE_URL: baseUrl ?? `https://${resource}.openai.azure.com/openai/v1`,
        ...(context.env("AZURE_OPENAI_API_VERSION")
          ? { AZURE_OPENAI_API_VERSION: context.env("AZURE_OPENAI_API_VERSION") as string }
          : {}),
        ...(context.env("AZURE_OPENAI_DEPLOYMENT_NAME_MAP")
          ? {
              AZURE_OPENAI_DEPLOYMENT_NAME_MAP: context.env(
                "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
              ) as string,
            }
          : {}),
      },
      source: credential?.key ? "stored credential" : "AZURE_OPENAI_API_KEY",
      secretValues: [key],
    };
  },
});

export function createAzureOpenAiResponsesProvider(options: ProviderFactoryOptions): ModelProvider {
  const id = "azure-openai-responses";
  const authentication = createProviderAuthentication({
    providerId: id,
    declaredMethods: ["environment", "file", "ambient"],
    methods: { apiKey: azureAuth(id) },
    store: options.store,
    context: options.context,
  });
  return new HttpSseProvider({
    id,
    displayName: "Azure OpenAI Responses",
    authMethods: authentication.methods,
    authentication,
    models: getStaticModelCatalog(id),
    resolveAuth: (signal) => authentication.resolve({ signal }),
    codecFor: () => ({
      encode: (model, request, resolved) =>
        encodeAzureOpenAiResponsesRequest(model, request, resolved),
      decode: (frames, decodeOptions) => decodeResponsesStream(frames, decodeOptions),
    }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function createGoogleVertexProvider(options: ProviderFactoryOptions): ModelProvider {
  const id = "google-vertex";
  return apiKeyProvider({
    id,
    displayName: "Google Vertex AI",
    environmentVariables: ["GOOGLE_CLOUD_API_KEY"],
    options,
    codecFor: () => ({
      encode: (model, request, resolved) =>
        encodeGoogleVertexRequest(model, request, {
          credential: { type: "api_key", apiKey: resolved.auth.apiKey ?? "" },
          ...(resolved.env?.GOOGLE_CLOUD_PROJECT
            ? { project: resolved.env.GOOGLE_CLOUD_PROJECT }
            : {}),
          ...(resolved.env?.GOOGLE_CLOUD_LOCATION
            ? { location: resolved.env.GOOGLE_CLOUD_LOCATION }
            : {}),
        }),
      decode: (frames, decodeOptions) => decodeGoogleVertexStream(frames, decodeOptions),
    }),
  });
}

function configuredApiKey(input: {
  providerId: string;
  displayName: string;
  keyEnv: string;
  settings: readonly { env: string; key: string }[];
}): ApiKeyAuthMethod {
  return {
    displayName: input.displayName,
    login: async (interaction) => {
      const key = await interaction.prompt({
        type: "secret",
        message: `Enter ${input.displayName}`,
      });
      const env: Record<string, string> = {};
      for (const setting of input.settings)
        env[setting.env] = await interaction.prompt({
          type: "text",
          message: `Enter ${setting.key}`,
        });
      return { type: "api_key", key, env };
    },
    resolve: async ({ context, credential, signal }) => {
      signal.throwIfAborted();
      const key = credential?.key ?? context.env(input.keyEnv);
      if (!key) return undefined;
      const env: Record<string, string> = {};
      for (const setting of input.settings) {
        const value = credential?.env?.[setting.env] ?? context.env(setting.env);
        if (!value)
          throw new AuthError(
            "not_configured",
            input.providerId,
            `${input.providerId} requires ${setting.env}`,
          );
        env[setting.env] = value;
      }
      return {
        auth: { apiKey: key },
        env,
        source: credential?.key ? "stored credential" : input.keyEnv,
        secretValues: [key],
      };
    },
  };
}

export function createCloudflareWorkersAiProvider(options: ProviderFactoryOptions): ModelProvider {
  const id = "cloudflare-workers-ai";
  const method = configuredApiKey({
    providerId: id,
    displayName: "Cloudflare API token",
    keyEnv: "CLOUDFLARE_API_KEY",
    settings: [{ env: "CLOUDFLARE_ACCOUNT_ID", key: "Cloudflare account ID" }],
  });
  const authentication = createProviderAuthentication({
    providerId: id,
    declaredMethods: ["environment", "file"],
    methods: { apiKey: method },
    store: options.store,
    context: options.context,
  });
  const models = getStaticModelCatalog(id);
  return new HttpSseProvider({
    id,
    displayName: "Cloudflare Workers AI",
    authMethods: authentication.methods,
    authentication,
    models,
    resolveAuth: (signal) => authentication.resolve({ signal }),
    codecFor: () => ({
      encode: (model, request, resolved) => ({
        url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(resolved.env?.CLOUDFLARE_ACCOUNT_ID ?? "")}/ai/v1/chat/completions`,
        headers: { authorization: bearer(resolved, id) },
        body: encodeOpenAiChatRequest(model, request).body,
      }),
      decode: (frames, decodeOptions) => decodeOpenAiChatStream(frames, decodeOptions),
    }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

function dynamicModel(
  providerId: string,
  endpoint: string,
  value: unknown,
  headers?: Readonly<Record<string, string>>,
): ModelInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${providerId} returned a malformed model`);
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0 || typeof row.name !== "string")
    throw new TypeError(`${providerId} returned a model without an identity`);
  const rawDialect: ApiDialect = (row.apiDialect ?? row.api ?? "openai-chat") as ApiDialect;
  if (
    ![
      "openai-chat",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
      "gateway-messages",
    ].includes(rawDialect)
  )
    throw new TypeError(`${providerId} returned unsupported dialect ${rawDialect}`);
  const dialect = rawDialect as
    | "openai-chat"
    | "openai-responses"
    | "anthropic-messages"
    | "google-generative-ai"
    | "gateway-messages";
  const context = Number(row.context_length ?? row.contextWindow ?? 128_000);
  const output = Number(
    (row.top_provider as Record<string, unknown> | undefined)?.max_completion_tokens ??
      row.maxOutputTokens ??
      Math.min(context, 16_384),
  );
  if (
    !Number.isSafeInteger(context) ||
    context <= 0 ||
    !Number.isSafeInteger(output) ||
    output <= 0 ||
    output > context
  )
    throw new TypeError(`${providerId} returned invalid model limits`);
  const input = (row.architecture as Record<string, unknown> | undefined)?.input_modalities;
  const supported = row.supported_parameters;
  const baseCompatibility =
    dialect === "openai-chat"
      ? { dialect, supportsUsageInStreaming: true, maxTokensField: "max_tokens" as const }
      : { dialect };
  return {
    providerId,
    modelId: row.id,
    displayName: row.name,
    apiDialect: dialect,
    capabilities: {
      toolUse: !Array.isArray(supported) || supported.includes("tools"),
      structuredOutput: Array.isArray(supported) && supported.includes("structured_outputs"),
      imageInput: Array.isArray(input) && input.includes("image"),
    },
    reasoning: Array.isArray(supported) && supported.includes("reasoning"),
    contextWindow: context,
    maxOutputTokens: output,
    endpoint: { type: "fixed", baseUrl: endpoint },
    ...(headers === undefined ? {} : { headers }),
    availability: { status: "available" },
    compatibility: baseCompatibility,
  };
}

function dynamicProvider(input: {
  id: string;
  displayName: string;
  environmentVariables: readonly string[];
  baseUrl: string;
  sourceKind: "provider_api" | "entitlement" | "gateway";
  options: ProviderFactoryOptions;
  headers?: (resolved: ResolvedAuth) => Readonly<Record<string, string>>;
  endpoint?: (resolved: ResolvedAuth) => string;
  rowFilter?: (row: unknown) => boolean;
  onRows?: (rows: readonly unknown[], endpoint: string) => readonly ImageModelInfo[] | undefined;
  modelHeaders?: Readonly<Record<string, string>>;
}): ModelProvider {
  const method = createEnvironmentApiKeyAuth({
    providerId: input.id,
    displayName: `${input.displayName} token`,
    environmentVariables: input.environmentVariables,
  });
  const authentication = createProviderAuthentication({
    providerId: input.id,
    declaredMethods: ["environment", "file", "oauth"],
    methods: { apiKey: method },
    store: input.options.store,
    context: input.options.context,
  });
  const provider = new HttpSseProvider({
    id: input.id,
    displayName: input.displayName,
    authMethods: authentication.methods,
    authentication,
    models: [],
    resolveAuth: (signal) => authentication.resolve({ signal }),
    codecFor: codecs(input.id, { anthropicBearer: true }),
    ...(input.options.fetch === undefined ? {} : { fetch: input.options.fetch }),
  });
  const fetchImpl = input.options.fetch ?? fetch;
  return Object.assign(provider, {
    refreshModels: async (context: ModelCatalogRefreshContext) => {
      const resolved = await authentication.resolve({ signal: context.signal });
      const base = input.endpoint?.(resolved) ?? input.baseUrl;
      const response = await fetchImpl(`${base.replace(/\/+$/, "")}/models`, {
        headers: {
          accept: "application/json",
          authorization: bearer(resolved, input.id),
          ...input.headers?.(resolved),
          ...(context.previous?.etag ? { "if-none-match": context.previous.etag } : {}),
        },
        signal: context.signal,
      });
      if (response.status === 304)
        return {
          status: "not_modified" as const,
          providerId: input.id,
          generation: context.generation,
          source: { id: `${input.id}-models`, kind: input.sourceKind },
        };
      if (!response.ok) throw new Error(`${input.displayName} catalog returned ${response.status}`);
      const body = (await response.json()) as {
        data?: unknown[];
        models?: unknown[];
        baseUrl?: unknown;
      };
      const rows = body.data ?? body.models;
      if (!Array.isArray(rows))
        throw new TypeError(`${input.displayName} catalog has no model array`);
      const endpoint = typeof body.baseUrl === "string" ? body.baseUrl : base;
      const imageModels = input.onRows?.(rows, endpoint);
      const models = rows
        .filter((row) => input.rowFilter?.(row) ?? true)
        .map((row) => dynamicModel(input.id, endpoint, row, input.modelHeaders));
      return {
        status: "updated" as const,
        providerId: input.id,
        generation: context.generation,
        source: { id: `${input.id}-models`, kind: input.sourceKind },
        models,
        ...(imageModels === undefined ? {} : { imageModels }),
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag") as string } : {}),
      };
    },
  });
}

export function createOpenRouterProvider(options: ProviderFactoryOptions): ModelProvider {
  let imageModels: readonly ImageModelInfo[] = [];
  const hasOutput = (row: unknown, output: string): boolean => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
    const architecture = (row as Record<string, unknown>).architecture;
    if (typeof architecture !== "object" || architecture === null || Array.isArray(architecture))
      return false;
    return (
      Array.isArray((architecture as Record<string, unknown>).output_modalities) &&
      ((architecture as Record<string, unknown>).output_modalities as unknown[]).includes(output)
    );
  };
  const provider = dynamicProvider({
    id: "openrouter",
    displayName: "OpenRouter",
    environmentVariables: ["OPENROUTER_API_KEY"],
    baseUrl: "https://openrouter.ai/api/v1",
    sourceKind: "provider_api",
    options,
    rowFilter: (row) => hasOutput(row, "text"),
    onRows: (rows, endpoint) => {
      imageModels = rows
        .filter((row) => hasOutput(row, "image"))
        .map((row) => {
          const value = row as Record<string, unknown>;
          const architecture = value.architecture as Record<string, unknown>;
          return {
            providerId: "openrouter",
            modelId: value.id as string,
            displayName: value.name as string,
            apiDialect: "openrouter-images",
            input:
              Array.isArray(architecture.input_modalities) &&
              architecture.input_modalities.includes("image")
                ? ["text", "image"]
                : ["text"],
            output: ["image"],
            endpoint: { type: "fixed", baseUrl: endpoint },
            availability: { status: "available" },
          } satisfies ImageModelInfo;
        });
      return imageModels;
    },
  });
  const fetchImpl = options.fetch ?? fetch;
  return Object.assign(provider, {
    listImageModels: () => Promise.resolve(imageModels),
    generateImages: async (request: ImageGenerationRequest) => {
      const model = imageModels.find((candidate) => candidate.modelId === request.modelId);
      if (model === undefined)
        throw new TypeError(`OpenRouter has no image model ${request.modelId}`);
      const authentication = provider.authentication;
      if (authentication === undefined)
        throw new AuthError(
          "not_configured",
          "openrouter",
          "OpenRouter authentication is unavailable",
        );
      const resolved = await authentication.resolve(
        request.signal === undefined ? {} : { signal: request.signal },
      );
      const encoded = await encodeOpenRouterImageRequest(model, request);
      const response = await fetchImpl("https://openrouter.ai/api/v1/images", {
        method: "POST",
        headers: {
          authorization: bearer(resolved, "openrouter"),
          "content-type": "application/json",
        },
        body: JSON.stringify(encoded.body),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`OpenRouter image generation returned ${response.status}`);
      return decodeOpenRouterImageResponse(body, {
        model,
        request,
        secretValues: resolved.secretValues,
      });
    },
  });
}

export const createGitHubCopilotProvider = (options: ProviderFactoryOptions): ModelProvider => {
  const requiredHeaders = {
    "copilot-integration-id": "vscode-chat",
    "editor-version": "vscode/1.107.0",
    "editor-plugin-version": "copilot-chat/0.35.0",
  } as const;
  return dynamicProvider({
    id: "github-copilot",
    displayName: "GitHub Copilot",
    environmentVariables: ["COPILOT_GITHUB_TOKEN"],
    baseUrl: "https://api.individual.githubcopilot.com",
    sourceKind: "entitlement",
    options,
    headers: () => requiredHeaders,
    modelHeaders: requiredHeaders,
  });
};

export function createCloudflareAiGatewayProvider(options: ProviderFactoryOptions): ModelProvider {
  const id = "cloudflare-ai-gateway";
  const method = configuredApiKey({
    providerId: id,
    displayName: "Cloudflare AI Gateway token",
    keyEnv: "CLOUDFLARE_API_KEY",
    settings: [
      { env: "CLOUDFLARE_ACCOUNT_ID", key: "Cloudflare account ID" },
      { env: "CLOUDFLARE_GATEWAY_ID", key: "Cloudflare gateway ID" },
    ],
  });
  const authentication = createProviderAuthentication({
    providerId: id,
    declaredMethods: ["environment", "file"],
    methods: { apiKey: method },
    store: options.store,
    context: options.context,
  });
  const fetchImpl = options.fetch ?? fetch;
  const base = (resolved: ResolvedAuth) =>
    `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(resolved.env?.CLOUDFLARE_ACCOUNT_ID ?? "")}/${encodeURIComponent(resolved.env?.CLOUDFLARE_GATEWAY_ID ?? "")}/compat`;
  const provider = new HttpSseProvider({
    id,
    displayName: "Cloudflare AI Gateway",
    authMethods: authentication.methods,
    authentication,
    models: [],
    resolveAuth: (signal) => authentication.resolve({ signal }),
    codecFor: codecs(id, { anthropicBearer: true }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return Object.assign(provider, {
    refreshModels: async (context: ModelCatalogRefreshContext) => {
      const resolved = await authentication.resolve({ signal: context.signal });
      const endpoint = base(resolved);
      const response = await fetchImpl(`${endpoint}/models`, {
        headers: { authorization: bearer(resolved, id), accept: "application/json" },
        signal: context.signal,
      });
      if (!response.ok)
        throw new Error(`Cloudflare AI Gateway catalog returned ${response.status}`);
      const body = (await response.json()) as { data?: unknown[] };
      if (!Array.isArray(body.data))
        throw new TypeError("Cloudflare AI Gateway catalog has no model array");
      const models = body.data.map((row) => dynamicModel(id, endpoint, row));
      return {
        status: "updated" as const,
        providerId: id,
        generation: context.generation,
        source: { id: "cloudflare-ai-gateway-models", kind: "gateway" as const },
        models,
      };
    },
  });
}

export function createRadiusProvider(
  options: ProviderFactoryOptions & { baseUrl?: string },
): ModelProvider {
  const id = "radius";
  const gateway = (options.baseUrl ?? "https://radius.pi.dev").replace(/\/+$/, "");
  const method = createEnvironmentApiKeyAuth({
    providerId: id,
    displayName: "Radius API key",
    environmentVariables: ["RADIUS_API_KEY"],
  });
  const authentication = createProviderAuthentication({
    providerId: id,
    declaredMethods: ["environment", "file", "oauth"],
    methods: { apiKey: method },
    store: options.store,
    context: options.context,
  });
  const fetchImpl = options.fetch ?? fetch;
  const provider = new HttpSseProvider({
    id,
    displayName: "Radius",
    authMethods: authentication.methods,
    authentication,
    models: [],
    resolveAuth: (signal) => authentication.resolve({ signal }),
    codecFor: codecs(id),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return Object.assign(provider, {
    refreshModels: async (context: ModelCatalogRefreshContext) => {
      const resolved = await authentication.resolve({ signal: context.signal });
      const response = await fetchImpl(`${gateway}/v1/config`, {
        headers: { accept: "application/json", authorization: bearer(resolved, id) },
        signal: context.signal,
      });
      if (!response.ok) throw new Error(`Radius catalog returned ${response.status}`);
      const body = (await response.json()) as { baseUrl?: unknown; models?: unknown[] };
      if (typeof body.baseUrl !== "string" || !Array.isArray(body.models))
        throw new TypeError("Radius config is malformed");
      const endpoint = body.baseUrl.replace(/\/+$/, "");
      const models = body.models.map((row) => {
        if (typeof row !== "object" || row === null || Array.isArray(row))
          throw new TypeError("Radius returned a malformed model");
        const value = row as Record<string, unknown>;
        return dynamicModel(id, endpoint, {
          ...value,
          apiDialect: "gateway-messages",
          context_length: value.contextWindow,
          maxOutputTokens: value.maxTokens,
        });
      });
      return {
        status: "updated" as const,
        providerId: id,
        generation: context.generation,
        source: { id: "radius-config", kind: "gateway" as const },
        models,
      };
    },
  });
}

export interface CustomProviderOptions extends ProviderFactoryOptions {
  readonly baseUrl?: string;
  readonly models?: readonly ModelInfo[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly apiKeyEnvironmentVariables?: readonly string[];
}

export function createCustomProvider(options: CustomProviderOptions): ModelProvider {
  const models = options.models ?? [];
  if (models.length === 0) {
    return {
      id: "custom",
      displayName: "User configured endpoint",
      authMethods: ["keyless"],
      listModels: () => Promise.resolve([]),
      stream: async function* () {
        yield {
          type: "error",
          code: "custom_not_configured",
          message: "User configured endpoint has no models",
          retryable: false,
          category: "invalid_request",
          requestPhase: "before_dispatch",
        };
      },
    };
  }
  const baseUrl = options.baseUrl;
  if (!baseUrl) throw new TypeError("User configured endpoint requires baseUrl");
  const normalized = models.map((model) => ({
    ...model,
    providerId: "custom",
    endpoint: { type: "fixed", baseUrl } as const,
    headers: { ...model.headers, ...options.headers },
  }));
  if ((options.apiKeyEnvironmentVariables?.length ?? 0) === 0) {
    return new HttpSseProvider({
      id: "custom",
      displayName: "User configured endpoint",
      authMethods: ["keyless"],
      models: normalized,
      resolveAuth: () => Promise.resolve({ auth: {}, source: "keyless", secretValues: [] }),
      codecFor: codecs("custom", { keyless: true }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }
  return apiKeyProvider({
    id: "custom",
    displayName: "User configured endpoint",
    environmentVariables: options.apiKeyEnvironmentVariables ?? [],
    options,
    models: normalized,
  });
}
