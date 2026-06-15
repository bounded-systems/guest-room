// attenuatesDoors — room-level attenuation: a child door set is never wider
// than its parent. This is attenuate()'s rule lifted from one door to the set a
// sub-room receives: every child door must exist in the parent AND be equally or
// more restricted (its caveats a superset of the parent's). Dropping a parent's
// caveat WIDENS authority and must be refused — the case a name-only ⊆ check
// silently misses.
//
//   bun test attenuates-doors.test.ts
import { test, expect, describe } from "bun:test";
import { attenuate, attenuatesDoors, unix, type DoorGrant } from "./mod.ts";

const door = (name: string, caveats?: string[]): DoorGrant => ({
  name,
  host: unix(`/tmp/${name}.sock`),
  guest: unix(`/run/${name}.sock`),
  env: `${name.toUpperCase()}_SOCK`,
  grants: `${name} capability`,
  use: `Use ${name}.`,
  caveats,
});

describe("attenuatesDoors — a sub-room is never wider than its parent", () => {
  test("identical door sets attenuate (equal is allowed)", () => {
    const parent = [door("net"), door("scout")];
    expect(attenuatesDoors(parent, parent).ok).toBe(true);
  });

  test("a strict subset of door names attenuates", () => {
    const parent = [door("net"), door("scout"), door("keeper")];
    expect(attenuatesDoors([door("scout")], parent).ok).toBe(true);
  });

  test("empty child attenuates from any parent (no authority is always narrower)", () => {
    expect(attenuatesDoors([], [door("net")]).ok).toBe(true);
  });

  test("a door absent from the parent is a violation (can't grant what you lack)", () => {
    const v = attenuatesDoors([door("scout"), door("keeper")], [door("scout")]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.violations).toEqual([{ door: "keeper", reason: "absent-in-parent" }]);
  });

  test("child KEEPS a parent caveat (adds more) → attenuates", () => {
    const parent = [door("scout", ["host=github.com"])];
    const child = [attenuate(door("scout", ["host=github.com"]), ["mode=readonly"])];
    expect(attenuatesDoors(child, parent).ok).toBe(true);
  });

  test("KEYSTONE: child DROPS a parent caveat → widens → violation", () => {
    const parent = [door("scout", ["host=github.com"])];
    const child = [door("scout")]; // no caveat = wider than parent
    const v = attenuatesDoors(child, parent);
    expect(v.ok).toBe(false);
    if (!v.ok)
      expect(v.violations).toEqual([
        { door: "scout", reason: "widened-caveats", dropped: ["host=github.com"] },
      ]);
  });

  test("child with a DIFFERENT caveat value still drops the parent's → violation", () => {
    const parent = [door("scout", ["host=github.com"])];
    const child = [door("scout", ["host=evil.com"])]; // added its own, dropped parent's
    const v = attenuatesDoors(child, parent);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.violations[0]).toMatchObject({ door: "scout", reason: "widened-caveats" });
  });

  test("reports ALL violations, not just the first", () => {
    const parent = [door("scout", ["host=github.com"])];
    const child = [door("scout"), door("keeper")]; // dropped caveat + absent door
    const v = attenuatesDoors(child, parent);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.violations).toHaveLength(2);
  });
});
