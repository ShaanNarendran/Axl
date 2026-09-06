<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Gateway and coding OpenAI Chat provider support record

## Scope

This record covers the built in Vercel AI Gateway, Fireworks AI, Together AI, Qwen Token Plan Individual, Xiaomi MiMo, Xiaomi Token Plan China, Xiaomi Token Plan Amsterdam, Xiaomi Token Plan Singapore, Ant Ling, and xAI registrations in `packages/ai`. All ten use the checked in static catalog, the completed `openai-chat` codec, the shared `OpenAiChatProvider` transport, and provider owned API key authentication.

The shared `createStaticOpenAiChatProvider` factory validates provider identity, catalog ownership, API dialect, and the exact fixed HTTPS endpoint before constructing a provider. Construction and listing perform no credential lookup, network request, remote discovery, or background work.

## Compatibility review

Each selected identity has the same active registration boundaries:

- One provider scoped API key, resolved from stored credentials before its documented environment variable
- One fixed HTTPS base URL with bearer authorization
- One checked in, nonempty static catalog using only the `openai-chat` dialect
- No required remote catalog discovery, custom account header, cloud credential chain, or OAuth flow

Vercel AI Gateway also supports Vercel OIDC authentication, but a gateway API key is sufficient for its documented OpenAI Chat endpoint. This slice does not add OIDC. xAI API-key authentication independently supports the registered Chat endpoint, and Step 10 added its subscription device OAuth flow.

Fireworks publishes separate OpenAI and Anthropic compatibility surfaces. Axl selects its documented OpenAI compatible `/inference/v1` surface for the generated Chat catalog and does not silently switch dialects. The selected catalog therefore needs no mixed dialect dispatch.

OpenCode Zen and OpenCode Go were reviewed but excluded from this batch. Their official catalogs route models across OpenAI Chat, OpenAI Responses, Anthropic Messages, and Google Generative AI endpoints, so registering their complete catalogs through the fixed Chat factory would be incorrect. Cloudflare Workers AI was also excluded because it requires an account identifier and provider specific stream handling.

Together's generated endpoint was corrected from `api.together.xyz` to the official `api.together.ai` OpenAI compatible base URL before registration. The checked in catalog was regenerated deterministically.

## Reviewed sources

### Catalog sources

The generated catalog uses these existing reviewed local inputs:

- models.dev, `https://models.dev/api.json`, revision `5c600a037417cf778ee6eb3ea2ce0f17abc12130`, retrieved 2026-09-05T13:49:08Z, SHA-256 `0b09a4d8dedab6a804ca15046729bb2ec03c5f5b689b89a983ea488bb71eaeef`
- Ant Ling's independently curated manifest in `packages/ai/catalog/sources/ant-ling.json`

The checked in generated catalog remains the runtime metadata source. No Pi model data was copied into Axl.

### Provider documentation

The compatibility review included these official documentation surfaces:

- Vercel OpenAI Chat Completions API: `https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions`
- Fireworks OpenAI compatibility: `https://docs.fireworks.ai/tools-sdks/openai-compatibility`
- Together OpenAI compatibility: `https://docs.together.ai/docs/openai-api-compatibility`
- Alibaba Cloud Coding Plan: `https://www.alibabacloud.com/help/en/model-studio/coding-plan`
- Xiaomi MiMo Token Plan: `https://mimo.mi.com/docs/tokenplan/subscription`
- Ant Ling OpenAI compatible API: `https://developer.ant-ling.com/en/docs/api-reference/openai/`
- xAI Chat Completions: `https://docs.x.ai/developers/rest-api-reference/inference/chat`
- OpenCode Zen: `https://opencode.ai/docs/zen/`
- OpenCode Go: `https://opencode.ai/docs/go/`

### Behavioral reference

- Repository: `https://github.com/earendil-works/pi`
- Commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed provider definitions: corresponding files under `packages/ai/src/providers`
- Reviewed shared boundaries: built in registration, API key helpers, OpenAI Chat transport, and provider tests

Pi was used to identify provider boundaries, environment conventions, static catalog behavior, and shared transport composition. Axl's implementation is independent and uses Axl's provider, authentication, prepared request, catalog, and canonical stream contracts.

## Provider definitions

| Provider | Environment variable | Fixed base URL | Static models |
| --- | --- | --- | --- |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `https://ai-gateway.vercel.sh/v1` | 229 |
| Fireworks AI | `FIREWORKS_API_KEY` | `https://api.fireworks.ai/inference/v1` | 20 |
| Together AI | `TOGETHER_API_KEY` | `https://api.together.ai/v1` | 32 |
| Qwen Token Plan Individual | `QWEN_TOKEN_PLAN_API_KEY` | `https://coding-intl.dashscope.aliyuncs.com/v1` | 19 |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `https://api.xiaomimimo.com/v1` | 6 |
| Xiaomi Token Plan China | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `https://token-plan-cn.xiaomimimo.com/v1` | 3 |
| Xiaomi Token Plan Amsterdam | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `https://token-plan-ams.xiaomimimo.com/v1` | 3 |
| Xiaomi Token Plan Singapore | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `https://token-plan-sgp.xiaomimimo.com/v1` | 3 |
| Ant Ling | `ANT_LING_API_KEY` | `https://api.ant-ling.com/v1` | 4 |
| xAI | `XAI_API_KEY` | `https://api.x.ai/v1` | 6 |

## Authentication, endpoint, catalog, and regional boundaries

Requests append `/chat/completions` to the exact base URL and use bearer authorization. Stored API key credentials own each provider. A missing or invalid stored key does not fall through to the environment. Interactive key entry uses the existing UI neutral provider authentication lifecycle.

Every provider lists only its checked in catalog. Models cannot cross provider identities or fixed endpoints, and all models must declare `openai-chat`. None implements dynamic refresh or performs discovery at registration, listing, authentication, or dispatch time.

The four Xiaomi identities retain distinct provider IDs, endpoints, catalogs, stored credentials, environment variables, and region metadata. Qwen Token Plan Individual and Qwen Token Plan intentionally recognize the same environment variable, while their provider IDs, stored credential ownership, endpoints, and catalogs remain separate.

The shared Chat transport supplies prepared request encoding, SSE decoding, finite timeout enforcement, capped prestream retries, bounded retry delays, `Retry-After` guidance, caller cancellation, safe terminal errors, and credential redaction. It never redispatches after stream consumption begins.

## Deterministic verification

Local fixtures cover:

- Side effect free construction and static model listing
- Exact provider identity, display name, catalog kind, regional metadata, model count, dialect, endpoint, and authentication metadata
- Environment key resolution for all ten providers
- Registry dispatch through the prepared OpenAI Chat transport
- Exact request URL, bearer header, request body, canonical text event, and response attribution
- Rejection of empty catalogs, foreign model ownership, non-Chat dialects, unsafe headers, and mismatched endpoints
- Deterministic regeneration of the corrected Together catalog endpoint

No live provider call was performed. This batch adds no protocol event, persisted format, daemon wire, kernel, runtime, SDK, CLI, or TUI change.

## Completion status and limitation

Built-in registration, xAI subscription OAuth, daemon-owned text-model selection, SDK, CLI, TUI, and deterministic verification are complete. Vercel OIDC remains unsupported; Vercel AI Gateway API-key authentication is supported. Live provider smoke testing remains explicit and opt in as documented in [`provider-reference.md`](provider-reference.md).
