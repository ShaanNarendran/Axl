// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ApiKeyAuthMethod,
  AuthError,
  type AuthContext,
  type AuthEvent,
  createProviderAuthentication,
  InMemoryCredentialStore,
  login,
  logout,
  type OAuthAuthMethod,
  type OAuthCredential,
  resolveProviderAuth,
  safeProviderMessage,
} from "../src/index.ts";

const providerId = "azure";

function makeContext(env: Record<string, string> = {}): AuthContext {
  return {
    env: (name) => env[name],
    fileExists: () => Promise.resolve(false),
  };
}

/** Azure-shaped api-key method: stored key wins, environment is the fallback. */
const apiKeyMethod: ApiKeyAuthMethod = {
  displayName: "Azure OpenAI API key",
  resolve: async ({ context, credential }) => {
    const key = credential?.key ?? context.env("AZURE_OPENAI_API_KEY");
    if (key === undefined) return undefined;
    return {
      auth: { apiKey: key },
      source: credential?.key !== undefined ? "stored api key" : "AZURE_OPENAI_API_KEY",
      secretValues: [key],
    };
  },
};

function makeOAuthMethod(refreshed: OAuthCredential): OAuthAuthMethod & { refreshCount: number } {
  return {
    displayName: "Azure OAuth",
    refreshCount: 0,
    async refresh() {
      this.refreshCount += 1;
      return refreshed;
    },
    toAuth: (credential) => ({ headers: { Authorization: `Bearer ${credential.access}` } }),
  };
}

function validOAuth(access = "fresh-access"): OAuthCredential {
  return { type: "oauth", access, refresh: "fresh-refresh", expiresAt: Date.now() + 3_600_000 };
}

function expiringOAuth(): OAuthCredential {
  return {
    type: "oauth",
    access: "old-access",
    refresh: "old-refresh",
    expiresAt: Date.now() + 1_000,
  };
}

test("a stored api key owns the provider over the environment", async () => {
  const store = new InMemoryCredentialStore();
  await login(store, providerId, { type: "api_key", key: "stored-key" });
  const context = makeContext({ AZURE_OPENAI_API_KEY: "env-key" });

  const resolved = await resolveProviderAuth(providerId, { apiKey: apiKeyMethod }, store, context);
  assert.deepEqual(resolved.auth, { apiKey: "stored-key" });
  assert.equal(resolved.source, "stored api key");
  assert.deepEqual(resolved.secretValues, ["stored-key"]);
});

test("falls back to ambient environment only when nothing is stored", async () => {
  const store = new InMemoryCredentialStore();
  const context = makeContext({ AZURE_OPENAI_API_KEY: "env-key" });

  const resolved = await resolveProviderAuth(providerId, { apiKey: apiKeyMethod }, store, context);
  assert.deepEqual(resolved.auth, { apiKey: "env-key" });
  assert.equal(resolved.source, "AZURE_OPENAI_API_KEY");
});

test("reports not_configured loudly when no credential or ambient source exists", async () => {
  const store = new InMemoryCredentialStore();
  await assert.rejects(
    resolveProviderAuth(providerId, { apiKey: apiKeyMethod }, store, makeContext()),
    (error) => error instanceof AuthError && error.code === "not_configured",
  );
});

test("logout removes the credential and restores the ambient path", async () => {
  const store = new InMemoryCredentialStore();
  const context = makeContext({ AZURE_OPENAI_API_KEY: "env-key" });
  await login(store, providerId, { type: "api_key", key: "stored-key" });
  await logout(store, providerId);

  const resolved = await resolveProviderAuth(providerId, { apiKey: apiKeyMethod }, store, context);
  assert.equal(resolved.auth.apiKey, "env-key");
});

test("valid oauth resolves without refreshing and lists its tokens as secrets", async () => {
  const store = new InMemoryCredentialStore();
  const method = makeOAuthMethod(validOAuth());
  await login(store, providerId, validOAuth("current-access"));

  const resolved = await resolveProviderAuth(providerId, { oauth: method }, store, makeContext());
  assert.equal(method.refreshCount, 0);
  assert.deepEqual(resolved.auth.headers, { Authorization: "Bearer current-access" });
  assert.deepEqual(resolved.secretValues, ["current-access", "fresh-refresh"]);
});

