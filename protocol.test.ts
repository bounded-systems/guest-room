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
  ok, err, createDoorHandlers, call, DoorCallError,
  constantTimeEqual, tokenAuthorizer,
  hmacSigner, hmacAuthorizer, canonicalRequest,
  type ResponseEnvelope, type RequestEnvelope,
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

describe("wire-token authentication (the tcp/vsock peer-identity stand-in)", () => {
  const TOKEN = "s3cret-per-launch-token";
  const handlers = createDoorHandlers(
    "test",
    { greet: (p) => ({ message: `hello ${p.name}` }) },
    noop,
    tokenAuthorizer(TOKEN),
  );
  const feed = async (fs: ReturnType<typeof fakeSocket>, line: string) =>
    handlers.data(fs.socket, new TextEncoder().encode(line));

  test("a request with the right token is served", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    await feed(fs, JSON.stringify({ id: "1", method: "greet", params: { name: "world" }, auth: TOKEN }) + "\n");
    expect(fs.replies()[0]).toEqual({ id: "1", ok: true, result: { message: "hello world" } });
  });

  test("a wrong token → UNAUTHENTICATED, and reaches no handler", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    await feed(fs, JSON.stringify({ id: "2", method: "greet", params: { name: "x" }, auth: "wrong" }) + "\n");
    expect(fs.replies()[0]).toMatchObject({ id: "2", ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  test("a missing token → UNAUTHENTICATED (fail closed)", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    await feed(fs, JSON.stringify({ id: "3", method: "greet", params: { name: "x" } }) + "\n");
    expect(fs.replies()[0]).toMatchObject({ id: "3", ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  test("no authorizer configured → backward compatible (auth not required)", async () => {
    const open = createDoorHandlers("test", { greet: (p) => ({ message: `hi ${p.name}` }) }, noop);
    const fs = fakeSocket(); open.open(fs.socket);
    await open.data(fs.socket, new TextEncoder().encode(JSON.stringify({ id: "4", method: "greet", params: { name: "y" } }) + "\n"));
    expect(fs.replies()[0]).toEqual({ id: "4", ok: true, result: { message: "hi y" } });
  });

  test("constantTimeEqual: equal iff identical, length-mismatch safe", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("HMAC-per-request authentication (authenticity + integrity + anti-replay)", () => {
  const KEY = "per-launch-shared-key";
  const sign = hmacSigner(KEY);
  const handlers = createDoorHandlers(
    "test",
    { greet: (p) => ({ message: `hello ${p.name}` }) },
    noop,
    hmacAuthorizer(KEY),
  );
  const feed = async (fs: ReturnType<typeof fakeSocket>, req: RequestEnvelope) =>
    handlers.data(fs.socket, new TextEncoder().encode(JSON.stringify(req) + "\n"));
  const signed = (id: string, name: string): RequestEnvelope => {
    const req: RequestEnvelope = { id, method: "greet", params: { name } };
    req.auth = sign(req);
    return req;
  };

  test("a correctly signed request is served", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    await feed(fs, signed("a", "world"));
    expect(fs.replies()[0]).toEqual({ id: "a", ok: true, result: { message: "hello world" } });
  });

  test("a tampered request (params changed after signing) → UNAUTHENTICATED", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    const req = signed("b", "world");
    (req.params as { name: string }).name = "attacker"; // mutate after the MAC was computed
    await feed(fs, req);
    expect(fs.replies()[0]).toMatchObject({ id: "b", ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  test("a signature under the wrong key → UNAUTHENTICATED", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    const req: RequestEnvelope = { id: "c", method: "greet", params: { name: "x" } };
    req.auth = hmacSigner("wrong-key")(req);
    await feed(fs, req);
    expect(fs.replies()[0]).toMatchObject({ id: "c", ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  test("replaying the exact same signed request → second is rejected", async () => {
    const fs = fakeSocket(); handlers.open(fs.socket);
    const req = signed("d", "world");
    await feed(fs, req);
    await feed(fs, req); // byte-for-byte replay
    expect(fs.replies()[0]).toMatchObject({ id: "d", ok: true });
    expect(fs.replies()[1]).toMatchObject({ id: "d", ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  test("canonicalRequest is key-order independent (so equal requests sign equal)", () => {
    const a: RequestEnvelope = { id: "1", method: "m", params: { x: 1, y: 2 } };
    const b: RequestEnvelope = { id: "1", method: "m", params: { y: 2, x: 1 } };
    expect(canonicalRequest(a)).toBe(canonicalRequest(b));
    expect(sign(a)).toBe(sign(b));
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

  test("a daemon error's code survives as DoorCallError.code (per-door clients pattern-match on it)", async () => {
    sockPath = `${tmpdir()}/gr-proto-${crypto.randomUUID()}.sock`;
    server = Bun.listen({
      unix: sockPath,
      socket: createDoorHandlers("test", {
        fail: () => { throw new Error("boom"); },
      }, noop),
    });

    try {
      await call(sockPath, "fail");
      throw new Error("expected call() to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(DoorCallError);
      expect((e as DoorCallError).code).toBe("HANDLER_ERROR");
      expect((e as DoorCallError).message).toBe("boom");
    }
  });

  test("a server that closes without answering rejects CONNECTION_CLOSED instead of hanging", async () => {
    sockPath = `${tmpdir()}/gr-proto-${crypto.randomUUID()}.sock`;
    server = Bun.listen({
      unix: sockPath,
      socket: {
        open(socket: { end(): void }) { socket.end(); }, // hang up, no response line
        data() {},
        close() {},
        error() {},
      },
    });

    try {
      await call(sockPath, "echo", { value: 1 });
      throw new Error("expected call() to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(DoorCallError);
      expect((e as DoorCallError).code).toBe("CONNECTION_CLOSED");
    }
  });

  test("connecting to a socket with nothing listening rejects CONNECTION_ERROR", async () => {
    const deadSock = `${tmpdir()}/gr-proto-dead-${crypto.randomUUID()}.sock`;
    try {
      await call(deadSock, "echo", { value: 1 });
      throw new Error("expected call() to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(DoorCallError);
      expect((e as DoorCallError).code).toBe("CONNECTION_ERROR");
    }
  });
});

describe("call ↔ createDoorHandlers over a real TCP socket (host:port)", () => {
  let server: { stop: () => void; port: number } | undefined;
  afterEach(() => { server?.stop(); });

  test("round-trips over a host:port endpoint", async () => {
    server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0, // ephemeral
      socket: createDoorHandlers("test", {
        echo: (p) => ({ echoed: p.value }),
      }, noop),
    }) as unknown as { stop: () => void; port: number };

    const res = await call<{ echoed: unknown }>(`127.0.0.1:${server.port}`, "echo", { value: 9 });
    expect(res).toEqual({ echoed: 9 });
  });

  test("an authenticated tcp door: the right token round-trips, a wrong one is rejected", async () => {
    const TOKEN = "launch-token-xyz";
    server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: createDoorHandlers("test", { echo: (p) => ({ echoed: p.value }) }, noop, tokenAuthorizer(TOKEN)),
    }) as unknown as { stop: () => void; port: number };
    const ep = `127.0.0.1:${server.port}`;

    const ok = await call<{ echoed: unknown }>(ep, "echo", { value: 11 }, { auth: TOKEN });
    expect(ok).toEqual({ echoed: 11 });

    await expect(call(ep, "echo", { value: 11 }, { auth: "nope" })).rejects.toThrow();
    await expect(call(ep, "echo", { value: 11 })).rejects.toThrow(); // no token at all
  });

  test("an HMAC-signed tcp door: signed calls round-trip; an unsigned one is rejected", async () => {
    const KEY = "launch-hmac-key";
    server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: createDoorHandlers("test", { echo: (p) => ({ echoed: p.value }) }, noop, hmacAuthorizer(KEY)),
    }) as unknown as { stop: () => void; port: number };
    const ep = `127.0.0.1:${server.port}`;
    const sign = hmacSigner(KEY);

    // each call has a fresh id, so two signed calls both succeed (not replays)
    expect(await call<{ echoed: unknown }>(ep, "echo", { value: 1 }, { sign })).toEqual({ echoed: 1 });
    expect(await call<{ echoed: unknown }>(ep, "echo", { value: 2 }, { sign })).toEqual({ echoed: 2 });

    await expect(call(ep, "echo", { value: 3 })).rejects.toThrow();                    // unsigned
    await expect(call(ep, "echo", { value: 3 }, { sign: hmacSigner("nope") })).rejects.toThrow(); // wrong key
  });
});
