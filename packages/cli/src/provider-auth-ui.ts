// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

import type { AuthEvent, AuthPrompt } from "@axl/ai";
import type { TrustedProviderLoginAdapter } from "@axl/runtime";
import { promptLine, type SetupInput, type SetupOutput, sanitizeTerminalText } from "@axl/tui";

export function validatedAuthorizationUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error("Provider supplied an invalid authorization URL", { cause });
  }
  if (url.protocol !== "https:") {
    throw new Error("Provider authorization URLs must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Provider authorization URLs must not contain credentials");
  }
  return url;
}

interface BrowserProcess {
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

type BrowserLauncher = (file: string, args: readonly string[]) => BrowserProcess;

export function openAuthorizationUrl(
  url: URL,
  output: SetupOutput,
  launch: BrowserLauncher = (file, args) => spawn(file, args, { detached: true, stdio: "ignore" }),
): void {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url.href] }
      : process.platform === "win32"
        ? { file: "rundll32", args: ["url.dll,FileProtocolHandler", url.href] }
        : { file: "xdg-open", args: [url.href] };
  const child = launch(command.file, command.args);
  child.once("error", (error) => {
    output.write(`  Could not open the authorization URL automatically: ${safe(error.message)}\n`);
  });
  child.unref();
}

function safe(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

async function answerPrompt(
  input: SetupInput,
  output: SetupOutput,
  prompt: AuthPrompt,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (prompt.type === "select") {
    output.write(`${safe(prompt.message)}\n`);
    prompt.options.forEach((option, index) => {
      const description = option.description ? `: ${safe(option.description)}` : "";
      output.write(`  ${index + 1}. ${safe(option.label)}${description}\n`);
    });
    while (true) {
      const answer = await promptLine(input, output, "  Select: ", { signal });
      const numeric = Number(answer);
      const selected = Number.isSafeInteger(numeric) ? prompt.options[numeric - 1] : undefined;
      const byId = prompt.options.find((option) => option.id === answer);
      if (selected !== undefined || byId !== undefined) return (selected ?? byId)?.id as string;
      output.write("  Choose one of the listed options.\n");
    }
  }
  return promptLine(input, output, `  ${safe(prompt.message)}: `, {
    mask: prompt.type === "secret" || prompt.type === "manual_code",
    signal,
  });
}

function presentEvent(output: SetupOutput, event: AuthEvent): void {
  if (event.type === "state") return;
  if (event.type === "auth_url") {
    const url = validatedAuthorizationUrl(event.url);
    output.write(`  ${safe(event.instructions ?? "Complete authorization in your browser.")}\n`);
    output.write(`  ${url.href}\n`);
    openAuthorizationUrl(url, output);
    return;
  }
  if (event.type === "device_code") {
    const url = validatedAuthorizationUrl(event.verificationUri);
    output.write(`  Open ${url.href}\n  Code: ${safe(event.userCode)}\n`);
    openAuthorizationUrl(url, output);
    return;
  }
  output.write(`  ${safe(event.message)}\n`);
  if (event.type === "info") {
    for (const link of event.links ?? []) {
      const url = validatedAuthorizationUrl(link.url);
      output.write(`  ${safe(link.label ?? "Open")}: ${url.href}\n`);
    }
  }
}

/** Keeps provider prompts and answers inside the trusted daemon process host. */
export function createTerminalProviderLoginAdapter(
  input: SetupInput,
  output: SetupOutput,
): TrustedProviderLoginAdapter {
  return {
    createInteraction: ({ signal }) => {
      if (input.isTTY !== true || output.isTTY !== true) {
        throw new Error(
          "Interactive provider login requires a terminal attached to the daemon host",
        );
      }
      return {
        signal,
        prompt: (prompt) => answerPrompt(input, output, prompt, signal),
        notify: (event) => presentEvent(output, event),
      };
    },
  };
}
