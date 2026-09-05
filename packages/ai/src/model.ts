// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type {
  BlobReference,
  JsonObject,
  ModelMessage,
  SafeProviderDiagnostic,
  ThinkingLevel,
  ToolDeclaration,
  Usage,
} from "@axl/protocol";

// The canonical stream and message shapes live in @axl/protocol so the
// kernel can consume them without depending on this package. Re-exported here
// so provider code keeps one import surface.
export type {
  ModelMessage,
  ModelStreamError,
  ModelStreamEvent,
  ProviderResponseMetadata,
  ProviderRetryGuidance,
  SafeProviderDiagnostic,
  TerminalModelStreamEvent,
  ToolCallRequest,
  ToolDeclaration,
} from "@axl/protocol";
export { isTerminalModelStreamEvent, parseModelStreamEvent } from "@axl/protocol";

/**
 * How a provider can authenticate. Credential storage and lifecycle are a
 * separate slice; the contract only declares the shapes a provider supports.
 */
export type AuthMethod = "environment" | "file" | "oauth" | "ambient" | "keyless";

export type KnownApiDialect =
  | "openai-chat"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "google-vertex"
  | "bedrock-converse-stream"
  | "mistral-conversations"
  | "gateway-messages"
  | "fake";

/** Known built-in dialects plus explicit extension dialect identities. */
export type ApiDialect = KnownApiDialect | (string & {});

export type CacheRetention = "none" | "short" | "long";

export interface ModelCostRates {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly cacheReadUsdPerMTok?: number;
  readonly cacheWriteUsdPerMTok?: number;
}

export interface ModelCostTier extends ModelCostRates {
  /** This request-wide tier applies when total input exceeds the threshold. */
  readonly inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
  /** Sorted request-wide price tiers. The highest matching threshold applies. */
  readonly tiers?: readonly ModelCostTier[];
}

export interface ModelCapabilities {
  readonly toolUse: boolean;
  readonly structuredOutput: boolean;
  readonly imageInput: boolean;
}

export interface ModelCachePolicy {
  readonly supported: boolean;
  readonly defaultRetention: CacheRetention;
  readonly supportedRetentions: readonly CacheRetention[];
}

export type ModelAvailabilityStatus = "available" | "preview" | "deprecated" | "unavailable";

export interface ModelAvailability {
  readonly status: ModelAvailabilityStatus;
  readonly reason?: string;
}

export interface EndpointVariable {
  /** Non-secret logical variable used in the endpoint template. */
  readonly name: string;
  /** Public configuration key from which the variable is read. */
  readonly setting: string;
  readonly required: boolean;
  readonly defaultValue?: string;
}

export type EndpointPolicy =
  | { readonly type: "fixed"; readonly baseUrl: string }
  | {
      readonly type: "configured";
      readonly baseUrlSetting: string;
      readonly defaultBaseUrl?: string;
    }
  | {
      readonly type: "template";
      readonly template: string;
      readonly variables: readonly EndpointVariable[];
    };

export type ThinkingFormat =
  | "openai"
  | "openrouter"
  | "deepseek"
  | "together"
  | "baseten"
  | "zai"
  | "qwen"
  | "chat-template"
  | "string-thinking"
  | "ant-ling";

export type ThinkingTokenBudgetField =
  | "thinking_token_budget"
  | "thinking_budget"
  | "thinking_budget_tokens";

export type SessionAffinityFormat = "openai" | "openai-no-session" | "openrouter";

export interface GatewayRoutingPolicy {
  readonly only?: readonly string[];
  readonly order?: readonly string[];
  readonly ignore?: readonly string[];
  readonly allowFallbacks?: boolean;
  readonly requireParameters?: boolean;
  readonly dataCollection?: "allow" | "deny";
  readonly zeroDataRetention?: boolean;
  readonly sort?: "price" | "throughput" | "latency";
}

export interface OpenAiChatCompatibility {
  readonly dialect: "openai-chat";
  readonly supportsStore?: boolean;
  readonly supportsDeveloperRole?: boolean;
  readonly supportsReasoningEffort?: boolean;
  readonly supportsUsageInStreaming?: boolean;
  readonly supportsFinishReason?: boolean;
  readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
  readonly requiresToolResultName?: boolean;
  readonly requiresAssistantAfterToolResult?: boolean;
  readonly requiresThinkingAsText?: boolean;
  readonly requiresReasoningContentOnAssistantMessages?: boolean;
  readonly thinkingFormat?: ThinkingFormat;
  readonly thinkingTokenBudgetField?: ThinkingTokenBudgetField;
  readonly supportsGrammarTools?: boolean;
  readonly supportsStrictTools?: boolean;
  readonly cacheControlFormat?: "anthropic";
  readonly sessionAffinityFormat?: SessionAffinityFormat;
  readonly supportsLongCacheRetention?: boolean;
  readonly routing?: GatewayRoutingPolicy;
}

