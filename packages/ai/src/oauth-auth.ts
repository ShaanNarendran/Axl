// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { ApiKeyAuthMethod, OAuthAuthMethod, ProviderAuthInteraction } from "./auth.ts";
import type { OAuthCredential } from "./credentials.ts";
import { raceWithSignal, readBoundedJson, stripTrailingSlashes } from "./transport-safety.ts";

export interface OAuthFactoryOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_INTERVAL_SECONDS = 5;
const MINIMUM_INTERVAL_MS = 1_000;
const REFRESH_SKEW_MS = 5 * 60 * 1_000;
const PERMANENT_EXPIRY = Number.MAX_SAFE_INTEGER;

type Json = Record<string, unknown>;

type DeviceCode = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
};

function object(value: unknown, operation: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${operation} returned malformed JSON`);
  }
  return value as Json;
}

function requiredString(value: Json, field: string, operation: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`${operation} response omitted ${field}`);
  }
  return result;
}

function positiveNumber(value: Json, field: string, operation: string): number {
  const result = value[field];
  if (typeof result !== "number" || !Number.isFinite(result) || result <= 0) {
    throw new Error(`${operation} response has invalid ${field}`);
  }
  return result;
}

function trustedUrl(value: string, operation: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(`${operation} returned an invalid URL`, { cause });
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`${operation} returned an untrusted URL`);
  }
  if (url.username || url.password) throw new Error(`${operation} returned an untrusted URL`);
  return url.toString();
}

async function jsonRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Json> {
  const signal = init.signal as AbortSignal | undefined;
  const response =
    signal === undefined
      ? await fetchImpl(url, init)
      : await raceWithSignal(fetchImpl(url, init), signal);
  let body: unknown;
  try {
    body = await readBoundedJson(response, undefined, signal);
  } catch (cause) {
    throw new Error(`${operation} returned invalid JSON with status ${response.status}`, { cause });
  }
  const result = object(body, operation);
  if (!response.ok) {
    const code = typeof result.error === "string" ? ` (${result.error})` : "";
    throw new Error(`${operation} failed with status ${response.status}${code}`);
  }
  return result;
}

function form(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}

function formRequest(fields: Readonly<Record<string, string>>, signal: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: form(fields),
    signal,
  };
}

function jsonPost(value: Json, signal: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(value),
    signal,
  };
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function pollDevice<Result>(input: {
  readonly signal: AbortSignal;
  readonly intervalSeconds?: number;
  readonly expiresInSeconds: number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly poll: () => Promise<
    | { readonly status: "pending" }
    | { readonly status: "slow_down"; readonly intervalSeconds?: number }
    | { readonly status: "complete"; readonly value: Result }
    | { readonly status: "failed"; readonly message: string }
  >;
}): Promise<Result> {
  const deadline = Date.now() + input.expiresInSeconds * 1_000;
  let interval = Math.max(
    MINIMUM_INTERVAL_MS,
    Math.floor((input.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1_000),
  );
  await input.sleep(Math.min(interval, Math.max(0, deadline - Date.now())), input.signal);
  while (Date.now() < deadline) {
    input.signal.throwIfAborted();
    const result = await input.poll();
    if (result.status === "complete") return result.value;
    if (result.status === "failed") throw new Error(result.message);
    if (result.status === "slow_down") {
      interval =
        result.intervalSeconds === undefined
          ? interval + 5_000
          : Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1_000));
    }
    await input.sleep(Math.min(interval, Math.max(0, deadline - Date.now())), input.signal);
  }
  throw new Error("OAuth device authorization timed out");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizationCode(input: string, expectedState?: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("OAuth authorization code is required");
  let code: string | null = null;
  let state: string | null = null;
  try {
    const url = new URL(trimmed);
    code = url.searchParams.get("code");
    state = url.searchParams.get("state");
  } catch {
    if (trimmed.includes("code=")) {
      const params = new URLSearchParams(trimmed);
      code = params.get("code");
      state = params.get("state");
    } else if (trimmed.includes("#")) {
      [code, state] = trimmed.split("#", 2) as [string, string];
    } else {
      code = trimmed;
    }
  }
  if (expectedState !== undefined && state !== null && state !== expectedState) {
    throw new Error("OAuth state did not match");
  }
  if (!code) throw new Error("OAuth authorization code is required");
  return code;
}

async function promptForCode(
  interaction: ProviderAuthInteraction,
  url: string,
  redirectUri: string,
): Promise<string> {
  interaction.notify({
    type: "auth_url",
    url,
    instructions: "Complete sign in, then paste the authorization code or final redirect URL.",
  });
  return interaction.prompt({
    type: "manual_code",
    message: "Paste the authorization code or final redirect URL:",
    placeholder: redirectUri,
    signal: interaction.signal,
  });
}

function oauthCredential(
  value: Json,
  now: () => number,
  operation: string,
  previousRefresh?: string,
  metadata?: Readonly<Record<string, string>>,
): OAuthCredential {
  const access = requiredString(value, "access_token", operation);
  const refresh =
    value.refresh_token === undefined && previousRefresh !== undefined
      ? previousRefresh
      : requiredString(value, "refresh_token", operation);
  const expiresIn =
    value.expires_in === undefined ? 3_600 : positiveNumber(value, "expires_in", operation);
  return {
    type: "oauth",
    access,
    refresh,
    expiresAt: Math.max(now(), now() + expiresIn * 1_000 - REFRESH_SKEW_MS),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function deviceCode(value: Json, operation: string): DeviceCode {
  const verification = requiredString(value, "verification_uri", operation);
  const complete =
    typeof value.verification_uri_complete === "string"
      ? value.verification_uri_complete
      : verification;
  return {
    deviceCode: requiredString(value, "device_code", operation),
    userCode: requiredString(value, "user_code", operation),
    verificationUri: trustedUrl(complete, operation),
    intervalSeconds:
      typeof value.interval === "number" && value.interval > 0
        ? value.interval
        : DEFAULT_INTERVAL_SECONDS,
    expiresInSeconds: positiveNumber(value, "expires_in", operation),
  };
}

function notifyDevice(interaction: ProviderAuthInteraction, device: DeviceCode): void {
  interaction.notify({
    type: "device_code",
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
  });
}

function oauthPollingResult(
  body: Json,
  response: Response,
  complete: () => OAuthCredential,
):
  | { readonly status: "pending" }
  | { readonly status: "slow_down"; readonly intervalSeconds?: number }
  | { readonly status: "complete"; readonly value: OAuthCredential }
  | { readonly status: "failed"; readonly message: string } {
  if (response.ok) return { status: "complete", value: complete() };
  if (body.error === "authorization_pending") return { status: "pending" };
  if (body.error === "slow_down") {
    return {
      status: "slow_down",
      ...(typeof body.interval === "number" ? { intervalSeconds: body.interval } : {}),
    };
  }
  if (body.error === "access_denied" || body.error === "authorization_denied") {
    return { status: "failed", message: "OAuth device authorization was denied" };
  }
  if (body.error === "expired_token") {
    return { status: "failed", message: "OAuth device authorization expired" };
  }
  return {
    status: "failed",
    message: `OAuth device token request failed with status ${response.status}`,
  };
}

async function pollFormToken(input: {
  readonly fetchImpl: typeof fetch;
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly device: DeviceCode;
  readonly signal: AbortSignal;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
  readonly operation: string;
}): Promise<OAuthCredential> {
  return pollDevice({
    signal: input.signal,
    intervalSeconds: input.device.intervalSeconds,
    expiresInSeconds: input.device.expiresInSeconds,
    sleep: input.sleep,
    poll: async () => {
      const response = await raceWithSignal(
        input.fetchImpl(input.url, formRequest(input.fields, input.signal)),
        input.signal,
      );
      let body: Json;
      try {
        body = object(await readBoundedJson(response, undefined, input.signal), input.operation);
      } catch {
        return {
          status: "failed" as const,
          message: `${input.operation} returned invalid JSON with status ${response.status}`,
        };
      }
      return oauthPollingResult(body, response, () =>
        oauthCredential(body, input.now, input.operation),
      );
    },
  });
}

export function createAnthropicOAuth(options: OAuthFactoryOptions = {}): OAuthAuthMethod {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const clientId = Buffer.from(
    "OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl",
    "base64",
  ).toString();
  const tokenUrl = "https://platform.claude.com/v1/oauth/token";
  return {
    displayName: "Anthropic subscription",
    login: async (interaction) => {
      const { verifier, challenge } = pkce();
      const state = randomUUID();
      const redirectUri = "http://localhost:53692/callback";
      const url = new URL("https://claude.ai/oauth/authorize");
      url.search = new URLSearchParams({
        code: "true",
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope:
          "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();
      const code = authorizationCode(
        await promptForCode(interaction, url.toString(), redirectUri),
        state,
      );
      const body = await jsonRequest(
        fetchImpl,
        tokenUrl,
        jsonPost(
          {
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            state,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          },
          interaction.signal,
        ),
        "Anthropic token exchange",
      );
      return oauthCredential(body, now, "Anthropic token exchange");
    },
    refresh: async (credential, signal) =>
      oauthCredential(
        await jsonRequest(
          fetchImpl,
          tokenUrl,
          jsonPost(
            {
              grant_type: "refresh_token",
              client_id: clientId,
              refresh_token: credential.refresh,
            },
            signal,
          ),
          "Anthropic token refresh",
        ),
        now,
        "Anthropic token refresh",
        credential.refresh,
      ),
    toAuth: (credential) => ({
      headers: {
        authorization: `Bearer ${credential.access}`,
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      },
    }),
  };
}

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";

function codexCredential(value: Json, now: () => number, operation: string): OAuthCredential {
  const credential = oauthCredential(value, now, operation);
  const segments = credential.access.split(".");
  if (segments.length !== 3) throw new Error(`${operation} returned an invalid access token`);
  let payload: Json;
  try {
    payload = object(JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString()), operation);
  } catch (cause) {
    throw new Error(`${operation} returned an invalid access token`, { cause });
  }
  const claim = object(payload["https://api.openai.com/auth"], operation);
  const accountId = requiredString(claim, "chatgpt_account_id", operation);
  return { ...credential, metadata: { accountId } };
}

export function createOpenAiCodexOAuth(options: OAuthFactoryOptions = {}): OAuthAuthMethod {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const exchange = async (
    code: string,
    verifier: string,
    redirectUri: string,
    signal: AbortSignal,
  ) =>
    codexCredential(
      await jsonRequest(
        fetchImpl,
        OPENAI_TOKEN_URL,
        formRequest(
          {
            grant_type: "authorization_code",
            client_id: OPENAI_CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
          },
          signal,
        ),
        "OpenAI Codex token exchange",
      ),
      now,
      "OpenAI Codex token exchange",
    );
  return {
    displayName: "OpenAI ChatGPT subscription",
    login: async (interaction) => {
      const method = await interaction.prompt({
        type: "select",
        message: "Select OpenAI Codex login method:",
        options: [
          { id: "browser", label: "Browser login" },
          { id: "device_code", label: "Device code login" },
        ],
      });
      if (method === "device_code") {
        const start = await jsonRequest(
          fetchImpl,
          "https://auth.openai.com/api/accounts/deviceauth/usercode",
          jsonPost({ client_id: OPENAI_CLIENT_ID }, interaction.signal),
          "OpenAI Codex device authorization",
        );
        const interval =
          typeof start.interval === "string" ? Number(start.interval) : start.interval;
        const device = {
          deviceCode: requiredString(start, "device_auth_id", "OpenAI Codex device authorization"),
          userCode: requiredString(start, "user_code", "OpenAI Codex device authorization"),
          verificationUri: "https://auth.openai.com/codex/device",
          intervalSeconds:
            typeof interval === "number" && Number.isFinite(interval) && interval >= 0
              ? interval
              : DEFAULT_INTERVAL_SECONDS,
          expiresInSeconds: 15 * 60,
        };
        notifyDevice(interaction, device);
        const authorization = await pollDevice({
          signal: interaction.signal,
          intervalSeconds: device.intervalSeconds,
          expiresInSeconds: device.expiresInSeconds,
          sleep,
          poll: async () => {
            const response = await raceWithSignal(
              fetchImpl(
                "https://auth.openai.com/api/accounts/deviceauth/token",
                jsonPost(
                  { device_auth_id: device.deviceCode, user_code: device.userCode },
                  interaction.signal,
                ),
              ),
              interaction.signal,
            );
            if (response.status === 403 || response.status === 404) return { status: "pending" };
            const body = object(
              await readBoundedJson(response, undefined, interaction.signal),
              "OpenAI Codex device token",
            );
            if (!response.ok) {
              return {
                status: "failed",
                message: `OpenAI Codex device token failed with status ${response.status}`,
              };
            }
            return {
              status: "complete",
              value: {
                code: requiredString(body, "authorization_code", "OpenAI Codex device token"),
                verifier: requiredString(body, "code_verifier", "OpenAI Codex device token"),
              },
            };
          },
        });
        return exchange(
          authorization.code,
          authorization.verifier,
          "https://auth.openai.com/deviceauth/callback",
          interaction.signal,
        );
      }
      if (method !== "browser") throw new Error(`Unknown OpenAI Codex login method: ${method}`);
      const { verifier, challenge } = pkce();
      const state = randomUUID();
      const redirectUri = "http://localhost:1455/auth/callback";
      const url = new URL("https://auth.openai.com/oauth/authorize");
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: OPENAI_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: "openid profile email offline_access",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "axl",
      }).toString();
      const code = authorizationCode(
        await promptForCode(interaction, url.toString(), redirectUri),
        state,
      );
      return exchange(code, verifier, redirectUri, interaction.signal);
    },
    refresh: async (credential, signal) =>
      codexCredential(
        await jsonRequest(
          fetchImpl,
          OPENAI_TOKEN_URL,
          formRequest(
            {
              grant_type: "refresh_token",
              client_id: OPENAI_CLIENT_ID,
              refresh_token: credential.refresh,
            },
            signal,
          ),
          "OpenAI Codex token refresh",
        ),
        now,
        "OpenAI Codex token refresh",
      ),
    toAuth: (credential) => ({ apiKey: credential.access }),
  };
}

export function createOpenRouterOAuth(options: OAuthFactoryOptions = {}): OAuthAuthMethod {
  const fetchImpl = options.fetch ?? fetch;
  return {
    displayName: "OpenRouter OAuth",
    login: async (interaction) => {
      const { verifier, challenge } = pkce();
      const callbackUrl = `http://127.0.0.1:1457/oauth/callback/${randomUUID()}`;
      const url = new URL("https://openrouter.ai/auth");
      url.search = new URLSearchParams({
        callback_url: callbackUrl,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      const code = authorizationCode(await promptForCode(interaction, url.toString(), callbackUrl));
      const body = await jsonRequest(
        fetchImpl,
        "https://openrouter.ai/api/v1/auth/keys",
        jsonPost(
          { code, code_verifier: verifier, code_challenge_method: "S256" },
          interaction.signal,
        ),
        "OpenRouter key exchange",
      );
      return { type: "api_key", key: requiredString(body, "key", "OpenRouter key exchange") };
    },
    refresh: async (credential) => credential,
    toAuth: (credential) => ({ apiKey: credential.access }),
  };
}

