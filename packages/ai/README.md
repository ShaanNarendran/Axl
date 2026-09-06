<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/ai`

This package owns provider-specific model behavior outside the kernel. It defines provider and model contracts, credential lookup, request preparation, API dialects, deterministic test models, provider transports, and built-in provider registration.

Supported native dialects include OpenAI Chat Completions, OpenAI Responses, Azure OpenAI Responses, OpenAI Codex Responses, Anthropic Messages, Google Generative AI, Google Vertex AI, Bedrock Converse Stream, Mistral Conversations, Gateway messages, and OpenRouter image generation. Models select their dialect through validated catalog metadata. Provider identity does not imply a dialect.

Every dispatch passes through `prepareModelRequest()`. Preparation validates and snapshots history, verifies content-addressed images, renders tools while retaining canonical identities, fits token and reasoning budgets, validates sampling and compatibility controls, and removes foreign replay metadata. Unsupported or unsafe input fails before provider I/O.

Provider transports enforce endpoint and header policy, bounded parsing, finite inactivity timeouts, cancellation, and bounded pre-stream retries. Credentials remain provider-owned and are never included in prompts, catalogs, diagnostics, canonical events, or public SDK projections. Construction and static listing perform no credential lookup, network request, or background work.

Static model metadata is generated offline from reviewed local manifests and overlays. Dynamic providers use explicit, cancellable refreshes and provider-scoped last-known-good snapshots. Invalid, cancelled, corrupt, or superseded refreshes cannot replace a valid generation.

See:

- [`catalog/README.md`](catalog/README.md) for catalog provenance and regeneration.
- [Provider reference](../../docs/provider-support/provider-reference.md) for setup, authentication, endpoints, compatibility, and limitations.
- [Provider implementation notes](../../docs/provider-support/implementation-notes.md) for behavioral provenance and durable design decisions.
- [Deterministic verification](../../docs/provider-support/deterministic-verification.md) for the requirement-to-test map.
