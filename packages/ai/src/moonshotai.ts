// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const MOONSHOTAI_PROVIDER_ID = "moonshotai";
export const MOONSHOTAI_API_KEY_ENV = "MOONSHOT_API_KEY";
export const MOONSHOTAI_BASE_URL = "https://api.moonshot.ai/v1";

export const MOONSHOTAI_PROVIDER_DEFINITION = {
  id: MOONSHOTAI_PROVIDER_ID,
  displayName: "Moonshot AI",
  apiKeyDisplayName: "Moonshot AI API key",
  environmentVariables: [MOONSHOTAI_API_KEY_ENV],
  baseUrl: MOONSHOTAI_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createMoonshotAiProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(MOONSHOTAI_PROVIDER_DEFINITION, options);
}
