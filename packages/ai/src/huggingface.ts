// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const HUGGINGFACE_PROVIDER_ID = "huggingface";
export const HUGGINGFACE_API_KEY_ENV = "HF_TOKEN";
export const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";

export const HUGGINGFACE_PROVIDER_DEFINITION = {
  id: HUGGINGFACE_PROVIDER_ID,
  displayName: "Hugging Face",
  apiKeyDisplayName: "Hugging Face token",
  environmentVariables: [HUGGINGFACE_API_KEY_ENV],
  baseUrl: HUGGINGFACE_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createHuggingFaceProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(HUGGINGFACE_PROVIDER_DEFINITION, options);
}
