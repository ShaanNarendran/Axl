<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Model provider deterministic verification matrix

## Scope

This record maps Step 12 requirements to executable local tests. Tests use injected fetch functions, in-memory stores, temporary directories, and checked-in manifests. They do not contact live providers or use live credentials.

Equivalent existing tests are retained as the requirement evidence. New tests are added only where the audit finds a missing integration boundary.

## Provider registration and dialect fixtures

- All 41 built-in provider identities: `builtin-providers.test.ts`, `registers exactly all 41 planned provider identities`.
- Listing has no credential or network side effects: `builtin-providers.test.ts`, `registers exactly all 41 planned provider identities`; `catalog.test.ts`, `static catalog access performs no network or credential work`.
- Catalog-selected dialect and endpoint policy: `builtin-providers.test.ts`, `preserves catalog selected dialects and exact endpoint policies`.
- OpenAI Chat and Responses transports: `remaining-providers.test.ts`, `dispatches every newly active static provider through its declared dialect endpoint`.
- Azure OpenAI Responses transport: `azure-openai.test.ts`, `streams from Azure with api-key header, versioned URL, and mapped deployment`.
- OpenAI Codex Responses transport: `remaining-providers.test.ts`, `dispatches Codex, Gateway, and image dialects through deterministic transports`.
- Anthropic Messages transport: `remaining-providers.test.ts`, `dispatches every newly active static provider through its declared dialect endpoint`.
- Google Generative AI and Vertex transports: `remaining-providers.test.ts`, `dispatches every newly active static provider through its declared dialect endpoint`.
- Bedrock Converse Stream transport: `aws-auth.test.ts`, `Bedrock signs every dispatch through the AWS default credential chain`.
- Mistral Conversations transport: `remaining-providers.test.ts`, `dispatches every newly active static provider through its declared dialect endpoint`.
- Gateway messages transport: `remaining-providers.test.ts`, `dispatches Codex, Gateway, and image dialects through deterministic transports`.
- OpenRouter image transport: `remaining-providers.test.ts`, `dispatches Codex, Gateway, and image dialects through deterministic transports`.
- Full codec request and stream fixtures: `openai-chat.test.ts`, `openai-responses.test.ts`, `azure-openai.test.ts`, `openai-codex-responses.test.ts`, `anthropic-messages.test.ts`, `google-generative-ai.test.ts`, `google-vertex.test.ts`, `bedrock-converse-stream.test.ts`, `mistral-conversations.test.ts`, `gateway-messages.test.ts`, and `openrouter-images.test.ts`.

## Authentication and catalog lifecycle

- Stored credential precedence: `auth.test.ts`, `a stored api key owns the provider over the environment`.
- Environment, file, ambient, and keyless order: `auth.test.ts`, `ambient authentication uses fixed environment, file, ambient, and keyless precedence`.
- Failed stored credentials never fall through: `auth.test.ts`, `stored credential failure never falls back through ambient precedence`.
- OAuth refresh serialization and failure: `auth.test.ts`, `expiring oauth refreshes exactly once across concurrent resolutions`; `a failed refresh surfaces refresh_failed with no silent fallback`.
- Login, cancellation, supersession, and logout races: `auth.test.ts`, lifecycle tests from `interactive authorization reports UI-neutral lifecycle states` through `logout wins a race with an in-flight refresh`.
- Provider OAuth protocols: `subscription-auth.test.ts`.
- Azure, Vertex, and Bedrock ambient credentials: `cloud-auth.test.ts` and `aws-auth.test.ts`.
- Credential persistence and metadata-only listing: `credentials.test.ts`.
- Generated catalog coverage and reproducibility: `catalog.test.ts`, `generated catalog covers every planned provider identity`; `catalog artifact deterministically matches local manifests and overlays`.
- Catalog validation, provenance, and regional isolation: `catalog.test.ts`.
- Reasoning-map shape, value types, and at least one supported level: `catalog.test.ts`, `reasoning maps require an object with valid values and a supported level`.
- All bundled Azure models across all seven Axl thinking levels: `azure-openai.test.ts`, `every generated Azure model encodes its declared reasoning map`.
- Native models.json rejects malformed reasoning, output limits, and missing or mismatched compatibility records: `models-config.test.ts`.
- Atomic provider-scoped catalog persistence: `catalog-store.test.ts`.
- Offline restoration before network work: `registry.test.ts`, `restores a persisted dynamic catalog before network refresh`.
- Failed and malformed refresh retention: `registry.test.ts`, `failed and malformed refreshes retain the previous valid catalog`.
- Cancelled and superseded refresh races: `registry.test.ts`, `cancelled and superseded refreshes cannot replace the last-known-good catalog`.
- Corrupt provider isolation: `registry.test.ts`, `dynamic refresh isolates corrupt persisted providers from healthy providers`.

## Integration boundaries and redaction

