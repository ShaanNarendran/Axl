<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GitHub issue 10 completion review

## Scope

This record maps the seven acceptance criteria in GitHub issue 10 to implementation and executable evidence. It also records the Step 13 review of the complete feature diff from `origin/main` through `feature/model-provider-support`.

The implementation keeps canonical `{ providerId, modelId }` selection, model-owned API dialect metadata, daemon authority, trusted process-host authentication, side-effect-free provider listing, explicit catalog refresh, and fail-closed compatibility behavior. No live provider call was used for this review.

## Acceptance criteria

### 1. Complete provider identity support

**Result: satisfied at the provider contract and registered runtime boundary.**

- `BUILTIN_PROVIDER_IDS` and `createBuiltinProviders()` register exactly 41 identities: every named provider plus the user-configured endpoint identity.
- Static, regional, dynamic, mixed-dialect, subscription, cloud, and custom endpoint behavior has a reviewed support record under `docs/provider-support/`.
- [`provider-reference.md`](provider-reference.md) provides the consolidated setup, environment, authentication, endpoint, region, catalog, and limitation matrix.
- Generated static entries come from reviewed local manifests and overlays. GitHub Copilot, OpenRouter, Cloudflare AI Gateway, and Radius document dynamic catalogs.
- `builtin-providers.test.ts` proves the exact inventory, endpoint policies, dialect ownership, regional isolation, and side-effect-free registration.
- `static-openai-chat-providers.test.ts`, `deepseek-provider.test.ts`, `remaining-providers.test.ts`, `cloud-auth.test.ts`, and `aws-auth.test.ts` provide provider-family and provider-specific deterministic fixtures.
- The `custom` identity is a fail-loud unconfigured runtime placeholder. `createCustomProvider()` provides configured Chat and Responses fixtures for embedding applications. First-party custom-provider configuration remains a documented product-surface limitation.

### 2. Every required native API through the existing contract

**Result: satisfied.**

- All 11 native dialects use the existing `ModelProvider`, prepared request, canonical message, and canonical stream contracts.
- `packages/kernel` has no provider codec or vendor dependency. Its only feature change records the provider configuration boundary alongside the model boundary.
- The codec suites named in [`deterministic-verification.md`](deterministic-verification.md) cover request conversion, streams, errors, cancellation, partial content, usage, and exact terminal normalization.
- Provider-level deterministic transport fixtures cover every dialect, including Codex Responses, Radius Gateway messages, Bedrock event streams, and OpenRouter image generation.

### 3. Preserve and complete Azure support

**Result: satisfied.**

- The canonical identity is `azure-openai-responses`; legacy `azure-openai` credentials migrate once without replacing an existing canonical credential.
- Azure uses the shared Responses codec with Azure-specific base URL, resource, API version, deployment mapping, API-key, and Microsoft Entra policy.
- `azure-openai.test.ts`, `cloud-auth.test.ts`, and `local-runtime.test.ts` cover endpoint composition, authentication, stream behavior, migration, registration, selection, and resume.
- [`azure-openai-responses.md`](azure-openai-responses.md) records the completed behavior and compatibility boundary.

### 4. Reproducible and safe catalogs

**Result: satisfied.**

- `generate-catalog.ts` consumes only checked-in reviewed manifests and overlays and writes a deterministic generated artifact.
- `catalog.test.ts` verifies complete provider coverage, deterministic generation, provenance, validation, endpoint policy, and regional isolation.
- `CatalogStore` and registry tests verify provider-scoped atomic persistence, last-known-good retention, explicit refresh, cancellation, supersession, corrupt-snapshot isolation, and offline restoration.
- [`../../packages/ai/catalog/README.md`](../../packages/ai/catalog/README.md) documents static and dynamic update processes.
- Catalog claims are tied to the support records and executable matrix, not inferred from provider names.

### 5. Daemon-owned management with typed SDK coverage

**Result: satisfied.**

- The daemon owns provider listing, catalog refresh, authentication status, login, logout, and session selection.
- Protocol version 11 defines validated provider RPCs and capability negotiation. The SDK exposes typed methods and rejects unsupported capabilities before sending requests.
- Interactive prompt exchange remains inside `TrustedProviderLoginAdapter`; RPC carries only provider and method identifiers.
- Runtime, daemon, protocol, SDK, CLI, and TUI tests cover selection, persistence, resume, management operations, cancellation, reconnect behavior, grouped display, usage, cost, and actionable failures.
- [`product-integration.md`](product-integration.md) records the authority and client projection boundaries.

