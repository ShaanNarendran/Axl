// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const MINIMAX_CN_PROVIDER_ID = "minimax-cn";
export const MINIMAX_CN_API_KEY_ENV = "MINIMAX_CN_API_KEY";
export const MINIMAX_CN_BASE_URL = "https://api.minimaxi.com/v1";

export const MINIMAX_CN_PROVIDER_DEFINITION = {
  id: MINIMAX_CN_PROVIDER_ID,
  displayName: "MiniMax China",
  apiKeyDisplayName: "MiniMax China API key",
  environmentVariables: [MINIMAX_CN_API_KEY_ENV],
  baseUrl: MINIMAX_CN_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createMiniMaxCnProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(MINIMAX_CN_PROVIDER_DEFINITION, options);
}
