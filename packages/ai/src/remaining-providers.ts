// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  decodeAnthropicMessagesStream,
  encodeAnthropicMessagesRequest,
} from "./anthropic-messages.ts";
import { createEnvironmentApiKeyAuth } from "./api-key-auth.ts";
import {
  type AmbientAuthSource,
  type ApiKeyAuthMethod,
  type AuthContext,
  AuthError,
  createProviderAuthentication,
  type ResolvedAuth,
} from "./auth.ts";
import {
  type AwsAuthFactories,
  createBedrockSources,
  createBedrockStoredAuth,
} from "./aws-auth.ts";
import { decodeAwsEventStream } from "./aws-event-stream.ts";
import { encodeAzureOpenAiResponsesRequest } from "./azure-openai.ts";
import {
  decodeBedrockConverseStream,
  encodeBedrockConverseStreamRequest,
} from "./bedrock-converse-stream.ts";
import { getStaticModelCatalog } from "./catalog.ts";
import { validateModelCatalog } from "./catalog-validation.ts";
import {
  type CloudAuthFactories,
  createAzureEntraSource,
  createGoogleVertexSources,
  createGoogleVertexStoredAuth,
  vertexRequestPolicy,
} from "./cloud-auth.ts";
import type { CredentialStore } from "./credentials.ts";
import { decodeGatewayMessagesStream, encodeGatewayMessagesRequest } from "./gateway-messages.ts";
import {
  decodeGoogleGenerativeAiStream,
  encodeGoogleGenerativeAiRequest,
} from "./google-generative-ai.ts";
import { decodeGoogleVertexStream, encodeGoogleVertexRequest } from "./google-vertex.ts";
import { type HttpSseCodec, HttpSseProvider } from "./http-sse-provider.ts";
import {
  decodeMistralConversationsStream,
  encodeMistralConversationsRequest,
} from "./mistral-conversations.ts";
import type { ImageGenerationRequest, ImageModelInfo, ModelInfo } from "./model.ts";
import {
  createAnthropicOAuth,
  createGitHubCopilotOAuth,
  createGitHubCopilotTokenAuth,
  createKimiCodingOAuth,
  createOpenAiCodexOAuth,
  createOpenRouterOAuth,
  createRadiusOAuth,
} from "./oauth-auth.ts";
import { decodeOpenAiChatStream, encodeOpenAiChatRequest } from "./openai-chat.ts";
import {
  decodeOpenAiCodexResponsesStream,
  encodeOpenAiCodexResponsesRequest,
} from "./openai-codex-responses.ts";
import { decodeResponsesStream, encodeResponsesRequest } from "./openai-responses.ts";
import {
  decodeOpenRouterImageResponse,
  encodeOpenRouterImageRequest,
} from "./openrouter-images.ts";
import type { ModelCatalogRefreshContext, ModelProvider } from "./provider.ts";
import { createStaticOpenAiChatProvider } from "./static-openai-chat-provider.ts";
import {
  delayWithSignal,
  raceWithSignal,
  readBoundedJson,
  safeEndpoint,
  stripTrailingSlashes,
} from "./transport-safety.ts";

export interface ProviderFactoryOptions {
  readonly store: CredentialStore;
  readonly context: AuthContext;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly cloudAuth?: CloudAuthFactories;
  readonly awsAuth?: AwsAuthFactories;
}

