# Authority, attenuation, and confinement

*What guest-room proves, what it defers, and where it sits under a provenance layer.*

---

The interesting bet in this lineage is contrarian: **authority lives in the
artifact, not the actor.** Most agent-authorization work going the other way —
machine identity, agent DIDs, trust scores — makes authority a durable property
of *who is acting*. guest-room refuses that. Here authority is a property of a
**door** (a `(name, socket)` capability brokered by a daemon that holds the
keys), and the guest is "just the code running inside the grant." This document
states the bet precisely, says what part of it is actually provable in *this*
repo, and is honest about what reduces to the substrate and what lives a layer
up.

## 1. The bet, made mechanical

guest-room can't represent actor-held authority even by accident. The engine is
guest-agnostic by construction (`mod.ts:1`), and a test enforces it: the engine
source must **name no guest** (`guest-room.test.ts`, *"the engine stays
guest-agnostic"*). That test is the mechanical form of **actor-fungibility** —
the property that any minimal-scaffold guest is a valid actor inside the
workcell, because the engine has no type in which to encode actor identity or a
standing privilege. There is no `ScopedAgent`, no trust score, no place to hang
"this actor may." The only thing that carries authority is a door.

## 2. Partial application is over the capability, not the actor

The tempting mistake is to treat narrowing as producing a *new kind of actor* —
a "scoped agent." That re-makes authority a durable property of an actor, the
exact thing the bet refuses. guest-room takes the other operand: the partial
application is over the **capability**, and it already has a name —
**attenuation** (Miller's object-capability rule).

- `attenuate(grant, caveats)` (`mod.ts`, *Attenuation*) appends opaque caveats to
  a door. It is **append-only**, so authority is monotonically non-increasing: a
  holder can add constraints, never drop them, and so can hand a door onward only
  equally or more restricted.
- `attenuatesDoors(child, parent)` (`mod.ts`, *Room attenuation*) lifts that rule
  to the *set* of doors a parent hands a sub-room: a child door that drops a
  parent caveat **widens** authority and is refused.

No new actor type is created anywhere. Attenuation returns a narrower
`DoorGrant` — a capability — and the unit that carries it is the door-set handed
to the room boundary, never the agent.

## 3. The property the design turns on: confinement

The one property worth stating precisely is this: **a capability never outlives
its provider or gets captured by its holder as durable state.** That single
property *is* the formalization of "an agent does not become a new actor type" —
if a grant could be stashed and replayed after the workcell is gone, ambient
authority has leaked back down one level.

guest-room now states it as an executable invariant. The concierge introduction
core hands a consumer a capability only from a **live** provider, attenuated by
what the caller asked for, never wider than the provider's ceiling
(`resolveProvider` / `liveProviders`, `mod.ts`, *Introduction*). The verification
side of that same guarantee is `isConfined` (`mod.ts`, *Confinement*):

```
isConfined(held, entries, capability, now)
  = some live provider for `capability` at `now` whose ceiling attenuates to `held`
```

- once every backing lease has lapsed, no live provider remains, so `isConfined`
  is **false** — the capability *does not outlive its provider*;
- if `held` widened past the ceiling, `attenuatesDoors` rejects it, so
  `isConfined` is **false** — the capability *was never one the concierge could
  have lent*.

`features/confinement.feature` exercises exactly these cases against the engine,
so the property can't drift into prose: a live grant is confined; the same grant
after the lease lapses is not; a grant forged wider than the ceiling is not; a
dead capability is never introduced at all.

But note the scope precisely: `isConfined` is **relative to the registry**. It
proves a held grant is bounded by *some live provider's declared ceiling* — it
never validates that the ceiling was legitimate to register. A provider that
registers a too-wide door makes `isConfined` return `true` over already-broken
authority, and the engine faithfully attenuates from the rotten root. Confinement
is conditional on **provider admission**, which is the broker's, not the engine's
(see the TCB below).

### What attenuation does and does not defend

Because the engine is intent-blind — it scores effects, not motives, so a
confused or compromised actor is treated identically to a hostile one — it is
tempting to call all undesirable agent behavior an "attack" and reach for the
authority machinery. That conflates three harms with three different defenses,
and attenuation answers only the first:

| Harm | Example | Defense | Where |
|---|---|---|---|
| **Authority misuse** (confused deputy) | acts outside its grant | **attenuation** — bound the authority | guest-room (`attenuate` / `isConfined`) — done |
| **Resource exhaustion** (denial-of-wallet) | burns its budget on authorized-but-wasteful work | **metering** — at the service / message / telemetry layer | *below* the room — not a caveat, not the engine (see below) |
| **Undesirable output** | a cheap, confidently wrong answer (one token) | **attestation gate** — no valid evidence, no transition | PRX's anchored chain, not guest-room |

A perfectly attenuated, perfectly confined workcell can still burn its whole
inference budget on fully-authorized work, and can still emit a wrong answer that
cost almost nothing. Confinement and budget are orthogonal axes; correctness is a
third. "Attack" is a fine *accounting* word — count all three against the budget —
but a category error as a *defense* word: reaching for attenuation leaves the
other two unhandled.

**Budget and TTL belong below the room, not in the caveat algebra.** A caveat is
authority-scoping — pure and decidable from the request alone (`host=`,
`mode=read-only`); every verifier today (`CaveatVerifier`, *Enforcement*) is
`(value, ctx) => boolean` with no engine state, and it should stay that way.
Budget and time-to-live are neither: they are stateful, temporal, cross-cutting
concerns the room cannot see and should not carry. Push them down to where the
spend and the clock actually live — the **service** (the broker daemon holds the
meter and the deadline), the **message** (the door protocol envelope carries and
enforces them per request), or the **telemetry** layer (OTel spans already carry
cost and duration; a collector kills the workcell when a threshold trips). The
room may carry at most a **correlation salt** so that spend and spans attribute
back to a grant — never the budget itself. guest-room already shows the pattern:
its only expiry, the provider **lease** (`expiresAt`, enforced by
`liveProviders`), lives in the broker's registry, not as a room caveat. Budget
follows TTL down. **Metering correctness** is therefore a TCB line of the *service
/ telemetry* layer, not a verifier in this engine.

### The TCB, and the gaps that are named not closed

`isConfined` proves the *algebra* of confinement — lease-gated and
ceiling-bound — purely and analyzably. It does **not** prove (a) the runtime
cannot stash a socket fd and use it after teardown, nor (b) that a provider's
ceiling was legitimate to register. Both reduce to the broker and substrate, not
this engine. The trusted base is small and explicit:

- **CAS / signing integrity** and **lease honesty** — the broker's
- **provider admission / ceiling honesty** — *who may register a door, and how
  its declared ceiling is bounded* — the broker's. This is the root `isConfined`
  trusts; a too-wide ceiling here voids confinement downstream.
- **workcell isolation** (the fd really dies at teardown) — the substrate's
- **caveat enforcement** — the broker's verifiers, combined fail-closed by the
  engine (next section)
- **the attenuation algebra** — *this engine's*, and the part proven here

These pass the membership test the intent-blindness principle implies: a
legitimate TCB element is auditable mechanism (a deterministic verifier, an
isolation boundary, a revocation path) trusted because it is small, fixed, and
inspectable — never an actor trusted because it "means well." Provider admission
earns its place only if it is *structural* bounding, not "this registration looks
legitimate"; trusting a desirable-looking provider's self-declared ceiling is the
same intent-trust the principle forbids, just relocated one seam down.

The substrate gap is the same one the founding essay already flags as the open
problem — *"who keeps the room honest"* (`docs/the-guest-room.md`, **The next
door**). We name it; we don't pretend the engine closes it.

## 4. What "proving security" actually means here

You cannot prove "guest-room is secure." You can prove narrow properties of
specific mechanisms against a model, and the honest deliverable is the small TCB
above plus the claim that everything reduces to it. Three tiers, and we always
say which we're claiming:

- **Formally tractable** (worth stating as crisp invariants): *complete
  mediation / non-bypassability* — `checkCaveats` (`mod.ts`, *Enforcement*) is
  fail-closed by construction: an unparseable caveat or a caveat with no verifier
  is **denied**, never allowed; and *attenuation monotonicity* — `attenuate`
  (append-only) with `attenuatesDoors` and `isConfined` (ceiling-bound). These
  are small pure functions specifically so they're analyzable.
- **Reduction** (the realistic target): *if* CAS integrity, signature
  verification, workcell isolation, lease honesty, and honest provider admission
  (legitimate ceilings) hold, *then* the properties hold. The list is short and
  auditable on purpose — and confinement is only as sound as its weakest root,
  the registered ceiling.
- **Coverage** (what the suite ships): the `features/*.feature` files **execute**
  against `mod.ts`, so each behavioral claim is checkable — but they are tests,
  not proofs, and this doc does not let coverage wear proof's clothes.

## 5. Where guest-room sits: under a provenance layer

guest-room is the **door / room / introduction substrate** — mechanical and
capability isolation, and the algebra above. It deliberately stops short of one
question the essay leaves standing in the hallway: *who is allowed to install a
door, and can you prove after the fact which doors a run actually held?* That is
a **provenance** problem, not an isolation one.

That layer lives in [PRX](https://github.com/bounded-systems/prx), guest-room's
sibling: an **anchored chain** — a derivation chain with contract validation,
signing, lineage tracking, and invalidation — that records the authority a unit
of work carried, from a content-addressed surface read through to a signed PR.
The artifact-authority model and the intake→plan style transitions are PRX's to
specify; when they need to lend a narrowed capability into a workcell, the
delegation primitive they ride is guest-room's `resolveProvider` — introduction
by message, not by spawn — and the confinement they depend on is the `isConfined`
property above.

In short: **guest-room keeps the guest honest (capability isolation, attenuation,
confinement); PRX's anchored chain keeps the room honest (provenance).** This
repo proves the algebra and names its TCB; the chain anchors it to artifacts.