export interface OpenAiResponsesCompatibility {
  readonly dialect: "openai-responses" | "azure-openai-responses" | "openai-codex-responses";
  readonly supportsDeveloperRole?: boolean;
  readonly supportsStrictTools?: boolean;
  readonly supportsGrammarTools?: boolean;
  readonly supportsLongCacheRetention?: boolean;
  readonly supportsMaxOutputTokens?: boolean;
  readonly sessionAffinityFormat?: SessionAffinityFormat;
}

export interface AnthropicCompatibility {
  readonly dialect: "anthropic-messages";
  readonly supportsLongCacheRetention?: boolean;
  readonly supportsCacheControlOnTools?: boolean;
  readonly supportsTemperature?: boolean;
  readonly forceAdaptiveThinking?: boolean;
  readonly allowEmptyThinkingSignature?: boolean;
  readonly supportsStrictTools?: boolean;
}

export interface BedrockCompatibility {
  readonly dialect: "bedrock-converse-stream";
  readonly supportsStrictTools?: boolean;
}

export interface GenericCompatibility {
  readonly dialect:
    | "google-generative-ai"
    | "google-vertex"
    | "mistral-conversations"
    | "gateway-messages"
    | "fake";
}

/** Dialect-specific compatibility controls. No arbitrary compatibility keys are accepted. */
export type ModelCompatibility =
  | OpenAiChatCompatibility
  | OpenAiResponsesCompatibility
  | AnthropicCompatibility
  | BedrockCompatibility
  | GenericCompatibility;

export interface ModelInfo {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  /** The wire dialect selected for this exact model. */
  readonly apiDialect: ApiDialect;
  readonly capabilities: ModelCapabilities;
  /** Whether the model can think at all. False means only the `off` level. */
  readonly reasoning: boolean;
  /**
   * Maps canonical thinking levels to provider-specific values. A missing key
   * uses the provider default; `null` marks the level unsupported. `xhigh` and
   * `max` are supported only when explicitly mapped.
   */
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string | null>>>;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly cost?: ModelCost;
  readonly cache?: ModelCachePolicy;
  readonly endpoint?: EndpointPolicy;
  readonly availability?: ModelAvailability;
  /** Non-secret headers required by this model. Authentication headers are forbidden. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly compatibility?: ModelCompatibility;
}

export interface SamplingOptions {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly minP?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly repetitionPenalty?: number;
  readonly seed?: number;
  /** Explicit custom sampling fields for configured compatible endpoints. */
  readonly custom?: JsonObject;
}

export interface CacheOptions {
  readonly retention?: CacheRetention;
  readonly sessionId?: string;
}

export interface RequestControlOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly maxRetryDelayMs?: number;
}

export interface ModelRequest extends RequestControlOptions {
  readonly modelId: string;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ToolDeclaration[];
  readonly thinkingLevel?: ThinkingLevel;
  readonly thinkingBudgets?: Readonly<Partial<Record<Exclude<ThinkingLevel, "off">, number>>>;
  readonly maxOutputTokens?: number;
  readonly httpIdleTimeoutMs?: number;
  readonly estimatedInputTokens?: number;
  readonly toolChoice?: "auto" | "required" | "none";
  readonly sampling?: SamplingOptions;
  readonly cache?: CacheOptions;
  /** Provider-safe request metadata. Credentials and authorization data are forbidden. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  /** Resolves content-addressed media without placing bytes in canonical events. */
  readonly readBlob?: (reference: BlobReference) => Promise<Uint8Array>;
  /** Cancellation for an in-flight stream travels through this signal. */
  readonly signal?: AbortSignal;
}

export interface ImageModelInfo {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly apiDialect: "openrouter-images" | (string & {});
  readonly input: readonly ("text" | "image")[];
  readonly output: readonly ("text" | "image")[];
  readonly cost?: ModelCost;
  readonly endpoint?: EndpointPolicy;
  readonly availability?: ModelAvailability;
}

export interface ImageGenerationRequest extends RequestControlOptions {
  readonly modelId: string;
  readonly prompt: string;
  readonly inputImages?: readonly BlobReference[];
  readonly count?: number;
  readonly size?: { readonly width: number; readonly height: number };
  readonly aspectRatio?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly readBlob?: (reference: BlobReference) => Promise<Uint8Array>;
  /** Stores generated bytes outside events and returns their content-addressed references. */
  readonly writeBlob: (
    bytes: Uint8Array,
    metadata: { readonly mediaType: string; readonly name?: string },
  ) => Promise<BlobReference>;
  readonly signal?: AbortSignal;
}

export interface ImageGenerationResult {
  readonly providerId: string;
  readonly requestedModelId: string;
  readonly routedModelId?: string;
  readonly responseId?: string;
  readonly images: readonly BlobReference[];
  readonly revisedPrompt?: string;
  readonly usage?: Usage;
  readonly diagnostics?: readonly SafeProviderDiagnostic[];
}
