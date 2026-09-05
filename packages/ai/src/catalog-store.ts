// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { validateModelCatalog } from "./catalog-validation.ts";
import type { ModelInfo } from "./model.ts";

const PROVIDER_IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_IDENTIFIER = /^[a-z0-9]+(?:[a-z0-9._:/-]*[a-z0-9])?$/i;
const MAX_SOURCE_TEXT_LENGTH = 512;
const MAX_ETAG_LENGTH = 1_024;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

export interface CatalogSourceMetadata {
  /** Stable public source identity. This is not a URL or provider configuration object. */
  readonly id: string;
  readonly kind: "provider_api" | "entitlement" | "gateway";
  /** Optional public source revision, never a credential or authorization value. */
  readonly revision?: string;
}

/** Complete provider-scoped last-known-good catalog generation. */
export interface CatalogSnapshot {
  readonly version: 1;
  readonly providerId: string;
  readonly generation: number;
  /** Time the source was last checked, as epoch milliseconds. */
  readonly checkedAt: number;
  /** Time this model generation was accepted, as epoch milliseconds. */
  readonly updatedAt: number;
  /** Source-provided model-data timestamp, as epoch milliseconds. */
  readonly sourceUpdatedAt?: number;
  /** Opaque HTTP entity validator, when the source supports one. */
  readonly etag?: string;
  readonly source: CatalogSourceMetadata;
  readonly models: readonly ModelInfo[];
}

export interface CatalogStoreOperationOptions {
  readonly signal?: AbortSignal;
}

/** Provider-scoped last-known-good catalog persistence. */
export interface CatalogStore {
  read(
    providerId: string,
    options?: CatalogStoreOperationOptions,
  ): Promise<CatalogSnapshot | undefined>;
  write(
    providerId: string,
    snapshot: CatalogSnapshot,
    options?: CatalogStoreOperationOptions,
  ): Promise<void>;
  delete(providerId: string, options?: CatalogStoreOperationOptions): Promise<void>;
}

export class CatalogStoreError extends Error {
  readonly providerId: string;

  constructor(providerId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CatalogStoreError";
    this.providerId = providerId;
  }
}

function fail(providerId: string, message: string): never {
  throw new CatalogStoreError(providerId, `Catalog snapshot for ${providerId} ${message}`);
}

