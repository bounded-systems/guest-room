/**
 * protocol.ts smoke tests — the door wire format every daemon speaks.
 * Covers the envelope helpers, the server-side line handler (parse → dispatch →
 * response, incl. the error paths), and one real unix-socket round-trip through
 * `call` so the client and server halves are proven against each other.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import {
  ok, err, createDoorHandlers, call,
  type ResponseEnvelope,
} from "./protocol.ts";

const noop = () => {};

describe("envelope helpers", () => {
  test("ok wraps a result", () => {
    expect(ok("1", { v: 42 })).toEqual({ id: "1", ok: true, result: { v: 42 } });
  });
  test("err carries code + message", () => {
    expect(err("2", "BOOM", "it broke")).toEqual({
      id: "2", ok: false, error: { code: "BOOM", message: "it broke" },
    });
  });
});

// A minimal stand-in for Bun's Socket: captures writes, holds a `data` bag.
function fakeSocket() {
  const writes: string[] = [];
  const socket = { data: undefined as unknown, write: (s: string) => { writes.push(s); } };
  return { socket: socket as never, replies: () => writes.map((w) => JSON.parse(w) as ResponseEnvelope) };
}

describe("createDoorHandlers (server side)", () => {
  const handlers = createDoorHandlers(
    "test",
    {
      greet: (p) => ({ message: `hello ${p.name}` }),
      boom: () => { throw new Error("nope"); },
    },
    noop,
  );
  const feed = async (fs: ReturnType<typeof fakeSocket>, line: string) =>
    handlers.data(fs.socket, new TextEncoder().encode(line));

  test("dispatches a known method and returns its result", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    await feed(fs, JSON.stringify({ id: "1", method: "greet", params: { name: "world" } }) + "\n");
    expect(fs.replies()[0]).toEqual({ id: "1", ok: true, result: { message: "hello world" } });
  });

  test("unknown method → UNKNOWN_METHOD", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    await feed(fs, JSON.stringify({ id: "2", method: "nope" }) + "\n");
    expect(fs.replies()[0]).toMatchObject({ id: "2", ok: false, error: { code: "UNKNOWN_METHOD" } });
  });

  test("a throwing handler → HANDLER_ERROR with the message", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    await feed(fs, JSON.stringify({ id: "3", method: "boom" }) + "\n");
    expect(fs.replies()[0]).toMatchObject({ id: "3", ok: false, error: { code: "HANDLER_ERROR", message: "nope" } });
  });

  test("invalid JSON → PARSE_ERROR", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    await feed(fs, "{not json\n");
    expect(fs.replies()[0]).toMatchObject({ ok: false, error: { code: "PARSE_ERROR" } });
  });

  test("buffers a line split across chunks", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    const line = JSON.stringify({ id: "4", method: "greet", params: { name: "split" } }) + "\n";
    await feed(fs, line.slice(0, 10));
    expect(fs.replies()).toHaveLength(0); // nothing complete yet
    await feed(fs, line.slice(10));
    expect(fs.replies()[0]).toEqual({ id: "4", ok: true, result: { message: "hello split" } });
  });
});

describe("call ↔ createDoorHandlers over a real unix socket", () => {
  let sockPath = "";
  let server: { stop: () => void } | undefined;
  afterEach(() => { server?.stop(); try { unlinkSync(sockPath); } catch {} });

  test("round-trips a result and propagates an error", async () => {
    sockPath = `${tmpdir()}/gr-proto-${crypto.randomUUID()}.sock`;
    server = Bun.listen({
      unix: sockPath,
      socket: createDoorHandlers("test", {
        echo: (p) => ({ echoed: p.value }),
        fail: () => { throw new Error("boom"); },
      }, noop),
    });

    const res = await call<{ echoed: unknown }>(sockPath, "echo", { value: 7 });
    expect(res).toEqual({ echoed: 7 });

    await expect(call(sockPath, "fail")).rejects.toThrow("boom");
  });
});
