// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ModelPort } from "@axl/kernel";
import { ToolRegistry } from "@axl/kernel";
import type { ProviderManagementService } from "../src/provider-management.ts";
import { AxlClientError, ProviderClientError } from "@axl/sdk";
import { connectUnixClient } from "@axl/sdk/unix";

import { AxlDaemon, ProviderManagementError } from "../src/index.ts";

const model: ModelPort = {
  stream: () =>
    (async function* () {
      yield {
        type: "completed" as const,
        stopReason: "stop" as const,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    })(),
};

function inventory() {
  return {
    providers: [
      {
        providerId: "openrouter",
        displayName: "OpenRouter",
        enabled: true,
        authMethods: ["environment", "file", "oauth"] as const,
        loginMethods: ["api_key", "oauth"] as const,
        authentication: { providerId: "openrouter", phase: "idle" as const },
        catalog: { refreshable: true },
        models: [
          {
            providerId: "openrouter",
            modelId: "example/model",
            displayName: "Example Model",
            apiDialect: "openai-chat",
            capabilities: { toolUse: true, structuredOutput: false, imageInput: true },
            reasoning: true,
            supportedThinkingLevels: ["off", "low", "medium", "high"] as const,
            contextWindow: 128_000,
            maxOutputTokens: 16_384,
            availability: { status: "available" as const },
          },
        ],
      },
    ],
  };
}

function service(overrides: Partial<ProviderManagementService> = {}): ProviderManagementService {
  return {
    list: async () => inventory(),
    refresh: async () => ({
      providers: [{ providerId: "openrouter", status: "refreshed", modelCount: 1 }],
    }),
    authenticationStatus: async () => ({
      providers: [{ providerId: "openrouter", phase: "idle" }],
    }),
    login: async ({ providerId, method }) => ({
      providerId,
      method,
      phase: "authenticated",
      source: "test adapter",
    }),
    logout: async ({ providerId }) => ({ providerId, phase: "logged_out" }),
    ...overrides,
  };
}

async function start(
  context: TestContext,
  providerManagement?: ProviderManagementService,
): Promise<{ daemon: AxlDaemon; socketPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "axl-provider-management-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "axl.sock");
  const daemon = new AxlDaemon({
    socketPath,
    dataDirectory: join(directory, "data"),
    ...(providerManagement === undefined ? {} : { providerManagement }),
    runtime: async () => ({ model, tools: new ToolRegistry() }),
  });
  await daemon.start();
  context.after(() => daemon.stop());
  return { daemon, socketPath };
}

test("grants provider capabilities only when the daemon owns a service", async (context) => {
  const without = await start(context);
  const unsupported = await connectUnixClient(without.socketPath);
  context.after(() => unsupported.close());
  assert.equal(unsupported.connection.grantedCapabilities.includes("provider.list"), false);
  await assert.rejects(
    unsupported.listProviders(),
    (error) => error instanceof AxlClientError && error.code === "unsupported_capability",
  );

  const withService = await start(context, service());
  const client = await connectUnixClient(withService.socketPath);
  context.after(() => client.close());
  assert.equal(client.connection.grantedCapabilities.includes("provider.list"), true);
  assert.deepEqual(await client.listProviders(), inventory());
});

test("serves typed authentication actions without credential payloads", async (context) => {
  const started = await start(context, service());
  const client = await connectUnixClient(started.socketPath);
  context.after(() => client.close());

  assert.deepEqual(await client.providerAuthenticationStatus({ providerId: "openrouter" }), {
    providers: [{ providerId: "openrouter", phase: "idle" }],
  });
  assert.deepEqual(await client.loginProvider({ providerId: "openrouter", method: "oauth" }), {
    providerId: "openrouter",
    method: "oauth",
    phase: "authenticated",
    source: "test adapter",
  });
  assert.deepEqual(await client.logoutProvider({ providerId: "openrouter" }), {
    providerId: "openrouter",
    phase: "logged_out",
  });
});

test("cancels explicit catalog refresh", async (context) => {
  let began!: () => void;
  const beginning = new Promise<void>((resolve) => {
    began = resolve;
  });
  const started = await start(
    context,
    service({
      refresh: async (_params, signal) => {
        began();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { providers: [] };
      },
    }),
  );
  const client = await connectUnixClient(started.socketPath);
  context.after(() => client.close());
  const controller = new AbortController();
  const refresh = client.refreshProviderCatalogs({}, { signal: controller.signal });
  await beginning;
  controller.abort();
  await assert.rejects(
    refresh,
    (error) => error instanceof AxlClientError && error.code === "cancelled",
  );
});

test("cancels trusted-host provider login", async (context) => {
  let began!: () => void;
  const beginning = new Promise<void>((resolve) => {
    began = resolve;
  });
  const started = await start(
    context,
    service({
      login: async (_params, signal) => {
        began();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { providerId: "openrouter", phase: "authenticated" };
      },
    }),
  );
  const client = await connectUnixClient(started.socketPath);
  context.after(() => client.close());
  const controller = new AbortController();
  const login = client.loginProvider(
    { providerId: "openrouter", method: "oauth" },
    { signal: controller.signal },
  );
  await beginning;
  controller.abort();
  await assert.rejects(
    login,
    (error) => error instanceof AxlClientError && error.code === "cancelled",
  );
});

test("returns actionable provider failures and redacts unknown causes", async (context) => {
  const secret = "provider-secret-value";
  const actionable = await start(
    context,
    service({
      login: async ({ providerId }) => {
        throw new ProviderManagementError(
          "authentication_required",
          `Provider ${providerId} requires authentication`,
          { category: "authentication", action: "login", providerId },
        );
      },
      list: async () => {
        throw new Error(secret);
      },
    }),
  );
  const client = await connectUnixClient(actionable.socketPath);
  context.after(() => client.close());

  await assert.rejects(
    client.loginProvider({ providerId: "openrouter", method: "oauth" }),
    (error) =>
      error instanceof ProviderClientError &&
      error.code === "authentication_required" &&
      error.details?.category === "authentication" &&
      error.details.action === "login",
  );
  await assert.rejects(
    client.listProviders(),
    (error) =>
      error instanceof AxlClientError &&
      error.code === "internal_error" &&
      !error.message.includes(secret),
  );
});
