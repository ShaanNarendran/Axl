// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const VERCEL_AI_GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
export const VERCEL_AI_GATEWAY_API_KEY_ENV = "AI_GATEWAY_API_KEY";
export const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export const VERCEL_AI_GATEWAY_PROVIDER_DEFINITION = {
  id: VERCEL_AI_GATEWAY_PROVIDER_ID,
  displayName: "Vercel AI Gateway",
  apiKeyDisplayName: "Vercel AI Gateway API key",
  environmentVariables: [VERCEL_AI_GATEWAY_API_KEY_ENV],
  baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createVercelAiGatewayProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(VERCEL_AI_GATEWAY_PROVIDER_DEFINITION, options);
}