test("expiring oauth refreshes exactly once across concurrent resolutions", async () => {
  const store = new InMemoryCredentialStore();
  const method = makeOAuthMethod(validOAuth());
  await login(store, providerId, expiringOAuth());

  const results = await Promise.all(
    [1, 2, 3].map(() => resolveProviderAuth(providerId, { oauth: method }, store, makeContext())),
  );
  assert.equal(method.refreshCount, 1);
  for (const resolved of results) {
    assert.deepEqual(resolved.auth.headers, { Authorization: "Bearer fresh-access" });
  }
  const stored = await store.read(providerId);
  assert.equal(stored?.type === "oauth" && stored.access, "fresh-access");
});

test("a failed refresh surfaces refresh_failed with no silent fallback", async () => {
  const store = new InMemoryCredentialStore();
  const method: OAuthAuthMethod = {
    displayName: "Azure OAuth",
    refresh: () => Promise.reject(new Error("invalid_grant")),
    toAuth: () => ({}),
  };
  await login(store, providerId, expiringOAuth());

  // The ambient env key exists but must not be used after a failed refresh.
  const context = makeContext({ AZURE_OPENAI_API_KEY: "env-key" });
  await assert.rejects(
    resolveProviderAuth(providerId, { oauth: method, apiKey: apiKeyMethod }, store, context),
    (error) =>
      error instanceof AuthError &&
      error.code === "refresh_failed" &&
      /log in again/.test(error.message),
  );
});

test("logging out between the optimistic check and the locked refresh reports not_configured", async () => {
  const store = new InMemoryCredentialStore();
  let refreshCalled = false;
  const method: OAuthAuthMethod = {
    displayName: "Azure OAuth",
    refresh: async (credential) => {
      refreshCalled = true;
      return credential;
    },
    toAuth: () => ({}),
  };
  await login(store, providerId, expiringOAuth());
  // Simulate a logout racing the resolution: the optimistic read sees the
  // expiring credential, then the entry is gone by the time the lock is held.
  const originalRead = store.read.bind(store);
  const racingStore = Object.assign(Object.create(store) as InMemoryCredentialStore, {
    read: async (id: string) => {
      const current = await originalRead(id);
      await logout(store, providerId);
      return current;
    },
  });

  await assert.rejects(
    resolveProviderAuth(providerId, { oauth: method }, racingStore, makeContext()),
    (error) =>
      error instanceof AuthError &&
      error.code === "not_configured" &&
      /logged out during refresh/.test(error.message),
  );
  assert.equal(refreshCalled, false);
});

test("a stored credential type without a matching method is not silently substituted", async () => {
  const store = new InMemoryCredentialStore();
  await login(store, providerId, validOAuth());

  await assert.rejects(
    resolveProviderAuth(providerId, { apiKey: apiKeyMethod }, store, makeContext()),
    (error) =>
      error instanceof AuthError &&
      error.code === "not_configured" &&
      /no matching auth method/.test(error.message),
  );
});

test("resolution failures surface invalid_auth with the provider named", async () => {
  const store = new InMemoryCredentialStore();
  const failing: ApiKeyAuthMethod = {
    displayName: "Azure OpenAI API key",
    resolve: () => Promise.reject(new Error("credential file unreadable")),
  };
  await login(store, providerId, { type: "api_key", key: "stored-key" });

  await assert.rejects(
    resolveProviderAuth(providerId, { apiKey: failing }, store, makeContext()),
    (error) =>
      error instanceof AuthError &&
      error.code === "invalid_auth" &&
      error.providerId === providerId,
  );
});

function source(
  type: "environment" | "file" | "ambient" | "keyless",
  available: boolean,
  calls: string[],
) {
  return {
    type,
    displayName: type,
    resolve: async () => {
      calls.push(type);
      if (!available) return undefined;
      const key = `${type}-secret`;
      return {
        auth: type === "keyless" ? {} : { apiKey: key },
        source: type,
        secretValues: type === "keyless" ? [] : [key],
      };
    },
  } as const;
}

function makeInteraction(events: AuthEvent[], signal?: AbortSignal) {
  return {
    ...(signal === undefined ? {} : { signal }),
    prompt: () => Promise.resolve("answer"),
    notify: (event: AuthEvent) => events.push(event),
  };
}

test("ambient authentication uses fixed environment, file, ambient, and keyless precedence", async () => {
  const store = new InMemoryCredentialStore();
  const calls: string[] = [];
  const methods = {
    sources: [
      source("keyless", true, calls),
      source("ambient", true, calls),
      source("file", true, calls),
      source("environment", false, calls),
    ],
  };

  const resolved = await resolveProviderAuth(providerId, methods, store, makeContext());
  assert.equal(resolved.source, "file");
  assert.deepEqual(calls, ["environment", "file"]);
});

