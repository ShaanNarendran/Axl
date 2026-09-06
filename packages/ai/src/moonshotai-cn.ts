// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const MOONSHOTAI_CN_PROVIDER_ID = "moonshotai-cn";
export const MOONSHOTAI_CN_API_KEY_ENV = "MOONSHOT_API_KEY";
export const MOONSHOTAI_CN_BASE_URL = "https://api.moonshot.cn/v1";

export const MOONSHOTAI_CN_PROVIDER_DEFINITION = {
  id: MOONSHOTAI_CN_PROVIDER_ID,
  displayName: "Moonshot AI China",
  apiKeyDisplayName: "Moonshot AI China API key",
  environmentVariables: [MOONSHOTAI_CN_API_KEY_ENV],
  baseUrl: MOONSHOTAI_CN_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createMoonshotAiCnProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(MOONSHOTAI_CN_PROVIDER_DEFINITION, options);
}
