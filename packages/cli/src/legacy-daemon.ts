// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { WIRE_PROTOCOL_VERSION } from "@axl/protocol";
import { localSandboxStateKey } from "@axl/runtime";

const execute = promisify(execFile);

export interface LegacyDaemonTarget {
  readonly entryPath: string;
  readonly socketPath: string;
  readonly stateDirectory: string;
  readonly unsafe: boolean;
  readonly sandbox: "native" | "podman" | "docker";
  readonly image?: string;
}

export interface LegacyDaemonStatus {
  readonly hostControl: false;
  readonly wireVersion: number;
  readonly pid: number;
  /** Linux pidfs identity, not just a reusable PID. */
  readonly processIdentity: string;
  readonly dataDirectory: string;
  readonly socketPath: string;
  readonly socketIdentity: string;
  readonly lockToken: string;
  readonly activity: "unknown";
}

async function utility(name: "getino" | "kill" | "waitpid", args: string[]): Promise<string> {
  try {
    return (
      await execute(`/usr/bin/${name}`, args, { timeout: 15_000, maxBuffer: 16_384 })
    ).stdout.trim();
  } catch (cause) {
    throw new Error(
      `Verified daemon recovery failed in ${name}: ${cause instanceof Error ? cause.message : "unknown error"}. Linux pidfs and util-linux getino, kill, and waitpid with PID:inode support are required; inspect daemon status before retrying.`,
      { cause },
    );
  }
}

async function processIdentity(pid: number): Promise<string> {
  const identity = await utility("getino", ["--pidfs", "--print-pid", String(pid)]);
  if (!new RegExp(`^${pid}:[1-9][0-9]*$`).test(identity)) {
    throw new Error("Could not establish the daemon's non-reusable process identity");
  }
  return identity;
}

async function legacyWireVersion(socketPath: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => finish(new Error("Legacy daemon greeting timed out")), 2_000);
    let buffer = "";
    const finish = (error?: Error, version?: number): void => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (version !== undefined) resolvePromise(version);
    };
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("Legacy daemon closed without a greeting")));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 16_384) {
        finish(new Error("Legacy daemon greeting is too large"));
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const greeting = JSON.parse(buffer.slice(0, end)) as {
          kind?: unknown;
          wireVersion?: unknown;
        };
        if (
          greeting?.kind !== "hello" ||
          !Number.isSafeInteger(greeting.wireVersion) ||
          (greeting.wireVersion as number) < 1 ||
          (greeting.wireVersion as number) >= WIRE_PROTOCOL_VERSION
        ) {
          throw new Error("Socket did not identify an older Axl daemon");
        }
        finish(undefined, greeting.wireVersion as number);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Invalid legacy daemon greeting"));
      }
    });
  });
}