function record(value: unknown, providerId: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail(providerId, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  providerId: string,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(providerId, `${label} has unknown field ${JSON.stringify(key)}`);
  }
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

export function validateCatalogSource(value: unknown, providerId: string): CatalogSourceMetadata {
  const source = record(value, providerId);
  exactKeys(source, new Set(["id", "kind", "revision"]), providerId, "source metadata");
  if (
    typeof source.id !== "string" ||
    source.id.length > MAX_SOURCE_TEXT_LENGTH ||
    !SOURCE_IDENTIFIER.test(source.id)
  ) {
    fail(providerId, "has an invalid source identity");
  }
  if (
    source.kind !== "provider_api" &&
    source.kind !== "entitlement" &&
    source.kind !== "gateway"
  ) {
    fail(providerId, "has an invalid source kind");
  }
  if (
    source.revision !== undefined &&
    (typeof source.revision !== "string" ||
      source.revision.length === 0 ||
      source.revision.length > MAX_SOURCE_TEXT_LENGTH ||
      hasControlCharacter(source.revision))
  ) {
    fail(providerId, "has an invalid source revision");
  }
  return source as unknown as CatalogSourceMetadata;
}

export function validateCatalogSnapshot(
  value: unknown,
  expectedProviderId: string,
): CatalogSnapshot {
  if (!PROVIDER_IDENTIFIER.test(expectedProviderId)) {
    throw new CatalogStoreError(
      expectedProviderId,
      `Invalid catalog provider ID ${expectedProviderId}`,
    );
  }
  const snapshot = record(value, expectedProviderId);
  exactKeys(
    snapshot,
    new Set([
      "version",
      "providerId",
      "generation",
      "checkedAt",
      "updatedAt",
      "sourceUpdatedAt",
      "etag",
      "source",
      "models",
    ]),
    expectedProviderId,
    "snapshot",
  );
  if (snapshot.version !== 1) fail(expectedProviderId, "has an unsupported version");
  if (snapshot.providerId !== expectedProviderId)
    fail(expectedProviderId, "has a mismatched provider ID");
  if (!Number.isSafeInteger(snapshot.generation) || (snapshot.generation as number) < 1) {
    fail(expectedProviderId, "has an invalid generation");
  }
  if (!validTimestamp(snapshot.checkedAt) || !validTimestamp(snapshot.updatedAt)) {
    fail(expectedProviderId, "has invalid freshness timestamps");
  }
  if (snapshot.sourceUpdatedAt !== undefined && !validTimestamp(snapshot.sourceUpdatedAt)) {
    fail(expectedProviderId, "has an invalid source timestamp");
  }
  if (
    snapshot.etag !== undefined &&
    (typeof snapshot.etag !== "string" ||
      snapshot.etag.length === 0 ||
      snapshot.etag.length > MAX_ETAG_LENGTH ||
      /[\r\n]/.test(snapshot.etag))
  ) {
    fail(expectedProviderId, "has an invalid ETag");
  }
  validateCatalogSource(snapshot.source, expectedProviderId);
  if (!Array.isArray(snapshot.models)) fail(expectedProviderId, "has a non-array model catalog");
  try {
    validateModelCatalog(snapshot.models as readonly ModelInfo[]);
  } catch (error) {
    throw new CatalogStoreError(
      expectedProviderId,
      `Catalog snapshot for ${expectedProviderId} is invalid`,
      {
        cause: error,
      },
    );
  }
  for (const model of snapshot.models as readonly ModelInfo[]) {
    if (model.providerId !== expectedProviderId) {
      fail(expectedProviderId, `contains model ${model.modelId} owned by ${model.providerId}`);
    }
  }
  return structuredClone(snapshot) as unknown as CatalogSnapshot;
}

export class InMemoryCatalogStore implements CatalogStore {
  private readonly snapshots = new Map<string, CatalogSnapshot>();

  async read(
    providerId: string,
    options: CatalogStoreOperationOptions = {},
  ): Promise<CatalogSnapshot | undefined> {
    options.signal?.throwIfAborted();
    const snapshot = this.snapshots.get(providerId);
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }

  async write(
    providerId: string,
    snapshot: CatalogSnapshot,
    options: CatalogStoreOperationOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    this.snapshots.set(providerId, validateCatalogSnapshot(snapshot, providerId));
  }

  async delete(providerId: string, options: CatalogStoreOperationOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    this.snapshots.delete(providerId);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Atomic JSON store using one independently locked file per provider. */
export class FileCatalogStore implements CatalogStore {
  readonly directory: string;
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  read(
    providerId: string,
    options: CatalogStoreOperationOptions = {},
  ): Promise<CatalogSnapshot | undefined> {
    return this.enqueue(providerId, async () => {
      options.signal?.throwIfAborted();
      const path = this.snapshotPath(providerId);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new CatalogStoreError(providerId, `Cannot read catalog snapshot ${path}`, {
          cause: error,
        });
      }
      options.signal?.throwIfAborted();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new CatalogStoreError(providerId, `Catalog snapshot ${path} is not valid JSON`, {
          cause: error,
        });
      }
      return validateCatalogSnapshot(parsed, providerId);
    });
  }

  write(
    providerId: string,
    snapshot: CatalogSnapshot,
    options: CatalogStoreOperationOptions = {},
  ): Promise<void> {
    return this.enqueue(providerId, () =>
      this.withLock(providerId, options.signal, async () => {
        options.signal?.throwIfAborted();
        const validated = validateCatalogSnapshot(snapshot, providerId);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const path = this.snapshotPath(providerId);
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try {
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(`${JSON.stringify(validated, null, "\t")}\n`);
            await handle.sync();
          } finally {
            await handle.close();
          }
          options.signal?.throwIfAborted();
          await rename(temporary, path);
        } catch (error) {
          options.signal?.throwIfAborted();
          throw new CatalogStoreError(providerId, `Cannot write catalog snapshot ${path}`, {
            cause: error,
          });
        } finally {
          await rm(temporary, { force: true });
        }
      }),
    );
  }

  delete(providerId: string, options: CatalogStoreOperationOptions = {}): Promise<void> {
    return this.enqueue(providerId, () =>
      this.withLock(providerId, options.signal, async () => {
        options.signal?.throwIfAborted();
        try {
          await rm(this.snapshotPath(providerId), { force: true });
        } catch (error) {
          throw new CatalogStoreError(providerId, "Cannot delete catalog snapshot", {
            cause: error,
          });
        }
      }),
    );
  }

  private snapshotPath(providerId: string): string {
    if (!PROVIDER_IDENTIFIER.test(providerId)) {
      throw new CatalogStoreError(providerId, `Invalid catalog provider ID ${providerId}`);
    }
    return resolve(this.directory, `${providerId}.json`);
  }

  private enqueue<Result>(providerId: string, task: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(providerId) ?? Promise.resolve();
    const queued = previous.then(task, task);
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(providerId, tail);
    void tail.then(() => {
      if (this.tails.get(providerId) === tail) this.tails.delete(providerId);
    });
    return queued;
  }

  private async withLock<Result>(
    providerId: string,
    signal: AbortSignal | undefined,
    task: () => Promise<Result>,
  ): Promise<Result> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = `${this.snapshotPath(providerId)}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      signal?.throwIfAborted();
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid} ${Date.now()}\n`);
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new CatalogStoreError(providerId, "Cannot lock catalog snapshot", { cause: error });
        }
        if (await this.removeStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new CatalogStoreError(providerId, "Timed out locking catalog snapshot");
        }
        await sleep(LOCK_RETRY_MS, signal);
      }
    }
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      await rm(lockPath, { force: true });
    }
  }

  private async removeStaleLock(lockPath: string): Promise<boolean> {
    try {
      const contents = await readFile(lockPath, "utf8");
      const [rawPid, rawTime] = contents.trim().split(" ");
      const pid = Number(rawPid);
      const lockedAt = Number(rawTime);
      if (
        !Number.isSafeInteger(pid) ||
        !Number.isFinite(lockedAt) ||
        Date.now() - lockedAt <= LOCK_STALE_MS
      ) {
        return false;
      }
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
      await rm(lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}
