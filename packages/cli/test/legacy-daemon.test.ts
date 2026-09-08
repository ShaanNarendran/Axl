// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { AxlClientError } from "@axl/sdk";
import { createUnixDaemonHost } from "@axl/sdk/unix";
import { inspectLegacyDaemon, stopLegacyDaemon } from "../src/legacy-daemon.ts";

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/legacy-daemon.mjs", import.meta.url));
let unavailable: string | undefined;
try {
  if (process.platform !== "linux") throw new Error("Linux is required");
  execFileSync("/usr/bin/getino", ["--pidfs", String(process.pid)]);
  if (
    !execFileSync("/usr/bin/kill", ["--help"], { encoding: "utf8" }).includes("pidfd_ino") ||
    !execFileSync("/usr/bin/waitpid", ["--help"], { encoding: "utf8" }).includes("PID[:inode]")
  )
    throw new Error("PID:inode utilities are required");
} catch {
  unavailable = "Linux pidfs and util-linux PID:inode utilities are unavailable";
}

async function run(args: string[], home?: string) {
  const child = spawn(process.execPath, [entry, ...args], {
    env: { HOME: home ?? tmpdir(), PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data: Buffer) => {
    stdout += data;
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data;
  });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

async function stopOwnedChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

async function setup(t: TestContext, wrongEntry = false) {
  const home = await mkdtemp(join(tmpdir(), "axl-legacy-"));
  const directory = join(home, ".axl", "unsafe");
  const socket = join(directory, "axl.sock");
  const child = spawn(
    process.execPath,
    [
      ...(wrongEntry ? [fixture] : ["--import", fixture, entry]),
      "daemon",
      "--socket",
      socket,
      "--unsafe",
    ],
    {
      env: { HOME: home, PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let diagnostics = "";
  child.stderr?.on("data", (data: Buffer) => {
    diagnostics += data;
  });
  t.after(async () => {
    await stopOwnedChild(child);
    const host = createUnixDaemonHost(socket);
    try {
      await host.shutdown(await host.status(), { interrupt: true, confirmed: true });
    } catch (error) {
      if (!(error instanceof AxlClientError) || error.code !== "connection_error") throw error;
    }
    await rm(home, { recursive: true, force: true });
  });
  await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => {
      throw new Error(diagnostics);
    }),
  ]);
  const target = {
    entryPath: entry,
    socketPath: socket,
    stateDirectory: directory,
    unsafe: true,
    sandbox: "native" as const,
  };
  return { home, directory, socket, child, target, cli: (args: string[]) => run(args, home) };
}

test("daemon action flags explain the supported subcommand syntax", async () => {
  const result = await run(["daemon", "--restart"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Use axl daemon restart/);
});

test(
  "built CLI explicitly recovers a wire-8 daemon and preserves its session history",
  { skip: unavailable },
  async (t) => {
    const { cli, directory, child } = await setup(t);
    const status = await cli(["daemon", "status", "--unsafe"]);
    assert.equal(status.code, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    assert.equal(report.wireVersion, 8);
    assert.equal(report.hostControl, false);
    assert.equal(report.activity, "unknown");
    assert.match(report.processIdentity, /^[1-9][0-9]*:[1-9][0-9]*$/);
    for (const args of [["--unsafe"], ["--unsafe", "--yes"], ["--unsafe", "--interrupt"]]) {
      const refused = await cli(["daemon", "stop", ...args]);
      assert.equal(refused.code, 2, refused.stderr);
      assert.match(refused.stderr, /--interrupt --yes/);
      assert.equal(child.exitCode, null);
    }
    const mismatch = await cli(["--unsafe"]);
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.stderr, /wire version 8/);
    assert.equal(child.exitCode, null);
    const path = join(directory, "sessions", "00000000-0000-4000-8000-000000000001.jsonl");
    await mkdir(join(directory, "sessions"));
    const history = `${JSON.stringify({ version: 1, id: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000001", parentId: null, timestamp: 1, type: "session.created", payload: { cwd: directory } })}\n`;
    await writeFile(path, history);
    const restart = await cli(["daemon", "restart", "--unsafe", "--interrupt", "--yes"]);
    assert.equal(restart.code, 0, restart.stderr);
    assert.match(restart.stdout, /Stopped legacy daemon/);
    assert.equal(await readFile(path, "utf8"), history);
    const current = await cli(["daemon", "status", "--unsafe"]);
    assert.equal(current.code, 0, current.stderr);
    assert.notEqual(JSON.parse(current.stdout).pid, child.pid);
  },
);

test(
  "recovery refuses unverified lock owners and changed process identities",
  { skip: unavailable },
  async (t) => {
    const { cli, home, directory, child, target } = await setup(t);
    const original = await inspectLegacyDaemon(target);
    await assert.rejects(
      stopLegacyDaemon(target, { ...original, processIdentity: `${original.pid}:1` }),
      /changed/,
    );
    const lockPath = join(directory, ".axl-data.lock");
    const record = JSON.parse(await readFile(lockPath, "utf8"));
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    t.after(() => stopOwnedChild(unrelated));
    await writeFile(lockPath, JSON.stringify({ ...record, pid: unrelated.pid }));
    const refused = await cli(["daemon", "stop", "--unsafe", "--interrupt", "--yes"]);
    assert.equal(refused.code, 1);
    assert.equal(unrelated.exitCode, null);
    assert.equal(child.exitCode, null);
    await writeFile(lockPath, JSON.stringify(record));
    const wrongDirectory = join(home, ".axl", "different");
    await mkdir(wrongDirectory, { mode: 0o700 });
    await writeFile(join(wrongDirectory, ".axl-data.lock"), JSON.stringify(record), {
      mode: 0o600,
    });
    await assert.rejects(
      inspectLegacyDaemon({ ...target, stateDirectory: wrongDirectory }),
      /data directory/,
    );
    await assert.rejects(inspectLegacyDaemon({ ...target, unsafe: false }), /placement/);
    await chmod(lockPath, 0o644);
    await assert.rejects(inspectLegacyDaemon(target), /owner-only/);
    await chmod(lockPath, 0o600);
    const stopped = await cli(["daemon", "stop", "--unsafe", "--interrupt", "--yes"]);
    assert.equal(stopped.code, 0, stopped.stderr);
  },
);

test(
  "recovery refuses a socket owner running a different entry point",
  { skip: unavailable },
  async (t) => {
    const { cli, child } = await setup(t, true);
    const result = await cli(["daemon", "stop", "--unsafe", "--interrupt", "--yes"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /entry point/);
    assert.equal(child.exitCode, null);
  },
);
