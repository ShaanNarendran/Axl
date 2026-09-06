// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthError,
  collectModelStream,
  createDeepSeekProvider,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODELS,
  InMemoryCredentialStore,
  type ModelStreamEvent,
  ProviderRegistry,
} from "../src/index.ts";

const model = DEEPSEEK_MODELS[0];
if (model === undefined) throw new Error("DeepSeek catalog is empty");

function context(environment: Readonly<Record<string, string>> = {}) {
  return {
    env: (name: string) => environment[name],
    fileExists: () => Promise.resolve(false),
  };
}

function streamResponse(values: readonly unknown[]): Response {
  const body = values
    .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function events(
  stream: AsyncIterable<ModelStreamEvent>,
): Promise<readonly ModelStreamEvent[]> {
  const result: ModelStreamEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

test("constructs and lists DeepSeek without credential or network work", async () => {
  let environmentReads = 0;
  let fetches = 0;
  const provider = createDeepSeekProvider({
    store: new InMemoryCredentialStore(),
    context: {
      env: () => {
        environmentReads += 1;
        return undefined;
      },
      fileExists: () => Promise.resolve(false),
    },
    fetch: async () => {
      fetches += 1;
      throw new Error("unexpected network request");
    },
  });

  assert.equal(provider.id, "deepseek");
  assert.equal(provider.displayName, "DeepSeek");
  assert.deepEqual(provider.authMethods, ["environment", "file"]);
  assert.equal("refreshModels" in provider, false);
  assert.deepEqual(await provider.listModels(), DEEPSEEK_MODELS);
  assert.equal(environmentReads, 0);
  assert.equal(fetches, 0);
});

test("resolves stored DeepSeek credentials before environment credentials", async () => {
  const store = new InMemoryCredentialStore();
  await store.modify("deepseek", () => Promise.resolve({ type: "api_key", key: "stored-secret" }));
  const provider = createDeepSeekProvider({
    store,
    context: context({ DEEPSEEK_API_KEY: "environment-secret" }),
  });

  assert.deepEqual(await provider.authentication?.resolve(), {
    auth: { apiKey: "stored-secret" },
    source: "stored credential",
    secretValues: ["stored-secret"],
  });
});

test("does not fall through when a stored DeepSeek credential has no key", async () => {
  const store = new InMemoryCredentialStore();
  await store.modify("deepseek", () => Promise.resolve({ type: "api_key" }));
  const provider = createDeepSeekProvider({
    store,
    context: context({ DEEPSEEK_API_KEY: "environment-secret" }),
  });

  const authentication = provider.authentication;
  if (authentication === undefined) throw new Error("DeepSeek authentication is missing");
  await assert.rejects(
    authentication.resolve(),
    (error: unknown) => error instanceof AuthError && error.code === "invalid_auth",
  );
});

test("supports provider-owned DeepSeek API key login", async () => {
  const store = new InMemoryCredentialStore();
  const provider = createDeepSeekProvider({ store, context: context() });
  const prompts: unknown[] = [];

  const state = await provider.authentication?.login("api_key", {
    prompt: (prompt) => {
      prompts.push(prompt);
      return Promise.resolve("entered-secret");
    },
    notify: () => undefined,
  });

  assert.equal(state?.phase, "authenticated");
  assert.equal(prompts.length, 1);
  assert.deepEqual(await store.read("deepseek"), { type: "api_key", key: "entered-secret" });
});

test("registers DeepSeek and streams through the prepared Chat transport", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return streamResponse([
      { id: "response-1", model: "deepseek-routed", choices: [{ delta: { content: "ok" } }] },
      {
        usage: { prompt_tokens: 2, completion_tokens: 1 },
        choices: [{ delta: {}, finish_reason: "stop" }],
      },
      "[DONE]",
    ]);
  };
  const provider = createDeepSeekProvider({
    store: new InMemoryCredentialStore(),
    context: context({ DEEPSEEK_API_KEY: "deepseek-secret" }),
    fetch: fetchImpl,
    now: () => 100,
  });
  const registry = new ProviderRegistry();
  registry.register(provider);

  const result = await collectModelStream(
    registry.stream("deepseek", { modelId: model.modelId, messages: [] }),
  );

  assert.equal(requestUrl, `${DEEPSEEK_BASE_URL}/chat/completions`);
  assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer deepseek-secret");
  assert.equal(new Headers(requestInit?.headers).get("accept"), "text/event-stream");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    model: model.modelId,
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.deepEqual(result.events[0], { type: "text_delta", text: "ok", contentIndex: 0 });
  assert.equal(result.terminal.type, "completed");
  assert.deepEqual(result.terminal.response, {
    providerId: "deepseek",
    requestedModelId: model.modelId,
    routedModelId: "deepseek-routed",
    responseId: "response-1",
    nativeStopReason: "stop",
    latencyMs: 0,
  });
});

