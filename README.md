# guest-room

As agents begin doing real engineering work, the hard question stops being how
capable the model is — it's what a given agent is *allowed* to do, and who answers
for what it did. Today that boundary is drawn at the process or the container: a
box that confines *where* an agent runs but not *what authority* it wields inside.
Everything the box can reach, the agent can reach.

Draw the boundary one level in, at the **door** — a named, scope-bounded set of
capabilities an agent acts through, where the mechanism (not the agent's good
intentions) enforces the ceiling, and the privileged effects that cross it are
attributable to a signed owner. The ceiling is enforced today; signed provenance is the layer above it. The door — not the process, not the container — is
**the unit of bounded authority**.

**guest-room** is the runtime that makes a door a real, testable object: its
capabilities are pinned as specs that run. **claude-box** is one guest — Claude
Code — plugged into it. The bet: as the number of agents and the stack of
abstractions under them multiply, what keeps them honest isn't a smarter sandbox —
it's authority that stays bounded and attributable at the door.

*In the object-capability tradition (POLA; cf. SES/Endo, and Cap'n Proto for
addressing), with macaroon-style append-only caveat attenuation and lease-bound
confinement.*

---

A **guest-agnostic room+door capability runtime**. It is the general thing
[`claude-box`](https://github.com/bounded-systems/claude-box) turned out to be
built on: nothing in here knows or cares who the guest is.

> **The hotel.** A guest room is part of a *hotel* — a building of many
> independent rooms. Housekeeping resets each room at checkout; the front desk
> runs the building; guests never hold the master keyring. Between some rooms
> there are **adjoining doors** — a connecting door opens only when the desk
> unlocked it for *this* stay, and even then it reaches just the one room next
> door, not the corridor. That is exactly a capability: the guest holds a door
> to one brokered service, never the keys behind it, and never the building.

See [`docs/the-guest-room.md`](docs/the-guest-room.md) for the full essay —
*why we stopped building a box for Claude and started building a room for anyone* —
and [`docs/authority-and-attenuation.md`](docs/authority-and-attenuation.md) for
*what guest-room proves about authority (attenuation, confinement), what it
defers to the substrate, and where it sits under a provenance layer*.

## The model

| Hotel | guest-room | claude-box (first consumer) |
|---|---|---|
| a room | walls + a furnished set of doors | a hardened container |
| an adjoining door | a **door** — one `(name, socket)` grant | `--keeper` / `--net` / `--scout` sockets |
| the service next door | a broker daemon holding the keys | `keeperd` / `netd` / `scoutd` |
| a kind of suite | a **room preset** — a named door bundle | `--room dev` / `--room read` |
| the room's house rules | the **rulebook** (granted + denied) | the injected capability manifest |
| the front desk | the supervisor | systemd / Quadlet |

A **door** is the unit of authority: the guest holds the socket, never the keys
the daemon behind it holds. A **room** is a named bundle of doors for a kind of
stay. The room hands its guest a **rulebook** keyed to exactly the doors present
— a how-to card per granted door, and a *no-rule* card per absent one — so the
surface is honest about what is **denied**, not only what is granted.

A door can be **attenuated**: narrowed by opaque *caveats* the broker behind it
enforces (a single host, a read-only mode). Attenuation is append-only, so
authority only ever decreases — a holder can hand a door onward equally or more
restricted, never wider (`attenuate(grant, caveats)`). The rulebook states the
restriction on a narrowed door, so the honest surface extends to it. The caveat
*grammar* is the consumer's; the engine carries and renders, never interprets —
the same seam that keeps it guest-agnostic. (This is the object-capability
attenuation rule; the caveats are macaroon-shaped.)

## Usage

The engine is parameterized over a **catalog** (the doors a kind of room can
furnish) and **room bundles** — both supplied by the consumer. `mod.ts` contains
no product identity: no image, no account model, no container runtime. Those are
the *guest*, and they stay in the consumer.

```ts
import {
  resolveDoor, expandRoom, attenuate, deniedDoors,
  capabilityPreamble, grantedDoorLines, deniedDoorSection,
  type DoorCatalog, type RoomCatalog,
} from "@bounded-systems/guest-room";

// 1. The consumer owns the catalog (which doors this kind of room can furnish)…
const catalog: DoorCatalog = {
  keeper: {
    flag: "--keeper", inBox: "/run/keeperd.sock", env: "KEEPERD_SOCK",
    hostDefault: "/tmp/keeperd.sock", grants: "signed git writes",
    use: "Route every git write through the keeper door.",
    deny: "No git-write authority here; relaunch with --keeper.",
  },
  // …net, scout, etc.
};
const rooms: RoomCatalog = {
  dev: { doors: ["keeper"], about: "edit & commit" },
};

// 2. …guest-room resolves grants and renders the honest rulebook for a launch.
const granted = expandRoom(rooms, catalog, "dev", process.env);
const denied  = deniedDoors(catalog, new Set(granted.map((d) => d.name)));
const rulebook = [
  ...capabilityPreamble("my-workcell"),
  ...grantedDoorLines(granted),
  ...deniedDoorSection(denied),
].join("\n");

// 3. Narrow a door before handing it onward — append-only, never wider.
const readOnly = attenuate(granted[0], ["mode=read-only"]);
```

## What's here (v0 — tested core)

```
guest-room/
├── mod.ts              # the engine — door resolution, room expansion, attenuation, rulebook
├── gherkin.ts          # a tiny Gherkin-subset runner
├── features/           # behavior specs, EXECUTED against mod.ts
│   ├── doors.feature
│   ├── rooms.feature
│   ├── rulebook.feature
│   └── attenuation.feature
├── guest-room.test.ts  # wires the steps to the engine; each Scenario is a test
└── docs/the-guest-room.md
```

> **Deferred to a later release.** The wider runtime — a JSON-over-socket door
> `protocol`, shared `daemon` scaffolding, a two-key `hotel-safe`, and a
> `room-service` token issuer — lives in `claude-box` today and graduates here
> once it lands with tests. v0 ships only the proven, seam-guarded core.

## Docs that originate from the code

The `features/*.feature` files are **not prose about the engine — they run
against it**. Each Scenario is registered as a `bun test` whose steps call
`mod.ts` directly:

```sh
bun test
```

So the documentation can't drift: describe a behavior the engine doesn't have,
and the suite goes red. The fixture catalog in the test is a deliberately
*non-Claude* hotel — proof the engine works for any guest. A separate test
(`the engine stays guest-agnostic`) asserts the engine source **names no guest**,
so the library can never silently re-couple to a particular consumer.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE).
