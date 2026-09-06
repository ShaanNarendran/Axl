// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const XIAOMI_TOKEN_PLAN_SGP_PROVIDER_ID = "xiaomi-token-plan-sgp";
export const XIAOMI_TOKEN_PLAN_SGP_API_KEY_ENV = "XIAOMI_TOKEN_PLAN_SGP_API_KEY";
export const XIAOMI_TOKEN_PLAN_SGP_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1";

export const XIAOMI_TOKEN_PLAN_SGP_PROVIDER_DEFINITION = {
  id: XIAOMI_TOKEN_PLAN_SGP_PROVIDER_ID,
  displayName: "Xiaomi Token Plan Singapore",
  apiKeyDisplayName: "Xiaomi Token Plan Singapore API key",
  environmentVariables: [XIAOMI_TOKEN_PLAN_SGP_API_KEY_ENV],
  baseUrl: XIAOMI_TOKEN_PLAN_SGP_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createXiaomiTokenPlanSgpProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(XIAOMI_TOKEN_PLAN_SGP_PROVIDER_DEFINITION, options);
}
