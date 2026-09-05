// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  type ApiKeyCredential,
  type Credential,
  type CredentialStore,
  credentialSecretValues,
  type OAuthCredential,
  type ProviderEnv,
  validateCredential,
} from "./credentials.ts";
import type { AuthMethod } from "./model.ts";

export type AuthErrorCode = "not_configured" | "invalid_auth" | "refresh_failed" | "store_failure";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly providerId: string;

  constructor(code: AuthErrorCode, providerId: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AuthError";
    this.code = code;
    this.providerId = providerId;
  }
}

/** Request auth for one model call. Anything else is provider configuration. */
export interface ModelAuth {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly baseUrl?: string;
}

export interface ResolvedAuth {
  readonly auth: ModelAuth;
  /** Human-readable, non-secret origin for status display. */
  readonly source: string;
  /** Provider-scoped config resolved alongside the auth. */
  readonly env?: ProviderEnv;
  /** Every secret inside `auth`, for redaction registration only. */
  readonly secretValues: readonly string[];
}

/** Environment and file availability access for provider-owned resolution. */
export interface AuthContext {
  env(name: string): string | undefined;
  fileExists(path: string): Promise<boolean>;
}

export const nodeAuthContext: AuthContext = {
  env: (name) => process.env[name],
  fileExists: async (path) => {
    const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
    try {
      await access(expanded);
      return true;
    } catch {
      return false;
    }
  },
};

export type AuthPrompt =
  | { readonly type: "text"; readonly message: string; readonly placeholder?: string }
  | { readonly type: "secret"; readonly message: string; readonly placeholder?: string }
  | {
      readonly type: "select";
      readonly message: string;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
      }[];
    }
  | {
      readonly type: "manual_code";
      readonly message: string;
      readonly placeholder?: string;
      readonly signal?: AbortSignal;
    };

