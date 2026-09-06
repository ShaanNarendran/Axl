// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

const decoder = new TextDecoder();
export const MAX_AWS_EVENT_STREAM_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_AWS_EVENT_STREAM_TOTAL_BYTES = 64 * 1024 * 1024;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function eventType(headers: Uint8Array): string {
  let offset = 0;
  while (offset < headers.length) {
    const nameLength = headers[offset];
    if (nameLength === undefined || offset + 2 + nameLength > headers.length)
      throw new TypeError("AWS event stream header is truncated");
    const name = decoder.decode(headers.subarray(offset + 1, offset + 1 + nameLength));
    const type = headers[offset + 1 + nameLength];
    offset += 2 + nameLength;
    if (type !== 7) throw new TypeError("AWS event stream uses an unsupported header type");
    if (offset + 2 > headers.length)
      throw new TypeError("AWS event stream header value is truncated");
    const length = new DataView(headers.buffer, headers.byteOffset + offset, 2).getUint16(0);
    offset += 2;
    if (offset + length > headers.length)
      throw new TypeError("AWS event stream header value is truncated");
    const value = decoder.decode(headers.subarray(offset, offset + length));
    offset += length;
    if (name === ":event-type" || name === ":exception-type") return value;
  }
  throw new TypeError("AWS event stream message has no event type");
}

/** Decodes checked AWS event-stream messages into SDK-shaped Bedrock events. */
export async function* decodeAwsEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  let storage = new Uint8Array(64 * 1024);
  let start = 0;
  let end = 0;
  let received = 0;
  for await (const chunk of body) {
    received += chunk.byteLength;
    if (received > MAX_AWS_EVENT_STREAM_TOTAL_BYTES)
      throw new TypeError("AWS event stream response exceeds its byte limit");
    const pending = end - start;
    if (pending + chunk.byteLength > MAX_AWS_EVENT_STREAM_FRAME_BYTES)
      throw new TypeError("AWS event stream pending data exceeds its byte limit");
    if (storage.length - end < chunk.byteLength) {
      const capacity = Math.max(storage.length * 2, pending + chunk.byteLength);
      const next = new Uint8Array(capacity);
      next.set(storage.subarray(start, end));
      storage = next;
      end = pending;
      start = 0;
    }
    storage.set(chunk, end);
    end += chunk.byteLength;
    while (end - start >= 16) {
      const view = new DataView(storage.buffer, storage.byteOffset + start, end - start);
      const total = view.getUint32(0);
      const headersLength = view.getUint32(4);
      if (total < 16 || total > MAX_AWS_EVENT_STREAM_FRAME_BYTES || headersLength > total - 16)
        throw new TypeError("AWS event stream message has invalid or oversized lengths");
      if (end - start < total) break;
      const message = storage.subarray(start, start + total);
      start += total;
      const messageView = new DataView(message.buffer, message.byteOffset, message.byteLength);
      if (crc32(message.subarray(0, 8)) !== messageView.getUint32(8))
        throw new TypeError("AWS event stream prelude checksum failed");
      if (crc32(message.subarray(0, total - 4)) !== messageView.getUint32(total - 4))
        throw new TypeError("AWS event stream message checksum failed");
      const type = eventType(message.subarray(12, 12 + headersLength));
      const payloadText = decoder.decode(message.subarray(12 + headersLength, total - 4));
      const payload = payloadText.length === 0 ? {} : (JSON.parse(payloadText) as unknown);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload))
        throw new TypeError("AWS event stream payload is malformed");
      yield { [type]: payload };
      if (start === end) start = end = 0;
    }
  }
  if (end !== start) throw new TypeError("AWS event stream ended with a partial message");
}
