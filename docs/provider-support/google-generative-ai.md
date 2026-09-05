<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Google Generative AI codec support record

## Scope

This record covers the pure `google-generative-ai` request encoder and streaming response decoder in `packages/ai/src/google-generative-ai.ts`. The codec accepts only `PreparedModelRequest` and contains no authentication acquisition, provider registration, network transport, timeout enforcement, retry loop, runtime selection, Google Vertex policy, or product integration.

## Reviewed behavioral revision

- Behavioral reference repository: `https://github.com/earendil-works/pi`
- Reviewed commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed implementation: `packages/ai/src/api/google-generative-ai.ts`, its lazy entry point, and `packages/ai/src/api/google-shared.ts`
- Reviewed shared behavior: message transformation, constrained sampling, output and thinking limits, provider errors, retry policy, event streaming, and usage costing
- Reviewed provider metadata: the Google provider definition and generated model catalog entry point
- Reviewed focused fixtures: every Google-focused test under `packages/ai/test/`, including shared conversion, tool schema, thinking, signature, stop reason, retry, image result, and Vertex boundary cases

Pi was used to identify Google request and event behavior. Axl's codec is an independent implementation around Axl's prepared request and canonical stream contracts.

## Implemented request behavior

- User text and verified JPEG, PNG, GIF, and WebP image input from the prepared blob snapshot.
- Assistant text, visible thinking, function calls, and provenance-bound thought-signature replay for text, thinking, and tool-call parts.
- Function responses with success or error payloads, grouped adjacent results, Gemini 3 nested image results, and separate image turns for earlier Gemini models.
- Prepared function declarations, provider-visible names, strict JSON schemas for catalog-marked Gemini 3 models, validated tool mode, and explicit rejection of grammar tools.
- Token-budget thinking for Gemini 2 models, level-based thinking for Gemini 3 and Gemma 4 models, and explicit hidden minimum levels where current models cannot fully disable thinking.
- Output limits, automatic, required, and disabled tool choice, plus supported temperature, top-p, top-k, seed, and allowlisted custom generation fields.
- Provider-neutral safety settings with validated Google harm categories and thresholds.
- Google implicit short-lived prompt caching, optional explicit `cachedContents` resource replay, and explicit rejection of long retention.
- Explicit rejection of unprepared requests, unsupported media, malformed Google signatures, unsupported metadata, foreign or incompatible continuation state, invalid cached-content names, and request-control collisions.

## Implemented stream behavior

- Interleaved text, thinking, and function calls with stable canonical content positions and deterministic generated call identifiers.
- Thought-signature replay metadata bound to the exact provider, `google-generative-ai` dialect, requested model, content position, and tool-call identifier where applicable.
- Complete tool-call progress and canonical tool-call events with provider-visible names reversed to canonical names.
- Prompt, candidate, cached-content, and thinking token usage with request-wide tiered cost.
- Response ID, requested and routed model identity, native finish reason, and optional latency.
- Stop, tool-use, output-limit, prompt-safety, candidate-safety, provider-error, cancellation, malformed-input, partial-output, and truncated-stream outcomes.
- Unknown top-level events remain forward-compatible noise and never imply successful completion. Shared normalization guarantees exactly one terminal event.
- Known secret values are redacted from provider error events. The codec has no credential input and cannot place credentials in bodies, events, diagnostics, catalogs, generated artifacts, or fixtures.

## Thought-signature replay boundary

Google may attach a `thoughtSignature` to a visible text part, a thinking part, or a function-call part. The signature does not identify thinking by itself. Only `thought: true` marks visible thinking. The decoder emits the opaque signature as `replay_metadata` for the exact canonical block. Session ports retain the signature in memory and reconstruct the matching Google part only for the exact issuing provider, dialect, and model.

Signature-only metadata does not create continuation state. Google signatures must be valid base64. Empty visible text or thinking remains replayable when it carries a valid signature. Foreign signatures are removed during preparation and recorded as sanitizations.

Replay metadata remains in process only. Persisted JSONL events and daemon wire versions remain unchanged, so restart and history reconstruction intentionally do not restore Google thought signatures.

## Deterministic verification

Local fixtures cover request composition, verified user and tool-result images, text and thinking replay, function tools, strict schemas, tool calls and results, safety settings and failures, implicit and explicit cache behavior, thinking modes, sampling, output limits, usage and cached usage, cost, routed identity, native stop reasons, provider errors, cancellation, malformed input, partial output, truncation, unknown events, and exact terminal behavior. No live provider request is part of this slice.

## Deferred work

Concrete API-key acquisition, provider registration, HTTP transport, timeout enforcement, bounded retries, runtime selection, Google Vertex endpoint and authentication policy, daemon and SDK changes, CLI and TUI integration, and live provider smoke tests remain in their planned slices.
