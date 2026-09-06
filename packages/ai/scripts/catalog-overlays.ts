// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type {
  EndpointPolicy,
  KnownApiDialect,
  ModelCachePolicy,
  ModelCompatibility,
} from "../src/model.ts";

export type CatalogKind = "static" | "dynamic" | "configured";

export interface CatalogDialectRule {
  readonly prefix: string;
  readonly dialect: KnownApiDialect;
}

export interface CatalogSource {
  readonly manifest: "models-dev" | "ant-ling";
  readonly providerId: string;
  readonly includePrefixes?: readonly string[];
  readonly excludeSuffixes?: readonly string[];
  readonly excludeModelIds?: readonly string[];
}

export interface ProviderCatalogOverlay {
  readonly id: string;
  readonly displayName: string;
  readonly catalogKind: CatalogKind;
  readonly source?: CatalogSource;
  readonly dialect?: KnownApiDialect;
  readonly dialectRules?: readonly CatalogDialectRule[];
  readonly endpoint?: EndpointPolicy;
  readonly cache?: ModelCachePolicy;
  readonly compatibilityByDialect?: Readonly<Partial<Record<KnownApiDialect, ModelCompatibility>>>;
  /** Anthropic model prefixes that require adaptive rather than token-budget thinking. */
  readonly anthropicAdaptiveThinkingPrefixes?: readonly string[];
  /** Google model prefixes that support validated strict function calling. */
  readonly googleStrictToolPrefixes?: readonly string[];
  readonly regionFamily?: string;
  readonly region?: string;
}

const noCache = {
  supported: false,
  defaultRetention: "none",
  supportedRetentions: ["none"],
} as const;

const shortCache = {
  supported: true,
  defaultRetention: "short",
  supportedRetentions: ["none", "short"],
} as const;

const longCache = {
  supported: true,
  defaultRetention: "short",
  supportedRetentions: ["none", "short", "long"],
} as const;

const openAiChatCompatibility = {
  dialect: "openai-chat",
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  supportsStrictTools: false,
  supportsLongCacheRetention: false,
} as const;

const fixed = (baseUrl: string): EndpointPolicy => ({ type: "fixed", baseUrl });

