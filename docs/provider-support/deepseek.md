<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DeepSeek provider support record

## Scope

This record covers the built in `deepseek` provider in `packages/ai/src/deepseek.ts` and the reusable OpenAI Chat transport in `packages/ai/src/openai-chat-provider.ts`. The provider uses the existing generated DeepSeek catalog and completed `openai-chat` codec through the public `ModelProvider` contract.

This slice includes static registration, stored and environment API key resolution, provider owned API key entry, fixed endpoint enforcement, HTTP streaming, timeout, bounded retries, retry guidance, cancellation, redaction, and deterministic tests. It does not include product integration or live provider calls.

## Reviewed sources

### Catalog source

- Source: models.dev, `https://models.dev/api.json`
- Source revision: `5c600a037417cf778ee6eb3ea2ce0f17abc12130`
- Retrieved: 2026-09-05T13:49:08Z
- SHA-256: `0b09a4d8dedab6a804ca15046729bb2ec03c5f5b689b89a983ea488bb71eaeef`
- DeepSeek documentation recorded by the source: `https://api-docs.deepseek.com/quick_start/pricing`
- Reviewed surface: provider identity, model identity, fixed endpoint, context and output limits, capabilities, pricing, cache behavior, availability, reasoning levels, and OpenAI Chat compatibility.

The checked in generated catalog remains the runtime source. Provider construction and model listing perform no network or credential access.

### Behavioral reference

- Repository: `https://github.com/earendil-works/pi`
- Commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed files: `packages/ai/src/providers/deepseek.ts`, `packages/ai/src/providers/deepseek.models.ts`, `packages/ai/src/providers/all.ts`, `packages/ai/src/api/openai-completions.lazy.ts`, `packages/ai/src/api/openai-completions.ts`, `packages/ai/src/auth/helpers.ts`, and focused provider and OpenAI Completions tests under `packages/ai/test/`.

Pi was used to identify provider boundaries, lazy API composition, static catalog behavior, API key precedence, endpoint policy, and expected transport behavior. Axl's implementation is independent and uses Axl's prepared request, authentication, catalog, and canonical stream contracts.

## Registration and authentication

- Provider identity: `deepseek`
- Display name: `DeepSeek`
- API dialect: `openai-chat`
- Catalog: checked in static models from `getStaticModelCatalog("deepseek")`
- Endpoint: `https://api.deepseek.com/chat/completions`
- Stored authentication: provider scoped API key in `CredentialStore`
- Ambient authentication: `DEEPSEEK_API_KEY`
- Resolution order: stored credential first, then the environment
- Interactive authentication: UI neutral secret prompt persisted through the existing authentication lifecycle
- Discovery: none

A stored credential owns the provider. Invalid stored authentication does not fall through to the environment. Authentication values are registered as secrets for diagnostic redaction and are used only in the bearer authorization header.

## Transport behavior

The reusable OpenAI Chat provider transport prepares direct requests when necessary, then passes only `PreparedModelRequest` to the completed codec. DeepSeek endpoint policy verifies the generated fixed HTTPS endpoint before dispatch. Successful calls send JSON to the Chat Completions path and decode the SSE body into the canonical stream.

The transport applies a finite request timeout, caps retries at ten, and defaults to two retries. It retries only known connection failures and HTTP 429, 500, 502, 503, and 504 responses before stream consumption. Retry delays honor `Retry-After` when present and remain bounded by the request delay limit. Once stream decoding begins, failures are never redispatched.

Cancellation produces the canonical aborted terminal when initiated by the caller. Timeout, HTTP, network, malformed stream, and authentication failures produce typed terminal errors. Known credential values are redacted from diagnostic messages.

## Deterministic verification

Local fixtures cover side effect free construction and listing, static catalog ownership, stored credential precedence, provider owned API key entry, registry dispatch, endpoint and authorization composition, prepared request encoding, SSE decoding, routed response metadata, bounded HTTP retries, retry guidance, cancellation, timeout, and secret redaction.

No live DeepSeek request was performed. This registration adds no protocol event, persisted format, daemon wire, kernel, runtime, SDK, CLI, or TUI change.

## Completion status

All built-in provider registration, daemon-owned text-model selection, SDK, CLI, TUI, and deterministic verification work is complete. The remaining limitations and opt-in live smoke process are recorded in [`provider-reference.md`](provider-reference.md).