export function createKimiCodingOAuth(options: OAuthFactoryOptions = {}): OAuthAuthMethod {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const host = "https://auth.kimi.com";
  return {
    displayName: "Kimi For Coding subscription",
    login: async (interaction) => {
      const body = await jsonRequest(
        fetchImpl,
        `${host}/api/oauth/device_authorization`,
        formRequest({ client_id: "17e5f671-d194-4dfb-9706-5516cb48c098" }, interaction.signal),
        "Kimi device authorization",
      );
      const device = deviceCode(body, "Kimi device authorization");
      notifyDevice(interaction, device);
      return pollFormToken({
        fetchImpl,
        url: `${host}/api/oauth/token`,
        fields: {
          client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
          device_code: device.deviceCode,
          grant_type: DEVICE_GRANT,
        },
        device,
        signal: interaction.signal,
        sleep,
        now,
        operation: "Kimi device token",
      });
    },
    refresh: async (credential, signal) =>
      oauthCredential(
        await jsonRequest(
          fetchImpl,
          `${host}/api/oauth/token`,
          formRequest(
            {
              client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
              grant_type: "refresh_token",
              refresh_token: credential.refresh,
            },
            signal,
          ),
          "Kimi token refresh",
        ),
        now,
        "Kimi token refresh",
        credential.refresh,
      ),
    toAuth: (credential) => ({ apiKey: credential.access }),
  };
}

