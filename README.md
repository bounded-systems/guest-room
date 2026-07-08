<!-- descriptor:header start -->
# guest-room

**guest-room scopes what an agent is allowed to do, and refuses everything else by construction — not by a reminder you hope it reads.**

I built it for my own work. I wanted an agent that did the task and didn't get distracted or reach for things I never granted it. guest-room makes "exactly these capabilities, nothing ambient" a real, testable object.

🟡 **Partial** — mechanism present; named gaps remain.
<!-- descriptor:header end -->

> New here? **[START-HERE.md](START-HERE.md)** is the two-minute version.

## Try it

```sh
bun run examples/quickstart.ts
```

It prints the rulebook a room hands an agent at launch — what it grants, and, by
name, what it denies:

```
[example-workcell — capability surface for THIS launch]
...

GRANTED:
- scout: external reads. Read external content through the scout door.

DENIED (the capability is physically absent from this box — do not attempt):
- keeper: No git-write authority here; relaunch with --keeper.
- net: No network here; relaunch with --net.
```

The denied lines are not advice. The capability is absent; there is nothing in
the box to reach for.

## Where this sits in tools you already use

- A **container** (Docker/Podman) bounds *where* a process runs and what it can
  *write*. It does not bound what it can *reach*: a mounted repo plus ambient
  network is still an exfiltration path.
- guest-room bounds what the agent can *reach*. Each capability is a **door**: a
  unix socket to a broker that holds the actual key and enforces a policy. The
  agent knocks; it never holds the key.
- If you've used a **policy engine** (OPA/Rego) or **seccomp**/Linux
  capabilities: this is a reference monitor for an agent's capabilities,
  enforced at a socket boundary. The decision lives outside the thing it governs.

## The model

- **door** — one capability: a `(name, socket)` grant. The key stays with the
  broker behind it.
- **room** — a named bundle of doors for a kind of work (`read` = scout only;
  `dev` = keeper + net + scout).
- **rulebook** — the per-launch manifest the agent receives: exactly what is
  granted, and what is denied.

A missing door cannot be hallucinated into a success, because the rulebook names
it as absent.

A door can be **attenuated** — narrowed by append-only caveats (a single host,
read-only mode). Authority only ever decreases: a holder hands a door onward
equally or more restricted, never wider. The caveat grammar is the consumer's;
the engine carries and renders it, never interprets it — the seam that keeps the
engine guest-agnostic.