/** Read-only OS verification. No session handshake bypass and no PID-only signaling. */
export async function inspectLegacyDaemon(target: LegacyDaemonTarget): Promise<LegacyDaemonStatus> {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error(
      "Verified legacy daemon recovery requires Linux; manually verify the process on this platform",
    );
  }
  const uid = process.getuid();
  const dataDirectory = await realpath(target.stateDirectory);
  const socketPath = resolve(target.socketPath);
  const lockPath = join(dataDirectory, ".axl-data.lock");
  const [directory, socket, lock] = await Promise.all([
    lstat(dataDirectory),
    lstat(socketPath),
    lstat(lockPath),
  ]);
  if (
    !directory.isDirectory() ||
    !socket.isSocket() ||
    !lock.isFile() ||
    lock.size > 4096 ||
    [directory, socket, lock].some((stat) => stat.uid !== uid || (stat.mode & 0o077) !== 0)
  ) {
    throw new Error(
      "Legacy daemon directory, socket, and lock must be owner-only and must not be symlinks",
    );
  }
  const lockText = await readFile(lockPath, "utf8");
  const record = JSON.parse(lockText) as {
    version?: unknown;
    owner?: unknown;
    pid?: unknown;
    token?: unknown;
  };
  if (
    record?.version !== 1 ||
    record.owner !== "daemon" ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 1 ||
    record.pid === process.pid ||
    typeof record.token !== "string" ||
    !record.token ||
    record.token.length > 128
  ) {
    throw new Error("Legacy daemon lock does not identify a valid daemon owner");
  }
  const pid = record.pid as number;
  const identity = await processIdentity(pid);
  const proc = `/proc/${pid}`;
  if (
    (await lstat(proc)).uid !== uid ||
    (await readlink(`${proc}/exe`)) !== (await realpath(process.execPath))
  ) {
    throw new Error("Legacy daemon executable or process owner does not match this Axl host");
  }
  const args = (await readFile(`${proc}/cmdline`, "utf8")).split("\0").filter(Boolean);
  const command = args.indexOf("daemon");
  const entry = args[command - 1];
  const currentEntry = target.entryPath;
  if (
    command < 2 ||
    entry === undefined ||
    currentEntry === undefined ||
    (await realpath(resolve(await readlink(`${proc}/cwd`), entry))) !==
      (await realpath(currentEntry))
  ) {
    throw new Error("Socket owner is not running the selected Axl daemon entry point");
  }
  const options = args.slice(command + 1);
  const value = (flag: string): string | undefined => {
    const at = options.indexOf(flag);
    if (at < 0) return undefined;
    if (options.lastIndexOf(flag) !== at || options[at + 1] === undefined)
      throw new Error("Ambiguous daemon command arguments");
    return options[at + 1];
  };
  if (
    options.includes("--unsafe") !== target.unsafe ||
    (value("--sandbox") ?? "native") !== target.sandbox ||
    value("--image") !== target.image ||
    resolve(value("--socket") ?? join(dataDirectory, "axl.sock")) !== socketPath
  ) {
    throw new Error(
      "Legacy daemon placement or socket does not match the requested target; no process was stopped",
    );
  }
  // Read only HOME from the process environment; never report or retain credential values.
  const home = (await readFile(`${proc}/environ`, "utf8"))
    .split("\0")
    .find((entry) => entry.startsWith("HOME="))
    ?.slice(5);
  if (!home) throw new Error("Cannot verify the legacy daemon's data directory without HOME");
  const stateKey = target.unsafe
    ? "unsafe"
    : localSandboxStateKey(
        target.sandbox === "native"
          ? { type: "native" }
          : { type: "oci", engine: target.sandbox, image: target.image ?? "" },
      );
  if ((await realpath(join(home, ".axl", stateKey ?? ""))) !== dataDirectory) {
    throw new Error(
      "Legacy daemon data directory does not match the selected placement; no process was stopped",
    );
  }
  const listeners = (await readFile(`${proc}/net/unix`, "utf8")).split("\n").flatMap((line) => {
    const match = /^\S+\s+\S+\s+\S+\s+00010000\s+0001\s+01\s+([0-9]+)\s+(.+)$/.exec(line);
    return match?.[2] === socketPath ? [match[1]] : [];
  });
  if (listeners.length !== 1)
    throw new Error("Could not uniquely identify the daemon's listening socket");
  let ownsListener = false;
  for (const fd of await readdir(`${proc}/fd`)) {
    try {
      if ((await readlink(`${proc}/fd/${fd}`)) === `socket:[${listeners[0]}]`) ownsListener = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!ownsListener)
    throw new Error(
      "The lock PID does not own the selected listening socket; no process was stopped",
    );
  const wireVersion = await legacyWireVersion(socketPath);
  const currentSocket = await lstat(socketPath);
  if (
    (await processIdentity(pid)) !== identity ||
    (await readFile(lockPath, "utf8")) !== lockText ||
    currentSocket.dev !== socket.dev ||
    currentSocket.ino !== socket.ino
  ) {
    throw new Error("Legacy daemon identity changed during verification");
  }
  return {
    hostControl: false,
    wireVersion,
    pid,
    processIdentity: identity,
    dataDirectory,
    socketPath,
    socketIdentity: `${socket.dev}:${socket.ino}`,
    lockToken: record.token,
    activity: "unknown",
  };
}

/** Explicit graceful recovery only. Utilities address the verified PID:inode, never a bare PID. */
export async function stopLegacyDaemon(
  target: LegacyDaemonTarget,
  status: LegacyDaemonStatus,
): Promise<void> {
  const current = await inspectLegacyDaemon(target);
  if (JSON.stringify(current) !== JSON.stringify(status))
    throw new Error("Legacy daemon changed; inspect it again before stopping");
  // Verify required utilities before sending anything to the daemon.
  const killHelp = await utility("kill", ["--help"]);
  const waitHelp = await utility("waitpid", ["--help"]);
  if (!killHelp.includes("pidfd_ino") || !waitHelp.includes("PID[:inode]")) {
    throw new Error("Installed process utilities lack PID:inode support; no process was stopped");
  }
  await utility("kill", ["--signal", "TERM", "--require-handler", "--", status.processIdentity]);
  await utility("waitpid", ["--exited", "--timeout", "10", status.processIdentity]);
}
