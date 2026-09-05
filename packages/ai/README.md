<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Kaushik Kumar -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `@axl/ai`

This package keeps provider-specific behavior outside the kernel. It defines provider and model contracts, credential lookup, thinking levels, tool dialects, deterministic test models, and the Azure OpenAI Responses adapter.

The built-in provider inventory and static model metadata are generated from reviewed local manifests and overlays. Runtime reads are synchronous and offline. Source provenance and the update procedure are documented in [`catalog/README.md`](catalog/README.md).

Dynamic providers use provider-scoped `CatalogSnapshot` generations through `ProviderRegistry`. `restoreCatalogs()` restores validated last-known-good snapshots without credentials or network access. Explicit `refresh()` restores first, then gives each provider a cancellable generation token and its prior safe snapshot. A complete candidate is validated, atomically persisted, and published only when its generation is still current. Failures, cancellation, and superseded work retain the previous valid generation and remain isolated by provider. `FileCatalogStore` stores one locked JSON file per provider so corruption cannot hide healthy snapshots. Snapshot metadata is deliberately limited to public source identity, timestamps, and an optional ETag. Diagnostics are bounded, validated, and never persisted.