guest-room is the runtime [`claude-box`](https://github.com/bounded-systems/claude-box)
turned out to be built on: nothing in here knows or cares who the guest is.
`claude-box` is one consumer — Claude Code — plugged into it.

guest-room is one seam of [bounded-systems](https://github.com/bounded-systems) —
the bet that every privileged effect an agent performs should be attributable to a
signed owner, with contracts between components enforced rather than remembered.

## Transports — same authority, different wire

A door is a capability addressed over a **transport**, and the capability model is
transport-agnostic (`mod.ts`, *Door transport*): the **substrate** picks the wire,
the room never does. The same `keeper` door — same grant, same env var, same
in-room socket — is reached over:

- **unix** — a filesystem socket on the same machine (the default: container or native).
- **vsock** — a `(CID, port)` pair that crosses the VM boundary, for microVM
  substrates like [apple/container](https://github.com/apple/container), where a
  unix socket can't be shared host↔guest.
- **tcp** — a `host:port` across the network, for remote/distributed brokers.

`features/transport.feature` executes this: resolve a door over each wire and the
authority is the *same object* — only the broker address (`transportString`) moves.

**But the wires are not equally trustworthy, and that trust is a substrate
property, not an engine one.** A unix socket is gated by filesystem permissions and
lets the broker read the peer's kernel credentials (`SO_PEERCRED` on Linux,
`LOCAL_PEERCRED` / `getpeereid` on macOS/BSD) — the kernel vouches, unforgeably, for
*who* knocked. A vsock identifies the peer VM by CID. A tcp port carries no peer
identity at all: anyone who can route to it can knock. So moving a door to tcp
*loses* the authentication the kernel gave you for free, and the broker must
replace it on the wire — `protocol.ts` ships two fail-closed authorizers for
exactly this: `tokenAuthorizer` (a per-launch bearer token) and `hmacAuthorizer`
(a per-request HMAC-SHA256 that also proves integrity and, by binding the request
id, defeats replay). The engine
carries the transport; the broker enforces the trust — the full reduction is in
[`docs/authority-and-attenuation.md`](docs/authority-and-attenuation.md).

## Where this maps — the security canon this *is*

guest-room doesn't invent a model; it's a mechanical instance of long-standing
ones. It is **not** OPA/Rego — Rego is a policy *language*; guest-room is the
reference monitor *around* a policy (the broker's caveat verifiers are the rules,
`checkCaveats` is the fail-closed combinator that calls them).

| Canon | What it says | Where guest-room is it |
|---|---|---|
| **Saltzer & Schroeder** (1975) | least privilege · fail-safe defaults · complete mediation · economy of mechanism | the rulebook (least authority) · `deniedDoors` (deny by default) · `checkCaveats` (fail-closed mediation) · small pure TCB |
| **Reference monitor** (Anderson 1972) | tamper-proof · always-invoked · small enough to verify | the broker at the socket boundary + `checkCaveats`; the engine is pure functions on purpose |
| **Object-capability model** (Miller) | authority is an unforgeable reference, not an actor property; narrow by attenuation | the whole `door` model; `attenuate` is Miller's rule |
| **Macaroons** (Google 2014) | append-only caveats narrow a credential | `attenuate` / `attenuatesDoors` are macaroon-shaped |
| **NIST Zero Trust** (SP 800-207) | no ambient trust · per-request authorization · PDP/PEP split | nothing is ambient · per-request `checkCaveats` · broker = PEP, verifiers = PDP |
| **NIST SP 800-53** | AC-3 access enforcement · AC-6 least privilege | door resolution + the rulebook |
| **OWASP Top 10 A01:2021** | Broken Access Control — enforce deny-by-default, server-side | the door boundary is that server-side control |
| **OWASP LLM Top 10 — LLM06:2025** | Excessive Agency — bound an agent's functionality/permissions; *don't let the model decide its own authorization* | the core thesis: authority is absent unless granted, decided outside the agent |

The sharpest match is **LLM06 (Excessive Agency)**: OWASP's own mitigation —
*"do not rely on the LLM to decide whether an action is authorized; all downstream
systems must independently enforce authorization"* — is verbatim what the door
boundary does. Peer credentials are where that enforcement bottoms out: the
kernel, not the payload, decides who is on the other end of a unix-socket door.

## Usage

The engine is parameterized over a **catalog** (the doors a kind of room can
furnish) and **room bundles** — both supplied by the consumer. `mod.ts` carries
no product identity: no image, no account model, no container runtime. Those are
the guest, and they stay in the consumer.

```ts
import {
  expandRoom, deniedDoors,
  capabilityPreamble, grantedDoorLines, deniedDoorSection,
  type DoorCatalog, type RoomCatalog,
} from "@bounded-systems/guest-room";

// The consumer owns the catalog (which doors a kind of room can furnish)...
const catalog: DoorCatalog = {
  keeper: {
    flag: "--keeper", inBox: "/run/keeperd.sock", env: "KEEPERD_SOCK",
    hostDefault: "/tmp/keeperd.sock", grants: "signed git writes",
    use: "Route every git write through the keeper door.",
    deny: "No git-write authority here; relaunch with --keeper.",
  },
  // ...net, scout, etc.
};
const rooms: RoomCatalog = { dev: { doors: ["keeper"], about: "edit & commit" } };

// ...guest-room resolves the grants and renders the honest rulebook for a launch.
const granted = expandRoom(rooms, catalog, "dev", process.env);
const denied = deniedDoors(catalog, new Set(granted.map((d) => d.name)));
const rulebook = [
  ...capabilityPreamble("my-workcell"),
  ...grantedDoorLines(granted),
  ...deniedDoorSection(denied),
].join("\n");
```

See [`examples/quickstart.ts`](examples/quickstart.ts) for a runnable version.

## Every claim here runs

<!-- descriptor:claims start -->
Every row is generated from `descriptor.proof` in `trellis.json`: the `Proven by`
file must exist, and `Pinned at` is its content digest (git blob hash) — it changes
iff the test content changes, so the table can't cite a missing test or a stale one.

| Claim | Proven by | Pinned at |
|---|---|---|
| A room grants exactly its doors and denies the rest, by name | `features/rulebook.feature` → `deniedDoors` / `deniedDoorSection` in `mod.ts` | `c31986507bce` |
| Attenuation is append-only — authority never widens | `features/attenuation.feature` → `attenuate` / `attenuatesDoors` | `2efc95a11164` |
| A capability dies with its lease and never exceeds its ceiling | `features/confinement.feature` → `isConfined` / `resolveProvider` | `0318058ab3aa` |
| The engine names no guest, so it works for any agent | `guest-room.test.ts` ("names no guest") | `2b49bbedb9ce` |
| A door's authority is the same object across unix/vsock/tcp wires | `features/transport.feature` → `transportString` / `resolveDoor` in `mod.ts` | `42ad3cba4222` |
| The algebra holds for EVERY case, not just examples (bounded-exhaustive) | `algebra-proofs.test.ts` (bounded model checking by exhaustion) | `e1a7f987b10d` |
| A tcp/vsock door requires a per-launch token; unauthorized peers reach no handler | `protocol.test.ts` → `tokenAuthorizer` / `RequestAuthorizer` in `protocol.ts` | `a5b4d772cf72` |
| A per-request HMAC door rejects tampered, wrong-key, and replayed requests | `protocol.test.ts` → `hmacSigner` / `hmacAuthorizer` / `canonicalRequest` | `a5b4d772cf72` |
| A denied request is NEVER forwarded upstream — over real unix sockets and chains | `interpose.test.ts` → `enforceAndForward` / `transportToEndpoint` in `interpose.ts` | `fe33fc419c14` |
| A signed grant is honored only if its Ed25519 signature verifies against the issuer key | `signed-grant-authorizer.test.ts` → `signedGrantAuthorizer` (`protocol.ts`) / `verifyGrantWithKeys` (`mod.ts`) | `c2b4a6c4b825` |

```sh
bun test
```
<!-- descriptor:claims end -->

The fixture catalog in the test is deliberately non-Claude — proof the engine
works for any guest.

## What's here (v0 — tested core)

```
guest-room/
├── mod.ts                 # the engine — door resolution, room expansion, attenuation, rulebook
├── gherkin.ts             # a tiny Gherkin-subset runner
├── features/              # behavior specs, EXECUTED against mod.ts
├── examples/quickstart.ts # the runnable allow + deny demo
├── guest-room.test.ts     # wires the steps to the engine; each Scenario is a test
└── docs/
```

> **The wider runtime — now mostly in-tree.** The JSON-over-socket door
> `protocol`, shared `daemon` scaffolding, the `interpose` enforcement chokepoint,
> and the signed-grant issuer (`signedGrantAuthorizer` / `verifyGrantWithKeys`)
> graduated from `claude-box` and ship here with tests (`protocol.test.ts`,
> `daemon.test.ts`, `interpose.test.ts`, `signed-grant-authorizer.test.ts`,
> `issuer-keys.test.ts`). The one piece still deferred is the two-key escrow (the
> `hotel-safe`); when it lands it graduates the same way, behind tests.

## Going deeper

- [`docs/the-guest-room.md`](docs/the-guest-room.md) — the long-form essay: why a
  room, not a box. (The hotel metaphor lives here, where it has something to
  ground itself in.)
- [`docs/authority-and-attenuation.md`](docs/authority-and-attenuation.md) — what
  guest-room proves about authority, what it defers to the substrate, and where a
  provenance layer fits above it.
- [`docs/scorecard.md`](docs/scorecard.md) — an honest self-rating against the
  canon above (per spec: proven in-engine vs. deferred vs. the real gap), the
  algebra theorems now proven by exhaustion (`algebra-proofs.test.ts`), and the
  verification roadmap (what to reach for next, in TS or Rust).
- [`docs/building-guest-room.md`](docs/building-guest-room.md) — a short builder's
  retrospective: the problem, what got built, the hard part (and what I cut), and
  what it left behind.

In the object-capability tradition (POLA), with macaroon-style append-only caveat
attenuation and lease-bound confinement.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE).
