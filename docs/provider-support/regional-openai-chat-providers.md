<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Regional OpenAI Chat provider support record

## Scope

This record covers the built in Baseten, Hugging Face, Z.AI, Z.AI Coding China, MiniMax, MiniMax China, Moonshot AI, Moonshot AI China, Qwen Token Plan, and Qwen Token Plan China registrations in `packages/ai`. All ten use the checked in static catalog, the completed `openai-chat` codec, the shared `OpenAiChatProvider` transport, and provider owned API key authentication.

The shared `createStaticOpenAiChatProvider` factory validates provider identity, catalog ownership, API dialect, and the exact fixed HTTPS endpoint before constructing a provider. Construction and listing perform no credential lookup, network request, remote discovery, or background work.

## Compatibility review

Each selected identity has the same registration boundaries:

- One provider scoped API key, resolved from stored credentials before its documented environment variable
- One fixed HTTPS base URL with bearer authorization
- One checked in, nonempty static catalog using only the `openai-chat` dialect
- No remote catalog discovery, refresh method, custom account header, cloud credential chain, or OAuth flow

MiniMax and MiniMax China also publish Anthropic compatible interfaces. Their official documentation separately publishes the OpenAI compatible `/v1` interfaces selected by Axl's generated catalog, so the native Anthropic option does not make this batch incompatible. Z.AI publishes general and coding plan endpoints. Axl keeps the global general API at `api.z.ai` separate from the China coding plan identity at `open.bigmodel.cn`.

No provider required replacement.

## Reviewed sources

### Catalog source

- Source: models.dev, `https://models.dev/api.json`
- Source revision: `5c600a037417cf778ee6eb3ea2ce0f17abc12130`
- Retrieved: 2026-09-05T13:49:08Z
- SHA-256: `0b09a4d8dedab6a804ca15046729bb2ec03c5f5b689b89a983ea488bb71eaeef`
- Reviewed surface: provider and model identities, fixed endpoints, capabilities, context and output limits, pricing, cache behavior, availability, reasoning controls, sampling policy, regional separation, and OpenAI Chat compatibility

The checked in generated catalog remains the runtime metadata source. No Pi model data was copied into Axl.

### Provider documentation

The compatibility review included these provider documentation surfaces:

- Baseten Chat Completions: `https://docs.baseten.co/reference/inference-api/chat-completions`
- Hugging Face Chat Completion: `https://huggingface.co/docs/inference-providers/en/tasks/chat-completion`
- Z.AI OpenAI SDK integration: `https://docs.z.ai/guides/develop/openai/python`
- Z.AI Coding China tool integration: `https://docs.bigmodel.cn/cn/coding-plan/tool/others`
- MiniMax global OpenAI SDK integration: `https://platform.minimax.io/docs/api-reference/text-openai-api`
- MiniMax China OpenAI SDK integration: `https://platform.minimaxi.com/docs/api-reference/text-openai-api`
- Moonshot OpenAI compatibility: `https://platform.moonshot.cn/docs/guide/migrating-from-openai-to-kimi`

The Qwen Token Plan endpoint and environment conventions were cross checked between the reviewed models.dev manifest and the pinned behavioral reference. Routine verification remains offline and performs no live provider request.

### Behavioral reference

- Repository: `https://github.com/earendil-works/pi`
- Commit: `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c`
- Reviewed provider definitions: the corresponding files under `packages/ai/src/providers`
- Reviewed metadata entry points: the corresponding generated provider model modules
- Reviewed shared boundaries: built in registration, lazy OpenAI Chat transport, API key helpers, and provider tests

Pi was used to identify provider boundaries, endpoint and environment conventions, static catalog behavior, and shared transport composition. Axl's implementation is independent and uses Axl's provider, authentication, prepared request, catalog, and canonical stream contracts.

## Provider definitions

| Provider | Environment variable | Fixed base URL | Static models |
| --- | --- | --- | --- |
| Baseten | `BASETEN_API_KEY` | `https://inference.baseten.co/v1` | 22 |
| Hugging Face | `HF_TOKEN` | `https://router.huggingface.co/v1` | 70 |
| Z.AI | `ZAI_API_KEY` | `https://api.z.ai/api/paas/v4` | 16 |
| Z.AI Coding China | `ZAI_CODING_CN_API_KEY` | `https://open.bigmodel.cn/api/coding/paas/v4` | 10 |
| MiniMax | `MINIMAX_API_KEY` | `https://api.minimax.io/v1` | 7 |
| MiniMax China | `MINIMAX_CN_API_KEY` | `https://api.minimaxi.com/v1` | 7 |
| Moonshot AI | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` | 10 |
| Moonshot AI China | `MOONSHOT_API_KEY` | `https://api.moonshot.cn/v1` | 10 |
| Qwen Token Plan | `QWEN_TOKEN_PLAN_API_KEY` | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | 19 |
| Qwen Token Plan China | `QWEN_TOKEN_PLAN_CN_API_KEY` | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | 19 |

Regional identities retain distinct provider IDs, endpoints, catalogs, stored credentials, and catalog region metadata. Moonshot's two identities intentionally recognize the same environment variable while retaining separate stored credential ownership.

## Authentication, endpoint, catalog, and discovery boundaries

Requests append `/chat/completions` to the exact base URL and use bearer authorization. Stored API key credentials own each provider. A missing or invalid stored key does not fall through to the environment. Interactive key entry uses the existing UI neutral provider authentication lifecycle.

Every provider lists only its checked in catalog. Models cannot cross provider identities or fixed endpoints, and all models must declare `openai-chat`. Regional catalog metadata remains explicit for Z.AI, MiniMax, Moonshot AI, and Qwen Token Plan. None of these providers implements dynamic refresh or performs discovery at registration, listing, authentication, or dispatch time.

The shared Chat transport supplies prepared request encoding, SSE decoding, finite timeout enforcement, capped prestream retries, bounded retry delays, `Retry-After` guidance, caller cancellation, safe terminal errors, and credential redaction. It never redispatches after stream consumption begins.

## Deterministic verification

Local fixtures cover:

- Side effect free construction and static model listing
- Exact provider identity, display name, catalog kind, regional metadata, model count, dialect, endpoint, and authentication metadata
- Environment key resolution for all ten providers
- Registry dispatch through the prepared OpenAI Chat transport
- Exact request URL, bearer header, request body, canonical text event, and response attribution
- Rejection of empty catalogs, foreign model ownership, non-Chat dialects, unsafe headers, and mismatched endpoints

No live provider call was performed. This batch adds no protocol event, persisted format, daemon wire, kernel, runtime, SDK, CLI, or TUI change.

## Deferred work

Other built in providers remain in step 9. Subscription and cloud authentication remain in step 10, and product integration remains in step 11. Opt in live provider smoke tests remain outside routine deterministic verification.
