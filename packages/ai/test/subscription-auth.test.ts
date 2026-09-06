// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  createAnthropicOAuth,
  createGitHubCopilotOAuth,
  createGitHubCopilotTokenAuth,
  createKimiCodingOAuth,
  createOpenAiCodexOAuth,
  createOpenRouterOAuth,
  createRadiusOAuth,
  createXaiOAuth,
  type AuthEvent,
  type AuthPrompt,
  type Credential,
  type ProviderAuthInteraction,
} from "../src/index.ts";

const now = () => 1_000_000;
const sleep = () => Promise.resolve();

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function interaction(
  input: { answers?: readonly string[]; events?: AuthEvent[]; signal?: AbortSignal } = {},
): ProviderAuthInteraction {
  const answers = [...(input.answers ?? [])];
  return {
    signal: input.signal ?? new AbortController().signal,
    notify: (event) => input.events?.push(event),
    prompt: (prompt: AuthPrompt) => {
      const answer = answers.shift();
      if (answer !== undefined) return Promise.resolve(answer);
      if (prompt.type === "manual_code") {
        const state = input.events?.findLast((event) => event.type === "auth_url")?.url;
        const value = state === undefined ? undefined : new URL(state).searchParams.get("state");
        return Promise.resolve(`http://localhost/callback?code=test-code&state=${value ?? ""}`);
      }
      return Promise.resolve("");
    },
  };
}

function oauth(value: Credential): asserts value is Extract<Credential, { type: "oauth" }> {
  assert.equal(value.type, "oauth");
}

function jwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

test("Anthropic OAuth exchanges and refreshes without exposing tokens in events", async () => {
  const events: AuthEvent[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const method = createAnthropicOAuth({
    now,
    fetch: async (input, init) => {
      requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return response({
        access_token: "anthropic-access",
        refresh_token: "anthropic-refresh",
        expires_in: 3600,
      });
    },
  });

  const credential = await method.login?.(interaction({ events }));
  assert.ok(credential);
  oauth(credential);
  assert.equal(requests[0]?.url, "https://platform.claude.com/v1/oauth/token");
  assert.equal(credential.expiresAt, now() + 3_300_000);
  assert.equal(JSON.stringify(events).includes("anthropic-access"), false);
  assert.deepEqual(await method.toAuth(credential), {
    headers: {
      authorization: "Bearer anthropic-access",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    },
  });

  const refreshed = await method.refresh(credential, new AbortController().signal);
  assert.equal(refreshed.access, "anthropic-access");
  assert.equal(requests.length, 2);
});

test("OpenAI Codex device flow validates account identity before enabling auth", async () => {
  const events: AuthEvent[] = [];
  const token = jwt("account-123");
  const urls: string[] = [];
  const method = createOpenAiCodexOAuth({
    now,
    sleep,
    fetch: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/usercode")) {
        return response({ device_auth_id: "device", user_code: "ABCD", interval: 0 });
      }
      if (url.endsWith("/deviceauth/token")) {
        return response({ authorization_code: "code", code_verifier: "verifier" });
      }
      return response({ access_token: token, refresh_token: "codex-refresh", expires_in: 3600 });
    },
  });
  const credential = await method.login?.(interaction({ answers: ["device_code"], events }));
  assert.ok(credential);
  oauth(credential);
  assert.equal(credential.metadata?.accountId, "account-123");
  assert.equal(
    events.some((event) => event.type === "device_code"),
    true,
  );
  assert.equal(urls.at(-1), "https://auth.openai.com/oauth/token");
});

test("OpenRouter OAuth persists the exchanged permanent key as an API key", async () => {
  const events: AuthEvent[] = [];
  const method = createOpenRouterOAuth({
    fetch: async () => response({ key: "openrouter-key" }),
  });
  const credential = await method.login?.(interaction({ events }));
  assert.deepEqual(credential, { type: "api_key", key: "openrouter-key" });
  assert.equal(JSON.stringify(events).includes("openrouter-key"), false);
});

