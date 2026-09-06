// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";

export const GROQ_PROVIDER_ID = "groq";
export const GROQ_API_KEY_ENV = "GROQ_API_KEY";
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export const GROQ_PROVIDER_DEFINITION = {
  id: GROQ_PROVIDER_ID,
  displayName: "Groq",
  apiKeyDisplayName: "Groq API key",
  environmentVariables: [GROQ_API_KEY_ENV],
  baseUrl: GROQ_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createGroqProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(GROQ_PROVIDER_DEFINITION, options);
}
