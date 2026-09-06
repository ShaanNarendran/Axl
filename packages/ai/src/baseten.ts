// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const BASETEN_PROVIDER_ID = "baseten";
export const BASETEN_API_KEY_ENV = "BASETEN_API_KEY";
export const BASETEN_BASE_URL = "https://inference.baseten.co/v1";

export const BASETEN_PROVIDER_DEFINITION = {
  id: BASETEN_PROVIDER_ID,
  displayName: "Baseten",
  apiKeyDisplayName: "Baseten API key",
  environmentVariables: [BASETEN_API_KEY_ENV],
  baseUrl: BASETEN_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createBasetenProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(BASETEN_PROVIDER_DEFINITION, options);
}
