// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const TOGETHER_PROVIDER_ID = "together";
export const TOGETHER_API_KEY_ENV = "TOGETHER_API_KEY";
export const TOGETHER_BASE_URL = "https://api.together.ai/v1";

export const TOGETHER_PROVIDER_DEFINITION = {
  id: TOGETHER_PROVIDER_ID,
  displayName: "Together AI",
  apiKeyDisplayName: "Together API key",
  environmentVariables: [TOGETHER_API_KEY_ENV],
  baseUrl: TOGETHER_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createTogetherProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(TOGETHER_PROVIDER_DEFINITION, options);
}
