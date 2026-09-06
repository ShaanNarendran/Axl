// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const NVIDIA_PROVIDER_ID = "nvidia";
export const NVIDIA_API_KEY_ENV = "NVIDIA_API_KEY";
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

export const NVIDIA_PROVIDER_DEFINITION = {
  id: NVIDIA_PROVIDER_ID,
  displayName: "NVIDIA NIM",
  apiKeyDisplayName: "NVIDIA API key",
  environmentVariables: [NVIDIA_API_KEY_ENV],
  baseUrl: NVIDIA_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createNvidiaProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(NVIDIA_PROVIDER_DEFINITION, options);
}
