// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const ANT_LING_PROVIDER_ID = "ant-ling";
export const ANT_LING_API_KEY_ENV = "ANT_LING_API_KEY";
export const ANT_LING_BASE_URL = "https://api.ant-ling.com/v1";

export const ANT_LING_PROVIDER_DEFINITION = {
  id: ANT_LING_PROVIDER_ID,
  displayName: "Ant Ling",
  apiKeyDisplayName: "Ant Ling API key",
  environmentVariables: [ANT_LING_API_KEY_ENV],
  baseUrl: ANT_LING_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createAntLingProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(ANT_LING_PROVIDER_DEFINITION, options);
}
