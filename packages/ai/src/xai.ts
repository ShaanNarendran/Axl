// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import {
  createStaticOpenAiChatProvider,
  type StaticOpenAiChatProviderDefinition,
  type StaticOpenAiChatProviderOptions,
} from "./static-openai-chat-provider.ts";
import { createXaiOAuth } from "./oauth-auth.ts";

export const XAI_PROVIDER_ID = "xai";
export const XAI_API_KEY_ENV = "XAI_API_KEY";
export const XAI_BASE_URL = "https://api.x.ai/v1";

export const XAI_PROVIDER_DEFINITION = {
  id: XAI_PROVIDER_ID,
  displayName: "xAI",
  apiKeyDisplayName: "xAI API key",
  environmentVariables: [XAI_API_KEY_ENV],
  baseUrl: XAI_BASE_URL,
} as const satisfies StaticOpenAiChatProviderDefinition;

export function createXaiProvider(options: StaticOpenAiChatProviderOptions) {
  return createStaticOpenAiChatProvider(
    { ...XAI_PROVIDER_DEFINITION, oauth: createXaiOAuth(options) },
    options,
  );
}
