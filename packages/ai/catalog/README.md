<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Model catalog sources

This directory contains reviewed inputs for Axl's generated static model catalog. Runtime catalog reads use only `src/catalog.generated.ts`. They do not read environment variables, credential stores, source manifests, or the network.

## Provenance

`models-dev.json` is a reduced snapshot of factual model metadata retrieved from `https://models.dev/api.json` on 2026-09-05. The upstream response SHA-256 and the corresponding `anomalyco/models.dev` repository revision are recorded in the manifest. The upstream catalog is MIT licensed. Only provider identity, model identity, display name, capability flags, reasoning options, token limits, lifecycle status, and pricing fields required by Axl are retained.

`ant-ling.json` is independently curated from the official Ant Ling API overview, OpenAI-compatible API reference, and reasoning-effort guide listed in that manifest. It contains factual compatibility metadata and no copied implementation.

Pi at commit `92d8e2d17d4f357788381c49ce2cdb3f4ed1f21c` was consulted only as an architectural and behavioral reference for separating source data, provider policy, validation, and generated output. No Pi catalog data or source was copied or mechanically translated.

## Updating

1. Retrieve the current upstream source into a temporary location.
2. Record its retrieval time, SHA-256, and source revision.
3. Reduce it to the existing source-manifest fields for the provider IDs declared in `scripts/catalog-overlays.ts`.
4. Review endpoint, region, dialect, reasoning, cache, and compatibility overlays against official provider documentation.
5. Run `node packages/ai/scripts/generate-catalog.ts`.
6. Review the generated diff for unexpected provider, endpoint, region, pricing, capability, and availability changes.
7. Run `pnpm check:generated` and the complete AI package tests.

Generation is deliberately local and deterministic. It never fetches remote data and fails before writing when source records or overlays are invalid. Do not copy model data from the pinned Pi behavioral reference.

GitHub Copilot, OpenRouter, Cloudflare AI Gateway, and Radius use dynamic provider discovery instead of this generator. Their catalogs change only through explicit `axl refresh`, are validated before publication, and are persisted as provider-scoped last-known-good snapshots. A dynamic catalog source change requires focused refresh, cancellation, malformed-response, race, persistence, and offline-restoration tests.
