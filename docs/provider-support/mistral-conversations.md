<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Mistral Conversations codec support record

## Scope

This record covers the transport-neutral `mistral-conversations` request encoder and streaming event decoder in `packages/ai`. The codec accepts only `PreparedModelRequest`. It does not acquire an API key, compose authorization headers, perform HTTP transport, register a provider, enforce retries or timeouts, or integrate provider selection into the runtime, daemon, SDK, CLI, or TUI.

## Reviewed behavioral revision

- Behavioral reference repository: `https://github.com/earendil-works/pi`
- Reviewed commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed implementation: the complete Mistral Conversations implementation, lazy entry point, provider and model metadata, environment API-key authentication boundary, and every focused Mistral test

Pi was used to identify native message, image, thinking, tool, reasoning-control, prompt-cache, usage, stop-reason, and stream behavior. Axl implements that behavior independently around Axl's prepared request and canonical stream contracts. No Mistral SDK or other production dependency was added.

## Request conversion

The encoder covers system and prepared conversation history, verified user and tool-result images, visible assistant thinking replay, function tools, strict JSON schemas, paired nine-character tool-call identifiers, tool errors, output limits, tool choice, temperature, top-p, frequency and presence penalties, random seed, prompt-cache identity, and safe affinity metadata.

Models with a prepared native effort value use `reasoning_effort`. Reasoning models without effort metadata use `prompt_mode: reasoning`. Generated compatibility metadata marks strict-tool support only for models whose reviewed catalog metadata declares structured output.

Unsupported grammar tools, assistant images, provider replay signatures, continuation metadata, request metadata, and colliding custom request fields fail explicitly. The codec does not silently downgrade required strict schemas.

## Authentication and transport boundary

The pure codec emits no authorization material and does not resolve `MISTRAL_API_KEY`. A later provider registration slice owns stored and environment API-key resolution. A later transport owns the Mistral endpoint, HTTP headers, SSE byte decoding, cancellation propagation, timeout enforcement, bounded retries, and retry guidance derived from HTTP responses.

Prompt caching emits the prepared session identity as `prompt_cache_key` and the non-secret `x-affinity` header. No credential or arbitrary provider object enters the encoded body, diagnostics, or response metadata.

## Stream conversion

The decoder consumes already framed SSE data. It handles native text and thinking content, fragmented function calls whose later chunks omit identifiers, deterministic fallback call identifiers, cache-read usage, cost, response IDs, routed model identity, native stop reasons, cancellation, provider errors, malformed frames, safe partial failures, and truncation.

`stop`, `length`, `model_length`, and `tool_calls` map to canonical completion reasons. Provider `error` and unknown finish reasons fail closed while preserving the native reason. Every normal, failed, cancelled, malformed, or truncated stream produces exactly one terminal event when used through `normalizeModelStream`.

## Deterministic verification

Local fixtures cover generated compatibility metadata, prepared history and image encoding, strict tools, reasoning effort and prompt mode, prompt caching and affinity, sampling, interleaved thinking and text, fragmented tools, usage and cost, routed identity, native stop reasons, redacted provider failures, cancellation, malformed input, unsupported replay data, and exact terminal normalization. No live provider request was performed.

## Registration status and deferred work

Built in API-key registration, endpoint and header composition, HTTP and SSE transport, timeout enforcement, and bounded retries were completed in `118fd89`. Runtime selection, daemon and SDK changes, CLI and TUI integration, and live provider smoke tests remain in their planned slices.
