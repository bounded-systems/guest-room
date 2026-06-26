/**
 * algebra-proofs.test.ts — the algebra, proven (not just exampled).
 *
 * features/*.feature pin BEHAVIOR by example: a handful of concrete scenarios.
 * This file pins the ALGEBRA by EXHAUSTION: over a finite caveat universe it
 * enumerates EVERY case and checks the invariant holds for all of them — bounded
 * model checking by brute force. Over that bounded domain this is a proof, not a
 * sample: there is no unchecked case left for a bug to hide in. We are explicit
 * about the bound (|U| below); the unbounded statement is the corresponding
 * theorem, and the randomized passes probe past the bound with arbitrary strings.
 *
 * Why no property-testing library: this engine has zero runtime deps on purpose
 * (small, inspectable TCB), and exhaustive enumeration is a stronger guarantee
 * than randomized sampling for these finite-domain invariants. The one thing a
 * fuzzer adds — coverage of the unbounded string domain — we get from a tiny
 * seeded PRNG, deterministic so a failure always reproduces.
 *
 * Proven here:
 *   1. attenuatesDoors(child, parent) ≡ (parent ⊆ child)   — the widening test IS superset
 *   2. attenuate is append-only / monotone                 — narrowing never widens
 *   3. checkCaveats is exactly "every caveat satisfied", fail-closed, and ENFORCEMENT-
 *      MONOTONE: adding caveats can only ever turn allow→deny, never deny→allow
 *   4. confinement is ceiling-bound and lease-gated         — handed-out authority stays confined
 */
import { describe, test, expect } from "bun:test";
import {
  attenuate,
  attenuatesDoors,
  checkCaveats,
  resolveProvider,
  isConfined,
  unix,
  type DoorGrant,
  type ProviderEntry,
  type CaveatVerifiers,
} from "./mod.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

/** The powerset of xs — every subset, 2^|xs| of them. */
function subsets<T>(xs: T[]): T[][] {
  return xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
}

/** A minimal door carrying exactly these caveats (everything else fixed). */
function door(caveats: string[]): DoorGrant {
  return {
    name: "d", host: unix("/h"), guest: unix("/g"),
    env: "D_SOCK", grants: "g", use: "u",
    caveats: caveats.length ? caveats : undefined,
  };
}

