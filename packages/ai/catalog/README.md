<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Model catalog sources

This directory contains reviewed inputs for Axl's generated static model catalog. Runtime catalog reads use only the generated index and provider shards under `src/catalog.generated.ts` and `src/catalog.generated/`. They do not read environment variables, credential stores, source manifests, or the network.

## Provenance

`sources/models-dev/manifest.json` indexes provider-scoped JSON Lines shards reduced from factual model metadata retrieved from `https://models.dev/api.json` on 2026-09-05. The upstream response SHA-256 and corresponding `anomalyco/models.dev` repository revision are recorded in the manifest. The upstream catalog is MIT licensed. Only provider identity, model identity, display name, capability flags, reasoning options, token limits, lifecycle status, and pricing fields required by Axl are retained.

`sources/ant-ling/manifest.json` indexes the Ant Ling shard independently curated from the official API overview, OpenAI-compatible API reference, and reasoning-effort guide listed in that manifest. It contains factual compatibility metadata and no copied implementation.

Azure also retains the existing Axl-curated definitions in `src/azure-openai-models.ts` when models.dev omits an ID. Shared normalization applies the canonical Azure endpoint, cache, and compatibility policy to these definitions. Explicit upstream records take precedence, including tool-capability exclusions; an empty upstream catalog still fails validation. The Astra definition uses limits and rates already recorded in the OpenAI source shard. This Azure-only update adds 14 IDs to the generated catalog, bringing Azure to 80 models and the reviewed total to 1,116. Other provider shards are unchanged.

Each source shard contains exactly one canonical JSON model record per line, ordered by model ID. Each manifest orders providers by ID and records the model count and SHA-256 of every shard. Generation fails on a noncanonical line, ordering change, count mismatch, checksum mismatch, unindexed shard, or missing indexed shard.

Pi at commit `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c` was consulted only as an architectural and behavioral reference for separating source data, provider policy, validation, and generated output. No Pi catalog data or source was copied or mechanically translated.

## Updating

1. Retrieve the current upstream source into a temporary location.
2. Record its retrieval time, SHA-256, and source revision.
3. Reduce it to the existing source fields for the provider IDs declared in `src/catalog-overlays.ts`, with one canonical JSON model record per line.
4. Update the provider's manifest count and shard SHA-256, while preserving deterministic provider and model ordering.
5. Review endpoint, region, dialect, reasoning, cache, and compatibility overlays against official provider documentation.
6. Run `node packages/ai/scripts/generate-catalog.ts`.
7. Review the provider-scoped source and generated diffs for unexpected endpoint, region, pricing, capability, and availability changes.
8. Run `pnpm check:generated` and the complete AI package tests. The semantic-baseline test must continue to pass unless an intentional catalog update separately reviews and updates that baseline.

Generation is deliberately local and deterministic. It never fetches remote data and fails before writing when source records or overlays are invalid. Do not copy model data from the pinned Pi behavioral reference.

GitHub Copilot, OpenRouter, Cloudflare AI Gateway, and Radius use dynamic provider discovery instead of this generator. Their catalogs change only through explicit `axl refresh`, are validated before publication, and are persisted as provider-scoped last-known-good snapshots. A dynamic catalog source change requires focused refresh, cancellation, malformed-response, race, persistence, and offline-restoration tests.

## Explicit runtime refresh

`axl refresh [provider-id]` and `/refresh [provider-id]` also refresh the 35 static providers mapped to models.dev. `src/catalog-normalization.ts` and `src/catalog-overlays.ts` are shared by generation and runtime refresh, so endpoint, dialect, cache, and compatibility policy remain reviewed local code. The same normalization retains curated Azure model IDs during refresh, including `gpt-6-astra`. Remote data supplies model facts, not endpoints or credential headers. Each fetch is bounded to 32 MiB and 15 seconds and sends no provider credentials to models.dev.

Unqualified refresh checks configured authentication and skips logged-out providers. Targeted refresh can retrieve public static metadata without a credential. Ant Ling remains a documentation-curated catalog, and user-configured providers retain their explicit model lists. Neither pretends to support remote discovery. These catalogs require a release update or a models.json edit respectively.

Runtime refresh writes only the user's catalog cache. It does not modify checked-in source shards, generated files, or user-authored models.json. Existing registry merge semantics retain bundled models while upserting refreshed IDs; a missing upstream ID is not interpreted as an entitlement revocation.
