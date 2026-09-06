<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Gateway messages codec support record

## Scope

This record covers the transport-neutral `gateway-messages` request encoder and streaming event decoder in `packages/ai`. The codec accepts only `PreparedModelRequest`. It does not register Radius or another provider, discover or persist a model catalog, acquire credentials, compose authorization headers, perform HTTP transport, enforce retries or timeouts, or integrate provider selection into the runtime, daemon, SDK, CLI, or TUI.

## Reviewed behavioral revision

- Behavioral reference repository: `https://github.com/earendil-works/pi`
- Reviewed commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed implementation: the complete `pi-messages` implementation and lazy entry point, Radius provider metadata, API-key and OAuth boundaries, dynamic catalog configuration and refresh behavior, and every focused Gateway codec, authentication, provider, and catalog test

Pi was used to identify the gateway context envelope, stream event sequence, image representation, replay fields, tool progress, usage and cost reporting, cancellation, and dynamic model behavior. Axl implements that behavior independently around Axl's prepared request and canonical stream contracts. No production dependency was added.

## Request conversion

The encoder produces the gateway's model, context, and options envelope from prepared data. It covers system and conversation history, verified images, assistant text and thinking replay, paired tool calls and results, function tools, declared strict JSON schemas, reasoning levels, output limits, tool choice, prompt-cache retention and session identity, and provider-safe request metadata.

Assistant replay metadata remains bound to the exact gateway provider, dialect, and requested model during preparation. Supported text and thinking signatures, response identifiers, tool signatures, and tool namespaces are rendered into the gateway protocol. Assistant images, grammar constraints, sampling controls, safety controls, and continuation fields that the gateway protocol cannot represent fail explicitly. Required strict schemas are accepted only when model compatibility declares gateway strict-tool support.

The body contains no authorization material. Deterministic history timestamps are protocol placeholders rather than wall-clock observations.

## Dynamic routing and usage

The requested model remains the catalog-selected gateway model, including dynamic selectors such as `auto`. Terminal events may identify the concrete routed model separately. The canonical response therefore records the gateway provider identity, requested model identity, routed model identity, response ID, native stop reason, and measured latency without exposing routing headers or arbitrary provider objects.

Usage and cost are accepted from the gateway's terminal event. The codec does not recompute cost from the requested gateway model because a dynamic route may use different upstream pricing. Token counts and every cost field are validated as finite non-negative values before crossing the trust boundary.

## Stream conversion

The decoder consumes already framed SSE data. It handles positioned text and thinking, authoritative end content, fragmented function calls, text, thinking, and tool replay signatures, gateway usage and cost, requested and routed identity, native stop reasons, cancellation, provider failures, malformed frames, safe partial failures, and truncation.

Gateway `stop`, `length`, `toolUse`, and `tool_use` reasons map to canonical completion reasons. Native stop detail is retained separately when supplied. Gateway error messages are redacted against known secret values. Unsupported events, invalid usage, mismatched request identity, incomplete tools, and malformed content fail closed. Every normal, failed, cancelled, malformed, or truncated stream produces exactly one terminal event when used through `normalizeModelStream`.

## Authentication, discovery, and transport boundary

The pure codec emits no headers and does not resolve `RADIUS_API_KEY`, OAuth credentials, gateway URLs, or dynamic catalogs. The registered Radius provider owns stored and environment credential resolution, OAuth, endpoint policy, `/v1/config` discovery, last-known-good catalog persistence, `/messages` transport, SSE byte framing, cancellation propagation, timeout enforcement, bounded retries, response headers, and retry guidance.

## Deterministic verification

Local fixtures cover prepared context and option conversion, verified images, same-gateway replay, strict tools, reasoning, caching, safe routing metadata, positioned text and thinking, fragmented tools, replay signatures, usage and cost, requested and routed identity, native stop reasons, redacted failures, cancellation, malformed input, unsupported history, and exact terminal normalization. No live provider request was performed.

## Completion status

Radius API-key and OAuth authentication, explicit persisted discovery, HTTP and SSE transport, daemon-owned text-model selection, SDK, CLI, TUI, and deterministic verification are complete. Live provider smoke testing remains explicit and opt in as documented in [`provider-reference.md`](provider-reference.md).
