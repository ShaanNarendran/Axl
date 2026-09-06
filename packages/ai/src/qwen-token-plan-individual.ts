// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const QWEN_TOKEN_PLAN_INDIVIDUAL_PROVIDER_ID = "qwen-token-plan-individual";
export const QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY_ENV = "QWEN_TOKEN_PLAN_API_KEY";
export const QWEN_TOKEN_PLAN_INDIVIDUAL_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";

export const QWEN_TOKEN_PLAN_INDIVIDUAL_PROVIDER_DEFINITION = {
  id: QWEN_TOKEN_PLAN_INDIVIDUAL_PROVIDER_ID,
  displayName: "Qwen Token Plan Individual",
  apiKeyDisplayName: "Qwen Token Plan Individual API key",
  environmentVariables: [QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY_ENV],
  baseUrl: QWEN_TOKEN_PLAN_INDIVIDUAL_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createQwenTokenPlanIndividualProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(QWEN_TOKEN_PLAN_INDIVIDUAL_PROVIDER_DEFINITION, options);
}
