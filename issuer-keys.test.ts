// verifyGrantWithKeys — keyless, published-key verification. A signed grant
// names its issuer key by `kid`; the verifier holds the issuer's PUBLISHED key
// set (no shared secret) and selects the named key. Rotation = publish a new
// key, retire an old one. The engine models the set + selection; crypto injected.
//
//   bun test issuer-keys.test.ts
import { test, expect, describe } from "bun:test";
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey } from "node:crypto";
import {
  signGrant,
  verifyGrantWithKeys,
  resolveIssuerKey,
  unix,
  type DoorGrant,
  type GrantBinding,
  type IssuerKeys,
} from "./mod.ts";

// Two issuers' keypairs (e.g. before/after a rotation).
const kp1 = generateKeyPairSync("ed25519");
const kp2 = generateKeyPairSync("ed25519");
const pem = (k: import("node:crypto").KeyObject): string => k.export({ type: "spki", format: "pem" }) as string;

const signWith = (priv: import("node:crypto").KeyObject) => (d: string): string =>
  nodeSign(null, Buffer.from(d), priv).toString("base64");
// Injected verifier: resolves a PEM string to a key and checks the signature.
const verifyWith = (d: string, s: string, publicKeyPem: string): boolean =>
  nodeVerify(null, Buffer.from(d), createPublicKey(publicKeyPem), Buffer.from(s, "base64"));

const door: DoorGrant = {
  name: "scout",
  host: unix("/tmp/scoutd.sock"),
  guest: unix("/run/doors/scoutd.sock"),
  env: "SCOUTD_SOCK",
  grants: "external reads",
  use: "read via scout",
};
const binding = (over: Partial<GrantBinding> = {}): GrantBinding => ({
  audience: "room-A",
  exp: 10_000,
  nonce: "n1",
  keyId: "k1",
  ...over,
});
const jwks: IssuerKeys = { keys: [{ kid: "k1", publicKeyPem: pem(kp1.publicKey) }, { kid: "k2", publicKeyPem: pem(kp2.publicKey) }] };
const ctx = { audience: "room-A", now: 5_000 };

describe("verifyGrantWithKeys (keyless published-key verification)", () => {
  test("resolves the named key and verifies", () => {
    const g = signGrant(door, binding({ keyId: "k1" }), signWith(kp1.privateKey));
    expect(verifyGrantWithKeys(g, ctx, jwks, verifyWith)).toEqual({ ok: true });
  });

  test("rotation: a grant signed by the second key verifies against the same set", () => {
    const g = signGrant(door, binding({ keyId: "k2" }), signWith(kp2.privateKey));
    expect(verifyGrantWithKeys(g, ctx, jwks, verifyWith)).toEqual({ ok: true });
  });

  test("unknown kid fails closed", () => {
    const g = signGrant(door, binding({ keyId: "k99" }), signWith(kp1.privateKey));
    expect(verifyGrantWithKeys(g, ctx, jwks, verifyWith)).toEqual({ ok: false, reason: "unknown-key" });
  });

  test("kid present but signed by the WRONG key → bad-signature (no key confusion)", () => {
    // claims k1 but actually signed with kp2's private key
    const g = signGrant(door, binding({ keyId: "k1" }), signWith(kp2.privateKey));
    expect(verifyGrantWithKeys(g, ctx, jwks, verifyWith).ok).toBe(false);
  });

  test("binding checks still apply (audience) after key resolution", () => {
    const g = signGrant(door, binding({ keyId: "k1" }), signWith(kp1.privateKey));
    expect(verifyGrantWithKeys(g, { audience: "room-B", now: 5_000 }, jwks, verifyWith)).toEqual({
      ok: false,
      reason: "audience-mismatch",
    });
  });

  test("resolveIssuerKey selects by kid, null when absent", () => {
    expect(resolveIssuerKey(jwks, "k2")?.kid).toBe("k2");
    expect(resolveIssuerKey(jwks, "nope")).toBeNull();
  });
});
