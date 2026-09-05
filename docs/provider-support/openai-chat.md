<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenAI Chat Completions codec support record

## Scope

This record covers the pure `openai-chat` request encoder and streaming response decoder in `packages/ai/src/openai-chat.ts`. Provider registration, endpoint selection, authentication, HTTP transport, timeout enforcement, and bounded request retries remain separate provider-integration work.

The codec accepts only `PreparedModelRequest`. It does not reload media, reinterpret canonical tool names, recalculate reasoning policy, or accept credentials.

## Reviewed sources

### Normative OpenAI source

- Source: OpenAI API schema, `https://platform.openai.com/docs/static/api-definition.yaml`
- Retrieved: 2026-09-05T15:54:08Z
- Server last-modified value: `Tue, 05 May 2026 17:23:20 GMT`
- SHA-256: `cfe59ecc68f1286ca4170223da7ce3097bb547f6daed9c7e6f94965494824188`
- Reviewed surface: `POST /v1/chat/completions`, streaming chat chunks, message content parts, function and custom tools, tool choice, streamed usage, finish reasons, reasoning effort, output limits, prompt-cache fields, and sampling fields.

### Behavioral reference

- Repository: `https://github.com/earendil-works/pi`
- Commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed files: `packages/ai/src/api/openai-completions.ts` and focused OpenAI Completions tests under `packages/ai/test/`.

Pi was used to identify compatibility cases and expected behavior. The Axl codec is an independent implementation around Axl's prepared request and canonical stream contracts.

## Implemented request behavior

- System and developer instructions selected from model compatibility.
- Text and verified image inputs using prepared content-addressed blobs.
- Canonical and provider-visible tool identity separation.
- Function tools, strict JSON schemas, grammar custom tools, historical calls, and tool results.
- Same-model reasoning replay through validated reasoning fields or structured `reasoning_details` payloads.
- Prepared reasoning effort and token-budget fields for declared Chat compatibility formats.
- Prepared output limits, tool choice, standard sampling, allowlisted custom sampling, prompt-cache keys, retention, content markers, and safe session-affinity headers.
- Explicit rejection of unprepared requests, request metadata, continuation identifiers, malformed replay signatures, collisions with reserved sampling fields, and controls without a declared wire representation.

## Implemented response behavior

- Text and visible reasoning deltas with stable interleaved content positions.
- Function and grammar tool-call progress, complete canonical tool calls, and provider-visible name reversal.
- Streamed usage, cache usage, reasoning usage, cost, response identifiers, routed model identifiers, native stop reasons, and latency.
- Stop, length, tool-use, provider-error, malformed-stream, truncation, and cancellation outcomes.
- Exactly one terminal event through `normalizeModelStream`, including partial-content attribution after failures or cancellation.
- Unknown top-level chunks remain forward-compatible noise, but they never imply successful completion.

## Explicit limitation

The canonical stream now has a provider-neutral `replay_metadata` event for opaque response-side signatures and continuation identifiers. The Chat decoder still rejects `reasoning_details` instead of silently discarding them. Emitting the new event from Chat remains a separate follow-up. Request-side replay of already retained same-model signatures is implemented.
