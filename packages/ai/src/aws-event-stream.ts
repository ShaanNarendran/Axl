// SPDX-FileCopyrightText: 2026 Kaushik Kumar
// SPDX-License-Identifier: Apache-2.0

const decoder = new TextDecoder();

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
  let buffered = new Uint8Array();
  for await (const chunk of body) {
    const joined = new Uint8Array(buffered.length + chunk.length);
    joined.set(buffered);
    joined.set(chunk, buffered.length);
    buffered = joined;
    while (buffered.length >= 16) {
      const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength);
      const total = view.getUint32(0);
      const headersLength = view.getUint32(4);
      if (total < 16 || headersLength > total - 16)
        throw new TypeError("AWS event stream message has invalid lengths");
      if (buffered.length < total) break;
      const message = buffered.slice(0, total);
      buffered = buffered.slice(total);
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
    }
  }
  if (buffered.length !== 0) throw new TypeError("AWS event stream ended with a partial message");
}
