// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import type { SafeProviderDiagnostic } from "@axl/protocol";

const REDACTED = "[REDACTED]";
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 2_000;

/** Redacts resolved credential values and bounds text before it reaches a diagnostic or event. */
export function safeProviderMessage(message: string, secretValues: readonly string[] = []): string {
  let safe = message;
  const uniqueSecrets = [...new Set(secretValues.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of uniqueSecrets) safe = safe.split(secret).join(REDACTED);
  return safe.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
}

export function safeProviderDiagnostic(
  code: string,
  message: string,
  severity: SafeProviderDiagnostic["severity"],
  secretValues: readonly string[] = [],
): SafeProviderDiagnostic {
  return { code, message: safeProviderMessage(message, secretValues), severity };
}