test("Kimi and xAI device flows honor provider endpoints and refresh rotation", async () => {
  for (const provider of ["kimi", "xai"] as const) {
    const urls: string[] = [];
    let tokenCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("device_authorization") || url.endsWith("/device/code")) {
        return response({
          device_code: "device",
          user_code: "CODE",
          verification_uri: `https://${provider}.example/verify`,
          verification_uri_complete: `https://${provider}.example/verify?code=CODE`,
          interval: 1,
          expires_in: 60,
        });
      }
      tokenCalls += 1;
      return response({
        access_token: `${provider}-access-${tokenCalls}`,
        refresh_token: `${provider}-refresh-${tokenCalls}`,
        expires_in: 3600,
      });
    };
    const method =
      provider === "kimi"
        ? createKimiCodingOAuth({ fetch: fetchImpl, now, sleep })
        : createXaiOAuth({ fetch: fetchImpl, now, sleep });
    const credential = await method.login?.(interaction({ events: [] }));
    assert.ok(credential);
    oauth(credential);
    const refreshed = await method.refresh(credential, new AbortController().signal);
    assert.equal(refreshed.access, `${provider}-access-2`);
    assert.equal(urls.length, 3);
  }
});

test("GitHub Copilot device flow preserves enterprise routing through refresh", async () => {
  const calls: string[] = [];
  let exchange = 0;
  const method = createGitHubCopilotOAuth({
    now,
    sleep,
    fetch: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/login/device/code")) {
        return response({
          device_code: "device",
          user_code: "CODE",
          verification_uri: "https://github.example/device",
          interval: 1,
          expires_in: 60,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return response({ access_token: "github-token" });
      }
      exchange += 1;
      return response({
        token: `tid=x;proxy-ep=proxy.enterprise.example;value=${exchange}`,
        expires_at: 5000,
      });
    },
  });
  const credential = await method.login?.(interaction({ answers: ["github.example"], events: [] }));
  assert.ok(credential);
  oauth(credential);
  assert.equal(credential.metadata?.domain, "github.example");
  assert.equal(credential.metadata?.baseUrl, "https://api.enterprise.example");
  const refreshed = await method.refresh(credential, new AbortController().signal);
  assert.equal(refreshed.metadata?.domain, "github.example");
  assert.equal(calls.at(-1), "https://api.github.example/copilot_internal/v2/token");
});

test("Copilot GitHub tokens exchange against the enterprise domain and derive routing", async () => {
  const calls: string[] = [];
  const method = createGitHubCopilotTokenAuth({
    fetch: async (input) => {
      calls.push(String(input));
      return response({
        token: "tid=x;proxy-ep=proxy.business.example;value=token",
        expires_at: 5000,
      });
    },
  });
  const resolved = await method.resolve({
    context: {
      env: (name) =>
        name === "COPILOT_GITHUB_TOKEN"
          ? "github-access"
          : name === "GITHUB_ENTERPRISE_URL"
            ? "github.example"
            : undefined,
      fileExists: () => Promise.resolve(false),
    },
    signal: new AbortController().signal,
  });
  assert.equal(calls[0], "https://api.github.example/copilot_internal/v2/token");
  assert.equal(resolved?.auth.baseUrl, "https://api.business.example");
  assert.equal(resolved?.auth.apiKey?.includes("proxy-ep"), true);
  assert.deepEqual(resolved?.secretValues, [
    "github-access",
    "tid=x;proxy-ep=proxy.business.example;value=token",
  ]);
});

test("Radius supports device authorization and refresh on the configured gateway", async () => {
  const calls: string[] = [];
  let tokens = 0;
  const method = createRadiusOAuth("https://radius.example/base", {
    now,
    sleep,
    fetch: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/v1/oauth/device")) {
        return response({
          device_code: "device",
          user_code: "CODE",
          verification_uri: "https://radius.example/verify",
          interval: 1,
          expires_in: 60,
        });
      }
      tokens += 1;
      return response({
        access_token: `radius-access-${tokens}`,
        refresh_token: "radius-refresh",
        expires_in: 3600,
      });
    },
  });
  const credential = await method.login?.(interaction({ answers: ["device_code"], events: [] }));
  assert.ok(credential);
  oauth(credential);
  const refreshed = await method.refresh(credential, new AbortController().signal);
  assert.equal(refreshed.access, "radius-access-2");
  assert.deepEqual(calls, [
    "https://radius.example/base/v1/oauth/device",
    "https://radius.example/base/v1/oauth/token",
    "https://radius.example/base/v1/oauth/token",
  ]);
});

test("device OAuth cancellation stops before token persistence", async () => {
  const controller = new AbortController();
  const method = createKimiCodingOAuth({
    sleep: async () => {
      controller.abort();
    },
    fetch: async () =>
      response({
        device_code: "device",
        user_code: "CODE",
        verification_uri: "https://kimi.example/verify",
        interval: 1,
        expires_in: 60,
      }),
  });
  assert.ok(method.login);
  await assert.rejects(method.login(interaction({ signal: controller.signal, events: [] })), {
    name: "AbortError",
  });
});