export const PROVIDER_CATALOG_OVERLAYS: readonly ProviderCatalogOverlay[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "openai" },
    dialect: "openai-responses",
    dialectRules: [
      { prefix: "gpt-3.5", dialect: "openai-chat" },
      { prefix: "gpt-4", dialect: "openai-chat" },
    ],
    endpoint: fixed("https://api.openai.com/v1"),
    cache: longCache,
    compatibilityByDialect: {
      "openai-chat": { ...openAiChatCompatibility, supportsDeveloperRole: true },
      "openai-responses": {
        dialect: "openai-responses",
        supportsDeveloperRole: true,
        supportsStrictTools: true,
        supportsGrammarTools: true,
        supportsLongCacheRetention: true,
        supportsMaxOutputTokens: true,
      },
    },
  },
  {
    id: "azure-openai-responses",
    displayName: "Azure OpenAI Responses",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "azure" },
    dialect: "azure-openai-responses",
    endpoint: {
      type: "template",
      template: "https://{resource}.openai.azure.com/openai/v1",
      variables: [{ name: "resource", setting: "resource", required: true }],
    },
    cache: shortCache,
    compatibilityByDialect: {
      "azure-openai-responses": {
        dialect: "azure-openai-responses",
        supportsDeveloperRole: true,
        supportsStrictTools: true,
        supportsGrammarTools: true,
        supportsMaxOutputTokens: true,
      },
    },
  },
  {
    id: "openai-codex",
    displayName: "OpenAI Codex",
    catalogKind: "static",
    source: {
      manifest: "models-dev",
      providerId: "openai",
      includePrefixes: ["gpt-5"],
      excludeSuffixes: ["chat-latest"],
    },
    dialect: "openai-codex-responses",
    endpoint: fixed("https://chatgpt.com/backend-api/codex"),
    cache: longCache,
    compatibilityByDialect: {
      "openai-codex-responses": {
        dialect: "openai-codex-responses",
        supportsDeveloperRole: true,
        supportsStrictTools: true,
        supportsGrammarTools: true,
        supportsLongCacheRetention: true,
        supportsMaxOutputTokens: true,
      },
    },
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "anthropic" },
    dialect: "anthropic-messages",
    endpoint: fixed("https://api.anthropic.com"),
    cache: longCache,
    anthropicAdaptiveThinkingPrefixes: [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
    ],
    compatibilityByDialect: {
      "anthropic-messages": {
        dialect: "anthropic-messages",
        supportsLongCacheRetention: true,
        supportsCacheControlOnTools: true,
        supportsTemperature: true,
        supportsStrictTools: true,
      },
    },
  },
  {
    id: "google",
    displayName: "Google Generative AI",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "google" },
    dialect: "google-generative-ai",
    endpoint: fixed("https://generativelanguage.googleapis.com/v1beta"),
    cache: shortCache,
    googleStrictToolPrefixes: ["gemini-3"],
    compatibilityByDialect: {
      "google-generative-ai": {
        dialect: "google-generative-ai",
      },
    },
  },
  {
    id: "google-vertex",
    displayName: "Google Vertex AI",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "google-vertex" },
    dialect: "google-vertex",
    endpoint: {
      type: "template",
      template:
        "https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}",
      variables: [
        { name: "location", setting: "location", required: true },
        { name: "project", setting: "project", required: true },
      ],
    },
    cache: shortCache,
    googleStrictToolPrefixes: ["gemini-3"],
    compatibilityByDialect: {
      "google-vertex": {
        dialect: "google-vertex",
      },
    },
  },
  {
    id: "amazon-bedrock",
    displayName: "Amazon Bedrock",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "amazon-bedrock" },
    dialect: "bedrock-converse-stream",
    endpoint: {
      type: "template",
      template: "https://bedrock-runtime.{region}.amazonaws.com",
      variables: [{ name: "region", setting: "region", required: true }],
    },
    cache: shortCache,
    compatibilityByDialect: {
      "bedrock-converse-stream": { dialect: "bedrock-converse-stream" },
    },
  },
  {
    id: "github-copilot",
    displayName: "GitHub Copilot",
    catalogKind: "dynamic",
    dialect: "openai-chat",
    dialectRules: [{ prefix: "claude-", dialect: "anthropic-messages" }],
    endpoint: fixed("https://api.githubcopilot.com"),
    cache: shortCache,
  },
  {
    id: "xai",
    displayName: "xAI",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "xai" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.x.ai/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "deepseek" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.deepseek.com"),
    cache: shortCache,
    compatibilityByDialect: {
      "openai-chat": {
        ...openAiChatCompatibility,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
    },
  },
  {
    id: "mistral",
    displayName: "Mistral",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "mistral" },
    dialect: "mistral-conversations",
    endpoint: fixed("https://api.mistral.ai/v1"),
    cache: shortCache,
    compatibilityByDialect: {
      "mistral-conversations": { dialect: "mistral-conversations" },
    },
  },
  {
    id: "groq",
    displayName: "Groq",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "groq" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.groq.com/openai/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
  },
  {
    id: "cerebras",
    displayName: "Cerebras",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "cerebras" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.cerebras.ai/v1"),
    cache: noCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
  },
  {
    id: "nvidia",
    displayName: "NVIDIA NIM",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "nvidia" },
    dialect: "openai-chat",
    endpoint: fixed("https://integrate.api.nvidia.com/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    catalogKind: "dynamic",
    dialect: "openai-chat",
    endpoint: fixed("https://openrouter.ai/api/v1"),
    cache: longCache,
  },
  {
    id: "vercel-ai-gateway",
    displayName: "Vercel AI Gateway",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "vercel" },
    dialect: "openai-chat",
    endpoint: fixed("https://ai-gateway.vercel.sh/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
  },
  {
    id: "cloudflare-ai-gateway",
    displayName: "Cloudflare AI Gateway",
    catalogKind: "dynamic",
    dialect: "openai-chat",
    endpoint: {
      type: "template",
      template: "https://gateway.ai.cloudflare.com/v1/{account}/{gateway}",
      variables: [
        { name: "account", setting: "account", required: true },
        { name: "gateway", setting: "gateway", required: true },
      ],
    },
    cache: shortCache,
  },
  {
    id: "cloudflare-workers-ai",
    displayName: "Cloudflare Workers AI",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "cloudflare-workers-ai" },
    dialect: "openai-chat",
    endpoint: {
      type: "template",
      template: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
      variables: [{ name: "account", setting: "account", required: true }],
    },
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
  },
  {
    id: "fireworks",
    displayName: "Fireworks AI",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "fireworks-ai" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.fireworks.ai/inference/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
  },
  {
    id: "together",
    displayName: "Together AI",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "togetherai" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.together.ai/v1"),
    cache: shortCache,
    compatibilityByDialect: {
      "openai-chat": { ...openAiChatCompatibility, thinkingFormat: "together" },
    },
  },
  {
    id: "baseten",
    displayName: "Baseten",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "baseten" },
    dialect: "openai-chat",
    endpoint: fixed("https://inference.baseten.co/v1"),
    cache: shortCache,
    compatibilityByDialect: {
      "openai-chat": { ...openAiChatCompatibility, thinkingFormat: "baseten" },
    },
  },
  {
    id: "huggingface",
    displayName: "Hugging Face",
    catalogKind: "static",
    source: {
      manifest: "models-dev",
      providerId: "huggingface",
      excludeModelIds: ["thinkingmachines/Inkling-Small"],
    },
    dialect: "openai-chat",
    endpoint: fixed("https://router.huggingface.co/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
  },
  {
    id: "zai",
    displayName: "Z.AI",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "zai" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.z.ai/api/paas/v4"),
    cache: shortCache,
    compatibilityByDialect: {
      "openai-chat": { ...openAiChatCompatibility, thinkingFormat: "zai" },
    },
    regionFamily: "zai",
    region: "global",
  },
  {
    id: "zai-coding-cn",
    displayName: "Z.AI Coding China",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "zhipuai-coding-plan" },
    dialect: "openai-chat",
    endpoint: fixed("https://open.bigmodel.cn/api/coding/paas/v4"),
    cache: shortCache,
    compatibilityByDialect: {
      "openai-chat": { ...openAiChatCompatibility, thinkingFormat: "zai" },
    },
    regionFamily: "zai",
    region: "cn",
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "minimax" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.minimax.io/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
    regionFamily: "minimax",
    region: "global",
  },
  {
    id: "minimax-cn",
    displayName: "MiniMax China",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "minimax-cn" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.minimaxi.com/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
    regionFamily: "minimax",
    region: "cn",
  },
  {
    id: "moonshotai",
    displayName: "Moonshot AI",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "moonshotai" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.moonshot.ai/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
    regionFamily: "moonshotai",
    region: "global",
  },
  {
    id: "moonshotai-cn",
    displayName: "Moonshot AI China",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "moonshotai-cn" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.moonshot.cn/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
    regionFamily: "moonshotai",
    region: "cn",
  },
  {
    id: "kimi-coding",
    displayName: "Kimi For Coding",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "kimi-for-coding" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.kimi.com/coding/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
  },
  {
    id: "qwen-token-plan",
    displayName: "Qwen Token Plan",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "alibaba-token-plan" },
    dialect: "openai-chat",
    endpoint: fixed("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"),
    cache: shortCache,
    compatibilityByDialect: {
      "openai-chat": { ...openAiChatCompatibility, thinkingFormat: "qwen" },
    },
    regionFamily: "qwen-token-plan",
    region: "sgp",
  },
  {
    id: "qwen-token-plan-individual",
    displayName: "Qwen Token Plan Individual",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "alibaba-token-plan" },
    dialect: "openai-chat",
    endpoint: fixed("https://coding-intl.dashscope.aliyuncs.com/v1"),
    cache: shortCache,
    compatibilityByDialect: {
      "openai-chat": { ...openAiChatCompatibility, thinkingFormat: "qwen" },
    },
  },
  {
    id: "qwen-token-plan-cn",
    displayName: "Qwen Token Plan China",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "alibaba-token-plan-cn" },
    dialect: "openai-chat",
    endpoint: fixed("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"),
    cache: shortCache,
    compatibilityByDialect: {
      "openai-chat": { ...openAiChatCompatibility, thinkingFormat: "qwen" },
    },
    regionFamily: "qwen-token-plan",
    region: "cn",
  },
  {
    id: "xiaomi",
    displayName: "Xiaomi MiMo",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "xiaomi" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.xiaomimimo.com/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
    regionFamily: "xiaomi",
    region: "global",
  },
  {
    id: "xiaomi-token-plan-cn",
    displayName: "Xiaomi Token Plan China",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "xiaomi-token-plan-cn" },
    dialect: "openai-chat",
    endpoint: fixed("https://token-plan-cn.xiaomimimo.com/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
    regionFamily: "xiaomi",
    region: "cn",
  },
  {
    id: "xiaomi-token-plan-ams",
    displayName: "Xiaomi Token Plan Amsterdam",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "xiaomi-token-plan-ams" },
    dialect: "openai-chat",
    endpoint: fixed("https://token-plan-ams.xiaomimimo.com/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
    regionFamily: "xiaomi",
    region: "ams",
  },
  {
    id: "xiaomi-token-plan-sgp",
    displayName: "Xiaomi Token Plan Singapore",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "xiaomi-token-plan-sgp" },
    dialect: "openai-chat",
    endpoint: fixed("https://token-plan-sgp.xiaomimimo.com/v1"),
    cache: shortCache,
    compatibilityByDialect: { "openai-chat": openAiChatCompatibility },
    regionFamily: "xiaomi",
    region: "sgp",
  },
  {
    id: "opencode",
    displayName: "OpenCode Zen",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "opencode" },
    dialect: "openai-chat",
    dialectRules: [
      { prefix: "claude-", dialect: "anthropic-messages" },
      { prefix: "qwen3", dialect: "anthropic-messages" },
      { prefix: "gemini-", dialect: "google-generative-ai" },
      { prefix: "gpt-", dialect: "openai-responses" },
      { prefix: "grok-", dialect: "openai-responses" },
      { prefix: "muse-", dialect: "openai-responses" },
    ],
    endpoint: fixed("https://opencode.ai/zen/v1"),
    cache: shortCache,
    compatibilityByDialect: {
      "openai-chat": openAiChatCompatibility,
      "openai-responses": {
        dialect: "openai-responses",
        supportsDeveloperRole: true,
        supportsStrictTools: true,
        supportsGrammarTools: true,
        supportsMaxOutputTokens: true,
      },
      "anthropic-messages": {
        dialect: "anthropic-messages",
        supportsCacheControlOnTools: true,
        supportsTemperature: true,
        supportsStrictTools: true,
      },
      "google-generative-ai": { dialect: "google-generative-ai" },
    },
  },
  {
    id: "opencode-go",
    displayName: "OpenCode Go",
    catalogKind: "static",
    source: { manifest: "models-dev", providerId: "opencode-go" },
    dialect: "openai-chat",
    dialectRules: [
      { prefix: "minimax-", dialect: "anthropic-messages" },
      { prefix: "qwen3", dialect: "anthropic-messages" },
      { prefix: "gpt-", dialect: "openai-responses" },
      { prefix: "grok-", dialect: "openai-responses" },
      { prefix: "muse-", dialect: "openai-responses" },
    ],
    endpoint: fixed("https://opencode.ai/zen/go/v1"),
    cache: shortCache,
    compatibilityByDialect: {
      "openai-chat": openAiChatCompatibility,
      "openai-responses": {
        dialect: "openai-responses",
        supportsDeveloperRole: true,
        supportsStrictTools: true,
        supportsGrammarTools: true,
        supportsMaxOutputTokens: true,
      },
      "anthropic-messages": {
        dialect: "anthropic-messages",
        supportsCacheControlOnTools: true,
        supportsTemperature: true,
        supportsStrictTools: true,
      },
    },
  },
  {
    id: "ant-ling",
    displayName: "Ant Ling",
    catalogKind: "static",
    source: { manifest: "ant-ling", providerId: "ant-ling" },
    dialect: "openai-chat",
    endpoint: fixed("https://api.ant-ling.com/v1"),
    cache: noCache,
    compatibilityByDialect: {
      "openai-chat": { ...openAiChatCompatibility, thinkingFormat: "ant-ling" },
    },
  },
  {
    id: "radius",
    displayName: "Radius",
    catalogKind: "dynamic",
    dialect: "gateway-messages",
    endpoint: { type: "configured", baseUrlSetting: "baseUrl" },
    cache: shortCache,
  },
  {
    id: "custom",
    displayName: "User configured endpoint",
    catalogKind: "configured",
    dialect: "openai-chat",
    endpoint: { type: "configured", baseUrlSetting: "baseUrl" },
    cache: noCache,
  },
] as const;
