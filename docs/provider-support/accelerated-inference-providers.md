<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Accelerated inference provider support record

## Scope

This record covers the built in Groq, Cerebras, and NVIDIA NIM provider registrations in `packages/ai`. Each provider uses the checked in static catalog, the completed `openai-chat` codec, the shared `OpenAiChatProvider` transport, and provider owned API key authentication.

The shared `createStaticOpenAiChatProvider` factory validates provider identity, catalog ownership, API dialect, and the exact fixed HTTPS endpoint before constructing a provider. Construction and listing perform no credential lookup, network request, discovery, or background work.

## Reviewed sources

### Catalog source

- Source: models.dev, `https://models.dev/api.json`
- Source revision: `5c600a037417cf778ee6eb3ea2ce0f17abc12130`
- Retrieved: 2026-09-05T13:49:08Z
- SHA-256: `0b09a4d8dedab6a804ca15046729bb2ec03c5f5b689b89a983ea488bb71eaeef`
- Reviewed surface: provider and model identities, fixed endpoints, capabilities, context and output limits, pricing, cache behavior, availability, reasoning controls, sampling policy, and OpenAI Chat compatibility.

The checked in generated catalog remains the runtime metadata source. No Pi model data was copied into Axl.

### Behavioral reference

- Repository: `https://github.com/earendil-works/pi`
- Commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed provider definitions: `packages/ai/src/providers/groq.ts`, `packages/ai/src/providers/cerebras.ts`, and `packages/ai/src/providers/nvidia.ts`
- Reviewed metadata entry points: the corresponding generated provider model modules
- Reviewed shared boundaries: `packages/ai/src/providers/all.ts`, `packages/ai/src/api/openai-completions.lazy.ts`, `packages/ai/src/api/openai-completions.ts`, and `packages/ai/src/auth/helpers.ts`
- Reviewed tests: provider registration and API key helper tests, provider-specific Chat compatibility fixtures, and opt in live stream, cancellation, tool, usage, Unicode, and context-limit coverage for the selected providers

Pi was used to identify provider boundaries, endpoint and environment conventions, static catalog behavior, shared lazy transport composition, and focused compatibility cases. Axl's implementation is independent and uses Axl's provider, authentication, prepared request, catalog, and canonical stream contracts.

## Provider definitions

| Provider | Environment variable | Fixed base URL | Static models at reviewed catalog |
| --- | --- | --- | --- |
| Groq | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` | 7 |
| Cerebras | `CEREBRAS_API_KEY` | `https://api.cerebras.ai/v1` | 2 |
| NVIDIA NIM | `NVIDIA_API_KEY` | `https://integrate.api.nvidia.com/v1` | 64 |

All registered models use `openai-chat`. Requests append `/chat/completions` to the exact reviewed base URL and use bearer authorization. Model-specific compatibility, availability, pricing, and capability behavior comes from the generated catalog rather than provider-name inference.

## Authentication and transport boundaries

Stored API key credentials own each provider. A missing or invalid stored key does not fall through to the environment. When no credential is stored, the provider resolves only its documented environment variable. Interactive key entry uses the existing UI neutral provider authentication lifecycle.

The shared Chat transport supplies prepared request encoding, SSE decoding, finite timeout enforcement, capped prestream retries, bounded retry delays, `Retry-After` guidance, caller cancellation, safe terminal errors, and credential redaction. It never redispatches after stream consumption begins.

## Deterministic verification

Local fixtures cover:

- Side effect free construction and static model listing
- Exact provider identity, display name, catalog ownership, dialect, endpoint, and authentication metadata
- Environment key resolution for all three providers
- Registry dispatch through the prepared OpenAI Chat transport
- Exact request URL, bearer header, body, canonical text event, and response attribution
- Rejection of empty catalogs, foreign model ownership, non-Chat dialects, and mismatched endpoints

No live provider call was performed. This slice adds no protocol event, persisted format, daemon wire, kernel, runtime, SDK, CLI, or TUI change.

## Deferred work

Other static OpenAI Chat providers remain in step 9. Subscription and cloud authentication remain in step 10, and product integration remains in step 11. Opt in live provider smoke tests remain outside routine deterministic verification.
