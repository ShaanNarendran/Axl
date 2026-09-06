// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

// Google Vertex AI dialect, endpoint, and request authentication policy.

import type { JsonObject } from "@axl/protocol";

import type { ModelInfo, ModelStreamEvent } from "./model.ts";
import {
  decodeGoogleStream,
  type EncodedGoogleRequest,
  encodeGoogleRequest,
  type GoogleDecodeOptions,
} from "./google-shared.ts";
import type { PreparedModelRequest } from "./request-preparation.ts";
import type { SseFrame } from "./sse.ts";
import { stripTrailingSlashes } from "./transport-safety.ts";

export const DEFAULT_GOOGLE_VERTEX_API_VERSION = "v1";

const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const API_VERSION_PATTERN = /^v\d+(?:beta\d+)?$/;
const RESOURCE_SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;
const MODEL_SEGMENT_PATTERN = /^[A-Za-z0-9._~@-]+$/;

export class GoogleVertexCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GoogleVertexCodecError";
  }
}

export type GoogleVertexCredentialPolicy =
  | {
      readonly type: "api_key";
      readonly apiKey: string;
    }
  | {
      readonly type: "adc";
      readonly accessToken: string;
    }
  | {
      readonly type: "service_account";
      readonly accessToken: string;
      /** Used by the later token acquisition layer and never sent to Vertex. */
      readonly credentialsFile: string;
    };

export interface GoogleVertexRequestPolicy {
  readonly credential: GoogleVertexCredentialPolicy;
  readonly project?: string;
  readonly location?: string;
  /** Optional collection endpoint for a proxy or private service route. */
  readonly baseUrl?: string;
  readonly apiVersion?: string;
}

export interface EncodedGoogleVertexRequest {
  readonly url: string;
  readonly body: JsonObject;
  readonly headers: Readonly<Record<string, string>>;
}

export type GoogleVertexDecodeOptions = GoogleDecodeOptions;

function nonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new GoogleVertexCodecError(`Google Vertex ${label} is required`);
  return trimmed;
}

function safeHeaderValue(value: string, label: string): string {
  if (/[\r\n]/.test(value)) {
    throw new GoogleVertexCodecError(`Google Vertex ${label} contains invalid characters`);
  }
  return value;
}

function resourceSegment(value: string | undefined, label: string): string {
  const segment = nonEmpty(value, label);
  if (!RESOURCE_SEGMENT_PATTERN.test(segment)) {
    throw new GoogleVertexCodecError(`Google Vertex ${label} is invalid`);
  }
  return segment;
}

function apiVersion(value: string | undefined): string {
  const version = value?.trim() || DEFAULT_GOOGLE_VERTEX_API_VERSION;
  if (!API_VERSION_PATTERN.test(version)) {
    throw new GoogleVertexCodecError("Google Vertex API version is invalid");
  }
  return version;
}

