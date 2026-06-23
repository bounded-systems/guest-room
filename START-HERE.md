# guest-room — start here

**guest-room scopes what an agent is allowed to do, and refuses everything else
by construction — not by a reminder you hope it reads.**

I built it for my own work. I wanted an agent that did the task and didn't get
distracted or reach for things I never granted it. guest-room is the piece that
makes "exactly these capabilities, nothing ambient" a real, testable object.

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

## The three nouns

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
read-only mode). Authority only ever decreases.

## Every claim here runs

The specs in `features/*.feature` are executed against the engine (`mod.ts`) by
`bun test`. Describe a behavior the engine lacks and the suite goes red, so the
page cannot drift from the code.

| Claim | Proven by | Pinned at |
|---|---|---|
| A room grants exactly its doors and denies the rest, by name | `features/rulebook.feature` → `deniedDoors` / `deniedDoorSection` in `mod.ts` | `5a44110` |
| Attenuation is append-only — authority never widens | `features/attenuation.feature` → `attenuate` / `attenuatesDoors` | `5a44110` |
| A capability dies with its lease and never exceeds its ceiling | `features/confinement.feature` → `isConfined` / `resolveProvider` | `5a44110` |
| The engine names no guest, so it works for any agent | `guest-room.test.ts` ("names no guest") | `5a44110` |

```sh
bun test
```

## Going deeper

- `docs/the-guest-room.md` — the long-form essay: why a room, not a box.
- `docs/authority-and-attenuation.md` — what guest-room proves, what it defers to
  the substrate, and where a provenance layer fits above it.
