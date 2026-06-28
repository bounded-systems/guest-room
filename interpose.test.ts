import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

import { type CaveatVerifiers, type DoorGrant, unix } from "./mod.ts";
import { call, createDoorHandlers } from "./protocol.ts";
import { type InterposeContext, createInterposerHandlers, enforceAndForward } from "./interpose.ts";

const noop = (): void => {};

/** A minimal grant carrying the given caveats. */
function grant(caveats: string[]): DoorGrant {
  return {
    name: "scout",
    host: unix("/run/host.sock"),
    guest: unix("/run/guest.sock"),
    env: "SCOUT_SOCK",
    grants: "test door",
    use: "test",
    caveats,
  };
}

/** Allow only the method named by a `method=<name>` caveat. */
const methodVerifiers: CaveatVerifiers<InterposeContext> = {
  method: (value, ctx) => ctx.method === value,
  // a param equality caveat `x=<v>` (used for the chaining test)
  x: (value, ctx) => String((ctx.params as { x?: unknown }).x) === value,
};

describe("enforceAndForward — the enforcement core (no sockets)", () => {
  test("an allowed request forwards upstream with the original method + params", async () => {
    const calls: Array<{ ep: string; method: string; params: unknown }> = [];
    const res = await enforceAndForward(
      { id: "1", method: "read", params: { x: 1 } },
      {
        upstream: "UP",
        grant: grant(["method=read"]),
        verifiers: methodVerifiers,
        forward: async (ep, method, params) => {
          calls.push({ ep, method, params });
          return { echoed: params };
        },
      },
    );
    expect(res).toEqual({ id: "1", ok: true, result: { echoed: { x: 1 } } });
    expect(calls).toEqual([{ ep: "UP", method: "read", params: { x: 1 } }]);
  });

  test("KEYSTONE: a denied request is NEVER forwarded", async () => {
    let forwarded = false;
    const res = await enforceAndForward(
      { id: "2", method: "write", params: {} },
      {
        upstream: "UP",
        grant: grant(["method=read"]),
        verifiers: methodVerifiers,
        forward: async () => {
          forwarded = true;
          return {};
        },
      },
    );
    expect(forwarded).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("CAVEAT_DENIED");
  });

  test("fail-closed: an uninterpretable caveat (no verifier) denies", async () => {
    const res = await enforceAndForward(
      { id: "3", method: "read", params: {} },
      { upstream: "UP", grant: grant(["mode=readonly"]), verifiers: methodVerifiers, forward: async () => ({}) },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("CAVEAT_DENIED");
  });

  test("an upstream failure surfaces as UPSTREAM_ERROR (not a caveat denial)", async () => {
    const res = await enforceAndForward(
      { id: "4", method: "read", params: {} },
      {
        upstream: "UP",
        grant: grant(["method=read"]),
        verifiers: methodVerifiers,
        forward: async () => {
          throw new Error("upstream down");
        },
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("UPSTREAM_ERROR");
  });
});

describe("interposer door over real unix sockets", () => {
  const sockets: string[] = [];
  const servers: Array<{ stop: () => void }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop();
    for (const p of sockets.splice(0)) {
      try {
        unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
  });

  function sock(tag: string): string {
    const p = `${tmpdir()}/gr-interpose-${tag}-${crypto.randomUUID()}.sock`;
    sockets.push(p);
    return p;
  }

  /** An upstream door that records every method it actually receives. */
  function upstream(seen: string[]): string {
    const path = sock("up");
    servers.push(
      Bun.listen({
        unix: path,
        socket: createDoorHandlers(
          "up",
          {
            read: (p) => {
              seen.push("read");
              return { read: p.x };
            },
            write: (p) => {
              seen.push("write");
              return { wrote: p.x };
            },
          },
          noop,
        ),
      }),
    );
    return path;
  }

  function interposer(upstreamPath: string, caveats: string[]): string {
    const path = sock("ip");
    servers.push(
      Bun.listen({
        unix: path,
        socket: createInterposerHandlers({
          upstream: upstreamPath,
          grant: grant(caveats),
          verifiers: methodVerifiers,
        }),
      }),
    );
    return path;
  }

  test("KEYSTONE: a denied request never reaches the upstream the child can't see", async () => {
    const seen: string[] = [];
    const ip = interposer(upstream(seen), ["method=read"]);

    // The child holds ONLY `ip`. An allowed call round-trips and reaches upstream.
    expect(await call(ip, "read", { x: 1 })).toEqual({ read: 1 });
    expect(seen).toEqual(["read"]);

    // A request outside the caveat is refused AT THE PROXY — upstream never sees it.
    await expect(call(ip, "write", { x: 2 })).rejects.toThrow(/caveat not satisfied/);
    expect(seen).toEqual(["read"]); // still just the one allowed call — write was structurally blocked
  });

  test("chaining: a request denied by the OUTER interposer never reaches the inner one or upstream", async () => {
    const seen: string[] = [];
    const inner = interposer(upstream(seen), ["method=read"]); // inner: only read
    const outer = interposer(inner, ["x=1"]); // outer: only x=1 (append-only narrowing)

    // read + x=1 satisfies both layers → reaches upstream.
    expect(await call(outer, "read", { x: 1 })).toEqual({ read: 1 });
    expect(seen).toEqual(["read"]);

    // read + x=2 fails the OUTER caveat → blocked before the inner layer or upstream.
    await expect(call(outer, "read", { x: 2 })).rejects.toThrow(/caveat not satisfied/);
    expect(seen).toEqual(["read"]); // authority only ever shrank down the chain
  });
});