const fixedBase = (model: ModelInfo): string => {
  if (model.endpoint?.type !== "fixed")
    throw new TypeError(`Model ${model.modelId} has no fixed endpoint`);
  return stripTrailingSlashes(model.endpoint.baseUrl);
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
  const base = (model: ModelInfo, resolved: ResolvedAuth): string =>
    resolved.auth.baseUrl === undefined
      ? fixedBase(model)
      : stripTrailingSlashes(resolved.auth.baseUrl);
  return (model) => {
    if (model.apiDialect === "openai-chat") {
      return {
        encode: (selected, request, resolved) => ({
          url: `${base(selected, resolved)}/chat/completions`,
          headers: { ...selected.headers, ...authorization(resolved) },
          body: encodeOpenAiChatRequest(selected, request).body,
        }),
        decode: (frames, decodeOptions) => decodeOpenAiChatStream(frames, decodeOptions),
      };
    }
    if (model.apiDialect === "openai-responses") {
      return {
        encode: (selected, request, resolved) => ({
          url: `${base(selected, resolved)}/responses`,
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
          const authorization =
            resolved.auth.headers?.authorization ?? bearer(resolved, providerId);
          const endpoint = base(selected, resolved);
          return {
            url: `${endpoint}${endpoint.endsWith("/v1") ? "" : "/v1"}/messages`,
            headers: {
              ...selected.headers,
              ...encoded.headers,
              ...resolved.auth.headers,
              ...(options.anthropicBearer || resolved.auth.headers?.authorization !== undefined
                ? { authorization }
                : { "x-api-key": resolved.auth.apiKey ?? "" }),
              ...(encoded.headers["anthropic-beta"] !== undefined &&
              resolved.auth.headers?.["anthropic-beta"] !== undefined
                ? {
                    "anthropic-beta": `${encoded.headers["anthropic-beta"]},${resolved.auth.headers["anthropic-beta"]}`,
                  }
                : {}),
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
            url: `${base(selected, resolved)}/models/${encodeURIComponent(selected.modelId)}:streamGenerateContent?alt=sse`,
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
            url: `${base(selected, resolved)}/conversations`,
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
          url: `${base(selected, resolved)}/messages`,
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
  oauth?: ReturnType<typeof createAnthropicOAuth>;
  validateEndpoint?: (url: URL, model: ModelInfo, resolved: ResolvedAuth) => void;
}): HttpSseProvider {
  const method = createEnvironmentApiKeyAuth({
    providerId: input.id,
    displayName: `${input.displayName} API key`,
    environmentVariables: input.environmentVariables,
  });
  const authentication = createProviderAuthentication({
    providerId: input.id,
    declaredMethods:
      input.oauth === undefined ? ["environment", "file"] : ["environment", "file", "oauth"],
    methods: { apiKey: method, ...(input.oauth === undefined ? {} : { oauth: input.oauth }) },
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
    ...(input.validateEndpoint === undefined ? {} : { validateEndpoint: input.validateEndpoint }),
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
  const id = "anthropic";
  const apiKey = createEnvironmentApiKeyAuth({
    providerId: id,
    displayName: "Anthropic API key",
    environmentVariables: ["ANTHROPIC_API_KEY"],
  });
  const oauthEnvironment: AmbientAuthSource = {
    type: "environment",
    displayName: "Anthropic OAuth token",
    resolve: async ({ context, signal }) => {
      signal.throwIfAborted();
      const token = context.env("ANTHROPIC_OAUTH_TOKEN");
      if (!token) return undefined;
      return {
        auth: {
          headers: {
            authorization: `Bearer ${token}`,
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
          },
        },
        source: "ANTHROPIC_OAUTH_TOKEN",
        secretValues: [token, "claude-code-20250219,oauth-2025-04-20"],
      };
    },
  };
  const authentication = createProviderAuthentication({
    providerId: id,
    declaredMethods: ["environment", "file", "oauth"],
    methods: {
      apiKey,
      oauth: createAnthropicOAuth(options),
      sources: [{ ...apiKey, type: "environment" }, oauthEnvironment],
    },
    store: options.store,
    context: options.context,
  });
  return new HttpSseProvider({
    id,
    displayName: "Anthropic",
    authMethods: authentication.methods,
    authentication,
    models: getStaticModelCatalog(id),
    resolveAuth: (signal) => authentication.resolve({ signal }),
    codecFor: codecs(id),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
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
      oauth: createKimiCodingOAuth(options),
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

export function createOpenAiCodexProvider(options: ProviderFactoryOptions): ModelProvider {
  const id = "openai-codex";
  const oauth = createOpenAiCodexOAuth(options);
  const authentication = createProviderAuthentication({
    providerId: id,
    declaredMethods: ["oauth"],
    methods: { oauth },
    store: options.store,
    context: options.context,
  });
  return new HttpSseProvider({
    id,
    displayName: "OpenAI Codex",
    authMethods: authentication.methods,
    authentication,
    models: getStaticModelCatalog(id),
    resolveAuth: (signal) => authentication.resolve({ signal }),
    codecFor: () => ({
      encode: (model, request, resolved) =>
        encodeOpenAiCodexResponsesRequest(model, request, resolved),
      decode: (frames, decodeOptions) => decodeOpenAiCodexResponsesStream(frames, decodeOptions),
    }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function createAmazonBedrockProvider(options: ProviderFactoryOptions): ModelProvider {
  const id = "amazon-bedrock";
  const method = createBedrockStoredAuth(options.awsAuth);
  const authentication = createProviderAuthentication({
    providerId: id,
    declaredMethods: ["environment", "file", "ambient"],
    methods: { apiKey: method, sources: createBedrockSources(options.awsAuth) },
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
          authentication:
            resolved.auth.signRequest === undefined
              ? { type: "bearer", token: resolved.auth.apiKey ?? "" }
              : { type: "sigv4" },
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
  login: async (interaction) => {
    const key = await interaction.prompt({
      type: "secret",
      message: "Enter Azure OpenAI API key",
    });
    const baseUrl = await interaction.prompt({
      type: "text",
      message: "Enter Azure OpenAI base URL",
    });
    if (key.length === 0) throw new TypeError("Azure OpenAI API key cannot be empty");
    safeEndpoint(baseUrl, { label: "Azure OpenAI base URL", allowLoopbackHttp: true });
    return { type: "api_key", key, env: { AZURE_OPENAI_BASE_URL: baseUrl } };
  },
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
  const apiKey = azureAuth(id);
  const authentication = createProviderAuthentication({
    providerId: id,
    declaredMethods: ["environment", "file", "ambient"],
    methods: {
      apiKey,
      sources: [{ ...apiKey, type: "environment" }, createAzureEntraSource(options.cloudAuth)],
    },
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
  const apiKey = createGoogleVertexStoredAuth(options.cloudAuth);
  const authentication = createProviderAuthentication({
    providerId: id,
    declaredMethods: ["environment", "file", "ambient"],
    methods: { apiKey, sources: createGoogleVertexSources(options.cloudAuth) },
    store: options.store,
    context: options.context,
  });
  return new HttpSseProvider({
    id,
    displayName: "Google Vertex AI",
    authMethods: authentication.methods,
    authentication,
    models: getStaticModelCatalog(id),
    resolveAuth: (signal) => authentication.resolve({ signal }),
    codecFor: () => ({
      encode: (model, request, resolved) =>
        encodeGoogleVertexRequest(model, request, vertexRequestPolicy(resolved)),
      decode: (frames, decodeOptions) => decodeGoogleVertexStream(frames, decodeOptions),
    }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
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

const MAX_DYNAMIC_MODELS = 10_000;
const MAX_DYNAMIC_NAME_LENGTH = 512;

function dynamicModel(
  providerId: string,
  endpoint: string,
  value: unknown,
  headers?: Readonly<Record<string, string>>,
): ModelInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${providerId} returned a malformed model`);
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    row.id.length > 256 ||
    typeof row.name !== "string" ||
    row.name.length === 0 ||
    row.name.length > MAX_DYNAMIC_NAME_LENGTH
  ) {
    throw new TypeError(`${providerId} returned a model without a bounded identity`);
  }
  const rawDialect = row.apiDialect ?? row.api;
  if (
    typeof rawDialect !== "string" ||
    ![
      "openai-chat",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
      "gateway-messages",
    ].includes(rawDialect)
  ) {
    throw new TypeError(`${providerId} returned missing or unsupported dialect metadata`);
  }
  const dialect = rawDialect as
    | "openai-chat"
    | "openai-responses"
    | "anthropic-messages"
    | "google-generative-ai"
    | "gateway-messages";
  const topProvider =
    typeof row.top_provider === "object" &&
    row.top_provider !== null &&
    !Array.isArray(row.top_provider)
      ? (row.top_provider as Record<string, unknown>)
      : undefined;
  const contextValue = row.context_length ?? row.contextWindow;
  const outputValue = topProvider?.max_completion_tokens ?? row.maxOutputTokens;
  const context = Number(contextValue);
  const output = Number(outputValue);
  if (
    contextValue === undefined ||
    outputValue === undefined ||
    !Number.isSafeInteger(context) ||
    context <= 0 ||
    !Number.isSafeInteger(output) ||
    output <= 0 ||
    output > context
  ) {
    throw new TypeError(`${providerId} returned missing or invalid model limits`);
  }
  const architecture =
    typeof row.architecture === "object" &&
    row.architecture !== null &&
    !Array.isArray(row.architecture)
      ? (row.architecture as Record<string, unknown>)
      : undefined;
  const input = architecture?.input_modalities;
  const supported = row.supported_parameters;
  if (
    !Array.isArray(input) ||
    input.length > 32 ||
    !input.every((item) => typeof item === "string" && item.length <= 128)
  ) {
    throw new TypeError(`${providerId} returned missing input capability metadata`);
  }
  if (
    !Array.isArray(supported) ||
    supported.length > 128 ||
    !supported.every((item) => typeof item === "string" && item.length <= 128)
  ) {
    throw new TypeError(`${providerId} returned missing supported-parameter metadata`);
  }
  const baseCompatibility =
    dialect === "openai-chat"
      ? { dialect, supportsUsageInStreaming: true, maxTokensField: "max_tokens" as const }
      : { dialect };
  const model = {
    providerId,
    modelId: row.id,
    displayName: row.name,
    apiDialect: dialect,
    capabilities: {
      toolUse: supported.includes("tools"),
      structuredOutput: supported.includes("structured_outputs"),
      imageInput: input.includes("image"),
    },
    reasoning: supported.includes("reasoning"),
    contextWindow: context,
    maxOutputTokens: output,
    endpoint: { type: "fixed", baseUrl: endpoint } as const,
    ...(headers === undefined ? {} : { headers }),
    availability: { status: "available" as const },
    compatibility: baseCompatibility,
  } satisfies ModelInfo;
  validateModelCatalog([model]);
  return model;
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
  allowEndpoint?: (url: URL) => boolean;
  rowFilter?: (row: unknown) => boolean;
  onRows?: (rows: readonly unknown[], endpoint: string) => readonly ImageModelInfo[] | undefined;
  modelHeaders?: Readonly<Record<string, string>>;
  defaultDialect?: "openai-chat";
  oauth?: ReturnType<typeof createOpenRouterOAuth>;
  apiKey?: ApiKeyAuthMethod;
}): ModelProvider {
  const method =
    input.apiKey ??
    createEnvironmentApiKeyAuth({
      providerId: input.id,
      displayName: `${input.displayName} token`,
      environmentVariables: input.environmentVariables,
    });
  const authentication = createProviderAuthentication({
    providerId: input.id,
    declaredMethods: ["environment", "file", "oauth"],
    methods: { apiKey: method, ...(input.oauth === undefined ? {} : { oauth: input.oauth }) },
    store: input.options.store,
    context: input.options.context,
  });
  const approvedBase = (resolved: ResolvedAuth): string => {
    const base = safeEndpoint(input.endpoint?.(resolved) ?? input.baseUrl, {
      label: `${input.displayName} endpoint`,
    });
    if (
      input.allowEndpoint !== undefined
        ? !input.allowEndpoint(new URL(base))
        : new URL(base).origin !== new URL(input.baseUrl).origin
    ) {
      throw new TypeError(`${input.displayName} endpoint has an unapproved origin`);
    }
    return base;
  };
  const provider = new HttpSseProvider({
    id: input.id,
    displayName: input.displayName,
    authMethods: authentication.methods,
    authentication,
    models: [],
    resolveAuth: (signal) => authentication.resolve({ signal }),
    codecFor: codecs(input.id, { anthropicBearer: true }),
    validateEndpoint: (url, _model, resolved) => {
      if (url.origin !== new URL(approvedBase(resolved)).origin)
        throw new TypeError(`${input.displayName} request endpoint has an unapproved origin`);
    },
    ...(input.options.fetch === undefined ? {} : { fetch: input.options.fetch }),
  });
  const fetchImpl = input.options.fetch ?? fetch;
  return Object.assign(provider, {
    refreshModelCatalog: async (context: ModelCatalogRefreshContext) => {
      const resolved = await authentication.resolve({ signal: context.signal });
      const base = approvedBase(resolved);
      const response = await raceWithSignal(
        fetchImpl(`${base}/models`, {
          headers: {
            accept: "application/json",
            authorization: bearer(resolved, input.id),
            ...input.headers?.(resolved),
            ...(context.previous?.etag ? { "if-none-match": context.previous.etag } : {}),
          },
          signal: context.signal,
        }),
        context.signal,
      );
      if (response.status === 304)
        return {
          status: "not_modified" as const,
          providerId: input.id,
          generation: context.generation,
          source: { id: `${input.id}-models`, kind: input.sourceKind },
        };
      if (!response.ok) throw new Error(`${input.displayName} catalog returned ${response.status}`);
      const body = (await readBoundedJson(response, undefined, context.signal)) as {
        data?: unknown[];
        models?: unknown[];
        baseUrl?: unknown;
      };
      const rows = body.data ?? body.models;
      if (!Array.isArray(rows) || rows.length > MAX_DYNAMIC_MODELS)
        throw new TypeError(`${input.displayName} catalog has no bounded model array`);
      const endpoint = safeEndpoint(typeof body.baseUrl === "string" ? body.baseUrl : base, {
        label: `${input.displayName} model endpoint`,
        expectedOrigin: base,
      });
      const normalizedRows = rows.map((row) => ({
        raw: row,
        model: dynamicModel(
          input.id,
          endpoint,
          input.defaultDialect === undefined || typeof row !== "object" || row === null
            ? row
            : {
                ...(row as Record<string, unknown>),
                apiDialect: (row as Record<string, unknown>).apiDialect ?? input.defaultDialect,
              },
          input.modelHeaders,
        ),
      }));
      const imageModels = input.onRows?.(rows, endpoint);
      const models = normalizedRows
        .filter(({ raw }) => input.rowFilter?.(raw) ?? true)
        .map(({ model }) => model);
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
    oauth: createOpenRouterOAuth(options),
    defaultDialect: "openai-chat",
    rowFilter: (row) => hasOutput(row, "text"),
    onRows: (rows, endpoint) => {
      imageModels = rows
        .filter((row) => hasOutput(row, "image"))
        .map((row) => {
          const value = row as Record<string, unknown>;
          const architecture = value.architecture as Record<string, unknown>;
          if (
            typeof value.id !== "string" ||
            value.id.length === 0 ||
            value.id.length > 256 ||
            typeof value.name !== "string" ||
            value.name.length === 0 ||
            value.name.length > MAX_DYNAMIC_NAME_LENGTH
          ) {
            throw new TypeError("OpenRouter returned invalid image model identity");
          }
          return {
            providerId: "openrouter",
            modelId: value.id,
            displayName: value.name,
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
      const timeout = AbortSignal.timeout(request.timeoutMs ?? 120_000);
      const signal =
        request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
      const controlledRequest = { ...request, signal };
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
      const resolved = await raceWithSignal(authentication.resolve({ signal }), signal);
      const encoded = await raceWithSignal(
        encodeOpenRouterImageRequest(model, controlledRequest),
        signal,
      );
      const maximumRetries = Math.min(request.maxRetries ?? 2, 10);
      let response: Response | undefined;
      for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
        response = await raceWithSignal(
          fetchImpl("https://openrouter.ai/api/v1/images", {
            method: "POST",
            headers: {
              authorization: bearer(resolved, "openrouter"),
              "content-type": "application/json",
            },
            body: JSON.stringify(encoded.body),
            signal,
          }),
          signal,
        );
        if (
          response.ok ||
          attempt === maximumRetries ||
          ![429, 500, 502, 503, 504].includes(response.status)
        )
          break;
        await response.body?.cancel();
        const delay = Math.min(250 * 2 ** attempt, request.maxRetryDelayMs ?? 30_000);
        await delayWithSignal(delay, signal);
      }
      if (response === undefined || !response.ok) {
        await response?.body?.cancel();
        throw new Error(
          `OpenRouter image generation returned ${response?.status ?? "no response"}`,
        );
      }
      const body = await readBoundedJson(response, 64 * 1024 * 1024, signal);
      return decodeOpenRouterImageResponse(body, {
        model,
        request: controlledRequest,
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
    oauth: createGitHubCopilotOAuth(options),
    apiKey: createGitHubCopilotTokenAuth(options),
    endpoint: (resolved) => resolved.auth.baseUrl ?? "https://api.individual.githubcopilot.com",
    allowEndpoint: (url) =>
      url.protocol === "https:" &&
      (url.hostname === "api.individual.githubcopilot.com" ||
        url.hostname.endsWith(".githubcopilot.com")),
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
    validateEndpoint: (url, _model, resolved) => {
      if (url.origin !== new URL(base(resolved)).origin)
        throw new TypeError("Cloudflare AI Gateway request endpoint has an unapproved origin");
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return Object.assign(provider, {
    refreshModelCatalog: async (context: ModelCatalogRefreshContext) => {
      const resolved = await authentication.resolve({ signal: context.signal });
      const endpoint = base(resolved);
      const response = await raceWithSignal(
        fetchImpl(`${endpoint}/models`, {
          headers: { authorization: bearer(resolved, id), accept: "application/json" },
          signal: context.signal,
        }),
        context.signal,
      );
      if (!response.ok)
        throw new Error(`Cloudflare AI Gateway catalog returned ${response.status}`);
      const body = (await readBoundedJson(response, undefined, context.signal)) as {
        data?: unknown[];
      };
      if (!Array.isArray(body.data) || body.data.length > MAX_DYNAMIC_MODELS)
        throw new TypeError("Cloudflare AI Gateway catalog has no bounded model array");
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
  const gateway = safeEndpoint(options.baseUrl ?? "https://radius.pi.dev", {
    label: "Radius gateway endpoint",
    allowLoopbackHttp: options.baseUrl !== undefined,
  });
  const method = createEnvironmentApiKeyAuth({
    providerId: id,
    displayName: "Radius API key",
    environmentVariables: ["RADIUS_API_KEY"],
  });
  const authentication = createProviderAuthentication({
    providerId: id,
    declaredMethods: ["environment", "file", "oauth"],
    methods: { apiKey: method, oauth: createRadiusOAuth(gateway, options) },
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
    validateEndpoint: (url) => {
      if (url.origin !== new URL(gateway).origin)
        throw new TypeError("Radius request endpoint has an unapproved origin");
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return Object.assign(provider, {
    refreshModelCatalog: async (context: ModelCatalogRefreshContext) => {
      const resolved = await authentication.resolve({ signal: context.signal });
      const response = await raceWithSignal(
        fetchImpl(`${gateway}/v1/config`, {
          headers: { accept: "application/json", authorization: bearer(resolved, id) },
          signal: context.signal,
        }),
        context.signal,
      );
      if (!response.ok) throw new Error(`Radius catalog returned ${response.status}`);
      const body = (await readBoundedJson(response, undefined, context.signal)) as {
        baseUrl?: unknown;
        models?: unknown[];
      };
      if (
        typeof body.baseUrl !== "string" ||
        !Array.isArray(body.models) ||
        body.models.length > MAX_DYNAMIC_MODELS
      ) {
        throw new TypeError("Radius config is malformed or exceeds model limits");
      }
      const endpoint = safeEndpoint(body.baseUrl, {
        label: "Radius model endpoint",
        allowLoopbackHttp: options.baseUrl !== undefined,
        expectedOrigin: gateway,
      });
      const models = body.models.map((row) => {
        if (typeof row !== "object" || row === null || Array.isArray(row))
          throw new TypeError("Radius returned a malformed model");
        const value = row as Record<string, unknown>;
        if (
          typeof value.reasoning !== "boolean" ||
          typeof value.toolUse !== "boolean" ||
          !Array.isArray(value.input) ||
          !value.input.every((item) => typeof item === "string")
        ) {
          throw new TypeError("Radius returned incomplete capability metadata");
        }
        return dynamicModel(id, endpoint, {
          ...value,
          apiDialect: "gateway-messages",
          context_length: value.contextWindow,
          maxOutputTokens: value.maxTokens,
          architecture: { input_modalities: value.input },
          supported_parameters: [
            ...(value.toolUse ? ["tools"] : []),
            ...(value.reasoning ? ["reasoning"] : []),
          ],
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
  const endpoint = safeEndpoint(baseUrl, {
    label: "User configured endpoint",
    allowLoopbackHttp: true,
  });
  const supportedDialects = new Set([
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "mistral-conversations",
    "gateway-messages",
  ]);
  if (models.some((model) => !supportedDialects.has(model.apiDialect))) {
    throw new TypeError("User configured endpoint contains an unsupported API dialect");
  }
  const normalized = models.map((model) => ({
    ...model,
    providerId: "custom",
    endpoint: { type: "fixed", baseUrl: endpoint } as const,
    headers: { ...model.headers, ...options.headers },
  }));
  validateModelCatalog(normalized);
  if ((options.apiKeyEnvironmentVariables?.length ?? 0) === 0) {
    return new HttpSseProvider({
      id: "custom",
      displayName: "User configured endpoint",
      authMethods: ["keyless"],
      models: normalized,
      resolveAuth: () => Promise.resolve({ auth: {}, source: "keyless", secretValues: [] }),
      codecFor: codecs("custom", { keyless: true }),
      validateEndpoint: (url) => {
        if (url.origin !== new URL(endpoint).origin)
          throw new TypeError("User configured request endpoint changed origin");
      },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }
  return apiKeyProvider({
    id: "custom",
    displayName: "User configured endpoint",
    environmentVariables: options.apiKeyEnvironmentVariables ?? [],
    options,
    models: normalized,
    validateEndpoint: (url) => {
      if (url.origin !== new URL(endpoint).origin)
        throw new TypeError("User configured request endpoint changed origin");
    },
  });
}
