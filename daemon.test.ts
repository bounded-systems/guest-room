/**
 * daemon.ts smoke tests — the shared door-daemon scaffolding. Pure: socket-path
 * resolution, CLI arg parsing, the structured log format, and stale-socket
 * cleanup. The runDir function is injected (the seam that keeps this module
 * guest-agnostic), so the tests supply their own.
 */
import { describe, test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import {
  defaultSocketPath, prepareSocket, parseArgs, createLogger,
  type Env,
} from "./daemon.ts";

const runDir: (env: Env) => string = (env) => env.RUN_DIR ?? `${tmpdir()}/gr-rundir`;

describe("defaultSocketPath", () => {
  test("XDG_RUNTIME_DIR wins (systemd convention)", () => {
    expect(defaultSocketPath("keep", runDir, { XDG_RUNTIME_DIR: "/run/user/1000" }))
      .toBe("/run/user/1000/keep.sock");
  });

  test("falls back to runDir(env) and creates it", () => {
    const dir = mkdtempSync(`${tmpdir()}/gr-daemon-`);
    const path = defaultSocketPath("keep", runDir, { RUN_DIR: `${dir}/sub` });
    expect(path).toBe(`${dir}/sub/keep.sock`);
    expect(existsSync(`${dir}/sub`)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parseArgs", () => {
  const env: Env = {}; // no XDG, no NAME_SOCK → default path
  test("reads the command and a default socket from the daemon name", () => {
    const { command, socket } = parseArgs("keep", ["serve"], runDir, env);
    expect(command).toBe("serve");
    expect(socket.endsWith("/keep.sock")).toBe(true);
  });
  test("--socket / --unix / -s override the path", () => {
    for (const flag of ["--socket", "--unix", "-s"]) {
      expect(parseArgs("keep", ["serve", flag, "/tmp/x.sock"], runDir, env).socket).toBe("/tmp/x.sock");
    }
  });
  test("--port parses a TCP port", () => {
    expect(parseArgs("keep", ["serve", "--port", "3128"], runDir, env).port).toBe(3128);
  });
  test("the NAME_SOCK env var is the default when set", () => {
    expect(parseArgs("keep", ["serve"], runDir, { KEEP_SOCK: "/env/keep.sock" }).socket)
      .toBe("/env/keep.sock");
  });
});

describe("createLogger", () => {
  test("emits `<name> <ISO> <LEVEL> <message>`", () => {
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (s: string) => { out.push(s); return true; };
    try {
      createLogger("keep")("INFO", "listening");
    } finally {
      (process.stdout as { write: unknown }).write = orig;
    }
    expect(out[0]).toMatch(/^keep \d{4}-\d{2}-\d{2}T[\d:.]+Z INFO listening\n$/);
  });
});

describe("prepareSocket", () => {
  test("unlinks a stale socket file and returns the path", () => {
    const path = `${tmpdir()}/gr-stale-${crypto.randomUUID()}.sock`;
    writeFileSync(path, "");
    expect(existsSync(path)).toBe(true);
    expect(prepareSocket(path)).toBe(path);
    expect(existsSync(path)).toBe(false);
  });
  test("is a no-op when nothing is there", () => {
    const path = `${tmpdir()}/gr-absent-${crypto.randomUUID()}.sock`;
    expect(prepareSocket(path)).toBe(path);
  });
});
