// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

// Google Generative AI dialect boundary over the shared Google codec.

import type { ModelInfo, ModelStreamEvent } from "./model.ts";
import {
  decodeGoogleStream,
  type EncodedGoogleRequest,
  encodeGoogleRequest,
  GoogleGenerativeAiCodecError,
  type GoogleDecodeOptions,
} from "./google-shared.ts";
import type { PreparedModelRequest } from "./request-preparation.ts";
import type { SseFrame } from "./sse.ts";

export { GoogleGenerativeAiCodecError };
export type EncodedGoogleGenerativeAiRequest = EncodedGoogleRequest;
export type GoogleGenerativeAiDecodeOptions = GoogleDecodeOptions;

/** Encodes only the Google Generative AI dialect. */
export function encodeGoogleGenerativeAiRequest(
  model: ModelInfo,
  request: PreparedModelRequest,
): EncodedGoogleGenerativeAiRequest {
  return encodeGoogleRequest(model, request, "google-generative-ai");
}

/** Decodes only the Google Generative AI dialect. */
export function decodeGoogleGenerativeAiStream(
  frames: AsyncIterable<SseFrame>,
  options: GoogleGenerativeAiDecodeOptions,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  return decodeGoogleStream(frames, options, "google-generative-ai");
}
