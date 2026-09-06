// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const CEREBRAS_PROVIDER_ID = "cerebras";
export const CEREBRAS_API_KEY_ENV = "CEREBRAS_API_KEY";
export const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

export const CEREBRAS_PROVIDER_DEFINITION = {
  id: CEREBRAS_PROVIDER_ID,
  displayName: "Cerebras",
  apiKeyDisplayName: "Cerebras API key",
  environmentVariables: [CEREBRAS_API_KEY_ENV],
  baseUrl: CEREBRAS_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createCerebrasProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(CEREBRAS_PROVIDER_DEFINITION, options);
}
