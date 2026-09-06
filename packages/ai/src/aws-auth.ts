// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

import {
  type AmbientAuthSource,
  type ApiKeyAuthMethod,
  type AuthenticatedHttpRequest,
  type AuthContext,
  AuthError,
  type ResolvedAuth,
} from "./auth.ts";
import type { ApiKeyCredential } from "./credentials.ts";

export interface AwsCredentialIdentityLike {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
}

export type AwsCredentialProviderLike = () => Promise<AwsCredentialIdentityLike>;

export interface AwsAuthFactories {
  readonly credentials?: (options: { readonly profile?: string }) => AwsCredentialProviderLike;
}

function region(context: AuthContext, credential?: ApiKeyCredential): string {
  const value =
    credential?.env?.AWS_REGION ??
    credential?.env?.AWS_DEFAULT_REGION ??
    context.env("AWS_REGION") ??
    context.env("AWS_DEFAULT_REGION");
  if (!value?.trim()) {
    throw new AuthError(
      "not_configured",
      "amazon-bedrock",
      "Amazon Bedrock requires an AWS region",
    );
  }
  return value.trim();
}

function profile(context: AuthContext, credential?: ApiKeyCredential): string | undefined {
  return credential?.env?.AWS_PROFILE?.trim() || context.env("AWS_PROFILE")?.trim() || undefined;
}

function query(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of url.searchParams) {
    const current = result[name];
    if (current === undefined) result[name] = value;
    else if (Array.isArray(current)) current.push(value);
    else result[name] = [current, value];
  }
  return result;
}

function validateCredentials(value: AwsCredentialIdentityLike): AwsCredentialIdentityLike {
  if (!value.accessKeyId || !value.secretAccessKey) {
    throw new AuthError(
      "invalid_auth",
      "amazon-bedrock",
      "AWS credential chain returned incomplete credentials",
    );
  }
  return value;
}

async function sign(
  request: AuthenticatedHttpRequest,
  signal: AbortSignal,
  credentials: AwsCredentialIdentityLike,
  awsRegion: string,
): Promise<Readonly<Record<string, string>>> {
  signal.throwIfAborted();
  const url = new URL(request.url);
  const signer = new SignatureV4({
    credentials,
    region: awsRegion,
    service: "bedrock",
    sha256: Hash.bind(null, "sha256"),
  });
  const signed = await signer.sign(
    new HttpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      method: request.method,
      path: url.pathname,
      query: query(url),
      headers: { host: url.host, ...request.headers },
      body: request.body,
    }),
  );
  signal.throwIfAborted();
  return signed.headers;
}

function bearer(context: AuthContext, credential?: ApiKeyCredential): ResolvedAuth | undefined {
  const token = credential?.key ?? context.env("AWS_BEARER_TOKEN_BEDROCK");
  if (!token) return undefined;
  return {
    auth: { apiKey: token },
    env: { AWS_REGION: region(context, credential) },
    source: credential?.key === undefined ? "AWS_BEARER_TOKEN_BEDROCK" : "stored credential",
    secretValues: [token],
  };
}

async function sigv4(
  context: AuthContext,
  credential: ApiKeyCredential | undefined,
  signal: AbortSignal,
  factories: AwsAuthFactories,
): Promise<ResolvedAuth> {
  const awsRegion = region(context, credential);
  const selectedProfile = profile(context, credential);
  const provider =
    factories.credentials?.(selectedProfile === undefined ? {} : { profile: selectedProfile }) ??
    defaultProvider(selectedProfile === undefined ? {} : { profile: selectedProfile });
  let credentials: AwsCredentialIdentityLike;
  try {
    signal.throwIfAborted();
    credentials = validateCredentials(await provider());
    signal.throwIfAborted();
  } catch (cause) {
    if (signal.aborted) signal.throwIfAborted();
    if (cause instanceof AuthError) throw cause;
    throw new AuthError(
      "invalid_auth",
      "amazon-bedrock",
      "AWS default credential chain failed for amazon-bedrock",
      cause,
    );
  }
  const secretValues = [
    credentials.accessKeyId,
    credentials.secretAccessKey,
    ...(credentials.sessionToken === undefined ? [] : [credentials.sessionToken]),
  ];
  return {
    auth: {
      signRequest: (request, requestSignal) => sign(request, requestSignal, credentials, awsRegion),
    },
    env: { AWS_REGION: awsRegion, ...(selectedProfile ? { AWS_PROFILE: selectedProfile } : {}) },
    source: selectedProfile ? `AWS profile ${selectedProfile}` : "AWS default credential chain",
    secretValues,
  };
}

export function createBedrockStoredAuth(factories: AwsAuthFactories = {}): ApiKeyAuthMethod {
  return {
    displayName: "Amazon Bedrock credentials",
    login: async (interaction) => {
      const method = await interaction.prompt({
        type: "select",
        message: "Select Amazon Bedrock authentication method:",
        options: [
          { id: "bearer", label: "Bedrock bearer token" },
          { id: "profile", label: "AWS profile" },
          { id: "default", label: "AWS default credential chain" },
        ],
      });
      const awsRegion = await interaction.prompt({
        type: "text",
        message: "Enter AWS region:",
      });
      if (method === "bearer") {
        return {
          type: "api_key",
          key: await interaction.prompt({
            type: "secret",
            message: "Enter Amazon Bedrock bearer token:",
          }),
          env: { AWS_REGION: awsRegion },
        };
      }
      if (method === "profile") {
        return {
          type: "api_key",
          env: {
            AWS_REGION: awsRegion,
            AWS_PROFILE: await interaction.prompt({
              type: "text",
              message: "Enter AWS profile name:",
            }),
          },
        };
      }
      if (method !== "default") throw new Error(`Unknown Amazon Bedrock auth method: ${method}`);
      return { type: "api_key", env: { AWS_REGION: awsRegion } };
    },
    resolve: async ({ context, credential, signal }) => {
      const token = bearer(context, credential);
      if (token !== undefined) return token;
      if (credential === undefined) return undefined;
      return sigv4(context, credential, signal, factories);
    },
  };
}

export function createBedrockSources(
  factories: AwsAuthFactories = {},
): readonly AmbientAuthSource[] {
  return [
    {
      type: "environment",
      displayName: "Amazon Bedrock bearer token",
      resolve: async ({ context, signal }) => {
        signal.throwIfAborted();
        return bearer(context);
      },
    },
    {
      type: "ambient",
      displayName: "AWS default credential chain",
      resolve: ({ context, signal }) => sigv4(context, undefined, signal, factories),
    },
  ];
}