- Mixed-dialect model selection: `registry.test.ts`, `dispatches mixed dialect models through their owning provider`.
- Mixed-dialect built-in transport selection: `remaining-providers.test.ts`, `dispatches every newly active static provider through its declared dialect endpoint`, including OpenAI, OpenCode, and OpenCode Go.
- Keyless configured Chat endpoint and validated custom headers: `remaining-providers.test.ts`, `dispatches a keyless configured endpoint with only validated custom headers`.
- API-key configured Responses endpoint: `remaining-providers.test.ts`, `dispatches a configured Responses endpoint with explicit API key authentication`.
- Shared diagnostics and authentication redaction: `model-contract.test.ts`, `provider diagnostics redact known secrets and remain bounded`; `auth.test.ts`, `authentication states and diagnostics expose no credential values`.
- Transport and codec redaction: provider failure tests in `deepseek-provider.test.ts`, `azure-openai.test.ts`, `openai-chat.test.ts`, `anthropic-messages.test.ts`, `google-generative-ai.test.ts`, `bedrock-converse-stream.test.ts`, `mistral-conversations.test.ts`, `gateway-messages.test.ts`, and `openrouter-images.test.ts`.
- Same-model continuation retention: `request-preparation.test.ts`, `retains replay metadata only for its exact issuing model`; `provider-port.test.ts`, `retains replay metadata in assistant history for the next in-process turn`.
- Cross-provider continuation sanitization: `provider-port.test.ts`, `strips foreign continuation state when a session changes providers`.
- Foreign opaque reasoning rejection: `request-preparation.test.ts`, `rejects foreign redacted reasoning instead of dropping opaque content`.
- Dynamic and custom endpoint policy, restored-origin dispatch checks, fail-closed rows, Anthropic environment headers, and image timeout: `remaining-providers.test.ts`.
- SSE line, event, frame, and total limits: `sse.test.ts`.
- AWS frame and split-prelude limits: `aws-event-stream.test.ts`.
- Bounded buffered JSON and linear URL normalization: `transport-safety.test.ts`.
- Real pinned-DNS HTTP transport with Node's single-address and address-array callbacks: `transport-safety.test.ts`, `real transport honors both Node DNS lookup callback shapes`.
- Vertex and Bedrock SDK cancellation: `cloud-auth.test.ts` and `aws-auth.test.ts`.
- Persistence-commit supersession and legacy provider source compatibility: `registry.test.ts`.
- Azure interactive login: `cloud-auth.test.ts` and the runtime provider inventory assertion in `local-runtime.test.ts`.

## Invariants

The matrix preserves canonical `{ providerId, modelId }` selection. API dialect stays model metadata. Provider listing remains side-effect free. Authentication and credential values remain inside provider-owned trusted processes. No test introduces a compatibility fallback or live provider dependency.

## Separate opt-in Azure smoke, 2026-09-07

The user explicitly authorized Azure testing. The built CLI and built runtime ran against Azure in a disposable workspace with Bubblewrap enforced. The existing Azure API key was read into an isolated in-memory store. The user's credential and settings files were hash-checked before and after and remained unchanged. No other provider inference was tested.

- Public catalog refresh initially failed because the pinned DNS callback ignored Node's `all` option. The shared transport was fixed without disabling address validation or DNS pinning. Azure metadata refresh then succeeded with 67 models.
- Two minimal inference calls were made with `gpt-5.6-luna` and `low` reasoning. The first CLI call exited successfully, but the temporary smoke reporter used incorrect canonical event names. The corrected reporter verified the second call returned exactly `OK`, stopped normally, and recorded requested/effective thinking as `low` without clamping.
- The verified call reported 195 input tokens, 5 output tokens, 0 reasoning tokens, and catalog-derived cost of $0.000045. Zero reasoning tokens on this trivial prompt does not prove that reasoning is disabled; the requested level was accepted.
- No tool calls occurred. Credential values were absent from stdout, stderr, and the canonical session record. The isolated daemon and temporary session were cleaned up.
- `pnpm check` passed with 810 tests passing and 8 existing platform/environment skips. The bundled catalog retained its reviewed 1,102-model baseline, including 66 Azure models. Offline Azure reasoning encoding covered 462 model/level combinations.

This smoke verifies one configured Azure model at `low`, not every Azure deployment or advertised reasoning level. It is not part of the automated test suite.

## Azure Astra catalog correction

The active generated Azure catalog omitted 13 IDs already present in Axl's curated Azure definitions, plus `gpt-6-astra`. Shared normalization now retains curated Azure definitions when upstream omits them, while explicit upstream facts take precedence. Non-reasoning curated models no longer carry contradictory reasoning maps. Generation and explicit refresh both publish 80 Azure models, including all 39 IDs found in the user's Pi Azure cache. Other generated provider shards are unchanged. No Pi source, credentials, or catalog file was copied into the repository.

- `node packages/ai/scripts/generate-catalog.ts`: passed after validation exposed and the implementation corrected the contradictory non-reasoning maps. The reviewed semantic baseline intentionally advances from 1,102 to 1,116 models.
- `node --test --test-timeout=30000 packages/ai/test/azure-openai.test.ts packages/ai/test/catalog.test.ts packages/ai/test/catalog-refresh.test.ts`: 26 passed. Coverage includes Astra selection, 1,050,000-token context, 128,000-token output limit, reasoning effort encoding, curated refresh retention, upstream precedence, tool-capability exclusions, empty-catalog rejection, and offline restoration.
- `pnpm check`: passed, 815 tests passed and 8 existing skips, including build, formatting, lint, type checking, boundaries, and generated-file checks.
- User-authorized live Azure catalog verification returned HTTP 200 and listed Astra. After an authorized idle daemon restart, `axl models azure-openai-responses` listed Astra before and after `axl refresh azure-openai-responses`, which returned 80 models.
- A built-CLI smoke launcher initially timed out because it left stdin open; the CLI waited for EOF before submitting a prompt. Closing the launcher's stdin allowed the single authorized inference request to run. Astra returned exactly `OK` at requested `low`, with normal stop and no tool calls. Bubblewrap enforcement was recorded. Usage was 439 input tokens, 5 output tokens, zero reasoning tokens, and catalog-derived cost of $0.00464. This verifies one configured deployment and request, not all Azure models or reasoning levels.
- Credentials remained in an isolated in-memory store. Credential values were absent from CLI output and canonical history. Hashes of the existing Axl credential/settings files and Pi model cache/configuration files were unchanged. The disposable daemon and workspace were cleaned up.
