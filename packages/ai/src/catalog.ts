// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { ModelInfo } from "./model.ts";
import {
  BUILTIN_CATALOG_PROVIDERS,
  GENERATED_CATALOG_PROVENANCE,
  STATIC_MODEL_CATALOG,
} from "./catalog.generated.ts";

export {
  ModelCatalogValidationError,
  validateModelCatalog,
} from "./catalog-validation.ts";

export interface BuiltinCatalogProvider {
  readonly id: string;
  readonly displayName: string;
  readonly catalogKind: "static" | "dynamic" | "configured";
  readonly regionFamily?: string;
  readonly region?: string;
}

export interface CatalogProvenance {
  readonly generatedAt: string;
  readonly sources: readonly {
    readonly name: string;
    readonly location: string;
    readonly retrievedAt: string;
    readonly sha256?: string;
    readonly revision?: string;
    readonly license: string;
  }[];
}

/** Synchronous static lookup with no network or credential access. */
export function getStaticModelCatalog(providerId: string): readonly ModelInfo[] {
  const catalog: Readonly<Record<string, readonly ModelInfo[]>> = STATIC_MODEL_CATALOG;
  return catalog[providerId] ?? [];
}

export function listBuiltinCatalogProviders(): readonly BuiltinCatalogProvider[] {
  return BUILTIN_CATALOG_PROVIDERS;
}

export { GENERATED_CATALOG_PROVENANCE, STATIC_MODEL_CATALOG };
