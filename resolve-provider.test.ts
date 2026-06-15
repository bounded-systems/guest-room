// resolveProvider / liveProviders — the introducer core of the concierge model.
//
// A concierge holds a registry of capability → provider (a door the provider
// serves) with a liveness lease. `resolveProvider` introduces a consumer to a
// capability: it returns the first LIVE provider's door, attenuated by the
// caller's requested narrowing — never wider than the provider's ceiling, and
// null when nothing live serves it (fail closed). The engine owns this pure
// logic; the daemon owns the mutable registry, the clock, and policy ordering.
//
//   bun test resolve-provider.test.ts
import { test, expect, describe } from "bun:test";
import { resolveProvider, liveProviders, unix, type DoorGrant, type ProviderEntry } from "./mod.ts";

const door = (name: string, caveats?: string[]): DoorGrant => ({
  name,
  host: unix(`/run/${name}.sock`),
  guest: unix(`/run/${name}.sock`),
  env: `${name.toUpperCase()}_SOCK`,
  grants: `${name} capability`,
  use: `Use ${name}.`,
  caveats,
});

const entry = (capability: string, d: DoorGrant, expiresAt: number): ProviderEntry => ({
  capability,
  door: d,
  expiresAt,
});

const NOW = 1000;

describe("liveProviders — lease-aware filtering", () => {
  test("excludes expired leases (expiresAt <= now)", () => {
    const entries = [
      entry("scout", door("scout"), NOW - 1), // expired
      entry("scout", door("scout"), NOW + 100), // live
    ];
    expect(liveProviders(entries, "scout", NOW).map((e) => e.expiresAt)).toEqual([NOW + 100]);
  });

  test("filters by capability and preserves order (daemon pre-ranks by policy)", () => {
    const a = entry("scout", door("scout"), NOW + 1);
    const b = entry("egress", door("net"), NOW + 1);
    const c = entry("scout", door("scout"), NOW + 2);
    expect(liveProviders([a, b, c], "scout", NOW)).toEqual([a, c]);
  });
});

describe("resolveProvider — introduce a consumer to a capability", () => {
  test("returns null when no provider serves the capability (fail closed)", () => {
    expect(resolveProvider([], "scout", [], NOW)).toBeNull();
  });

  test("returns null when the only provider's lease has expired", () => {
    const entries = [entry("scout", door("scout"), NOW - 1)];
    expect(resolveProvider(entries, "scout", [], NOW)).toBeNull();
  });

  test("introduces the live provider's door", () => {
    const entries = [entry("scout", door("scout"), NOW + 100)];
    const grant = resolveProvider(entries, "scout", [], NOW);
    expect(grant?.name).toBe("scout");
  });

  test("attenuates by the caller's requested narrowing (want)", () => {
    const entries = [entry("scout", door("scout"), NOW + 100)];
    const grant = resolveProvider(entries, "scout", ["host=github.com"], NOW);
    expect(grant?.caveats).toEqual(["host=github.com"]);
  });

  test("KEYSTONE: the result is never wider than the provider's ceiling — want only adds", () => {
    // provider ceiling already restricts to github.com; want adds readonly
    const entries = [entry("scout", door("scout", ["host=github.com"]), NOW + 100)];
    const grant = resolveProvider(entries, "scout", ["mode=readonly"], NOW);
    // ceiling caveat retained AND the new one appended — strictly narrower
    expect(grant?.caveats).toEqual(["host=github.com", "mode=readonly"]);
  });

  test("picks the first live provider (deterministic; daemon orders by policy)", () => {
    const entries = [
      entry("scout", door("scout-a"), NOW - 1), // expired, skipped
      entry("scout", door("scout-b"), NOW + 100), // first live
      entry("scout", door("scout-c"), NOW + 100),
    ];
    expect(resolveProvider(entries, "scout", [], NOW)?.name).toBe("scout-b");
  });
});
