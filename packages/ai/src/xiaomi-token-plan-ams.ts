// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const XIAOMI_TOKEN_PLAN_AMS_PROVIDER_ID = "xiaomi-token-plan-ams";
export const XIAOMI_TOKEN_PLAN_AMS_API_KEY_ENV = "XIAOMI_TOKEN_PLAN_AMS_API_KEY";
export const XIAOMI_TOKEN_PLAN_AMS_BASE_URL = "https://token-plan-ams.xiaomimimo.com/v1";

export const XIAOMI_TOKEN_PLAN_AMS_PROVIDER_DEFINITION = {
  id: XIAOMI_TOKEN_PLAN_AMS_PROVIDER_ID,
  displayName: "Xiaomi Token Plan Amsterdam",
  apiKeyDisplayName: "Xiaomi Token Plan Amsterdam API key",
  environmentVariables: [XIAOMI_TOKEN_PLAN_AMS_API_KEY_ENV],
  baseUrl: XIAOMI_TOKEN_PLAN_AMS_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createXiaomiTokenPlanAmsProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(XIAOMI_TOKEN_PLAN_AMS_PROVIDER_DEFINITION, options);
}
