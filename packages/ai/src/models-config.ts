// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { BUILTIN_PROVIDER_IDS } from "./builtin-providers.ts";
import { object } from "./catalog-normalization.ts";
import type { ModelProvider } from "./provider.ts";
import {
  createCustomProvider,
  type ProviderFactoryOptions,
  parseCustomProviderConfiguration,
} from "./remaining-providers.ts";

/** Native user configuration. Credentials remain in the provider-scoped secret store. */
export async function loadConfiguredProviders(
  axlHome: string,
  options: ProviderFactoryOptions,
): Promise<readonly ModelProvider[]> {
  const path = join(axlHome, "models.json");
  try {
    await access(join(axlHome, "custom-provider.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return readConfiguration(path, options);
  }
  throw new Error(
    `custom-provider.json has been replaced by ${path}; move its configuration under providers.custom and remove the old file`,
  );
}

async function readConfiguration(
  path: string,
  options: ProviderFactoryOptions,
): Promise<readonly ModelProvider[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Configuration exceeds 4 MiB");
    const input = object(JSON.parse(text), "models.json");
    if (Object.keys(input).some((key) => key !== "providers")) {
      throw new Error("models.json contains an unknown field");
    }
    return Object.entries(object(input.providers, "providers")).map(([id, value]) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 128) {
        throw new Error("Invalid configured provider ID");
      }
      if (id !== "custom" && (BUILTIN_PROVIDER_IDS as readonly string[]).includes(id)) {
        throw new Error(`Configured provider ${id} conflicts with a built-in provider`);
      }
      const entry = object(value, id);
      const { displayName, ...configuration } = entry;
      if (
        displayName !== undefined &&
        (typeof displayName !== "string" ||
          !displayName.trim() ||
          /[\p{Cc}\p{Cf}]/u.test(displayName))
      ) {
        throw new Error(`Invalid display name for ${id}`);
      }
      return createCustomProvider({
        ...options,
        ...parseCustomProviderConfiguration(configuration, id),
        id,
        ...(typeof displayName === "string" ? { displayName } : {}),
      });
    });
  } catch (cause) {
    // Do not echo config values: a malformed file may contain misplaced credentials.
    throw new Error(`Invalid model configuration in ${path}`, { cause });
  }
}
