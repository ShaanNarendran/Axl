<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Anthropic Messages codec support record

## Scope

This record covers the pure `anthropic-messages` request encoder and streaming response decoder in `packages/ai/src/anthropic-messages.ts`. The codec accepts only `PreparedModelRequest` and contains no authentication acquisition, provider registration, network transport, timeout enforcement, retry loop, runtime selection, or product integration.

## Reviewed behavioral revision

- Behavioral reference repository: `https://github.com/earendil-works/pi`
- Reviewed commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed implementation: `packages/ai/src/api/anthropic-messages.ts` and `packages/ai/src/api/anthropic-messages.lazy.ts`
- Reviewed shared behavior: message transformation, constrained sampling, output and thinking limits, deferred tools, streaming JSON parsing, and usage costing
- Reviewed focused fixtures: every Anthropic-focused test under `packages/ai/test/`, including compatible-provider, OAuth, cache-retention, adaptive-thinking, strict-tool, SSE, and signed-thinking cases

Pi was used to identify Anthropic request and event behavior. Axl's codec is an independent implementation around Axl's prepared request and canonical stream contracts.

## Implemented request behavior

- User text and verified JPEG, PNG, GIF, and WebP image input from the prepared blob snapshot.
- Assistant text, provenance-bound signed thinking, opaque redacted thinking, function calls, and grouped tool results.
- Prepared function tools, provider-visible names, strict JSON schemas, output limits, tool choice, and supported temperature, top-p, top-k, and allowlisted custom sampling controls.
- Explicit adaptive-thinking policy for the generated Claude Fable 5, Claude Opus 4.8, Claude Opus 5, and Claude Sonnet 5 families. Other reasoning models use prepared token budgets that reserve answer capacity.
- Short and one-hour prompt-cache controls at prepared system, tool, and final conversation breakpoints.
- Optional safe `metadata.user_id` and explicit rejection of unsupported metadata.
- Explicit rejection of unprepared requests, unsupported media, continuation metadata, tool signatures, grammar tools, unavailable prepared blobs, unsupported cache policy, and request-control conflicts.

## Implemented stream behavior

- Interleaved text, thinking, redacted thinking, and function-tool blocks with stable canonical content positions.
- Signed and redacted thinking replay metadata bound to the exact provider, `anthropic-messages` dialect, and requested model.
- Streamed tool argument progress followed by one complete canonical tool call.
- Input, output, prompt-cache read, prompt-cache write, reasoning usage, request-wide tiered cost, and Anthropic one-hour cache-write pricing.
- Response ID, requested and routed model identity, native stop reason, and optional latency.
- End-turn, stop-sequence, pause-turn, output-limit, tool-use, refusal, sensitive-content, provider-error, cancellation, malformed-input, partial-output, and truncated-stream outcomes.
- Unknown top-level events remain forward-compatible noise and never imply successful completion. Shared normalization guarantees exactly one terminal event.
- Known secret values are redacted from provider error events. The codec has no credential input and cannot place credentials in bodies, events, diagnostics, catalogs, generated artifacts, or fixtures.

## Signed-thinking replay boundary

A normal thinking block returns its opaque signature in `replay_metadata`. A redacted thinking block returns the same provenance-bound signature plus `redacted: true`. Session ports retain both fields in memory and reconstruct either `thinking` or `redacted_thinking` only for the exact issuing provider, dialect, and model. Request preparation removes foreign signatures and rejects foreign redacted content because it cannot be replayed safely.

Replay metadata remains in-process only. Persisted JSONL events and daemon wire versions remain unchanged, so restart and history reconstruction intentionally do not restore signed thinking.

## Deterministic verification

Local fixtures cover request composition, verified images, signed and redacted replay, adaptive and budget-based thinking, strict tools, tool calls and results, short and long cache policy, sampling, output limits, usage and cache cost, routed identity, native stop reasons, provider errors, cancellation, malformed input, partial output, truncation, unknown events, and exact terminal behavior. No live provider request is part of this slice.

## Registration status and deferred work

Built in API-key registration, native HTTP transport, timeout enforcement, bounded retries, and compatible-provider dispatch were completed in `118fd89`. Step 10 added subscription browser OAuth, refresh, bearer authentication, and required OAuth beta headers. Runtime selection, daemon and SDK changes, CLI and TUI integration remain in their planned slices.
