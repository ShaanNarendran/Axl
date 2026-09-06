// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

const sinks = new AsyncLocalStorage<(values: readonly string[]) => void>();

export function withResolvedSecretSink<Result>(
  sink: ((values: readonly string[]) => void) | undefined,
  operation: () => Promise<Result>,
): Promise<Result> {
  return sink === undefined ? operation() : sinks.run(sink, operation);
}

export function registerResolvedSecrets(values: readonly string[]): void {
  sinks.getStore()?.(values);
}