export function createXaiOAuth(options: OAuthFactoryOptions = {}): OAuthAuthMethod {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const clientId = "b1a00492-073a-47ea-816f-4c329264a828";
  const tokenUrl = "https://auth.x.ai/oauth2/token";
  return {
    displayName: "xAI subscription",
    login: async (interaction) => {
      const body = await jsonRequest(
        fetchImpl,
        "https://auth.x.ai/oauth2/device/code",
        formRequest(
          {
            client_id: clientId,
            scope: "openid profile email offline_access grok-cli:access api:access",
            referrer: "axl",
          },
          interaction.signal,
        ),
        "xAI device authorization",
      );
      const device = deviceCode(body, "xAI device authorization");
      notifyDevice(interaction, device);
      return pollFormToken({
        fetchImpl,
        url: tokenUrl,
        fields: { grant_type: DEVICE_GRANT, client_id: clientId, device_code: device.deviceCode },
        device,
        signal: interaction.signal,
        sleep,
        now,
        operation: "xAI device token",
      });
    },
    refresh: async (credential, signal) =>
      oauthCredential(
        await jsonRequest(
          fetchImpl,
          tokenUrl,
          formRequest(
            { grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refresh },
            signal,
          ),
          "xAI token refresh",
        ),
        now,
        "xAI token refresh",
        credential.refresh,
      ),
    toAuth: (credential) => ({ apiKey: credential.access }),
  };
}

