<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Amazon Bedrock Converse Stream codec support record

## Scope

This record covers the `bedrock-converse-stream` request encoder, endpoint and authentication policy, AWS signing inputs, and streaming event decoder in `packages/ai`. The codec accepts only `PreparedModelRequest`. It does not acquire AWS credentials, calculate SigV4 signatures, perform network transport, register a provider, enforce transport retries or timeouts, or integrate provider selection into the product.

## Reviewed behavioral revision

- Behavioral reference repository: `https://github.com/earendil-works/pi`
- Reviewed commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed implementation: the complete Bedrock Converse Stream implementation, lazy entry point, provider definition, generated model entry point, AWS credential and signing boundary, and focused Bedrock tests
- Reviewed pinned AWS SDK dependency: `@aws-sdk/client-bedrock-runtime` 3.1048.0

Pi was used to identify Bedrock request, endpoint, authentication-boundary, reasoning, and event behavior. Axl implements that behavior independently around Axl's prepared request and canonical stream contracts and adds no AWS SDK dependency in this slice.

Current AWS SDK documentation was also reviewed for the `ConverseStream` command boundary. The pure codec emits the request body and the non-secret service and region inputs needed by a later SigV4 transport.

## Request conversion

The encoder covers verified image bytes, grouped tool results, sanitized replayed tool input, strict JSON-schema tools, tool choice, system and conversation cache points, fixed-budget and adaptive Claude thinking, output limits, temperature, top-p sampling, provider-safe request metadata, and custom additional model fields.

Empty user and tool-result content receives a non-empty placeholder because Bedrock rejects empty content arrays. Assistant images and unsupported continuation or tool replay metadata fail explicitly. Signed thinking is replayed only after shared request preparation has verified exact provider, dialect, and model provenance. Opaque redacted reasoning is replayed through `reasoningContent.redactedContent`.

Generated Bedrock catalog compatibility now marks native strict-tool support, Claude prompt-cache markers, Claude thinking signatures, and adaptive-thinking models explicitly.

## Endpoint and authentication boundary

- Standard endpoints use `https://bedrock-runtime.{region}.amazonaws.com`.
- Inference-profile ARNs override a configured region for routing and signing.
- Model identifiers are encoded into the `/model/{modelId}/converse-stream` path.
- Custom HTTP or HTTPS base URLs preserve existing paths and query settings while rejecting embedded credentials and fragments.
- SigV4 mode returns the `bedrock` signing service and resolved region without acquiring or exposing credentials.
- Bearer mode emits only the validated authorization header and does not request signing.

Concrete AWS profile, environment, container, web-identity, and instance-role credential discovery, credential refresh, and SigV4 calculation remain step 10 work.

## Stream conversion

The decoder handles interleaved text, signed thinking, encrypted redacted reasoning, function-tool progress and completion, usage, cache usage, cost, native stop reasons, response identity supplied by transport, latency, cancellation, modeled stream failures, malformed events, and streams that omit individual block-stop events. Every completed reasoning signature is emitted as provenance-bound in-process replay metadata.

Throttling and service-unavailable events carry bounded retry classification. Validation, policy, and interrupted-stream failures fail closed. Provider messages are redacted against known credential values, and partial output is marked explicitly.

## Deterministic verification

Local fixtures cover generated compatibility metadata, prepared content and image encoding, strict tools, cache points, fixed and adaptive thinking, request metadata, SigV4 inputs, bearer headers, regional and ARN routing, custom endpoints, interleaved stream events, signed and redacted reasoning, tool arguments, usage and cost, routed identity, native stops, provider failures, cancellation, malformed input, and exact terminal normalization. No live provider request was performed.

## Registration status and deferred work

Built in registration, bearer-token transport, checked HTTP event-stream framing, timeout enforcement, and bounded transport retries were completed in `118fd89`. AWS credential-chain acquisition and refresh, SigV4 implementation, runtime selection, daemon and SDK changes, CLI and TUI integration, and live provider smoke tests remain in their planned slices.
