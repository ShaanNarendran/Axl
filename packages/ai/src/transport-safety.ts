// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

export const MAX_ENDPOINT_LENGTH = 4_096;
export const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (isIP(host) !== 4) return false;
  return Number(host.split(".")[0]) === 127;
}

function isDisallowedIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const octets = hostname.split(".").map(Number);
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isDisallowedIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) !== 6) return false;
  if (host === "::" || host === "::1" || host.startsWith("ff")) return true;
  if (host.startsWith("::ffff:")) return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(host)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
  return mapped !== undefined && isDisallowedIpv4(mapped);
}

export interface EndpointPolicyOptions {
  readonly label: string;
  readonly allowLoopbackHttp?: boolean;
  readonly allowQuery?: boolean;
  readonly expectedOrigin?: string;
}

/** Validates and normalizes an endpoint before credentials or prompts can reach it. */
export function safeEndpoint(value: string, options: EndpointPolicyOptions): string {
  if (value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw new TypeError(`${options.label} has an invalid length`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${options.label} is not a valid URL`);
  }
  if (url.username || url.password || (url.search && options.allowQuery !== true) || url.hash) {
    throw new TypeError(`${options.label} must not contain credentials, a query, or a fragment`);
  }
  const loopback = isLoopback(url.hostname);
  if (url.protocol !== "https:" && !(options.allowLoopbackHttp === true && loopback)) {
    throw new TypeError(`${options.label} must use HTTPS, except for explicit loopback HTTP`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    (loopback && options.allowLoopbackHttp !== true) ||
    (!loopback && (isDisallowedIpv4(hostname) || isDisallowedIpv6(hostname))) ||
    hostname.endsWith(".local")
  ) {
    throw new TypeError(`${options.label} resolves to a disallowed destination`);
  }
  if (options.expectedOrigin !== undefined) {
    const expected = safeEndpoint(options.expectedOrigin, {
      label: `${options.label} source`,
      ...(options.allowLoopbackHttp === undefined
        ? {}
        : { allowLoopbackHttp: options.allowLoopbackHttp }),
    });
    if (url.origin !== new URL(expected).origin) {
      throw new TypeError(`${options.label} changed to an unapproved origin`);
    }
  }
  return stripTrailingSlashes(url.toString());
}

export function delayWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function raceWithSignal<Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function readBoundedBody(
  response: Pick<Response, "body" | "headers">,
  maximumBytes = MAX_JSON_RESPONSE_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new TypeError(`Provider response exceeds ${maximumBytes} bytes`);
  }
  if (response.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const result =
        signal === undefined ? await reader.read() : await raceWithSignal(reader.read(), signal);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes)
        throw new TypeError(`Provider response exceeds ${maximumBytes} bytes`);
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedJson(
  response: Pick<Response, "body" | "headers">,
  maximumBytes = MAX_JSON_RESPONSE_BYTES,
  signal?: AbortSignal,
): Promise<unknown> {
  const bytes = await readBoundedBody(response, maximumBytes, signal);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new TypeError("Provider response is not valid bounded JSON", { cause });
  }
}