test("stored credential failure never falls back through ambient precedence", async () => {
  const store = new InMemoryCredentialStore();
  const calls: string[] = [];
  await login(store, providerId, { type: "api_key", key: "rejected-secret" });
  const rejecting: ApiKeyAuthMethod = {
    displayName: "stored key",
    resolve: () => Promise.resolve(undefined),
  };

  await assert.rejects(
    resolveProviderAuth(
      providerId,
      { apiKey: rejecting, sources: [source("environment", true, calls)] },
      store,
      makeContext(),
    ),
    (error) => error instanceof AuthError && error.code === "invalid_auth",
  );
  assert.deepEqual(calls, []);
});

test("interactive authorization reports UI-neutral lifecycle states", async () => {
  const events: AuthEvent[] = [];
  const store = new InMemoryCredentialStore();
  const authentication = createProviderAuthentication({
    providerId,
    declaredMethods: ["oauth"],
    methods: {
      oauth: {
        displayName: "Test OAuth",
        login: async (interaction) => {
          interaction.notify({ type: "auth_url", url: "https://login.example.test" });
          return validOAuth("interactive-access");
        },
        refresh: async (credential) => credential,
        toAuth: (credential) => ({ apiKey: credential.access }),
      },
    },
    store,
    context: makeContext(),
  });

  const state = await authentication.login("oauth", makeInteraction(events));
  assert.equal(state.phase, "authenticated");
  assert.deepEqual(
    events.map((event) => event.type),
    ["state", "auth_url", "state"],
  );
  assert.equal(JSON.stringify(events).includes("interactive-access"), false);
});

test("interactive authorization cancellation cannot persist late completion", async () => {
  const store = new InMemoryCredentialStore();
  const controller = new AbortController();
  let complete!: (credential: OAuthCredential) => void;
  const pending = new Promise<OAuthCredential>((resolvePromise) => {
    complete = resolvePromise;
  });
  const authentication = createProviderAuthentication({
    providerId,
    declaredMethods: ["oauth"],
    methods: {
      oauth: {
        displayName: "Test OAuth",
        login: () => pending,
        refresh: async (credential) => credential,
        toAuth: () => ({}),
      },
    },
    store,
    context: makeContext(),
  });

  const operation = authentication.login("oauth", makeInteraction([], controller.signal));
  controller.abort();
  complete(validOAuth("late-access"));
  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(await store.read(providerId), undefined);
  assert.equal(authentication.state().phase, "idle");
});

test("newest concurrent authorization completion wins deterministically", async () => {
  const store = new InMemoryCredentialStore();
  const completions: ((credential: OAuthCredential) => void)[] = [];
  const authentication = createProviderAuthentication({
    providerId,
    declaredMethods: ["oauth"],
    methods: {
      oauth: {
        displayName: "Test OAuth",
        login: () =>
          new Promise<OAuthCredential>((resolvePromise) => {
            completions.push(resolvePromise);
          }),
        refresh: async (credential) => credential,
        toAuth: () => ({}),
      },
    },
    store,
    context: makeContext(),
  });

  const first = authentication.login("oauth", makeInteraction([]));
  const second = authentication.login("oauth", makeInteraction([]));
  completions[1]?.(validOAuth("newest-access"));
  await second;
  completions[0]?.(validOAuth("stale-access"));
  await assert.rejects(first, /superseded/);
  const stored = await store.read(providerId);
  assert.equal(stored?.type === "oauth" && stored.access, "newest-access");
});

test("logout wins a race with interactive authorization completion", async () => {
  const store = new InMemoryCredentialStore();
  let complete!: (credential: OAuthCredential) => void;
  const authentication = createProviderAuthentication({
    providerId,
    declaredMethods: ["oauth"],
    methods: {
      oauth: {
        displayName: "Test OAuth",
        login: () =>
          new Promise<OAuthCredential>((resolvePromise) => {
            complete = resolvePromise;
          }),
        refresh: async (credential) => credential,
        toAuth: () => ({}),
      },
    },
    store,
    context: makeContext(),
  });

  const authorization = authentication.login("oauth", makeInteraction([]));
  await authentication.logout();
  complete(validOAuth("late-access"));
  await assert.rejects(authorization, /superseded/);
  assert.equal(await store.read(providerId), undefined);
  assert.deepEqual(authentication.state(), { phase: "logged_out" });
});

