// checkCaveats — enforcement of attenuation: granted == enforced.
//
// The engine renders a door's caveats into the rulebook (`grantedDoorLines`);
// this is the matching enforcement side. The engine owns the COMBINATOR
// (conjunction + fail-closed on any caveat it can't get a verdict for) and
// stays guest-agnostic — it never reads a caveat's value. The broker behind the
// door supplies one VERIFIER per caveat key it understands; the value grammar
// (here, a comma-OR host list) is the broker's, not the engine's.
//
//   bun test check-caveats.test.ts
import { test, expect, describe } from "bun:test";
import {
  attenuate,
  checkCaveats,
  unix,
  type DoorGrant,
  type CaveatVerifiers,
} from "./mod.ts";

const door = (caveats?: string[]): DoorGrant => ({
  name: "fetch",
  host: unix("/tmp/fetch.sock"),
  guest: unix("/run/fetch.sock"),
  env: "FETCH_SOCK",
  grants: "external reads",
  use: "fetch external content via the socket",
  caveats,
});

// A fixture verifier set: the broker owns the `host` grammar (comma = OR,
// exact + .suffix match). The engine never sees inside this.
const verifiers: CaveatVerifiers<{ hostname: string }> = {
  host: (value, ctx) =>
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .some((a) =>
        a.startsWith(".")
          ? ctx.hostname === a.slice(1) || ctx.hostname.endsWith(a)
          : ctx.hostname === a,
      ),
};

describe("checkCaveats — granted == enforced", () => {
  test("an unattenuated door allows anything (coarse capability already gated reach)", () => {
    expect(checkCaveats(door(), { hostname: "evil.example" }, verifiers).ok).toBe(true);
  });

  test("a request satisfying the caveat is ALLOWED", () => {
    const v = checkCaveats(door(["host=github.com,.github.com"]), { hostname: "api.github.com" }, verifiers);
    expect(v.ok).toBe(true);
  });

  test("a request violating the caveat is DENIED (unsatisfied), citing the caveat", () => {
    const v = checkCaveats(door(["host=github.com,.github.com"]), { hostname: "evil.example" }, verifiers);
    expect(v).toEqual({ ok: false, caveat: "host=github.com,.github.com", reason: "unsatisfied" });
  });

  test("KEYSTONE: a caveat with no registered verifier DENIES, never silently allows", () => {
    const v = checkCaveats(door(["mode=readonly"]), { hostname: "github.com" }, verifiers);
    expect(v).toEqual({ ok: false, caveat: "mode=readonly", reason: "uninterpretable" });
  });

  test("a malformed caveat (no key=value separator) DENIES", () => {
    const v = checkCaveats(door(["garbage"]), { hostname: "github.com" }, verifiers);
    expect(v.reason).toBe("uninterpretable");
  });

  test("conjunction: appending a caveat only narrows — intersection, never widens", () => {
    // start: {github.com, pypi.org}; attenuate with host=github.com → intersect → {github.com}
    const narrowed = attenuate(door(["host=github.com,pypi.org"]), ["host=github.com"]);
    expect(checkCaveats(narrowed, { hostname: "pypi.org" }, verifiers).ok).toBe(false);
    expect(checkCaveats(narrowed, { hostname: "github.com" }, verifiers).ok).toBe(true);
  });

  test("every caveat must hold — first failure short-circuits and is the one cited", () => {
    const v = checkCaveats(
      door(["host=github.com", "mode=readonly"]),
      { hostname: "github.com" },
      verifiers,
    );
    expect(v).toEqual({ ok: false, caveat: "mode=readonly", reason: "uninterpretable" });
  });
});