test("retries bounded prestream failures and honors retry guidance", async () => {
  let fetches = 0;
  const fetchImpl: typeof fetch = async () => {
    fetches += 1;
    if (fetches === 1) {
      return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
    }
    return streamResponse([{ choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
  };
  const provider = createDeepSeekProvider({
    store: new InMemoryCredentialStore(),
    context: context({ DEEPSEEK_API_KEY: "secret" }),
    fetch: fetchImpl,
  });

  const completed = await events(
    provider.stream({ modelId: model.modelId, messages: [], maxRetries: 1 }),
  );
  assert.equal(fetches, 2);
  assert.equal(completed.at(-1)?.type, "completed");

  const limited = createDeepSeekProvider({
    store: new InMemoryCredentialStore(),
    context: context({ DEEPSEEK_API_KEY: "secret" }),
    fetch: async () => new Response("busy", { status: 429, headers: { "retry-after": "3" } }),
  });
  assert.deepEqual(
    await events(limited.stream({ modelId: model.modelId, messages: [], maxRetries: 0 })),
    [
      {
        type: "error",
        code: "http_429",
        message: "Provider deepseek returned 429",
        retryable: true,
        category: "rate_limit",
        requestPhase: "awaiting_response",
        retryAfterMs: 3_000,
      },
    ],
  );
});

test("reports cancellation, timeout, and redacted transport failures", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const provider = createDeepSeekProvider({
    store: new InMemoryCredentialStore(),
    context: context({ DEEPSEEK_API_KEY: "secret-value" }),
    fetch: async () => {
      throw new Error("should not fetch");
    },
  });
  assert.deepEqual(
    await events(
      provider.stream({ modelId: model.modelId, messages: [], signal: cancelled.signal }),
    ),
    [{ type: "aborted" }],
  );

  const timeoutProvider = createDeepSeekProvider({
    store: new InMemoryCredentialStore(),
    context: context({ DEEPSEEK_API_KEY: "secret-value" }),
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const guard = setTimeout(() => reject(new Error("timeout signal did not fire")), 100);
        const abort = () => {
          clearTimeout(guard);
          reject(signal?.reason);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
  });
  const timedOut = await events(
    timeoutProvider.stream({ modelId: model.modelId, messages: [], timeoutMs: 1 }),
  );
  assert.deepEqual(timedOut, [
    {
      type: "error",
      code: "provider_timeout",
      message: "Provider deepseek request timed out",
      retryable: true,
      category: "timeout",
      requestPhase: "before_dispatch",
    },
  ]);

  let retryAttempts = 0;
  const retryController = new AbortController();
  const retrying = createDeepSeekProvider({
    store: new InMemoryCredentialStore(),
    context: context({ DEEPSEEK_API_KEY: "secret-value" }),
    fetch: async () => {
      retryAttempts += 1;
      retryController.abort();
      return new Response("busy", { status: 429, headers: { "retry-after": "30" } });
    },
  });
  assert.deepEqual(
    await events(
      retrying.stream({ modelId: model.modelId, messages: [], signal: retryController.signal }),
    ),
    [{ type: "aborted" }],
  );
  assert.equal(retryAttempts, 1);

  const failed = createDeepSeekProvider({
    store: new InMemoryCredentialStore(),
    context: context({ DEEPSEEK_API_KEY: "secret-value" }),
    fetch: async () => {
      throw new Error("credential secret-value rejected");
    },
  });
  const failedEvents = await events(
    failed.stream({ modelId: model.modelId, messages: [], maxRetries: 0 }),
  );
  assert.equal(failedEvents[0]?.type, "error");
  if (failedEvents[0]?.type !== "error") throw new Error("Expected transport error");
  assert.equal(failedEvents[0].message, "credential [REDACTED] rejected");
  assert.equal(failedEvents[0].category, "network");
});
