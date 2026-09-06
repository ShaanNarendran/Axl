<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Model provider product integration support record

## Scope

This record covers Step 11 product integration across the runtime, daemon, protocol, SDK, CLI, and TUI. It replaces Azure-specific product paths with provider-neutral session selection and management for the 41 built-in provider identities.

The product surface is text-model based. Image-model product commands remain outside Step 11.

## Authority and trust boundaries

A session selects one canonical `{ providerId, modelId }` pair. The daemon validates that pair, assembles the matching provider model port, persists `config.provider` and `config.model` boundary events, and restores both values when a session resumes. CLI settings are defaults for new sessions only. They do not replace daemon-owned session state.

API dialect is model metadata. Clients may display it to explain compatibility, but no CLI option, TUI action, SDK method, or daemon RPC accepts a dialect as a substitute for provider and model identity.

Provider listing reads registered metadata and local catalog snapshots only. It does not read credentials, authenticate, refresh a catalog, perform network requests, or start background work. Authentication status is a separate explicit operation. It may inspect configured stored, environment, file, ambient, or keyless sources, but it does not refresh stored OAuth credentials.

Interactive authentication remains inside the trusted daemon process host. Login RPC carries only a provider ID and login method. Provider-authored prompts and their answers, API keys, OAuth codes, access tokens, and refresh tokens are never represented in protocol messages or SDK projections. The process host masks secret and manual-code input, sanitizes provider text, and opens only validated HTTPS authorization URLs without embedded URL credentials. Browser-launch failures are reported visibly while the already printed URL remains available for manual use.

Provider operations are cancellable and are not replayed automatically after reconnect because login, logout, and catalog refresh can have external effects.

## CLI workflows

| Command | Behavior |
| --- | --- |
| `axl providers [provider-id]` | Shows authentication phase, safe source label, supported login methods, catalog type, model count, and catalog errors. Authentication status is checked explicitly after metadata listing. |
| `axl models [provider-id]` | Lists text models grouped by provider, including model ID, API dialect metadata, published token prices, and unavailable reasons. It does not select or authenticate a model. |
| `axl login <provider-id> [api_key\|oauth]` | Starts the provider-owned login method in the trusted daemon process host. A method may be omitted only when the provider exposes exactly one login method. |
| `axl logout <provider-id>` | Removes stored authentication for that provider without affecting other providers. |
| `axl refresh [provider-id]` | Explicitly refreshes one dynamic catalog, or all enabled dynamic catalogs when no provider is supplied. Static catalogs fail with an actionable unsupported error. |

The `provider` and `model` startup options must identify the intended pair together when changing providers. The selected pair becomes daemon-owned session configuration. The TUI persists an accepted pair as the default for later new sessions.

Ctrl+C or an RPC cancellation aborts provider status, login, logout, and refresh operations. A cancelled provider action is not retried silently.

Headless print mode writes the final assistant text to stdout and writes per-turn token usage and USD cost, when available, to stderr. JSON mode continues to emit canonical events, including canonical usage, without presentation-only summaries.

## TUI workflows

- `/model` opens a grouped, favorite-first provider model picker. `/model <provider-id>/<model-id>` selects an exact pair. An unqualified model ID is accepted only when it resolves to the active provider or is unique across providers.
- Unavailable models remain visible with their safe reason. Selecting one fails through daemon validation rather than a client-side compatibility fallback.
- `/providers [provider-id]` shows explicit authentication and catalog status.
- `/login [provider-id]` selects the active provider by default, prompts for a provider when needed, and prompts for a login method when more than one is available. The TUI temporarily yields terminal ownership to the trusted process-host adapter.
- `/logout [provider-id]` removes that provider's stored authentication.
- `/refresh [provider-id]` explicitly refreshes dynamic catalogs. Escape cancels the active provider operation.
- `/favorite` stores provider-qualified model favorites so providers with the same model ID remain distinct.

The editor status displays the last completed turn and cumulative input, output, cache, reasoning, and USD cost values. Provider-reported cost is authoritative. When a turn has usage but no reported cost, the TUI computes presentation cost from the selected provider-qualified catalog price. Headless print mode does not invent a fallback cost.

Provider failures show a safe message plus category, provider and model identity when present, concrete action, and retry guidance. Authentication, entitlement, region, catalog, model, and provider configuration failures remain distinct.

## Compatibility

Legacy `azure-openai` stored credentials migrate once to `azure-openai-responses` when no canonical credential exists. Existing canonical credentials are never overwritten. Persisted session events retain read compatibility while new and rebuilt sessions record provider and model boundaries separately.

The provider RPC additions use negotiated capabilities and wire protocol version 11. Daemons without provider management do not advertise provider capabilities. SDK provider actions fail capability checks before sending a request and are never automatically replayed after transport loss.

## Deterministic verification

Focused tests cover canonical selection and resume, credential migration, all built-in runtime registration, side-effect-free listing, explicit status, refresh, login and logout, capability enforcement, cancellation, reconnect behavior, protocol validation, prompt masking, URL restrictions, grouped CLI output, unavailable models, provider-qualified TUI selection, usage and costs, and actionable errors.

The aggregate repository runner retains its 30-second per-file timeout. Aggregate runs completed every non-TUI test, but the large TUI app file intermittently reported temporary-directory cleanup races and then remained alive until the file timeout. Reducing aggregate file concurrency to four, two, and one did not reliably remove that independent TUI flake, so no ineffective runner change or relaxed timeout was retained. The complete TUI app file passed in isolation with 42 tests in 7.4 seconds, and the focused Step 11 TUI tests pass.

No live provider credential or request is used by the deterministic suites.

## Review result

The complete Step 11 diff was reviewed across runtime assembly, session persistence, protocol validation, daemon dispatch, SDK errors, CLI process-host authentication, TUI selection, usage, and cost presentation. The review confirmed the canonical selection and trusted authentication boundaries. It found one silent browser-launch error path, which was changed to report the failure visibly and covered by a focused regression test.
