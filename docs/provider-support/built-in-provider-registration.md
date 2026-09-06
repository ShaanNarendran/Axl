<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Built in provider registration support record

## Scope

This record completes Step 9 for the 17 provider identities that were not covered by the earlier static OpenAI Chat registration batches. Together with those 24 registrations, `createBuiltinProviders()` now constructs exactly all 41 planned identities without reading credentials, performing network requests, refreshing catalogs, or starting background work.

The implementation adds catalog selected dispatch, native HTTP and SSE composition, checked AWS event stream framing, explicit dynamic discovery, account scoped endpoint composition, native OpenRouter image generation, and user configured endpoint registration. Dynamic text catalogs publish only through the provider scoped persistence and generation checks in `ProviderRegistry`.

## Compatibility matrix

| Provider | Authentication and environment | Exact endpoint policy | Catalog and dialect | Discovery, headers, isolation, and deferred work |
| --- | --- | --- | --- | --- |
| `openai` | Stored key, then `OPENAI_API_KEY` | Fixed `https://api.openai.com/v1`; Chat uses `/chat/completions`, Responses uses `/responses` | Static, catalog selected `openai-chat` or `openai-responses` | Bearer authorization. No discovery. |
| `azure-openai-responses` | Stored key, then `AZURE_OPENAI_API_KEY`, then Microsoft Entra default credentials; `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`; optional API version and deployment map | Azure hosts normalize to `/openai/v1/responses`; explicit proxy paths and query settings are preserved | Static `azure-openai-responses` | API keys use `api-key`; Entra uses a bearer token for the Cognitive Services scope. The official Azure Identity chain owns refresh. |
| `openai-codex` | OAuth subscription only | Fixed `https://chatgpt.com/backend-api/codex`; codec owns `/codex/responses` and required Codex headers | Static `openai-codex-responses` | Browser PKCE and device OAuth, refresh, account validation, and transport are active. No fallback to an OpenAI API key is attempted. |
| `anthropic` | Stored key, then `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN`; subscription OAuth | Fixed `https://api.anthropic.com/v1/messages` | Static `anthropic-messages` | API keys use `x-api-key`. OAuth uses bearer authentication, refresh, and the required subscription beta headers. |
| `google` | Stored key, then `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Fixed `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse` | Static `google-generative-ai` | `x-goog-api-key` header. No discovery. |
| `google-vertex` | Stored key, then `GOOGLE_CLOUD_API_KEY`, service-account file, then ADC | Express Mode uses `aiplatform.googleapis.com`; the native policy composes model resources and `:streamGenerateContent?alt=sse` | Static `google-vertex` | `x-goog-api-key` or bearer authentication is selected explicitly. The official Google Auth Library owns ADC and service-account refresh. |
| `amazon-bedrock` | Stored bearer, profile, or chain selection; then `AWS_BEARER_TOKEN_BEDROCK`; then the AWS default credential chain | `https://bedrock-runtime.{region}.amazonaws.com/model/{model}/converse-stream`, with ARN region routing from the codec | Static `bedrock-converse-stream` | Bearer transport and checked AWS event-stream framing are active. SigV4 signs every dispatch attempt with refreshable default-chain credentials. |
| `github-copilot` | Stored token, then `COPILOT_GITHUB_TOKEN`; GitHub device OAuth | Token `proxy-ep` selects the account endpoint; explicit `/models` refresh; model dialect selects request path | Dynamic entitlement catalog | GitHub and enterprise tokens are exchanged for short-lived Copilot tokens. Required integration headers and provider isolation remain enforced. |
| `mistral` | Stored key, then `MISTRAL_API_KEY` | Fixed `https://api.mistral.ai/v1/conversations` | Static `mistral-conversations` | Bearer authorization plus codec supplied affinity header. No discovery. |
| `openrouter` | Stored key, then `OPENROUTER_API_KEY`; browser PKCE OAuth | Fixed `https://openrouter.ai/api/v1`; `/models`, `/chat/completions`, and `/images` | Dynamic OpenAI Chat text catalog and native image catalog | OAuth exchanges an authorization code for a permanent API key. Discovery stays explicit and cancellable. Attribution headers are not invented. |
| `cloudflare-ai-gateway` | Stored token, then `CLOUDFLARE_API_KEY`; requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_GATEWAY_ID` | `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat` | Dynamic catalog, dialect selected when the returned catalog declares one | Explicit `/models` refresh and bearer authorization for the unified endpoint. Account and gateway values are provider scoped and cannot cross into Workers AI credentials. |
| `cloudflare-workers-ai` | Stored token, then `CLOUDFLARE_API_KEY`; requires `CLOUDFLARE_ACCOUNT_ID` | `https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions` | Static `openai-chat` | Bearer authorization. Account identity is required at dispatch and is isolated from AI Gateway settings. |
| `kimi-coding` | Stored key, then `KIMI_API_KEY`; subscription device OAuth | Fixed `https://api.kimi.com/coding/v1/chat/completions` | Static `openai-chat` | API key and refreshable subscription OAuth dispatch are active. |
| `opencode` | Stored key, then `OPENCODE_API_KEY` | Fixed `https://opencode.ai/zen/v1`; model dialect selects `/chat/completions`, `/responses`, `/messages`, or Google `models/{model}:streamGenerateContent` | Static mixed catalog | Bearer authorization. Official endpoint tables determine model dialect. No compatibility fallback is used. |
| `opencode-go` | Stored key, then `OPENCODE_API_KEY`, with separate stored credential ownership from `opencode` | Fixed `https://opencode.ai/zen/go/v1`; model dialect selects Chat, Responses, or Messages | Static mixed catalog | Bearer authorization. The two OpenCode identities remain isolated despite sharing one environment variable. |
| `radius` | Stored key, then `RADIUS_API_KEY`; gateway browser or device OAuth | Configured gateway defaults to `https://radius.pi.dev`; discovery uses `/v1/config`; returned base URL owns `/messages` | Dynamic `gateway-messages` | OAuth endpoints remain gateway-owned. Refresh and catalog discovery are explicit, cancellable, and provider isolated. |
| `custom` | Explicit API key environment names or keyless mode | Caller supplied HTTP or HTTPS base URL; dialect selects the path | Caller supplied models using OpenAI Chat, Responses, Anthropic Messages, Google Generative AI, Mistral Conversations, or Gateway messages | Caller supplied non-secret headers are validated by catalog validation. An unconfigured built in placeholder lists no models and fails explicitly. |