function normalizeGitHubDomain(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "github.com";
  const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    throw new Error("GitHub Enterprise domain is invalid");
  }
  return parsed.hostname;
}

function copilotBaseUrl(token: string, domain: string): string {
  const endpoint = /(?:^|;)proxy-ep=([^;]+)/.exec(token)?.[1];
  if (endpoint) {
    const host = endpoint.replace(/^proxy\./, "api.");
    return stripTrailingSlashes(trustedUrl(`https://${host}`, "GitHub Copilot token"));
  }
  return domain === "github.com"
    ? "https://api.individual.githubcopilot.com"
    : `https://copilot-api.${domain}`;
}

export function createGitHubCopilotTokenAuth(options: OAuthFactoryOptions = {}): ApiKeyAuthMethod {
  const fetchImpl = options.fetch ?? fetch;
  const headers = {
    accept: "application/json",
    "user-agent": "GitHubCopilotChat/0.35.0",
    "editor-version": "vscode/1.107.0",
    "editor-plugin-version": "copilot-chat/0.35.0",
    "copilot-integration-id": "vscode-chat",
  };
  return {
    displayName: "GitHub Copilot token",
    login: async (interaction) => ({
      type: "api_key",
      key: await interaction.prompt({ type: "secret", message: "Enter GitHub access token:" }),
      env: {
        GITHUB_ENTERPRISE_URL: await interaction.prompt({
          type: "text",
          message: "GitHub Enterprise domain, or blank for github.com:",
          placeholder: "github.com",
        }),
      },
    }),
    resolve: async ({ context, credential, signal }) => {
      signal.throwIfAborted();
      const githubToken = credential?.key ?? context.env("COPILOT_GITHUB_TOKEN");
      if (!githubToken) return undefined;
      const domain = normalizeGitHubDomain(
        credential?.env?.GITHUB_ENTERPRISE_URL ??
          context.env("GITHUB_ENTERPRISE_URL") ??
          context.env("GH_HOST") ??
          "github.com",
      );
      if (/(?:^|;)proxy-ep=([^;]+)/.test(githubToken)) {
        return {
          auth: { apiKey: githubToken, baseUrl: copilotBaseUrl(githubToken, domain) },
          source: credential?.key === undefined ? "COPILOT_GITHUB_TOKEN" : "stored credential",
          secretValues: [githubToken],
        };
      }
      const body = await jsonRequest(
        fetchImpl,
        `https://api.${domain}/copilot_internal/v2/token`,
        { headers: { ...headers, authorization: `Bearer ${githubToken}` }, signal },
        "GitHub Copilot token exchange",
      );
      const access = requiredString(body, "token", "GitHub Copilot token exchange");
      positiveNumber(body, "expires_at", "GitHub Copilot token exchange");
      signal.throwIfAborted();
      return {
        auth: { apiKey: access, baseUrl: copilotBaseUrl(access, domain) },
        source: credential?.key === undefined ? "COPILOT_GITHUB_TOKEN" : "stored credential",
        secretValues: [githubToken, access],
      };
    },
  };
}

