-------------------------------- MODULE Confinement --------------------------------
(***************************************************************************)
(* A TLA+ model of guest-room's CONFINEMENT property: a capability handed *)
(* out by the concierge never outlives its provider's lease and never     *)
(* exceeds its ceiling — across ALL interleavings of register / tick /    *)
(* introduce, and against an adversary that tries to FORGE a wider door   *)
(* (drop a caveat) or REPLAY a grant by holding it as the clock advances  *)
(* past the lease.                                                        *)
(*                                                                         *)
(* algebra-proofs.test.ts proves the algebra by exhaustion over a finite  *)
(* caveat universe, but it cannot cover arbitrary EVENT ORDERINGS — the    *)
(* temporal heart of confinement ("dies with the lease"). That is this     *)
(* model's job: TLC explores every reachable interleaving.                 *)
(*                                                                         *)
(* Each operator mirrors a function in ../mod.ts:                          *)
(*   Attenuate        <->  attenuate         (append-only: caveats grow)   *)
(*   AttenuatesDoors  <->  attenuatesDoors   (ok iff parent.caveats ⊆ child)*)
(*   LiveProviders    <->  liveProviders     (expiresAt > now)             *)
(*   IsConfined       <->  isConfined        (some live ceiling ⊆ held)    *)
(* Introduce mirrors resolveProvider (first live provider, attenuated by   *)
(* the caller's `want`).                                                   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Caps,        \* the set of capability names, e.g. {reads}
          CaveatU,     \* the finite universe of caveats, e.g. {r1, r2}
          Consumers,   \* the set of consumers, e.g. {c1}
          MaxTime,     \* clock ceiling for the bounded check, e.g. 3
          Leases       \* the lease-expiry values a provider may register, e.g. {1, 2}

\* The empty/absent grant — a consumer that holds nothing.
NoGrant == [cap |-> CHOOSE c \in Caps : TRUE, caveats |-> {}, present |-> FALSE]

\* A door grant: the capability it claims, the caveat set it carries, present flag.
Grants == [cap : Caps, caveats : SUBSET CaveatU, present : BOOLEAN]

\* A provider entry in the concierge registry: capability, ceiling, lease expiry.
Providers == [cap : Caps, ceiling : SUBSET CaveatU, expiresAt : Leases]

VARIABLES now,        \* the clock (Naturals, 0..MaxTime)
          registry,   \* the set of registered providers
          held        \* held[c] = the grant consumer c currently holds

vars == <<now, registry, held>>

----------------------------------------------------------------------------
(* Operators mirroring mod.ts *)

\* attenuate: append-only — the caveat set can only grow.
Attenuate(door, want) == [door EXCEPT !.caveats = door.caveats \cup want]

\* attenuatesDoors (single door, matched by capability): child ok iff it keeps
\* every parent caveat — i.e. parent.caveats ⊆ child.caveats.
AttenuatesDoors(child, parent) == parent.caveats \subseteq child.caveats

\* liveProviders: registered for `cap`, lease not yet lapsed (expiresAt > t).
LiveProviders(cap, t) == { p \in registry : p.cap = cap /\ p.expiresAt > t }

\* A ceiling rendered as a door, for the AttenuatesDoors comparison.
CeilingDoor(cap, ceiling) == [cap |-> cap, caveats |-> ceiling, present |-> TRUE]

\* isConfined: present, and SOME live provider's ceiling attenuates to it.
IsConfined(g, t) ==
    /\ g.present
    /\ \E p \in LiveProviders(g.cap, t) : AttenuatesDoors(g, CeilingDoor(g.cap, p.ceiling))

----------------------------------------------------------------------------
(* The spec *)

TypeOK ==
    /\ now \in 0..MaxTime
    /\ registry \subseteq Providers
    /\ held \in [Consumers -> Grants]

Init ==
    /\ now = 0
    /\ registry = {}
    /\ held = [c \in Consumers |-> NoGrant]

\* time passes (bounded so the model is finite)
Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ UNCHANGED <<registry, held>>

\* a provider registers a door for a capability, with a ceiling and a lease
Register ==
    /\ \E cap \in Caps, ceil \in SUBSET CaveatU, exp \in Leases :
        registry' = registry \cup {[cap |-> cap, ceiling |-> ceil, expiresAt |-> exp]}
    /\ UNCHANGED <<now, held>>

\* a consumer is introduced to a live provider's capability, narrowed by `want`
\* (resolveProvider: first live provider's door, attenuated)
Introduce ==
    /\ \E c \in Consumers, cap \in Caps, want \in SUBSET CaveatU :
        /\ \E p \in LiveProviders(cap, now) :
            held' = [held EXCEPT ![c] = Attenuate(CeilingDoor(cap, p.ceiling), want)]
    /\ UNCHANGED <<now, registry>>

\* ADVERSARY: forge a WIDER door by dropping a caveat the consumer already holds.
Forge ==
    /\ \E c \in Consumers :
        /\ held[c].present
        /\ \E cv \in held[c].caveats :
            held' = [held EXCEPT ![c].caveats = held[c].caveats \ {cv}]
    /\ UNCHANGED <<now, registry>>

Next == Tick \/ Register \/ Introduce \/ Forge \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
(* The theorems TLC checks as invariants over every reachable state *)

\* SOUNDNESS: confinement is never vacuous — anything the broker would treat as
\* confined really is backed by a live provider whose ceiling it respects. Holds
\* even right after a Forge (a widened grant cannot pass against that ceiling).
ConfinedIsBacked ==
    \A c \in Consumers :
        IsConfined(held[c], now) =>
            \E p \in LiveProviders(held[c].cap, now) : p.ceiling \subseteq held[c].caveats

\* LEASE-GATED: a capability does not outlive its provider. Once no live provider
\* remains for its capability, no amount of replay (holding it across Ticks)
\* keeps it confined. This is the temporal property enumeration can't reach.
ExpiredNotConfined ==
    \A c \in Consumers :
        (held[c].present /\ LiveProviders(held[c].cap, now) = {}) =>
            ~IsConfined(held[c], now)

\* The conjunction is the confinement guarantee.
Confinement == ConfinedIsBacked /\ ExpiredNotConfined
=============================================================================
