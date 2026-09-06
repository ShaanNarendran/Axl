// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const XIAOMI_PROVIDER_ID = "xiaomi";
export const XIAOMI_API_KEY_ENV = "XIAOMI_API_KEY";
export const XIAOMI_BASE_URL = "https://api.xiaomimimo.com/v1";

export const XIAOMI_PROVIDER_DEFINITION = {
  id: XIAOMI_PROVIDER_ID,
  displayName: "Xiaomi MiMo",
  apiKeyDisplayName: "Xiaomi API key",
  environmentVariables: [XIAOMI_API_KEY_ENV],
  baseUrl: XIAOMI_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createXiaomiProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(XIAOMI_PROVIDER_DEFINITION, options);
}
