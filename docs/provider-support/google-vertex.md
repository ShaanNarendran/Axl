<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Google Vertex AI codec support record

## Scope

This record covers the `google-vertex` request encoder, endpoint composition, request authentication policy, and streaming response decoder in `packages/ai`. The codec accepts only `PreparedModelRequest`. It does not acquire cloud credentials, perform network transport, register a provider, enforce transport retries or timeouts, or integrate provider selection into the product.

## Reviewed behavioral revision

- Behavioral reference repository: `https://github.com/earendil-works/pi`
- Reviewed commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed implementation: the complete Google Vertex implementation, lazy entry point, provider definition, generated model entry point, and shared Google conversion helpers
- Reviewed focused fixture: `packages/ai/test/google-vertex-api-key-resolution.test.ts`
- Reviewed pinned Google Gen AI SDK dependency: `@google/genai` 1.52.0

Pi was used to identify Vertex request, endpoint, and authentication behavior. Axl implements that behavior independently around Axl's prepared request and canonical stream contracts.

Current Google documentation and the Google Gen AI JavaScript SDK documentation were also reviewed for Vertex project and location configuration, Express Mode API keys, regional endpoints, model resource normalization, Application Default Credentials, service-account files, the Cloud Platform OAuth scope, and the `x-goog-api-key` header.

## Shared Google conversion

Google Generative AI and Google Vertex AI use one internal codec for prepared content and streamed response events. Public entry points still enforce their exact dialect. A Generative AI entry point rejects a Vertex model, and a Vertex entry point rejects a Generative AI model. Replay metadata remains bound to the exact provider, dialect, and model.

The shared conversion covers verified images, thought signatures, visible thinking, tools and strict schemas, grouped tool results, safety settings, prompt caching, output controls, sampling, usage, cost, routed identity, provider failures, cancellation, partial output, and exact terminal normalization. Vertex permits full project-scoped cached-content resource names in addition to the short Google resource shape.

## Vertex endpoint policy

- API-key credentials select Vertex Express Mode at `aiplatform.googleapis.com` and use the `x-goog-api-key` header.
- ADC and service-account access tokens require explicit project and location settings.
- The `global` location uses `aiplatform.googleapis.com`.
- The `us` and `eu` multi-regions use their `aiplatform.{location}.rep.googleapis.com` hosts.
- Other locations use `{location}-aiplatform.googleapis.com`.
- The default API version is `v1`. A validated explicit version may override it.
- Bare Gemini model IDs map to the Google publisher. Publisher and model shorthand maps to the corresponding Vertex publisher resource.
- Custom base URLs are explicit collection endpoints. Existing API-version path segments and query settings are preserved.
- URLs reject embedded credentials, fragments, path traversal, malformed resource segments, and unsupported model resource shapes.

## Authentication boundary

The codec represents three explicit credential policies: API key, ADC access token, and service-account access token. API keys and access tokens are added only to transport headers. Service-account credential file paths are validated as acquisition inputs and never enter the URL, request body, output events, catalog, or diagnostics. Placeholder API keys fail explicitly rather than silently selecting another authentication path.

Step 10 added ADC discovery, service-account file validation, access-token acquisition, SDK-managed refresh, explicit interactive method selection, and provider-owned precedence. The required OAuth scope is `https://www.googleapis.com/auth/cloud-platform`.

## Deterministic verification

Local fixtures cover generated Vertex compatibility metadata, strict Gemini 3 tools, shared request conversion, dialect isolation, Express Mode API-key headers, regional ADC routing, service-account routing, global and multi-region hosts, custom collection endpoints, API versions, publisher model paths, malformed configuration, secret isolation, replay provenance, usage, routed identity, and exact terminal behavior. No live provider request was performed.

## Completion status

Built-in Express Mode API-key registration, HTTP transport, timeout enforcement, bounded retries, service-account and ADC handling, daemon-owned text-model selection, SDK, CLI, TUI, and deterministic verification are complete. Live provider smoke testing remains explicit and opt in as documented in [`provider-reference.md`](provider-reference.md).
