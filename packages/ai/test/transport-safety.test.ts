// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_JSON_RESPONSE_BYTES,
  readBoundedJson,
  safeEndpoint,
  stripTrailingSlashes,
} from "../src/index.ts";

test("endpoint policy permits HTTPS and explicit loopback HTTP only", () => {
  assert.equal(
    safeEndpoint("https://example.com/v1///", { label: "test" }),
    "https://example.com/v1",
  );
  assert.equal(
    safeEndpoint("http://127.0.0.1:11434/v1", { label: "test", allowLoopbackHttp: true }),
    "http://127.0.0.1:11434/v1",
  );
  for (const value of [
    "http://example.com/v1",
    "https://10.0.0.1/v1",
    "https://169.254.169.254/v1",
    "https://[::1]/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1#fragment",
  ])
    assert.throws(() => safeEndpoint(value, { label: "test" }));
  assert.throws(() =>
    safeEndpoint("https://other.example/v1", {
      label: "test",
      expectedOrigin: "https://example.com/catalog",
    }),
  );
});

test("trailing slash removal is linear and handles long non-matching input", () => {
  const value = `${"/".repeat(100_000)}x`;
  assert.equal(stripTrailingSlashes(value), value);
  assert.equal(stripTrailingSlashes(`${value}///`), value);
});

test("bounded JSON rejects declared and chunked response overflow", async () => {
  await assert.rejects(
    readBoundedJson(
      new Response("{}", { headers: { "content-length": String(MAX_JSON_RESPONSE_BYTES + 1) } }),
    ),
    /exceeds/,
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(Math.floor(MAX_JSON_RESPONSE_BYTES / 2)));
        controller.enqueue(new Uint8Array(Math.floor(MAX_JSON_RESPONSE_BYTES / 2) + 1));
        controller.close();
      },
    }),
  );
  await assert.rejects(readBoundedJson(response), /exceeds/);
});
