// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

export const MAX_SSE_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_SSE_LINE_BYTES = 1024 * 1024;
export const MAX_SSE_EVENT_NAME_BYTES = 256;
export const MAX_SSE_DATA_LINES = 1_024;
export const MAX_SSE_FRAME_DATA_BYTES = 4 * 1024 * 1024;

/** One server-sent event: optional event name plus joined data lines. */
export interface SseFrame {
  readonly event?: string;
  readonly data: string;
}

/**
 * Decodes a byte stream into server-sent-event frames. Pure with respect to
 * transport: chunk boundaries may fall anywhere, CRLF and LF both terminate
 * lines, comment lines are ignored, and multi-line data is joined with
 * newlines per the SSE specification.
 */
export async function* decodeSseStream(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseFrame, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let data: string[] = [];
  let dataBytes = 0;
  let totalBytes = 0;
  const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

  function* drainLines(): Generator<SseFrame> {
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (byteLength(line) > MAX_SSE_LINE_BYTES)
        throw new TypeError("SSE line exceeds its byte limit");
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        if (data.length > 0) {
          yield { ...(eventName === undefined ? {} : { event: eventName }), data: data.join("\n") };
        }
        eventName = undefined;
        data = [];
        dataBytes = 0;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") {
          if (byteLength(value) > MAX_SSE_EVENT_NAME_BYTES)
            throw new TypeError("SSE event name exceeds its byte limit");
          eventName = value;
        } else if (field === "data") {
          if (data.length >= MAX_SSE_DATA_LINES)
            throw new TypeError("SSE frame exceeds its data-line limit");
          dataBytes += byteLength(value) + (data.length === 0 ? 0 : 1);
          if (dataBytes > MAX_SSE_FRAME_DATA_BYTES)
            throw new TypeError("SSE frame data exceeds its byte limit");
          data.push(value);
        }
      }
      newline = buffer.indexOf("\n");
    }
  }

  for await (const chunk of source) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_SSE_TOTAL_BYTES)
      throw new TypeError("SSE response exceeds its byte limit");
    buffer += decoder.decode(chunk, { stream: true });
    if (!buffer.includes("\n") && byteLength(buffer) > MAX_SSE_LINE_BYTES)
      throw new TypeError("SSE pending line exceeds its byte limit");
    yield* drainLines();
  }
  // End of source terminates any partial line and flushes the pending frame.
  buffer += `${decoder.decode()}\n\n`;
  yield* drainLines();
}