/** A tiny deterministic PRNG (mulberry32) — seeded so any failure reproduces.
 *  Math.random would do, but a fixed seed makes the randomized passes stable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 1. attenuatesDoors(child, parent) ≡ (parent ⊆ child) ─────────────────────
// The whole non-widening guarantee reduces to one claim: a child door-set
// attenuates a parent IFF every parent caveat survives in the child (superset).
// Prove the implementation equals that set relation over the ENTIRE bounded
// domain — all 2^|U| × 2^|U| (parent, child) caveat-set pairs.

describe("attenuatesDoors ≡ superset (exhaustive)", () => {
  test("for ALL parent/child caveat-sets over |U|=8: ok IFF parent ⊆ child", () => {
    const U = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"];
    const all = subsets(U);
    let checked = 0;
    for (const parent of all) {
      const P = new Set(parent);
      for (const child of all) {
        const childSet = new Set(child);
        const isSuperset = [...P].every((c) => childSet.has(c)); // parent ⊆ child
        const verdict = attenuatesDoors([door(child)], [door(parent)]).ok;
        if (verdict !== isSuperset) {
          throw new Error(`counterexample: parent=[${parent}] child=[${child}] → ${verdict}, expected ${isSuperset}`);
        }
        checked++;
      }
    }
    expect(checked).toBe(all.length * all.length); // 256 × 256 = 65 536, none skipped
  });

  test("randomized past the bound: arbitrary string caveats, dropping any one widens", () => {
    const next = rng(0xC0FFEE);
    const blob = () => Math.floor(next() * 1e9).toString(36); // arbitrary, off the |U|=8 alphabet
    for (let i = 0; i < 20_000; i++) {
      const n = 1 + Math.floor(next() * 6);
      const parent = Array.from({ length: n }, blob);
      // child = parent ∪ extras  →  must attenuate (superset)
      const extras = Array.from({ length: Math.floor(next() * 3) }, blob);
      expect(attenuatesDoors([door([...parent, ...extras])], [door(parent)]).ok).toBe(true);
      // child = parent with one caveat dropped  →  must NOT attenuate (widened)
      const dropIdx = Math.floor(next() * parent.length);
      const widened = parent.filter((_, j) => j !== dropIdx);
      expect(attenuatesDoors([door(widened)], [door(parent)]).ok).toBe(false);
    }
  });
});

// ── 2. attenuate is append-only / monotone ───────────────────────────────────
// Appending caveats can only narrow: the result always carries every original
// caveat, so it always attenuates the door it came from. Exhaustive over all
// (original, added) caveat-set pairs.

describe("attenuate is append-only (exhaustive)", () => {
  test("for ALL (original, added) sets: the result keeps every original caveat and attenuates the original", () => {
    const U = ["a", "b", "c", "d", "e"];
    const all = subsets(U);
    let checked = 0;
    for (const original of all) {
      const base = door(original);
      for (const added of all) {
        const narrowed = attenuate(base, added);
        const kept = new Set(narrowed.caveats ?? []);
        // every original caveat survives…
        if (!original.every((c) => kept.has(c))) {
          throw new Error(`dropped an original caveat: original=[${original}] added=[${added}]`);
        }
        // …so the narrowed door always attenuates the one it derived from.
        if (!attenuatesDoors([narrowed], [base]).ok) {
          throw new Error(`narrowing widened authority: original=[${original}] added=[${added}]`);
        }
        checked++;
      }
    }
    expect(checked).toBe(all.length * all.length);
  });
});

// ── 3. checkCaveats: exact, fail-closed, and enforcement-monotone ────────────
// The enforcement side. With parseable caveats and registered verifiers,
// checkCaveats allows IFF every caveat is satisfied. It is fail-closed on
// anything it can't get a verdict for. And — the property that makes attenuation
// REAL rather than cosmetic — adding caveats is enforcement-monotone: it can only
// ever turn an allow into a deny, never a deny into an allow.

describe("checkCaveats is exact and fail-closed (exhaustive)", () => {
  const KEYS = ["a", "b", "c", "d"];
  const CAVS = KEYS.map((k) => `${k}=1`);
  // each verifier passes iff its key is true in the context
  const verifiers: CaveatVerifiers<Record<string, boolean>> = Object.fromEntries(
    KEYS.map((k) => [k, (_v: string, ctx: Record<string, boolean>) => ctx[k] === true]),
  );
  const contexts = subsets(KEYS).map((on) => Object.fromEntries(KEYS.map((k) => [k, on.includes(k)])));

  test("allow IFF every caveat's verifier is satisfied (over all caveat-sets × all contexts)", () => {
    let checked = 0;
    for (const cavs of subsets(CAVS)) {
      for (const ctx of contexts) {
        const expected = cavs.every((c) => ctx[c[0]!] === true); // every caveat's key true
        const got = checkCaveats(door(cavs), ctx, verifiers).ok;
        if (got !== expected) throw new Error(`counterexample: caveats=[${cavs}] ctx=${JSON.stringify(ctx)}`);
        checked++;
      }
    }
    expect(checked).toBe(subsets(CAVS).length * contexts.length);
  });

  test("enforcement is monotone: adding caveats never turns a deny into an allow", () => {
    const all = subsets(CAVS);
    let checked = 0;
    for (const base of all) {
      for (const added of all) {
        for (const ctx of contexts) {
          const wider = checkCaveats(door(base), ctx, verifiers).ok;
          const narrower = checkCaveats(door([...base, ...added]), ctx, verifiers).ok;
          // narrower allowed ⟹ wider allowed  (i.e. no deny→allow on adding caveats)
          if (narrower && !wider) {
            throw new Error(`monotonicity broken: base=[${base}] added=[${added}] ctx=${JSON.stringify(ctx)}`);
          }
          checked++;
        }
      }
    }
    expect(checked).toBe(all.length * all.length * contexts.length);
  });

  test("fail-closed truth table: unparseable and unknown-verifier caveats are denied", () => {
    const va: CaveatVerifiers<Record<string, boolean>> = { a: (_v, c) => c.a === true };
    expect(checkCaveats(door([]), {}, va).ok).toBe(true);                   // no caveats → allow
    expect(checkCaveats(door(["a=1"]), { a: true }, va).ok).toBe(true);     // satisfied → allow
    const noSep = checkCaveats(door(["nosep"]), { a: true }, va);           // unparseable → deny
    expect(noSep.ok).toBe(false);
    expect(noSep.ok === false && noSep.reason).toBe("uninterpretable");
    const noVer = checkCaveats(door(["z=1"]), { a: true }, va);             // no verifier → deny
    expect(noVer.ok).toBe(false);
    expect(noVer.ok === false && noVer.reason).toBe("uninterpretable");
    const unsat = checkCaveats(door(["a=1"]), { a: false }, va);           // verifier false → deny
    expect(unsat.ok === false && unsat.reason).toBe("unsatisfied");
  });
});

// ── 4. confinement is ceiling-bound and lease-gated ──────────────────────────
// What the concierge hands out stays confined: never wider than the provider's
// ceiling, and only while the lease is live. Exhaustive over ceiling/want sets.

describe("confinement is ceiling-bound and lease-gated (exhaustive)", () => {
  const U = ["x", "y", "z", "w"];
  const EXPIRES = 1000;
  const entriesFor = (ceiling: string[]): ProviderEntry[] => [
    { capability: "cap", door: door(ceiling), expiresAt: EXPIRES },
  ];

  test("a live introduction is never wider than the ceiling, and IS confined", () => {
    let checked = 0;
    for (const ceiling of subsets(U)) {
      const entries = entriesFor(ceiling);
      for (const want of subsets(U)) {
        const held = resolveProvider(entries, "cap", want, 500); // 500 < 1000, live
        if (!held) throw new Error(`live provider yielded nothing: ceiling=[${ceiling}] want=[${want}]`);
        // never wider than the ceiling…
        if (!attenuatesDoors([held], [door(ceiling)]).ok) {
          throw new Error(`widened past ceiling: ceiling=[${ceiling}] want=[${want}]`);
        }
        // …and confined against the live registry.
        if (!isConfined(held, entries, "cap", 500)) {
          throw new Error(`not confined while live: ceiling=[${ceiling}] want=[${want}]`);
        }
        checked++;
      }
    }
    expect(checked).toBe(subsets(U).length * subsets(U).length);
  });

  test("a capability does not outlive its lease", () => {
    const entries = entriesFor(["x=1"]);
    const held = resolveProvider(entries, "cap", [], 500)!;
    // confined strictly before expiry, not confined at or after it — check the boundary
    for (const now of [0, 500, 999]) expect(isConfined(held, entries, "cap", now)).toBe(true);
    for (const now of [1000, 1001, 5000]) expect(isConfined(held, entries, "cap", now)).toBe(false);
    // and a dead provider is never introduced in the first place
    expect(resolveProvider(entries, "cap", [], 1000)).toBeNull();
  });

  test("a capability forged wider than the ceiling is not confined", () => {
    let checked = 0;
    for (const ceiling of subsets(U).filter((c) => c.length > 0)) {
      const entries = entriesFor(ceiling);
      const held = resolveProvider(entries, "cap", [], 500)!;
      for (let drop = 0; drop < ceiling.length; drop++) {
        const forged: DoorGrant = { ...held, caveats: (held.caveats ?? []).filter((c) => c !== ceiling[drop]) };
        if (isConfined(forged, entries, "cap", 500)) {
          throw new Error(`forgery confined: ceiling=[${ceiling}] dropped=${ceiling[drop]}`);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
