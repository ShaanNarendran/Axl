// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const MINIMAX_PROVIDER_ID = "minimax";
export const MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY";
export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";

export const MINIMAX_PROVIDER_DEFINITION = {
  id: MINIMAX_PROVIDER_ID,
  displayName: "MiniMax",
  apiKeyDisplayName: "MiniMax API key",
  environmentVariables: [MINIMAX_API_KEY_ENV],
  baseUrl: MINIMAX_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createMiniMaxProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(MINIMAX_PROVIDER_DEFINITION, options);
}
