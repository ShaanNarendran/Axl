// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { stripVTControlCharacters } from "node:util";

import type {
  ProviderAuthenticationStatus,
  ProviderInventoryGroup,
  ProviderLoginMethod,
  Usage,
} from "@axl/protocol";
import { type AxlClient, ProviderClientError } from "@axl/sdk";

function safe(value: string): string {
  const text = [...stripVTControlCharacters(value).replace(/\s+/gu, " ")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return !(
        code < 32 ||
        (code >= 127 && code <= 159) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    })
    .join("");
  return text.trim();
}

export function providerErrorMessage(error: unknown): string {
  if (!(error instanceof ProviderClientError)) {
    return error instanceof Error ? safe(error.message) : "provider operation failed";
  }
  const subject = [error.details.providerId, error.details.modelId].filter(Boolean).join("/");
  const action = error.details.action.replaceAll("_", " ");
  return [
    safe(error.message),
    subject ? `${error.details.category}: ${subject}` : error.details.category,
    `action: ${action}`,
    ...(error.retryable ? ["retryable"] : []),
  ].join(" · ");
}

function authenticationLabel(status: ProviderAuthenticationStatus): string {
  return [status.phase.replaceAll("_", " "), status.method, status.source]
    .filter(Boolean)
    .join(" · ");
}

export function providerStatusLines(providers: readonly ProviderInventoryGroup[]): string[] {
  return providers.flatMap((provider) => [
    `${provider.displayName} (${provider.providerId})`,
    `  authentication  ${authenticationLabel(provider.authentication)}`,
    `  login methods   ${provider.loginMethods.join(", ") || "none"}`,
    `  catalog         ${provider.catalog.refreshable ? "dynamic" : "static"} · ${provider.models.length} text models`,
    ...(provider.catalogError === undefined
      ? []
      : [
          `  catalog error   ${safe(provider.catalogError.message)} · action: ${provider.catalogError.action.replaceAll("_", " ")}`,
        ]),
  ]);
}

export function modelLines(providers: readonly ProviderInventoryGroup[]): string[] {
  return providers.flatMap((provider) => [
    `${provider.displayName} (${provider.providerId})`,
    ...provider.models.map((model) => {
      const unavailable =
        model.availability.status === "available"
          ? ""
          : ` · ${model.availability.status}${model.availability.reason ? `: ${safe(model.availability.reason)}` : ""}`;
      const cost = model.cost
        ? ` · $${model.cost.inputUsdPerMTok}/$${model.cost.outputUsdPerMTok} per MTok`
        : "";
      return `  ${model.modelId} · ${model.apiDialect}${cost}${unavailable}`;
    }),
  ]);
}

export function usageLine(usage: Usage): string {
  const values = [
    `input ${usage.inputTokens}`,
    `output ${usage.outputTokens}`,
    `cache read ${usage.cacheReadTokens}`,
    `cache write ${usage.cacheWriteTokens}`,
    ...(usage.reasoningTokens === undefined ? [] : [`reasoning ${usage.reasoningTokens}`]),
    ...(usage.costUsd === undefined ? [] : [`cost $${usage.costUsd.toFixed(6)}`]),
  ];
  return `usage: ${values.join(" · ")}`;
}

export async function runProviderCommand(input: {
  readonly client: AxlClient;
  readonly command: "providers" | "models" | "login" | "logout" | "refresh";
  readonly providerId?: string;
  readonly loginMethod?: ProviderLoginMethod;
  readonly login?: (
    providerId: string,
    method: ProviderLoginMethod,
  ) => Promise<ProviderAuthenticationStatus>;
  readonly write: (value: string) => void;
}): Promise<void> {
  const params = input.providerId === undefined ? {} : { providerId: input.providerId };
  if (input.command === "providers") {
    const listed = await input.client.listProviders(params);
    const statuses = await input.client.providerAuthenticationStatus(params);
    const statusByProvider = new Map(
      statuses.providers.map((status) => [status.providerId, status]),
    );
    const providers = listed.providers.map((provider) => ({
      ...provider,
      authentication: statusByProvider.get(provider.providerId) ?? provider.authentication,
    }));
    input.write(`${providerStatusLines(providers).join("\n")}\n`);
    return;
  }
  if (input.command === "models") {
    input.write(`${modelLines((await input.client.listProviders(params)).providers).join("\n")}\n`);
    return;
  }
  if (input.command === "refresh") {
    const refreshed = await input.client.refreshProviderCatalogs(params);
    input.write(
      `${refreshed.providers
        .map((provider) =>
          provider.error === undefined
            ? `${provider.providerId}: ${provider.status} · ${provider.modelCount} models`
            : `${provider.providerId}: ${provider.status} · ${safe(provider.error.message)} · action: ${provider.error.action.replaceAll("_", " ")}`,
        )
        .join("\n")}\n`,
    );
    return;
  }
  if (input.providerId === undefined) throw new Error(`${input.command} requires a provider ID`);
  if (input.command === "logout") {
    const status = await input.client.logoutProvider({ providerId: input.providerId });
    input.write(`${status.providerId}: ${authenticationLabel(status)}\n`);
    return;
  }
  const listed = await input.client.listProviders({ providerId: input.providerId });
  const provider = listed.providers[0];
  if (provider === undefined) throw new Error(`Unknown provider ${input.providerId}`);
  const method =
    input.loginMethod ??
    (provider.loginMethods.length === 1 ? provider.loginMethods[0] : undefined);
  if (method === undefined) {
    throw new Error(
      `Provider ${input.providerId} requires a login method: ${provider.loginMethods.join(" or ") || "none available"}`,
    );
  }
  if (!provider.loginMethods.includes(method)) {
    throw new Error(`Provider ${input.providerId} does not support ${method} login`);
  }
  const status =
    input.login === undefined
      ? await input.client.loginProvider({ providerId: input.providerId, method })
      : await input.login(input.providerId, method);
  input.write(`${status.providerId}: ${authenticationLabel(status)}\n`);
}
