// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const FIREWORKS_PROVIDER_ID = "fireworks";
export const FIREWORKS_API_KEY_ENV = "FIREWORKS_API_KEY";
export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

export const FIREWORKS_PROVIDER_DEFINITION = {
  id: FIREWORKS_PROVIDER_ID,
  displayName: "Fireworks AI",
  apiKeyDisplayName: "Fireworks API key",
  environmentVariables: [FIREWORKS_API_KEY_ENV],
  baseUrl: FIREWORKS_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createFireworksProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(FIREWORKS_PROVIDER_DEFINITION, options);
}