export function createGitHubCopilotOAuth(options: OAuthFactoryOptions = {}): OAuthAuthMethod {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const clientId = Buffer.from("SXYxLmI1MDdhMDhjODdlY2ZlOTg=", "base64").toString();
  const headers = {
    accept: "application/json",
    "user-agent": "GitHubCopilotChat/0.35.0",
    "editor-version": "vscode/1.107.0",
    "editor-plugin-version": "copilot-chat/0.35.0",
    "copilot-integration-id": "vscode-chat",
  };
  const exchange = async (githubToken: string, domain: string, signal: AbortSignal) => {
    const body = await jsonRequest(
      fetchImpl,
      `https://api.${domain}/copilot_internal/v2/token`,
      { headers: { ...headers, authorization: `Bearer ${githubToken}` }, signal },
      "GitHub Copilot token exchange",
    );
    const access = requiredString(body, "token", "GitHub Copilot token exchange");
    const expires = positiveNumber(body, "expires_at", "GitHub Copilot token exchange");
    return {
      type: "oauth" as const,
      access,
      refresh: githubToken,
      expiresAt: Math.max(now(), expires * 1_000 - REFRESH_SKEW_MS),
      metadata: { domain, baseUrl: copilotBaseUrl(access, domain) },
    };
  };
  return {
    displayName: "GitHub Copilot",
    login: async (interaction) => {
      const domain = normalizeGitHubDomain(
        await interaction.prompt({
          type: "text",
          message: "GitHub Enterprise domain, or blank for github.com:",
          placeholder: "github.com",
        }),
      );
      const start = await jsonRequest(
        fetchImpl,
        `https://${domain}/login/device/code`,
        {
          ...formRequest({ client_id: clientId, scope: "read:user" }, interaction.signal),
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": headers["user-agent"],
          },
        },
        "GitHub device authorization",
      );
      const device = deviceCode(start, "GitHub device authorization");
      notifyDevice(interaction, device);
      const githubToken = await pollDevice({
        signal: interaction.signal,
        intervalSeconds: device.intervalSeconds,
        expiresInSeconds: device.expiresInSeconds,
        sleep,
        poll: async () => {
          const response = await raceWithSignal(
            fetchImpl(`https://${domain}/login/oauth/access_token`, {
              ...formRequest(
                { client_id: clientId, device_code: device.deviceCode, grant_type: DEVICE_GRANT },
                interaction.signal,
              ),
              headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded",
                "user-agent": headers["user-agent"],
              },
            }),
            interaction.signal,
          );
          const body = object(
            await readBoundedJson(response, undefined, interaction.signal),
            "GitHub device token",
          );
          if (response.ok && typeof body.access_token === "string") {
            return { status: "complete", value: body.access_token };
          }
          if (body.error === "authorization_pending") return { status: "pending" };
          if (body.error === "slow_down") return { status: "slow_down" };
          return {
            status: "failed",
            message: `GitHub device token failed with status ${response.status}`,
          };
        },
      });
      return exchange(githubToken, domain, interaction.signal);
    },
    refresh: (credential, signal) =>
      exchange(credential.refresh, credential.metadata?.domain ?? "github.com", signal),
    toAuth: (credential) => ({
      apiKey: credential.access,
      baseUrl:
        credential.metadata?.baseUrl ??
        copilotBaseUrl(credential.access, credential.metadata?.domain ?? "github.com"),
    }),
  };
}

