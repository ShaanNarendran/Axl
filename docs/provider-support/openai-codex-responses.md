<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenAI Codex Responses codec support record

## Scope

This record covers the pure `openai-codex-responses` request composition and stream mapping in `packages/ai/src/openai-codex-responses.ts`. It includes subscription request headers, Codex request defaults, prepared reasoning, stateless replay, Codex terminal aliases, and canonical Responses decoding.

Concrete OAuth acquisition and refresh, provider registration, WebSocket connection ownership, timeout enforcement, bounded HTTP retries, runtime selection, and product integration remain deferred to their owning slices.

## Reviewed protocol revision

OpenAI does not publish the ChatGPT Codex subscription backend as a stable public API specification. This implementation therefore pins the reviewed behavioral revision rather than claiming compatibility with an undocumented moving target.

- Behavioral reference repository: `https://github.com/earendil-works/pi`
- Reviewed commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed implementation: `packages/ai/src/api/openai-codex-responses.ts` and `packages/ai/src/api/openai-codex-responses.lazy.ts`
- Reviewed shared behavior: `packages/ai/src/api/openai-responses-shared.ts` and `packages/ai/src/api/openai-prompt-cache.ts`
- Reviewed focused fixtures: every Codex file under `packages/ai/test/`, including stream, cache-affinity, OAuth, and cached-WebSocket probe coverage

Pi was used to identify Codex subscription request and event behavior. Axl's codec is an independent implementation around Axl's prepared request, resolved-auth, and canonical stream contracts.

## Implemented request behavior

- Only immutable `PreparedModelRequest` values are accepted.
- The endpoint resolves to `/codex/responses` while retaining explicit proxy paths and query settings.
- A resolved subscription token supplies bearer authorization and the required `chatgpt-account-id` JWT claim.
- Required Codex metadata includes `originator`, `user-agent`, `OpenAI-Beta`, event-stream acceptance, and JSON content type.
- Prompt-cache sessions set clamped `session-id` and `x-client-request-id` headers in addition to the shared `prompt_cache_key` body field.
- Codex defaults are explicit: `store: false`, streaming, low text verbosity, automatic tool choice, parallel tool calls, encrypted reasoning inclusion, and a fallback instruction when no system instruction exists.
- Prepared reasoning levels and model-specific mappings remain authoritative. Unconstrained function tools use Codex's explicit `strict: null` policy, while prepared strict tools remain strict.
- Verified images, grammar tools, output limits, sampling, and cache controls reuse the shared Responses encoder only where wire behavior is identical.
- Required headers cannot be overridden by model or resolved custom headers. Missing or malformed subscription identity fails before transport work.

## Continuation and replay policy

The SSE request is stateless and always sends the complete prepared history with `store: false`. It does not send `previous_response_id`, because the reviewed Codex continuation is connection-scoped and valid only when a transport proves the same live WebSocket, account, request baseline, and response prefix. Guessing that state from history would create a silent and unsafe fallback.

Completed reasoning, message, and tool items still emit shared `replay_metadata`. Session ports bind this data to the exact `openai-codex` provider, `openai-codex-responses` dialect, and model before the next preparation pass. Same-model reasoning and item identifiers are replayed in the full request. Foreign metadata is removed by request preparation. A later transport slice may use response IDs for connection-scoped deltas after it owns and validates the required state.

## Implemented stream behavior

- Standard Responses text, reasoning, function tools, grammar tools, usage, cost, routed model identity, and replay metadata use the shared decoder.
- Codex `response.done` maps to the matching completed, incomplete, failed, or cancelled canonical path.
- Codex rate-limit metadata and other unknown nonterminal events remain forward-compatible noise and cannot imply success.
- Unsupported terminal statuses, malformed frames, orphaned deltas, and invalid tool arguments fail loudly.
- Provider errors and cancellation retain partial-content facts. Shared normalization guarantees exactly one terminal event and turns an early stream end into an error.
- Known secret values are redacted from provider error events. Tokens remain confined to composed request headers and never enter request bodies, canonical events, diagnostics, catalogs, or checked-in fixture values.

## Deterministic verification

Local fixtures cover prepared request bodies, subscription headers, endpoint paths, cache identifiers, reasoning mapping, strict policy, stateless continuation replay, usage and cost, routed identity, provider errors, redaction, cancellation, malformed terminals, malformed frames, unknown events, partial output, truncation, and exact terminal behavior. No live provider request is part of this slice.