### 6. No disabled background work and safe switching

**Result: satisfied.**

- Construction and listing perform no credential lookup, authentication, network request, catalog refresh, or background work.
- Dynamic refresh is explicit and cancellable. Provider actions are not replayed automatically after reconnect.
- Capability mismatch and unavailable model selection fail before dispatch.
- `request-preparation.test.ts` and `provider-port.test.ts` prove same-model continuation retention, cross-provider sanitization, and rejection of unsafe foreign redacted reasoning.
- `builtin-providers.test.ts`, `catalog.test.ts`, `registry.test.ts`, daemon tests, and SDK tests establish the remaining boundaries.

### 7. Kernel isolation and credential exclusion

**Result: satisfied.**

- Provider implementations, SDK dependencies, authentication, catalog behavior, and vendor wire formats remain in `packages/ai` or the process/runtime adapters that own them.
- The kernel has no new production dependency or vendor-specific branch. Package-boundary verification passes.
- Protocol provider messages contain only safe metadata, provider and model identifiers, status, catalog facts, and actions. They have no credential, OAuth code, token, prompt-answer, or arbitrary-header field.
- Credential-store, authentication, diagnostics, codec, transport, catalog, daemon, and process-host tests cover restrictive persistence, metadata-only listing, redaction, prompt masking, and URL validation.
- A changed-file credential-pattern scan found no credential-like material. Checked-in fixture values are synthetic.

## Complete feature diff review

### Correctness and regressions

Reviewed the provider contract, registry and catalog lifecycle, request preparation, all dialect adapters, provider transports, authentication, runtime assembly, session persistence, protocol validation, daemon dispatch, SDK methods, CLI and TUI projections, generated artifacts, and focused tests. The requirement-to-test map covers the high-risk error, cancellation, retry, race, replay, and malformed-input paths.

No confirmed correctness defect remains from this review. Documentation drift found during the audit was corrected in Step 13a. The known aggregate TUI timing and temporary-directory cleanup flake remains visible and is not attributed to the model-provider feature.

### Security and trust boundaries

The review confirmed:

- Interactive secrets and OAuth answers remain inside the trusted daemon process host.
- First-party authorization launch accepts only HTTPS URLs without embedded credentials.
- Provider RPC schemas cannot carry credentials or arbitrary provider objects.
- Authentication-shaped metadata and custom headers are rejected before dispatch.
- Credentials remain in provider-owned stores, SDK credential objects, signing closures, or request headers and are included in redaction sets.
- Provider listing remains local and side-effect free.
- Stored authentication failure does not fall through to ambient sources.
- Cloud acquisition and signing failures stop before dispatch, with no unsigned fallback.

No confirmed credential disclosure, authorization bypass, or silent fallback remains from this review.

### Architecture

The protocol remains dependency free. The kernel remains provider independent and depends only on protocol plus Node.js built-ins. Provider-specific behavior remains in `packages/ai`; runtime composes it for the daemon; SDK and clients consume typed daemon operations. The only kernel change records the canonical provider boundary and does not select a dialect or inspect credentials.

Package-boundary and type checks pass. No second model abstraction, client-owned agent loop, or client-owned authentication flow was introduced.

### Provenance and dependencies

The generated catalog records the models.dev source URL, retrieval time, upstream SHA-256, repository, and repository revision. Ant Ling metadata records its independently reviewed official sources. The generator and support records distinguish source facts, Axl policy overlays, and the pinned Pi behavioral reference. No Pi source or generated catalog is claimed as copied.

The added production dependencies are official Azure, Google, AWS, and Smithy packages required for cloud credential acquisition and SigV4 signing. Versions are pinned through the lockfile, licenses are recorded, and the final high-severity package audit is a Step 13c gate.

### Scope review

The feature diff is concentrated in `packages/ai`, deterministic tests, generated catalog data, provider-management protocol and runtime integration, and first-party CLI and TUI projections. The protocol and kernel changes are limited to facts needed for canonical provider selection and safe stream metadata. License, notice, formatter exclusion for the generated catalog, and repository guidance changes support the feature's provenance and review process.

First-party image commands and first-party custom-provider configuration were not added. Both are documented limitations rather than hidden partial implementations. No unrelated runtime feature was identified.

## Review result

No confirmed high-severity or medium-severity defect remains. Step 13a resolved documentation completeness and stale-status findings. The remaining work is final repository verification, synthetic merge verification against freshly fetched `origin/main`, DCO history repair, and pull request preparation.
