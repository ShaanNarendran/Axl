// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const XIAOMI_TOKEN_PLAN_CN_PROVIDER_ID = "xiaomi-token-plan-cn";
export const XIAOMI_TOKEN_PLAN_CN_API_KEY_ENV = "XIAOMI_TOKEN_PLAN_CN_API_KEY";
export const XIAOMI_TOKEN_PLAN_CN_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";

export const XIAOMI_TOKEN_PLAN_CN_PROVIDER_DEFINITION = {
  id: XIAOMI_TOKEN_PLAN_CN_PROVIDER_ID,
  displayName: "Xiaomi Token Plan China",
  apiKeyDisplayName: "Xiaomi Token Plan China API key",
  environmentVariables: [XIAOMI_TOKEN_PLAN_CN_API_KEY_ENV],
  baseUrl: XIAOMI_TOKEN_PLAN_CN_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createXiaomiTokenPlanCnProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(XIAOMI_TOKEN_PLAN_CN_PROVIDER_DEFINITION, options);
}
