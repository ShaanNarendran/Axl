// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type {
  BlobReference,
  ModelMessage,
  ModelRequestConfiguration,
  ModelRequestSettings,
  ModelStreamEvent,
  ThinkingLevel,
  ToolDeclaration,
} from "@axl/protocol";

import { DEFAULT_MODEL_REQUEST_SETTINGS } from "@axl/protocol";
import { fitModelRequest } from "./request-configuration.ts";

import type { ModelProvider } from "./provider.ts";
import type { ProviderRegistry } from "./registry.ts";
import { prepareModelRequest } from "./request-preparation.ts";
import { normalizeModelStream } from "./stream.ts";

export interface SessionPortOptions {
  readonly modelId: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly maxOutputTokens?: number;
  readonly requestSettings?: ModelRequestSettings;
  readonly readBlob?: (reference: BlobReference) => Promise<Uint8Array>;
}

interface PortTurnRequest {
  readonly system?: string | undefined;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDeclaration[];
  readonly maxOutputTokens?: number | undefined;
  readonly toolChoice?: "auto" | "required" | "none" | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly estimatedInputTokens?: number | undefined;
  readonly onRequestConfigured?:
    | ((configuration: ModelRequestConfiguration) => Promise<void>)
    | undefined;
}

/**
 * Binds a provider and model choice into the shape the kernel's ModelPort
 * expects (satisfied structurally — the kernel never imports this package).
 * Streams are normalized, so the kernel always sees exactly one terminal.
 */
function providerRequest(request: PortTurnRequest, options: SessionPortOptions) {
  return {
    modelId: options.modelId,
    ...(request.system === undefined ? {} : { system: request.system }),
    messages: request.messages,
    tools: request.tools,
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    ...(request.maxOutputTokens === undefined && options.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: request.maxOutputTokens ?? options.maxOutputTokens }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(options.readBlob === undefined ? {} : { readBlob: options.readBlob }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

export function modelPortForSession(
  provider: ModelProvider,
  options: SessionPortOptions,
): { stream(request: PortTurnRequest): AsyncIterable<ModelStreamEvent> } {
  return {
    stream: (request) =>
      normalizeModelStream(
        (async function* () {
          const models = await provider.listModels();
          const model = models.find((candidate) => candidate.modelId === options.modelId);
          if (model === undefined) {
            throw new Error(`Provider ${provider.id} has no model ${options.modelId}`);
          }
          const prepared = await prepareModelRequest(model, providerRequest(request, options));
          yield* provider.stream(prepared);
        })(),
        request.signal,
      ),
  };
}

export interface RegistrySessionPortOptions extends SessionPortOptions {
  readonly providerId: string;
}

/** Binds a provider and model identity through the registry coordinator. */
export function modelPortForRegistry(
  registry: ProviderRegistry,
  options: RegistrySessionPortOptions,
): { stream(request: PortTurnRequest): AsyncIterable<ModelStreamEvent> } {
  return {
    stream: (request) =>
      normalizeModelStream(
        registry.stream(options.providerId, providerRequest(request, options)),
        request.signal,
      ),
  };
}
