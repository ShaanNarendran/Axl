// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

// Preload an independently simulated wire-8 daemon before the current CLI entry.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const directory = join(homedir(), ".axl", "unsafe");
const socketPath = process.argv[process.argv.indexOf("--socket") + 1];
await mkdir(directory, { recursive: true, mode: 0o700 });
const lockPath = join(directory, ".axl-data.lock");
await writeFile(lockPath, JSON.stringify({ version: 1, owner: "daemon", pid: process.pid, token: randomUUID(), acquiredAt: Date.now() }), { mode: 0o600 });
const peers = new Set();
const server = createServer((peer) => {
  peers.add(peer);
  peer.on("close", () => peers.delete(peer));
  peer.on("error", () => peer.destroy());
  peer.write(`${JSON.stringify({ kind: "hello", wireVersion: 8, daemonInstanceId: randomUUID(), capabilities: [], limits: { maxMessageBytes: 1048576, maxPendingRequests: 32 } })}\n`);
  peer.on("data", () => peer.end(`${JSON.stringify({ kind: "error", id: -1, error: { code: "bad_request", message: "unknown request", retryable: false } })}\n`));
});
await new Promise((resolve) => server.listen(socketPath, resolve));
await chmod(socketPath, 0o600);
process.on("SIGTERM", async () => {
  for (const peer of peers) peer.destroy();
  await new Promise((resolve) => server.close(resolve));
  await unlink(lockPath);
  process.exit(0);
});
process.send?.("ready");
await new Promise(() => {});