export type AuthEvent =
  | { readonly type: "info"; readonly message: string; readonly links?: readonly AuthInfoLink[] }
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | {
      readonly type: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | { readonly type: "progress"; readonly message: string }
  | { readonly type: "state"; readonly state: AuthenticationState };

export interface AuthInfoLink {
  readonly url: string;
  readonly label?: string;
}

/** UI-neutral callbacks supplied by a client to a provider-owned login flow. */
export interface AuthInteraction {
  readonly signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

export type ProviderAuthEvent = Exclude<AuthEvent, { readonly type: "state" }>;

export type ProviderAuthInteraction = Omit<AuthInteraction, "notify" | "signal"> & {
  readonly signal: AbortSignal;
  notify(event: ProviderAuthEvent): void;
};

/** Api-key-shaped stored auth. Providers may also reuse this shape for ambient sources. */
export interface ApiKeyAuthMethod {
  readonly displayName: string;
  login?(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential>;
  resolve(input: {
    context: AuthContext;
    credential?: ApiKeyCredential | undefined;
    signal: AbortSignal;
  }): Promise<ResolvedAuth | undefined>;
}

/** One non-stored source. Resolution always uses the fixed source precedence. */
export interface AmbientAuthSource extends ApiKeyAuthMethod {
  readonly type: "environment" | "file" | "ambient" | "keyless";
}

export interface OAuthAuthMethod {
  readonly displayName: string;
  login?(interaction: ProviderAuthInteraction): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
  toAuth(credential: OAuthCredential): ModelAuth | Promise<ModelAuth>;
}

export interface ProviderAuthMethods {
  /** Resolver for a stored api-key credential. */
  readonly apiKey?: ApiKeyAuthMethod;
  readonly oauth?: OAuthAuthMethod;
  /** Explicit ambient resolvers, evaluated by type rather than declaration order. */
  readonly sources?: readonly AmbientAuthSource[];
}

export interface ResolveAuthOptions {
  readonly signal?: AbortSignal;
  /** Remaining OAuth validity required before a refresh triggers. */
  readonly minValidityMs?: number;
}

export type AuthenticationPhase =
  | "idle"
  | "authorizing"
  | "authenticated"
  | "reauthentication_required"
  | "logged_out";

/** Public authentication state contains no credential or provider response values. */
export interface AuthenticationState {
  readonly phase: AuthenticationPhase;
  readonly method?: "api_key" | "oauth";
  readonly source?: string;
}

export interface ProviderAuthentication {
  readonly methods: readonly AuthMethod[];
  state(): AuthenticationState;
  resolve(options?: ResolveAuthOptions): Promise<ResolvedAuth>;
  login(method: "api_key" | "oauth", interaction: AuthInteraction): Promise<AuthenticationState>;
  logout(options?: { readonly signal?: AbortSignal }): Promise<AuthenticationState>;
}

const DEFAULT_MIN_VALIDITY_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;
const SOURCE_PRECEDENCE: Readonly<Record<AmbientAuthSource["type"], number>> = {
  environment: 0,
  file: 1,
  ambient: 2,
  keyless: 3,
};

/** Explicit credential persistence through the store's serialized write path. */
export async function login(
  store: CredentialStore,
  providerId: string,
  credential: Credential,
): Promise<void> {
  const validated = validateCredential(credential, providerId);
  await store.modify(providerId, () => Promise.resolve(validated));
}

/** Explicit logout, serialized against refresh and login writes. */
export async function logout(store: CredentialStore, providerId: string): Promise<void> {
  await store.delete(providerId);
}

/**
 * Provider-owned authentication lifecycle. A monotonic generation prevents a
 * cancelled or superseded login or refresh from publishing authenticated
 * state, and prevents login completion from restoring a credential after
 * logout.
 */
export function createProviderAuthentication(input: {
  readonly providerId: string;
  readonly declaredMethods: readonly AuthMethod[];
  readonly methods: ProviderAuthMethods;
  readonly store: CredentialStore;
  readonly context: AuthContext;
}): ProviderAuthentication {
  let current: AuthenticationState = { phase: "idle" };
  let generation = 0;

  const transition = (state: AuthenticationState, interaction?: AuthInteraction) => {
    current = state;
    interaction?.notify({ type: "state", state });
    return state;
  };

  return {
    methods: [...input.declaredMethods],
    state: () => ({ ...current }),
    resolve: async (options = {}) => {
      const operation = generation;
      try {
        const resolved = await resolveProviderAuth(
          input.providerId,
          input.methods,
          input.store,
          input.context,
          options,
        );
        options.signal?.throwIfAborted();
        if (operation !== generation) {
          throw new AuthError(
            "not_configured",
            input.providerId,
            `Authentication changed while resolving ${input.providerId}`,
          );
        }
        transition({ phase: "authenticated", source: resolved.source });
        return resolved;
      } catch (error) {
        if (error instanceof AuthError && error.code === "refresh_failed") {
          transition({ phase: "reauthentication_required", method: "oauth" });
        }
        throw error;
      }
    },
    login: async (method, interaction) => {
      const previous = current;
      const operation = ++generation;
      const signal = interaction.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      transition({ phase: "authorizing", method }, interaction);
      const implementation = method === "oauth" ? input.methods.oauth : input.methods.apiKey;
      if (implementation?.login === undefined) {
        transition({ phase: "reauthentication_required", method }, interaction);
        throw new AuthError(
          "not_configured",
          input.providerId,
          `${implementation?.displayName ?? method} does not support interactive login`,
        );
      }
      try {
        const credential = validateCredential(
          await implementation.login({
            signal,
            prompt: async (prompt) => {
              signal.throwIfAborted();
              const answer = await interaction.prompt(prompt);
              signal.throwIfAborted();
              if (typeof answer !== "string") {
                throw new AuthError(
                  "invalid_auth",
                  input.providerId,
                  `Authentication prompt returned a malformed response for ${input.providerId}`,
                );
              }
              return answer;
            },
            notify: (event) => {
              signal.throwIfAborted();
              interaction.notify(validateAuthEvent(event, input.providerId));
            },
          }),
          input.providerId,
        );
        signal.throwIfAborted();
        await input.store.modify(input.providerId, () => {
          signal.throwIfAborted();
          return Promise.resolve(operation === generation ? credential : undefined);
        });
        signal.throwIfAborted();
        if (operation !== generation) {
          throw new AuthError(
            "not_configured",
            input.providerId,
            `Authentication was superseded for ${input.providerId}`,
          );
        }
        return transition(
          { phase: "authenticated", method, source: implementation.displayName },
          interaction,
        );
      } catch (error) {
        if (operation === generation) {
          transition(
            signal.aborted ? previous : { phase: "reauthentication_required", method },
            interaction,
          );
        }
        if (signal.aborted) signal.throwIfAborted();
        if (error instanceof AuthError) throw error;
        throw new AuthError(
          "invalid_auth",
          input.providerId,
          `${implementation.displayName} login failed for ${input.providerId}`,
        );
      }
    },
    logout: async (options = {}) => {
      generation += 1;
      options.signal?.throwIfAborted();
      await input.store.delete(input.providerId);
      options.signal?.throwIfAborted();
      return transition({ phase: "logged_out" });
    },
  };
}

/**
 * Resolves request auth or fails with an explicit state. Stored credentials
 * own the provider. Without one, ambient sources use environment, file,
 * ambient, then keyless precedence regardless of declaration order.
 */
export async function resolveProviderAuth(
  providerId: string,
  methods: ProviderAuthMethods,
  store: CredentialStore,
  context: AuthContext,
  options: ResolveAuthOptions = {},
): Promise<ResolvedAuth> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();

  let stored: Credential | undefined;
  try {
    stored = await store.read(providerId);
  } catch (error) {
    throw new AuthError(
      "store_failure",
      providerId,
      `Credential store read failed for ${providerId}`,
      error,
    );
  }

  if (stored !== undefined) {
    if (stored.type === "oauth" && methods.oauth) {
      return resolveStoredOAuth(providerId, methods.oauth, store, stored, signal, options);
    }
    if (stored.type === "api_key" && methods.apiKey) {
      return resolveApiKey(providerId, methods.apiKey, context, stored, signal);
    }
    throw new AuthError(
      "not_configured",
      providerId,
      `Stored ${stored.type} credential for ${providerId} has no matching auth method`,
    );
  }

  if (methods.sources !== undefined) {
    const sources = [...methods.sources].sort(
      (left, right) => SOURCE_PRECEDENCE[left.type] - SOURCE_PRECEDENCE[right.type],
    );
    for (const source of sources) {
      const resolved = await tryResolveApiKey(providerId, source, context, undefined, signal);
      if (resolved !== undefined) return resolved;
    }
  } else if (methods.apiKey) {
    const resolved = await tryResolveApiKey(providerId, methods.apiKey, context, undefined, signal);
    if (resolved !== undefined) return resolved;
  }

  throw new AuthError(
    "not_configured",
    providerId,
    `Provider ${providerId} is not configured with a stored credential or ambient auth method`,
  );
}

async function tryResolveApiKey(
  providerId: string,
  method: ApiKeyAuthMethod,
  context: AuthContext,
  credential: ApiKeyCredential | undefined,
  signal: AbortSignal,
): Promise<ResolvedAuth | undefined> {
  try {
    const resolved = await method.resolve({ context, credential, signal });
    signal.throwIfAborted();
    return resolved === undefined ? undefined : validateResolvedAuth(resolved, providerId);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(
      "invalid_auth",
      providerId,
      `${method.displayName} resolution failed for ${providerId}`,
    );
  }
}

async function resolveApiKey(
  providerId: string,
  method: ApiKeyAuthMethod,
  context: AuthContext,
  credential: ApiKeyCredential | undefined,
  signal: AbortSignal,
): Promise<ResolvedAuth> {
  const resolved = await tryResolveApiKey(providerId, method, context, credential, signal);
  if (resolved === undefined) {
    throw new AuthError(
      "invalid_auth",
      providerId,
      `${method.displayName} rejected the stored credential for ${providerId}`,
    );
  }
  return resolved;
}

async function resolveStoredOAuth(
  providerId: string,
  method: OAuthAuthMethod,
  store: CredentialStore,
  stored: OAuthCredential,
  signal: AbortSignal,
  options: ResolveAuthOptions,
): Promise<ResolvedAuth> {
  const minValidityMs = Math.max(DEFAULT_MIN_VALIDITY_MS, options.minValidityMs ?? 0);
  const expiresSoon = (credential: OAuthCredential) =>
    Date.now() + minValidityMs >= credential.expiresAt;

  let credential = stored;
  if (expiresSoon(credential)) {
    let post: Credential | undefined;
    try {
      post = await store.modify(providerId, async (current) => {
        if (current?.type !== "oauth") return undefined;
        if (!expiresSoon(current)) return undefined;
        const refreshSignal = AbortSignal.any([signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]);
        const refreshed = await method.refresh(current, refreshSignal);
        refreshSignal.throwIfAborted();
        return validateCredential(refreshed, providerId);
      });
    } catch {
      if (signal.aborted) signal.throwIfAborted();
      throw new AuthError(
        "refresh_failed",
        providerId,
        `OAuth refresh failed for ${providerId}; log in again`,
      );
    }
    if (post?.type !== "oauth") {
      throw new AuthError(
        "not_configured",
        providerId,
        `Provider ${providerId} was logged out during refresh`,
      );
    }
    credential = post;
  }

  try {
    const auth = await method.toAuth(credential);
    const secretValues = [...credentialSecretValues(credential)];
    for (const value of [auth.apiKey, ...Object.values(auth.headers ?? {})]) {
      if (
        value !== undefined &&
        value.length > 0 &&
        !secretValues.some((secret) => value.includes(secret))
      ) {
        secretValues.push(value);
      }
    }
    return validateResolvedAuth(
      {
        auth,
        source: method.displayName,
        secretValues,
      },
      providerId,
    );
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(
      "invalid_auth",
      providerId,
      `OAuth request authentication failed for ${providerId}; log in again`,
    );
  }
}

function validateResolvedAuth(value: ResolvedAuth, providerId: string): ResolvedAuth {
  if (!isPlainObject(value) || !isPlainObject(value.auth)) {
    throw new AuthError(
      "invalid_auth",
      providerId,
      `Provider ${providerId} returned malformed auth`,
    );
  }
  const allowedResult = new Set(["auth", "source", "env", "secretValues"]);
  const allowedAuth = new Set(["apiKey", "headers", "baseUrl"]);
  if (
    Object.keys(value).some((key) => !allowedResult.has(key)) ||
    Object.keys(value.auth).some((key) => !allowedAuth.has(key)) ||
    typeof value.source !== "string" ||
    value.source.length === 0 ||
    !Array.isArray(value.secretValues) ||
    value.secretValues.some((secret) => typeof secret !== "string" || secret.length === 0) ||
    value.secretValues.some((secret) => value.source.includes(secret)) ||
    (value.auth.apiKey !== undefined && typeof value.auth.apiKey !== "string") ||
    (value.auth.baseUrl !== undefined && typeof value.auth.baseUrl !== "string") ||
    !isStringRecord(value.auth.headers) ||
    !isStringRecord(value.env)
  ) {
    throw new AuthError(
      "invalid_auth",
      providerId,
      `Provider ${providerId} returned malformed auth`,
    );
  }
  const protectedValues = [value.auth.apiKey, ...Object.values(value.auth.headers ?? {})].filter(
    (item): item is string => item !== undefined && item.length > 0,
  );
  if (
    protectedValues.some(
      (protectedValue) => !value.secretValues.some((secret) => protectedValue.includes(secret)),
    )
  ) {
    throw new AuthError(
      "invalid_auth",
      providerId,
      `Provider ${providerId} omitted authentication values from redaction`,
    );
  }
  return value;
}

function validateAuthEvent(event: ProviderAuthEvent, providerId: string): ProviderAuthEvent {
  if (!isPlainObject(event) || typeof event.type !== "string") {
    throw new AuthError(
      "invalid_auth",
      providerId,
      `Provider ${providerId} emitted a malformed authentication event`,
    );
  }
  if (event.type === "info" || event.type === "progress") {
    if (typeof event.message === "string") return event;
  } else if (event.type === "auth_url") {
    if (typeof event.url === "string") return event;
  } else if (event.type === "device_code") {
    if (typeof event.userCode === "string" && typeof event.verificationUri === "string")
      return event;
  }
  throw new AuthError(
    "invalid_auth",
    providerId,
    `Provider ${providerId} emitted a malformed authentication event`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> | undefined {
  return (
    value === undefined ||
    (isPlainObject(value) && Object.values(value).every((item) => typeof item === "string"))
  );
}