## Catalog and dispatch decisions

OpenAI, OpenCode Zen, OpenCode Go, GitHub Copilot, and Cloudflare AI Gateway use model selected dialect dispatch. The OpenCode overlays were corrected from a forced Chat dialect to the endpoint families published in the official Zen and Go tables. Static catalog generation remains deterministic and uses the reviewed local models.dev manifest only for model facts. The endpoint table determines dialect selection independently.

Dynamic registration does not fetch during construction or `listModels()`. `ProviderRegistry.refresh()` supplies cancellation and provider generation identity, validates the complete candidate, persists it atomically, and publishes it only if the generation remains current. `streamModel()` lets the registry dispatch a validated model restored from persistence without requiring an implicit refresh or mutable provider catalog.

The 41 identity inventory test compares the registration list to the generated provider inventory, rejects duplicate IDs, verifies provider ownership and dialect compatibility, checks fixed and templated endpoint policy, proves side effect free static listing, verifies dynamic refresh remains explicit, checks regional identity separation, and verifies OAuth-only Codex availability.

## Reviewed official sources

The implementation review used these official sources:

- OpenAI API reference: `https://platform.openai.com/docs/api-reference`
- Azure OpenAI Responses reference: `https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference-preview-latest`
- Anthropic Messages reference: `https://docs.anthropic.com/en/api/messages`
- Gemini API reference: `https://ai.google.dev/api/generate-content`
- Vertex AI authentication and endpoint references: `https://cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys` and `https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations`
- Amazon Bedrock runtime reference: `https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html`
- GitHub Copilot authentication documentation: `https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate`
- Mistral Conversations reference: `https://docs.mistral.ai/api/endpoint/agents`
- OpenRouter models and images references: `https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties` and `https://openrouter.ai/docs/api/api-reference/images/generate-an-image`
- Cloudflare unified API and authentication references: `https://developers.cloudflare.com/ai-gateway/usage/chat-completion/` and `https://developers.cloudflare.com/ai-gateway/configuration/authentication/`
- OpenCode Zen and Go endpoint tables: `https://opencode.ai/docs/zen/` and `https://opencode.ai/docs/go/`

The Radius gateway protocol and GitHub Copilot entitlement behavior do not have complete stable public wire specifications. Those boundaries were checked against the pinned behavioral reference and deterministic local fixtures.

## Pinned behavioral reference

- Repository: `https://github.com/earendil-works/pi`
- Commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed scope: all built in provider definitions, Cloudflare account composition, OpenCode mixed dialect dispatch, GitHub Copilot entitlement catalog behavior and required headers, Radius config discovery, Bedrock registration, and provider inventory construction

Pi was used only to identify behavioral boundaries and compatibility cases. No Pi implementation or generated catalog data was copied into Axl.

## Deferred work

Step 10 completed OpenAI Codex, Anthropic, GitHub Copilot, OpenRouter, Kimi, Radius, and xAI OAuth; Azure Microsoft Entra; Vertex ADC and service accounts; and the Bedrock default credential chain plus SigV4 signing. See [`subscription-and-cloud-authentication.md`](subscription-and-cloud-authentication.md).

Step 11 still owns runtime, daemon, SDK, CLI, and TUI integration. No product selection or login path changed in this registration step.
