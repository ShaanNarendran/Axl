<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenAI Responses codec support record

## Scope

This record covers the pure `openai-responses` request encoder and streaming response decoder in `packages/ai/src/openai-responses.ts`. Provider registration, endpoint selection, authentication, timeout enforcement, bounded request retries, and Codex-specific policy remain separate work. Azure-specific composition is recorded in [`azure-openai-responses.md`](azure-openai-responses.md).

The encoder accepts only `PreparedModelRequest`. It consumes verified in-memory blobs, prepared tool identities and constraints, resolved reasoning policy, validated sampling, cache settings, and provenance-filtered replay metadata. It does not load media or accept credentials.

## Reviewed sources

### Normative OpenAI source

- Source: OpenAI API schema, `https://platform.openai.com/docs/static/api-definition.yaml`
- Retrieved: 2026-09-05T15:54:08Z
- Server last-modified value: `Tue, 05 May 2026 17:23:20 GMT`
- SHA-256: `cfe59ecc68f1286ca4170223da7ce3097bb547f6daed9c7e6f94965494824188`
- Reviewed surface: `POST /v1/responses`, input and output items, streaming events, reasoning, function and custom tools, usage, prompt caching, output limits, tool choice, and sampling.

### Behavioral reference

- Repository: `https://github.com/earendil-works/pi`
- Commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed files: `packages/ai/src/api/openai-responses.ts`, `packages/ai/src/api/openai-responses-shared.ts`, and focused Responses tests under `packages/ai/test/`.

Pi was used to identify compatibility and replay cases. The Axl codec is an independent implementation around Axl's prepared request and canonical stream contracts.

## Implemented request behavior

- User text and verified image input from the prepared blob snapshot.
- Assistant text item replay with retained message item identifiers.
- Same-model opaque reasoning-item replay.
- Function and grammar custom tools, historical calls, tool outputs, provider-visible names, strict schemas, item identifiers, and namespaces.
- Prepared reasoning effort, encrypted reasoning inclusion, output-token limits, tool choice, sampling, prompt-cache keys, long retention, and safe session-affinity headers.
- Deterministic fallback message item identifiers when retained identifiers are unavailable.
- Explicit rejection of unprepared input, unsupported metadata, invalid reasoning signatures, unavailable prepared blobs, malformed grammar inputs, and custom sampling collisions.

## Implemented response behavior

- Interleaved text, refusal, reasoning summary, reasoning text, function calls, and custom tool calls with stable content positions.
- Validated `replay_metadata` for completed reasoning items, text message item identifiers, tool item identifiers, namespaces, and response identifiers.
- Usage, prompt-cache usage, reasoning usage, cost, requested and routed model identity, native stop reasons, and optional latency.
- Stop, length, tool-use, provider-error, malformed-stream, cancellation, content-filter, and truncation outcomes.
- Exactly one terminal event after normalization, with partial-content attribution after failures, cancellation, or early stream termination.
- Unknown top-level events remain forward-compatible noise and never imply successful completion.

## Replay retention boundary

Session model-port adapters retain emitted replay metadata in memory and attach it to the matching assistant content and tool calls before the next prepared dispatch. Retention remains scoped to the live port instance and exact provider, dialect, and model identity. Persisted JSONL events and daemon wire versions remain unchanged, so replay metadata is intentionally unavailable after process restart or history reconstruction.

## Deferred work

Full OpenAI provider registration, authentication, endpoint policy, timeout enforcement, bounded retries, Codex Responses behavior, and product integration are deferred to their planned slices.
