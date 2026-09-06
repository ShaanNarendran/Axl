// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const ZAI_CODING_CN_PROVIDER_ID = "zai-coding-cn";
export const ZAI_CODING_CN_API_KEY_ENV = "ZAI_CODING_CN_API_KEY";
export const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";

export const ZAI_CODING_CN_PROVIDER_DEFINITION = {
  id: ZAI_CODING_CN_PROVIDER_ID,
  displayName: "Z.AI Coding China",
  apiKeyDisplayName: "Z.AI Coding China API key",
  environmentVariables: [ZAI_CODING_CN_API_KEY_ENV],
  baseUrl: ZAI_CODING_CN_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createZaiCodingCnProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(ZAI_CODING_CN_PROVIDER_DEFINITION, options);
}
