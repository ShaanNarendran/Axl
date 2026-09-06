// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { DefaultAzureCredential } from "@azure/identity";
import { GoogleAuth } from "google-auth-library";

import {
  type AmbientAuthSource,
  type ApiKeyAuthMethod,
  type AuthContext,
  AuthError,
  type ResolvedAuth,
} from "./auth.ts";
import type { ApiKeyCredential, ProviderEnv } from "./credentials.ts";

const AZURE_SCOPE = "https://cognitiveservices.azure.com/.default";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export interface AccessTokenValue {
  readonly token: string;
  readonly expiresOnTimestamp?: number;
}

export interface AzureCredentialLike {
  getToken(
    scope: string,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<AccessTokenValue | null>;
}

export interface GoogleAuthClientLike {
  getAccessToken(): Promise<string | { readonly token?: string | null } | null>;
}

export interface GoogleAuthLike {
  getClient(): Promise<GoogleAuthClientLike>;
  getProjectId(): Promise<string>;
}

export interface CloudAuthFactories {
  readonly azureCredential?: () => AzureCredentialLike;
  readonly googleAuth?: (options: {
    readonly scopes: string;
    readonly keyFilename?: string;
    readonly projectId?: string;
  }) => GoogleAuthLike;
}

function required(value: string | undefined, label: string, providerId: string): string {
  const result = value?.trim();
  if (!result) throw new AuthError("not_configured", providerId, `${providerId} requires ${label}`);
  return result;
}

function safeToken(value: string | null | undefined, providerId: string): string {
  if (!value || /[\r\n]/.test(value)) {
    throw new AuthError(
      "invalid_auth",
      providerId,
      `${providerId} returned an invalid access token`,
    );
  }
  return value;
}

function azureSettings(
  context: AuthContext,
  credential?: ApiKeyCredential,
): Readonly<Record<string, string>> {
  const setting = (name: string) => credential?.env?.[name] ?? context.env(name);
  const explicitBase = setting("AZURE_OPENAI_BASE_URL")?.trim();
  const resource = setting("AZURE_OPENAI_RESOURCE_NAME")?.trim();
  if (!explicitBase && !resource) {
    throw new AuthError(
      "not_configured",
      "azure-openai-responses",
      "Azure OpenAI requires AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME",
    );
  }
  return {
    AZURE_OPENAI_BASE_URL: explicitBase ?? `https://${resource}.openai.azure.com/openai/v1`,
    ...(setting("AZURE_OPENAI_API_VERSION")
      ? { AZURE_OPENAI_API_VERSION: setting("AZURE_OPENAI_API_VERSION") as string }
      : {}),
    ...(setting("AZURE_OPENAI_DEPLOYMENT_NAME_MAP")
      ? {
          AZURE_OPENAI_DEPLOYMENT_NAME_MAP: setting("AZURE_OPENAI_DEPLOYMENT_NAME_MAP") as string,
        }
      : {}),
  };
}

export function createAzureEntraSource(factories: CloudAuthFactories = {}): AmbientAuthSource {
  return {
    type: "ambient",
    displayName: "Microsoft Entra credentials",
    resolve: async ({ context, signal }) => {
      signal.throwIfAborted();
      const env = azureSettings(context);
      const credential =
        factories.azureCredential?.() ??
        new DefaultAzureCredential({
          requiredEnvVars: [],
        });
      let access: AccessTokenValue | null;
      try {
        access = await credential.getToken(AZURE_SCOPE, { abortSignal: signal });
      } catch (cause) {
        if (signal.aborted) signal.throwIfAborted();
        throw new AuthError(
          "invalid_auth",
          "azure-openai-responses",
          "Microsoft Entra credential acquisition failed for azure-openai-responses",
          cause,
        );
      }
      signal.throwIfAborted();
      const token = safeToken(access?.token, "azure-openai-responses");
      return {
        auth: { headers: { authorization: `Bearer ${token}` } },
        env,
        source: "Microsoft Entra default credential chain",
        secretValues: [token],
      };
    },
  };
}

function vertexSettings(
  context: AuthContext,
  credential: ApiKeyCredential | undefined,
): {
  project?: string;
  location?: string;
  keyFilename?: string;
  baseUrl?: string;
  apiVersion?: string;
} {
  const setting = (name: string) => credential?.env?.[name] ?? context.env(name);
  return {
    ...((setting("GOOGLE_CLOUD_PROJECT") ?? setting("GCLOUD_PROJECT"))
      ? { project: (setting("GOOGLE_CLOUD_PROJECT") ?? setting("GCLOUD_PROJECT")) as string }
      : {}),
    ...(setting("GOOGLE_CLOUD_LOCATION")
      ? { location: setting("GOOGLE_CLOUD_LOCATION") as string }
      : {}),
    ...(setting("GOOGLE_APPLICATION_CREDENTIALS")
      ? { keyFilename: setting("GOOGLE_APPLICATION_CREDENTIALS") as string }
      : {}),
    ...(setting("GOOGLE_VERTEX_BASE_URL")
      ? { baseUrl: setting("GOOGLE_VERTEX_BASE_URL") as string }
      : {}),
    ...(setting("GOOGLE_VERTEX_API_VERSION")
      ? { apiVersion: setting("GOOGLE_VERTEX_API_VERSION") as string }
      : {}),
  };
}

async function googleAccessToken(
  context: AuthContext,
  credential: ApiKeyCredential | undefined,
  signal: AbortSignal,
  factories: CloudAuthFactories,
  mode: "adc" | "service_account",
): Promise<ResolvedAuth> {
  const settings = vertexSettings(context, credential);
  const location = required(settings.location, "GOOGLE_CLOUD_LOCATION", "google-vertex");
  if (mode === "service_account") {
    required(settings.keyFilename, "GOOGLE_APPLICATION_CREDENTIALS", "google-vertex");
  }
  signal.throwIfAborted();
  const auth =
    factories.googleAuth?.({
      scopes: GOOGLE_SCOPE,
      ...(settings.keyFilename === undefined ? {} : { keyFilename: settings.keyFilename }),
      ...(settings.project === undefined ? {} : { projectId: settings.project }),
    }) ??
    new GoogleAuth({
      scopes: GOOGLE_SCOPE,
      ...(settings.keyFilename === undefined ? {} : { keyFilename: settings.keyFilename }),
      ...(settings.project === undefined ? {} : { projectId: settings.project }),
    });
  try {
    const [client, discoveredProject] = await Promise.all([
      auth.getClient(),
      settings.project === undefined ? auth.getProjectId() : Promise.resolve(settings.project),
    ]);
    signal.throwIfAborted();
    const access = await client.getAccessToken();
    signal.throwIfAborted();
    const token = safeToken(typeof access === "string" ? access : access?.token, "google-vertex");
    return {
      auth: { headers: { authorization: `Bearer ${token}` } },
      env: {
        GOOGLE_CLOUD_PROJECT: required(discoveredProject, "project ID", "google-vertex"),
        GOOGLE_CLOUD_LOCATION: location,
        GOOGLE_VERTEX_CREDENTIAL_TYPE: mode,
        ...(settings.keyFilename === undefined
          ? {}
          : { GOOGLE_APPLICATION_CREDENTIALS: settings.keyFilename }),
        ...(settings.baseUrl === undefined ? {} : { GOOGLE_VERTEX_BASE_URL: settings.baseUrl }),
        ...(settings.apiVersion === undefined
          ? {}
          : { GOOGLE_VERTEX_API_VERSION: settings.apiVersion }),
      },
      source:
        mode === "service_account"
          ? "Google service account credentials"
          : "Google Application Default Credentials",
      secretValues: [token],
    };
  } catch (cause) {
    if (signal.aborted) signal.throwIfAborted();
    if (cause instanceof AuthError) throw cause;
    throw new AuthError(
      "invalid_auth",
      "google-vertex",
      `Google ${mode === "service_account" ? "service account" : "ADC"} credential acquisition failed`,
      cause,
    );
  }
}

function vertexApiKey(
  context: AuthContext,
  credential?: ApiKeyCredential,
): ResolvedAuth | undefined {
  const key = credential?.key ?? context.env("GOOGLE_CLOUD_API_KEY");
  if (!key) return undefined;
  const settings = vertexSettings(context, credential);
  return {
    auth: { apiKey: key },
    env: {
      ...(settings.project === undefined ? {} : { GOOGLE_CLOUD_PROJECT: settings.project }),
      ...(settings.location === undefined ? {} : { GOOGLE_CLOUD_LOCATION: settings.location }),
      ...(settings.baseUrl === undefined ? {} : { GOOGLE_VERTEX_BASE_URL: settings.baseUrl }),
      ...(settings.apiVersion === undefined
        ? {}
        : { GOOGLE_VERTEX_API_VERSION: settings.apiVersion }),
    },
    source: credential?.key === undefined ? "GOOGLE_CLOUD_API_KEY" : "stored credential",
    secretValues: [key],
  };
}

export function createGoogleVertexStoredAuth(factories: CloudAuthFactories = {}): ApiKeyAuthMethod {
  return {
    displayName: "Google Vertex credentials",
    login: async (interaction) => {
      const method = await interaction.prompt({
        type: "select",
        message: "Select Google Vertex AI authentication method:",
        options: [
          { id: "api_key", label: "Google Cloud API key" },
          { id: "adc", label: "Application Default Credentials" },
          { id: "service_account", label: "Service account credentials file" },
        ],
      });
      if (method === "api_key") {
        return {
          type: "api_key",
          key: await interaction.prompt({ type: "secret", message: "Enter Google Cloud API key" }),
        };
      }
      if (method !== "adc" && method !== "service_account") {
        throw new Error(`Unknown Google Vertex authentication method: ${method}`);
      }
      const project = await interaction.prompt({
        type: "text",
        message: "Enter Google Cloud project ID:",
      });
      const location = await interaction.prompt({
        type: "text",
        message: "Enter Google Cloud location:",
      });
      const keyFilename =
        method === "service_account"
          ? await interaction.prompt({
              type: "text",
              message: "Enter service account credentials file path:",
            })
          : undefined;
      return {
        type: "api_key",
        env: {
          GOOGLE_VERTEX_CREDENTIAL_TYPE: method,
          GOOGLE_CLOUD_PROJECT: project,
          GOOGLE_CLOUD_LOCATION: location,
          ...(keyFilename === undefined ? {} : { GOOGLE_APPLICATION_CREDENTIALS: keyFilename }),
        },
      };
    },
    resolve: async ({ context, credential, signal }) => {
      const key = vertexApiKey(context, credential);
      if (key !== undefined) return key;
      if (credential === undefined) return undefined;
      const mode = credential.env?.GOOGLE_VERTEX_CREDENTIAL_TYPE;
      if (mode !== "adc" && mode !== "service_account") {
        throw new AuthError(
          "invalid_auth",
          "google-vertex",
          "Stored Google Vertex credential has no explicit authentication mode",
        );
      }
      if (mode === "service_account") {
        const path = required(
          credential.env?.GOOGLE_APPLICATION_CREDENTIALS,
          "GOOGLE_APPLICATION_CREDENTIALS",
          "google-vertex",
        );
        if (!(await context.fileExists(path))) {
          throw new AuthError(
            "not_configured",
            "google-vertex",
            "Stored Google Vertex service account file is not readable",
          );
        }
      }
      return googleAccessToken(context, credential, signal, factories, mode);
    },
  };
}

export function createGoogleVertexSources(
  factories: CloudAuthFactories = {},
): readonly AmbientAuthSource[] {
  const environment: AmbientAuthSource = {
    type: "environment",
    displayName: "Google Cloud API key",
    resolve: async ({ context, signal }) => {
      signal.throwIfAborted();
      return vertexApiKey(context);
    },
  };
  const serviceAccount: AmbientAuthSource = {
    type: "file",
    displayName: "Google service account credentials",
    resolve: async ({ context, signal }) => {
      const path = context.env("GOOGLE_APPLICATION_CREDENTIALS")?.trim();
      if (!path) return undefined;
      if (!(await context.fileExists(path))) {
        throw new AuthError(
          "not_configured",
          "google-vertex",
          "GOOGLE_APPLICATION_CREDENTIALS does not identify a readable file",
        );
      }
      return googleAccessToken(context, undefined, signal, factories, "service_account");
    },
  };
  const adc: AmbientAuthSource = {
    type: "ambient",
    displayName: "Google Application Default Credentials",
    resolve: ({ context, signal }) =>
      googleAccessToken(context, undefined, signal, factories, "adc"),
  };
  return [environment, serviceAccount, adc];
}

export function vertexRequestPolicy(resolved: ResolvedAuth): {
  readonly credential:
    | { readonly type: "api_key"; readonly apiKey: string }
    | { readonly type: "adc"; readonly accessToken: string }
    | {
        readonly type: "service_account";
        readonly accessToken: string;
        readonly credentialsFile: string;
      };
  readonly project?: string;
  readonly location?: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
} {
  const env: ProviderEnv = resolved.env ?? {};
  const common = {
    ...(env.GOOGLE_CLOUD_PROJECT ? { project: env.GOOGLE_CLOUD_PROJECT } : {}),
    ...(env.GOOGLE_CLOUD_LOCATION ? { location: env.GOOGLE_CLOUD_LOCATION } : {}),
    ...(env.GOOGLE_VERTEX_BASE_URL ? { baseUrl: env.GOOGLE_VERTEX_BASE_URL } : {}),
    ...(env.GOOGLE_VERTEX_API_VERSION ? { apiVersion: env.GOOGLE_VERTEX_API_VERSION } : {}),
  };
  if (resolved.auth.apiKey) {
    return { credential: { type: "api_key", apiKey: resolved.auth.apiKey }, ...common };
  }
  const authorization = resolved.auth.headers?.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  const accessToken = safeToken(token, "google-vertex");
  if (env.GOOGLE_VERTEX_CREDENTIAL_TYPE === "service_account") {
    return {
      credential: {
        type: "service_account",
        accessToken,
        credentialsFile: required(
          env.GOOGLE_APPLICATION_CREDENTIALS,
          "GOOGLE_APPLICATION_CREDENTIALS",
          "google-vertex",
        ),
      },
      ...common,
    };
  }
  if (env.GOOGLE_VERTEX_CREDENTIAL_TYPE !== "adc") {
    throw new AuthError(
      "invalid_auth",
      "google-vertex",
      "Google Vertex resolved an unknown credential type",
    );
  }
  return { credential: { type: "adc", accessToken }, ...common };
}

export { AZURE_SCOPE, GOOGLE_SCOPE };
