// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { ApiKeyAuthMethod } from "./auth.ts";

/** Standard stored API key with ordered environment fallback and interactive entry. */
export function createEnvironmentApiKeyAuth(input: {
  readonly providerId: string;
  readonly displayName: string;
  readonly environmentVariables: readonly string[];
}): ApiKeyAuthMethod {
  return {
    displayName: input.displayName,
    login: async (interaction) => {
      interaction.signal.throwIfAborted();
      const key = await interaction.prompt({
        type: "secret",
        message: `Enter ${input.displayName}`,
      });
      interaction.signal.throwIfAborted();
      if (key.length === 0) {
        throw new TypeError(`${input.providerId} ${input.displayName} cannot be empty`);
      }
      return { type: "api_key", key };
    },
    resolve: async ({ context, credential, signal }) => {
      signal.throwIfAborted();
      if (credential !== undefined) {
        if (credential.key === undefined) return undefined;
        return {
          auth: { apiKey: credential.key },
          source: "stored credential",
          ...(credential.env === undefined ? {} : { env: credential.env }),
          secretValues: [credential.key],
        };
      }
      for (const name of input.environmentVariables) {
        const key = context.env(name);
        signal.throwIfAborted();
        if (key !== undefined && key.length > 0) {
          return {
            auth: { apiKey: key },
            source: name,
            secretValues: [key],
          };
        }
      }
      return undefined;
    },
  };
}
