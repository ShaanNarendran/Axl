// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const ZAI_PROVIDER_ID = "zai";
export const ZAI_API_KEY_ENV = "ZAI_API_KEY";
export const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";

export const ZAI_PROVIDER_DEFINITION = {
  id: ZAI_PROVIDER_ID,
  displayName: "Z.AI",
  apiKeyDisplayName: "Z.AI API key",
  environmentVariables: [ZAI_API_KEY_ENV],
  baseUrl: ZAI_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createZaiProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(ZAI_PROVIDER_DEFINITION, options);
}
