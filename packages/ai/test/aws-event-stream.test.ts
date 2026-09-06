// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { decodeAwsEventStream, MAX_AWS_EVENT_STREAM_FRAME_BYTES } from "../src/index.ts";

function stream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test("rejects oversized AWS frames from the prelude before buffering their body", async () => {
  const prelude = new Uint8Array(16);
  new DataView(prelude.buffer).setUint32(0, MAX_AWS_EVENT_STREAM_FRAME_BYTES + 1);
  await assert.rejects(
    Array.fromAsync(decodeAwsEventStream(stream([prelude]))),
    /oversized lengths/,
  );
});

test("rejects oversized AWS preludes split across chunk boundaries", async () => {
  const prelude = new Uint8Array(16);
  new DataView(prelude.buffer).setUint32(0, MAX_AWS_EVENT_STREAM_FRAME_BYTES + 1);
  await assert.rejects(
    Array.fromAsync(decodeAwsEventStream(stream([prelude.subarray(0, 7), prelude.subarray(7)]))),
    /oversized lengths/,
  );
});
