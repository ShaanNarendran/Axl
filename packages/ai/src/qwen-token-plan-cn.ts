// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const QWEN_TOKEN_PLAN_CN_PROVIDER_ID = "qwen-token-plan-cn";
export const QWEN_TOKEN_PLAN_CN_API_KEY_ENV = "QWEN_TOKEN_PLAN_CN_API_KEY";
export const QWEN_TOKEN_PLAN_CN_BASE_URL =
  "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

export const QWEN_TOKEN_PLAN_CN_PROVIDER_DEFINITION = {
  id: QWEN_TOKEN_PLAN_CN_PROVIDER_ID,
  displayName: "Qwen Token Plan China",
  apiKeyDisplayName: "Qwen Token Plan China API key",
  environmentVariables: [QWEN_TOKEN_PLAN_CN_API_KEY_ENV],
  baseUrl: QWEN_TOKEN_PLAN_CN_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createQwenTokenPlanCnProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(QWEN_TOKEN_PLAN_CN_PROVIDER_DEFINITION, options);
}