export function createRadiusOAuth(
  gatewayUrl: string,
  options: OAuthFactoryOptions = {},
): OAuthAuthMethod {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol !== "https:" && gateway.protocol !== "http:") {
    throw new Error("Radius gateway must use HTTP or HTTPS");
  }
  gateway.pathname = stripTrailingSlashes(gateway.pathname);
  const endpoint = (path: string) =>
    new URL(path, `${stripTrailingSlashes(gateway.toString())}/`).toString();
  const requestToken = async (
    fields: Readonly<Record<string, string>>,
    signal: AbortSignal,
    operation: string,
    previousRefresh?: string,
  ) =>
    oauthCredential(
      await jsonRequest(
        fetchImpl,
        endpoint("v1/oauth/token"),
        formRequest(fields, signal),
        operation,
      ),
      now,
      operation,
      previousRefresh,
    );
  return {
    displayName: "Radius OAuth",
    login: async (interaction) => {
      const method = await interaction.prompt({
        type: "select",
        message: "Select Radius login method:",
        options: [
          { id: "browser", label: "Browser login" },
          { id: "device_code", label: "Device code login" },
        ],
      });
      if (method === "device_code") {
        const start = await jsonRequest(
          fetchImpl,
          endpoint("v1/oauth/device"),
          formRequest(
            { client_id: "pi-gateway", scope: "gateway offline_access" },
            interaction.signal,
          ),
          "Radius device authorization",
        );
        const device = deviceCode(start, "Radius device authorization");
        notifyDevice(interaction, device);
        return pollFormToken({
          fetchImpl,
          url: endpoint("v1/oauth/token"),
          fields: {
            grant_type: DEVICE_GRANT,
            client_id: "pi-gateway",
            device_code: device.deviceCode,
          },
          device,
          signal: interaction.signal,
          sleep,
          now,
          operation: "Radius device token",
        });
      }
      if (method !== "browser") throw new Error(`Unknown Radius login method: ${method}`);
      const discovery = await jsonRequest(
        fetchImpl,
        endpoint("v1/oauth"),
        { headers: { accept: "application/json" }, signal: interaction.signal },
        "Radius OAuth discovery",
      );
      const authorizationEndpoint = trustedUrl(
        requiredString(discovery, "authorizationEndpoint", "Radius OAuth discovery"),
        "Radius OAuth discovery",
      );
      const { verifier, challenge } = pkce();
      const state = randomUUID();
      const redirectUri = "http://127.0.0.1:1456/oauth/callback";
      const url = new URL(authorizationEndpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: "pi-gateway",
        redirect_uri: redirectUri,
        scope: "gateway offline_access",
        code_challenge: challenge,
        code_challenge_method: "S256",
        handoff: "url",
        state,
      }).toString();
      const code = authorizationCode(
        await promptForCode(interaction, url.toString(), redirectUri),
        state,
      );
      return requestToken(
        {
          grant_type: "authorization_code",
          client_id: "pi-gateway",
          redirect_uri: redirectUri,
          code,
          code_verifier: verifier,
        },
        interaction.signal,
        "Radius token exchange",
      );
    },
    refresh: (credential, signal) =>
      requestToken(
        { grant_type: "refresh_token", client_id: "pi-gateway", refresh_token: credential.refresh },
        signal,
        "Radius token refresh",
        credential.refresh,
      ),
    toAuth: (credential) => ({ apiKey: credential.access }),
  };
}

export { PERMANENT_EXPIRY };
