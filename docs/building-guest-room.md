# Building guest-room

*A short retrospective: the problem I started from, what I actually built, the
hard part, and what it left me with.*

---

## The gap

Everyone wiring a coding agent into a real machine reaches for a container, and a
container is genuinely half the answer — it bounds *where* a process runs and what
it can *write*. But it does nothing about what the process can *reach*. Give an
agent a mounted repo, ambient network, and a forwarded credential, and a
prompt-injected or simply runaway run can POST your repo — and the `.env` sitting
in it — to an arbitrary host, or push to your remote with your keys, without ever
leaving its bind-mount. It stayed perfectly inside the sandbox and exfiltrated
everything that mattered.

I didn't start from a threat model, though. I started from annoyance: I wanted an
agent that did the task I gave it and didn't get distracted reaching for things I
never granted it. Every setup I tried answered that with a sentence in a system
prompt — *"don't touch the network,"* *"only commit when asked"* — a reminder I
had to hope it read. I wanted "exactly these capabilities, nothing ambient" to be
a real, testable object instead of a polite request.

## What I built

guest-room makes a capability a physical thing called a **door**: a single unix
socket, bind-mounted to a fixed path inside the room, with a small broker daemon
on the other side that holds the actual key and enforces a policy. The agent can
knock. It cannot do. Look at what the guest *holds* and it's nothing, all the way
down:

| Door | What the guest can do | What the guest holds | Who holds the authority |
|---|---|---|---|
| **keeperd** | request a signed git commit/push | nothing | `keeperd` holds the signing key; runs `Network=none` |
| **netd** | reach an allowlisted host | nothing | `netd` holds the allowlist; it's the only egress path |
| **scoutd** | read an external repo/PR/URL | nothing | `scoutd` holds the read tokens; returns *content*, not creds |

The room itself runs `--network=none` with every Linux capability dropped, a
read-only root, and a disposable tmpfs workspace — so the doors aren't defense in
depth on top of a trusted box, they're the *only* way anything gets in or out. Egress
works because the in-room entrypoint points `HTTPS_PROXY` at a loopback relay to
netd's socket, so ordinary `git`/`curl`/SDK tooling Just Works while netd's
allowlist is the only thing that decides where a request can actually go. A `curl`
to `evil.com` has no route; there is no other path off the box.

A **room** is a named bundle of doors for a kind of work (`read` = scout only;
`dev` = keeper + net + scout). At launch the agent receives a **rulebook**: a
per-launch manifest, generated from the same registry that mounts the doors,
naming exactly what's granted and — by name — what's denied. The key decision is
that a denied capability is *physically absent*, and the rulebook says so. The
denial isn't advice; there's nothing in the box to reach for, and because the
absence is named, a missing door can't be hallucinated into a success. (That's the
other room the name nods to — Searle's Chinese Room: the agent acts only through
the cards it holds, and a symbol with no card has no rule.)

```
[example-workcell — capability surface for THIS launch]

GRANTED:
- scout: external reads. Read external content through the scout door.

DENIED (the capability is physically absent from this box — do not attempt):
- keeper: No git-write authority here; relaunch with --keeper.
- net: No network here; relaunch with --net.
```

## The hard part — and what I cut

The hardest part wasn't the sockets. It was noticing that the thing I built for
Claude had nothing to do with Claude.

I started building `claude-box`. Around the third door I went looking for the agent
in my own design and couldn't find it: `cap-drop=all` is true for any process,
`keeperd` signs for whoever knocks, `netd` polices whatever asks. A room, it turned
out, is just **walls plus a furnished set of capabilities** — the guest is a
runtime detail. That drove the one scoping call everything else hung off:
split a generic, guest-agnostic *engine* from the Claude-specific *launcher*, and
enforce the seam mechanically. There's a test that the engine source must **name
no guest**; the fixture catalog in the suite is a deliberately non-Claude hotel,
so "works for any agent" is checked, not asserted.

The harder discipline was what to *leave out*. It would have been easy to ship the
whole runtime — the socket protocol, the daemon scaffolding, a token issuer — half-
working. Instead this repo ships only the proven *algebra* and defers the rest:

- **door resolution and room expansion** — a room grants exactly its doors and
  denies the rest, by name;
- **attenuation** — narrowing a door is append-only, so authority is monotonically
  non-increasing; you can hand a door onward equally or more restricted, never
  wider;
- **confinement** — a capability never outlives its provider's lease or exceeds its
  ceiling.

Each of those claims is a Gherkin spec **executed against the engine** by `bun
test`, so the docs can't drift from the code: describe a behavior the engine lacks
and the suite goes red. The wider live runtime stays in `claude-box` until it lands
here with its own tests.

I was just as deliberate about what guest-room *doesn't* solve, because naming the
edge honestly mattered more than pretending the engine closed it. Attenuation bounds
**authority misuse** (a confused or compromised agent acting outside its grant). It
does nothing about **resource exhaustion** — a perfectly confined room can still
burn its whole budget on fully-authorized work — which is a metering concern that
belongs *below* the room, not in the caveat algebra. And it does nothing about
**provenance**: *who* is allowed to install a door, and whether you can prove after
the fact which doors a run actually held. That's a separate layer, and I drew the
line at it rather than letting the isolation engine sprawl into it.

## What it left me

It shipped: guest-room is published (JSR, `@bounded-systems/guest-room`) as a tested
core, and `claude-box` is now its first consumer — one tenant, not the building.

The lesson that carries forward is about where authority should live. Most
agent-security work makes authority a durable property of the *actor* — machine
identity, agent DIDs, trust scores. guest-room bets the opposite: authority lives in
the **artifact** (the door), and the guest is just code running inside the grant.
That single inversion is what made isolation *mechanical and testable* instead of
something you trust — there's no `ScopedAgent` type, no place to hang "this actor
may," nothing to encode standing privilege in. The most valuable move in the whole
project was the subtraction: finding the guest-agnostic abstraction hiding inside the
specific thing I'd been asked to build, shipping its proven core, and naming the rest
as explicitly deferred rather than vaguely promised.

---

*See [`the-guest-room.md`](the-guest-room.md) for the long-form design essay (why a
room, not a box) and [`authority-and-attenuation.md`](authority-and-attenuation.md)
for the formal account of what guest-room proves and what it defers to the
substrate.*