test("logout wins a race with an in-flight refresh", async () => {
  const store = new InMemoryCredentialStore();
  await login(store, providerId, expiringOAuth());
  let complete!: (credential: OAuthCredential) => void;
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolvePromise) => {
    refreshStarted = resolvePromise;
  });
  const authentication = createProviderAuthentication({
    providerId,
    declaredMethods: ["oauth"],
    methods: {
      oauth: {
        displayName: "Test OAuth",
        refresh: () => {
          refreshStarted();
          return new Promise<OAuthCredential>((resolvePromise) => {
            complete = resolvePromise;
          });
        },
        toAuth: (credential) => ({ apiKey: credential.access }),
      },
    },
    store,
    context: makeContext(),
  });

  const resolution = authentication.resolve();
  await started;
  const loggedOut = authentication.logout();
  complete(validOAuth("refreshed-after-logout"));
  await assert.rejects(resolution, /Authentication changed/);
  await loggedOut;
  assert.equal(await store.read(providerId), undefined);
  assert.deepEqual(authentication.state(), { phase: "logged_out" });
});

test("failed refresh enters reauthentication state without ambient fallback", async () => {
  const store = new InMemoryCredentialStore();
  await login(store, providerId, expiringOAuth());
  const authentication = createProviderAuthentication({
    providerId,
    declaredMethods: ["oauth", "environment"],
    methods: {
      oauth: {
        displayName: "Test OAuth",
        refresh: () => Promise.reject(new Error("old-refresh-token")),
        toAuth: () => ({}),
      },
      sources: [source("environment", true, [])],
    },
    store,
    context: makeContext(),
  });

  await assert.rejects(authentication.resolve(), (error) => {
    assert.equal(String(error).includes("old-refresh-token"), false);
    return error instanceof AuthError && error.code === "refresh_failed";
  });
  assert.deepEqual(authentication.state(), {
    phase: "reauthentication_required",
    method: "oauth",
  });
});

test("malformed provider auth and credential responses fail loudly", async () => {
  const store = new InMemoryCredentialStore();
  const malformedResolution: ApiKeyAuthMethod = {
    displayName: "Malformed",
    resolve: () =>
      Promise.resolve({
        auth: { apiKey: "unredacted-secret" },
        source: "malformed",
        secretValues: [],
      }),
  };
  await assert.rejects(
    resolveProviderAuth(providerId, { apiKey: malformedResolution }, store, makeContext()),
    (error) => error instanceof AuthError && error.code === "invalid_auth",
  );

  const authentication = createProviderAuthentication({
    providerId,
    declaredMethods: ["oauth"],
    methods: {
      oauth: {
        displayName: "Malformed OAuth",
        login: () => Promise.resolve({ type: "oauth", access: "only" } as OAuthCredential),
        refresh: async (credential) => credential,
        toAuth: () => ({}),
      },
    },
    store,
    context: makeContext(),
  });
  await assert.rejects(authentication.login("oauth", makeInteraction([])));
  assert.equal(await store.read(providerId), undefined);

  const malformedEventAuthentication = createProviderAuthentication({
    providerId,
    declaredMethods: ["oauth"],
    methods: {
      oauth: {
        displayName: "Malformed events",
        login: async (interaction) => {
          interaction.notify({ type: "auth_url" } as never);
          return validOAuth();
        },
        refresh: async (credential) => credential,
        toAuth: () => ({}),
      },
    },
    store,
    context: makeContext(),
  });
  await assert.rejects(
    malformedEventAuthentication.login("oauth", makeInteraction([])),
    (error) => error instanceof AuthError && error.code === "invalid_auth",
  );
});

test("authentication states and diagnostics expose no credential values", async () => {
  const store = new InMemoryCredentialStore();
  const secret = "diagnostic-secret";
  await login(store, providerId, { type: "api_key", key: secret });
  const authentication = createProviderAuthentication({
    providerId,
    declaredMethods: ["file"],
    methods: { apiKey: apiKeyMethod },
    store,
    context: makeContext(),
  });

  const resolved = await authentication.resolve();
  assert.deepEqual(resolved.secretValues, [secret]);
  assert.equal(JSON.stringify(authentication.state()).includes(secret), false);
  assert.equal(
    safeProviderMessage(`failed with ${secret}`, resolved.secretValues),
    "failed with [REDACTED]",
  );

  const leakingSource: ApiKeyAuthMethod = {
    displayName: "Leaking source",
    resolve: () =>
      Promise.resolve({ auth: { apiKey: secret }, source: secret, secretValues: [secret] }),
  };
  await assert.rejects(
    resolveProviderAuth(
      providerId,
      { apiKey: leakingSource },
      new InMemoryCredentialStore(),
      makeContext(),
    ),
    (error) => error instanceof AuthError && error.code === "invalid_auth",
  );
});
