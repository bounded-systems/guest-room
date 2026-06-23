# guest-room

**guest-room scopes what an agent is allowed to do, and refuses everything else
by construction — not by a reminder you hope it reads.**

I built it for my own work. I wanted an agent that did the task and didn't get
distracted or reach for things I never granted it. guest-room makes "exactly
these capabilities, nothing ambient" a real, testable object.

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

The rulebook follows Searle's Chinese Room: the agent acts only through the cards
(doors) it holds, and a symbol with no card has no rule. A missing door cannot be
hallucinated into a success, because the rulebook names it as absent.

A door can be **attenuated** — narrowed by append-only caveats (a single host,
read-only mode). Authority only ever decreases: a holder hands a door onward
equally or more restricted, never wider. The caveat grammar is the consumer's;
the engine carries and renders it, never interprets it — the seam that keeps the
engine guest-agnostic.

guest-room is the runtime [`claude-box`](https://github.com/bounded-systems/claude-box)
turned out to be built on: nothing in here knows or cares who the guest is.
`claude-box` is one consumer — Claude Code — plugged into it.

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

The specs in `features/*.feature` are executed against the engine (`mod.ts`) by
`bun test`. Describe a behavior the engine lacks and the suite goes red, so the
docs cannot drift from the code.

| Claim | Proven by | Pinned at |
|---|---|---|
| A room grants exactly its doors and denies the rest, by name | `features/rulebook.feature` → `deniedDoors` / `deniedDoorSection` in `mod.ts` | `5a44110` |
| Attenuation is append-only — authority never widens | `features/attenuation.feature` → `attenuate` / `attenuatesDoors` | `5a44110` |
| A capability dies with its lease and never exceeds its ceiling | `features/confinement.feature` → `isConfined` / `resolveProvider` | `5a44110` |
| The engine names no guest, so it works for any agent | `guest-room.test.ts` ("names no guest") | `5a44110` |

```sh
bun test
```

The fixture catalog in the test is a deliberately non-Claude hotel — proof the
engine works for any guest.

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

> **Deferred to a later release.** The wider runtime — a JSON-over-socket door
> `protocol`, shared `daemon` scaffolding, a two-key `hotel-safe`, and a
> `room-service` token issuer — lives in `claude-box` today and graduates here
> once it lands with tests. v0 ships only the proven, seam-guarded core.

## Going deeper

- [`docs/the-guest-room.md`](docs/the-guest-room.md) — the long-form essay: why a
  room, not a box. (The hotel metaphor lives here, where it has something to
  ground itself in.)
- [`docs/authority-and-attenuation.md`](docs/authority-and-attenuation.md) — what
  guest-room proves about authority, what it defers to the substrate, and where a
  provenance layer fits above it.

In the object-capability tradition (POLA), with macaroon-style append-only caveat
attenuation and lease-bound confinement.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE).