function modelResource(modelId: string): string {
  const id = nonEmpty(modelId, "model ID");
  if (id.includes("..") || /[?#&]/.test(id)) {
    throw new GoogleVertexCodecError("Google Vertex model ID is invalid");
  }
  const segments = id.split("/");
  if (segments.some((segment) => !MODEL_SEGMENT_PATTERN.test(segment))) {
    throw new GoogleVertexCodecError("Google Vertex model ID is invalid");
  }
  if (id.startsWith("projects/") || id.startsWith("publishers/")) return id;
  if (segments.length === 1) return `publishers/google/models/${id}`;
  if (segments.length === 2) return `publishers/${segments[0]}/models/${segments[1]}`;
  throw new GoogleVertexCodecError("Google Vertex model ID has an unsupported resource shape");
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (cause) {
    throw new GoogleVertexCodecError("Google Vertex base URL is invalid", { cause });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new GoogleVertexCodecError("Google Vertex base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.hash) {
    throw new GoogleVertexCodecError("Google Vertex base URL contains unsupported URL data");
  }
  url.pathname = stripTrailingSlashes(url.pathname);
  return url;
}

function credentialType(
  credential: GoogleVertexCredentialPolicy,
): GoogleVertexCredentialPolicy["type"] {
  if (
    typeof credential !== "object" ||
    credential === null ||
    (credential.type !== "api_key" &&
      credential.type !== "adc" &&
      credential.type !== "service_account")
  ) {
    throw new GoogleVertexCodecError("Google Vertex credential policy is invalid");
  }
  return credential.type;
}

function standardBaseUrl(location: string, version: string): URL {
  const host =
    location === "global"
      ? "aiplatform.googleapis.com"
      : location === "us" || location === "eu"
        ? `aiplatform.${location}.rep.googleapis.com`
        : `${location}-aiplatform.googleapis.com`;
  return new URL(`https://${host}/${version}`);
}

function customBaseUrl(value: string, version: string): URL {
  const url = parseBaseUrl(value);
  const segments = url.pathname.split("/").filter(Boolean);
  if (!segments.some((segment) => API_VERSION_PATTERN.test(segment))) {
    url.pathname = `${url.pathname}/${version}`;
  }
  return url;
}

function appendResource(url: URL, resource: string): URL {
  const result = new URL(url);
  result.pathname = `${stripTrailingSlashes(result.pathname)}/${resource}:streamGenerateContent`;
  result.searchParams.set("alt", "sse");
  return result;
}

/**
 * Resolves the Vertex collection URL without acquiring credentials. API keys
 * select Express Mode. ADC and service-account tokens require project and
 * location and use the regional resource path. A custom URL is already a
 * collection URL, matching the Google SDK collection-scope behavior.
 */
export function googleVertexStreamUrl(modelId: string, policy: GoogleVertexRequestPolicy): string {
  const version = apiVersion(policy.apiVersion);
  const resource = modelResource(modelId);
  const type = credentialType(policy.credential);
  if (type === "api_key") {
    const base =
      policy.baseUrl === undefined
        ? new URL(`https://aiplatform.googleapis.com/${version}`)
        : customBaseUrl(policy.baseUrl, version);
    return appendResource(base, resource).toString();
  }

  const project = resourceSegment(policy.project, "project");
  const location = resourceSegment(policy.location, "location");
  if (policy.baseUrl !== undefined) {
    return appendResource(customBaseUrl(policy.baseUrl, version), resource).toString();
  }
  const base = standardBaseUrl(location, version);
  const scopedResource = resource.startsWith("projects/")
    ? resource
    : `projects/${project}/locations/${location}/${resource}`;
  return appendResource(base, scopedResource).toString();
}

function credentialHeaders(
  credential: GoogleVertexCredentialPolicy,
): Readonly<Record<string, string>> {
  credentialType(credential);
  if (credential.type === "api_key") {
    const key = safeHeaderValue(nonEmpty(credential.apiKey, "API key"), "API key");
    if (key === "gcp-vertex-credentials" || /^<[^>]+>$/.test(key)) {
      throw new GoogleVertexCodecError("Google Vertex API key is a placeholder");
    }
    return { "x-goog-api-key": key };
  }
  if (credential.type === "service_account") {
    nonEmpty(credential.credentialsFile, "service account credentials file");
  }
  const token = safeHeaderValue(nonEmpty(credential.accessToken, "access token"), "access token");
  return { authorization: `Bearer ${token}` };
}

/** Cloud OAuth scope required when the ADC or service-account layer acquires a token. */
export function googleVertexOAuthScope(): string {
  return GOOGLE_CLOUD_SCOPE;
}

/** Composes shared Google content with Vertex endpoint and credential policy. */
export function encodeGoogleVertexRequest(
  model: ModelInfo,
  request: PreparedModelRequest,
  policy: GoogleVertexRequestPolicy,
): EncodedGoogleVertexRequest {
  const encoded: EncodedGoogleRequest = encodeGoogleRequest(model, request, "google-vertex");
  return {
    url: googleVertexStreamUrl(encoded.modelId, policy),
    body: encoded.body,
    headers: { ...encoded.headers, ...credentialHeaders(policy.credential) },
  };
}

/** Decodes Vertex SSE through the shared Google response codec. */
export function decodeGoogleVertexStream(
  frames: AsyncIterable<SseFrame>,
  options: GoogleVertexDecodeOptions,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  return decodeGoogleStream(frames, options, "google-vertex");
}
