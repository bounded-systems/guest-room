// signedGrantAuthorizer — the serving-room gate for tcp/vsock doors. A request
// is accepted iff it carries a `grant` that verifies (verifyGrantWithKeys)
// against the issuer's published keys, for THIS room (audience) and THIS door.
// Authority rides in the grant, not the socket. Composes with createDoorHandlers
// exactly like tokenAuthorizer / hmacAuthorizer.
//
//   bun test signed-grant-authorizer.test.ts
import { test, expect, describe } from "bun:test";
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey } from "node:crypto";
import {
  signGrant,
  unix,
  type DoorGrant,
  type GrantBinding,
  type IssuerKeys,
  type SignedGrant,
} from "./mod.ts";
import { signedGrantAuthorizer, type RequestEnvelope } from "./protocol.ts";

const kp = generateKeyPairSync("ed25519");
const pem = kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const sign = (d: string): string => nodeSign(null, Buffer.from(d), kp.privateKey).toString("base64");
const verifyWith = (d: string, s: string, publicKeyPem: string): boolean =>
  nodeVerify(null, Buffer.from(d), createPublicKey(publicKeyPem), Buffer.from(s, "base64"));

const keys: IssuerKeys = { keys: [{ kid: "k1", publicKeyPem: pem }] };
const door: DoorGrant = {
  name: "scout",
  host: unix("/tmp/scoutd.sock"),
  guest: unix("/run/doors/scoutd.sock"),
  env: "SCOUTD_SOCK",
  grants: "external reads",
  use: "read via scout",
};
const grantFor = (over: Partial<GrantBinding> = {}): SignedGrant =>
  signGrant(door, { audience: "room-A", exp: 10_000, nonce: "n1", keyId: "k1", ...over }, sign);

const req = (grant?: SignedGrant): RequestEnvelope => ({ id: "1", method: "fetch", grant });
// Fixed clock before expiry.
const authz = (over: Partial<Parameters<typeof signedGrantAuthorizer>[0]> = {}) =>
  signedGrantAuthorizer({ keys, audience: "room-A", verifyWith, now: () => 5_000, door: "scout", ...over });

describe("signedGrantAuthorizer", () => {
  test("accepts a valid grant for this room and door", () => {
    expect(authz()(req(grantFor()))).toBe(true);
  });

  test("rejects a request with no grant (reachability is not authority)", () => {
    expect(authz()(req(undefined))).toBe(false);
  });

  test("rejects a grant minted for another room (audience)", () => {
    expect(authz()(req(grantFor({ audience: "room-B" })))).toBe(false);
  });

  test("rejects a grant for a DIFFERENT door (name mismatch)", () => {
    const otherDoor = signGrant(
      { ...door, name: "keeper", guest: unix("/run/doors/keeperd.sock"), env: "KEEPERD_SOCK" },
      { audience: "room-A", exp: 10_000, nonce: "n1", keyId: "k1" },
      sign,
    );
    expect(authz()(req(otherDoor))).toBe(false);
  });

  test("rejects an expired grant", () => {
    expect(authz({ now: () => 50_000 })(req(grantFor({ exp: 1_000 })))).toBe(false);
  });

  test("rejects an unknown issuer key", () => {
    expect(authz()(req(grantFor({ keyId: "k99" })))).toBe(false);
  });

  test("door check is optional: omitting `door` accepts any valid grant", () => {
    expect(authz({ door: undefined })(req(grantFor()))).toBe(true);
  });
});
