// signGrant / verifyGrant — authority in transit. On vsock/tcp a held socket is
// not authority (reachability ≠ grant); the authority travels in a signature the
// serving room verifies. The engine owns the canonical bytes + binding checks
// and stays key-agnostic (sign/verify are injected). See ADR-CAPABILITY-TRANSPORT.
//
//   bun test sign-grant.test.ts
import { test, expect, describe } from "bun:test";
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import {
  signGrant,
  verifyGrant,
  grantSigningBytes,
  attenuate,
  unix,
  type DoorGrant,
  type GrantBinding,
  type SignedGrant,
} from "./mod.ts";

// A real Ed25519 issuer (the same primitive keeperd uses), injected into the
// key-agnostic engine.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const sign = (d: string): string => nodeSign(null, Buffer.from(d), privateKey).toString("base64");
const verify = (d: string, s: string): boolean =>
  nodeVerify(null, Buffer.from(d), publicKey, Buffer.from(s, "base64"));

const door: DoorGrant = {
  name: "scout",
  host: unix("/tmp/scoutd.sock"),
  guest: unix("/run/doors/scoutd.sock"),
  env: "SCOUTD_SOCK",
  grants: "external reads",
  use: "read via scout",
  caveats: ["host=github.com"],
};
const binding = (over: Partial<GrantBinding> = {}): GrantBinding => ({
  audience: "room-A",
  exp: 10_000,
  nonce: "n1",
  keyId: "k1",
  ...over,
});

describe("signGrant / verifyGrant", () => {
  test("a freshly signed grant verifies for its audience before expiry", () => {
    const g = signGrant(door, binding(), sign);
    expect(g.signature.length).toBeGreaterThan(0);
    expect(verifyGrant(g, { audience: "room-A", now: 5_000 }, verify)).toEqual({ ok: true });
  });

  test("rejects the wrong audience (a leaked grant can't be replayed by another room)", () => {
    const g = signGrant(door, binding(), sign);
    expect(verifyGrant(g, { audience: "room-B", now: 5_000 }, verify)).toEqual({
      ok: false,
      reason: "audience-mismatch",
    });
  });

  test("rejects an expired grant", () => {
    const g = signGrant(door, binding({ exp: 1_000 }), sign);
    expect(verifyGrant(g, { audience: "room-A", now: 5_000 }, verify)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("tamper-evident: mutating a caveat after signing breaks the signature", () => {
    const g = signGrant(door, binding(), sign);
    const tampered: SignedGrant = { ...g, caveats: ["host=evil.com"] };
    expect(verifyGrant(tampered, { audience: "room-A", now: 5_000 }, verify).ok).toBe(false);
  });

  test("tamper-evident: swapping the granted reference (guest) breaks the signature", () => {
    const g = signGrant(door, binding(), sign);
    const tampered: SignedGrant = { ...g, guest: unix("/run/doors/keeperd.sock") };
    expect(verifyGrant(tampered, { audience: "room-A", now: 5_000 }, verify).ok).toBe(false);
  });

  test("a different issuer key fails verification", () => {
    const g = signGrant(door, binding(), sign);
    const other = generateKeyPairSync("ed25519").publicKey;
    const verifyOther = (d: string, s: string): boolean =>
      nodeVerify(null, Buffer.from(d), other, Buffer.from(s, "base64"));
    expect(verifyGrant(g, { audience: "room-A", now: 5_000 }, verifyOther).ok).toBe(false);
  });

  test("an unsigned plain grant is rejected (reachability is not authority)", () => {
    expect(verifyGrant(door as unknown as SignedGrant, { audience: "room-A", now: 0 }, verify)).toEqual({
      ok: false,
      reason: "unsigned",
    });
  });

  test("cosmetic fields are not signed: re-describing a door keeps the signature valid", () => {
    const g = signGrant(door, binding(), sign);
    const redescribed: SignedGrant = { ...g, grants: "reworded", use: "reworded", env: "SCOUTD_SOCK_2" };
    expect(verifyGrant(redescribed, { audience: "room-A", now: 5_000 }, verify)).toEqual({ ok: true });
  });

  test("attenuate-THEN-sign: narrowing must precede signing (a signed grant is frozen)", () => {
    // Correct order: attenuate first, then sign — verifies.
    const narrowed = attenuate(door, ["path=/repos"]);
    const g = signGrant(narrowed, binding(), sign);
    expect(verifyGrant(g, { audience: "room-A", now: 5_000 }, verify)).toEqual({ ok: true });
    // Wrong order: attenuating AFTER signing changes the covered bytes → invalid.
    const signedThenNarrowed = attenuate(signGrant(door, binding(), sign), ["path=/repos"]) as SignedGrant;
    expect(verifyGrant(signedThenNarrowed, { audience: "room-A", now: 5_000 }, verify).ok).toBe(false);
  });

  test("grantSigningBytes is stable across caveat ordering", () => {
    const a = grantSigningBytes({ ...door, caveats: ["b=2", "a=1"] }, binding());
    const b = grantSigningBytes({ ...door, caveats: ["a=1", "b=2"] }, binding());
    expect(a).toBe(b);
  });
});
