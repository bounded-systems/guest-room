# Handoff — containers, transport trust, and wire auth

*Snapshot for resuming this thread in a fresh session. Captures what landed, what's
left, and which repos need to be in scope to continue.*

Date: 2026-06-26. Branch of record: `main`.

## How this started

Two questions drove the work:

1. **What's the lift to run guest-room in containers — specifically
   [apple/container](https://github.com/apple/container)** (Linux containers as
   per-VM lightweight microVMs on macOS)? A microVM can't share a unix socket
   host↔guest, so doors must cross over `tcp`/`vsock` — mechanically fine (the
   engine is transport-agnostic) but it *changes the trust* a door carries.
2. **Does the design match known security specs (Rego/OWASP/…), and can we prove
   the algebra?** Which surfaced two real gaps to close.

## What landed (all merged to `main`)

- **#31** — transport model made executable (`features/transport.feature`); the
  **security-canon scorecard** (`docs/scorecard.md`); the **algebra proven by
  exhaustion** (`algebra-proofs.test.ts`, ~40k assertions, zero-dep bounded model
  checking); and **TLA+ confinement** model-checked over time
  (`specs/Confinement.tla`, 5104 states, with a non-vacuity witness).
- **#32** — opt-in **bearer-token** wire auth (`tokenAuthorizer`, `RequestAuthorizer`,
  fail-closed, checked before dispatch).
- **#33** — **HMAC-per-request** auth (`hmacSigner` / `hmacAuthorizer` /
  `canonicalRequest`): authenticity + integrity + anti-replay (per-request `id`
  bound into the MAC, bounded-FIFO replay rejection).

Net: the **`tcp` ocap degradation is closed on the wire.** Suite at 86 tests green.
Read `docs/scorecard.md` first — it has the honest per-spec rating and marks which
cells are proven vs. deferred.

## What's left (prioritized)

### 1. Engine — `resolveDoor` guest-side transport (small, lives HERE)
`mod.ts` defines `unix`/`vsock`/`tcp` transports and `DoorGrant` carries separate
`host`/`guest` transports, but `resolveDoor` still hardcodes the **guest** (in-room)
side to `unix(...)` (`mod.ts`, both branches of `resolveDoor`). To run on a microVM
substrate the guest side must be selectable (tcp/vsock). Surgical change + a
`features/` scenario. This is the only remaining *engine* gap for the container story.

### 2. Broker — macaroon HMAC binding (the open crypto gap)
Today caveats are plaintext and non-widening is enforced by comparison
(`isConfined` is "relative to the registry"). Real macaroons chain an HMAC across
caveats (`Mᵢ = HMAC(Mᵢ₋₁, cᵢ)`) so the caveat set is self-authenticating —
append-only by construction, drop-detectable. **Reuses #33's exact HMAC machinery.**
- Engine (here): carry an **opaque `proof`/`tag`** field on `DoorGrant` the engine
  never interprets (same seam as caveats). ~10 LOC of type surface.
- Broker (NOT here): mint (chain on `attenuate`), verify (recompute + constant-time),
  and **root-key custody/rotation**. First-party caveats are the 80/20; third-party
  (discharge) caveats are a later, larger lift.
- Upgrades the scorecard **Macaroons C+ → B/B+** and strengthens confinement's root.

### 3. Substrate — apple/container launch path (NOT here)
- Host-gateway discovery (no `host.docker.internal` equivalent; resolve the vmnet
  host IP, ~`192.168.64.1`), wire each door's env var to `<host>:<port>`, build the
  OCI image (Bun + guest), broker TCP/vsock listen mode + per-launch token/key
  minting and injection.
- `vsock` for isolation parity: needs a guest-side relay (Rust/Go AF_VSOCK) because
  macOS host has no AF_VSOCK (only Virtualization.framework), and apple/container
  owns that device — blocked until it exposes a host-side unix-proxy for a guest
  vsock port, or you build on `apple/containerization` directly.

### 4. Optional hardening
- TLS or per-peer interface binding for `tcp` doors (defense in depth beyond HMAC).
- Verification roadmap (`docs/scorecard.md`): `z3-solver` (SMT from TS), scale
  TLA+ / add Apalache, and **Verus** if/when a broker is rewritten in Rust.

## Repos needed in scope to continue

| Repo | Why | For which item |
|---|---|---|
| `bounded-systems/guest-room` | engine: `resolveDoor` guest transport (#1), opaque `proof` field (#2) | 1, 2 |
| `bounded-systems/claude-box` | where the brokers (keeper/net/scout) + launcher live today | 2, 3 |
| `bounded-systems/keeperd` | signer/verifier room (extraction pending) — the home for macaroon root-key custody + HMAC chaining | 2 |
| `bounded-systems/ocap-provenance` | shared provenance/authenticator contract — the `proof`-field contract and lineage tie-in | 2 |
| `bounded-systems/facilities` (`prx-fleet`) | floor/host (microVM) provisioning for the apple/container substrate | 3 |

Minimal set to make progress now: **`guest-room` + `claude-box`** (engine change +
broker), with **`keeperd` / `ocap-provenance`** added when the macaroon work moves
out of `claude-box` into the dedicated signer. `facilities` only for the substrate
(apple/container) track.

## Pointers

- Honest status & ratings: `docs/scorecard.md`
- Transport trust & TCB lines: `docs/authority-and-attenuation.md` (*Transport trust is not uniform*)
- Wire auth: `protocol.ts` (*Authentication helpers*) + `protocol.test.ts`
- Proven algebra: `algebra-proofs.test.ts`; temporal confinement: `specs/`
