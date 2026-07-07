# Scorecard — what guest-room actually earns against the canon

*An honest self-rating. The repo's rule is that a claim must run; this doc extends
it to the spec-mapping table in the README — saying, per spec, what is **proven in
the engine**, what is **deferred to the broker/substrate**, and what the **real
gap** is. No row claims more than the code backs.*

The recurring shape: the engine reliably earns its grade on the *algebra* (least
privilege, fail-closed defaults, monotonic attenuation, confinement) because those
are small pure functions written to be checkable — and as of `algebra-proofs.test.ts`,
**checked by exhaustion, not just by example**. Every *downgrade* is one of the same
three deferred things, each a named TCB line (`docs/authority-and-attenuation.md`):

1. **"always invoked"** — the enforcement chokepoint now lives in-repo
   (`interpose.ts`, proven to never forward a denial); its *unavoidability* on
   every path is still the broker's / deployment's job.
2. **peer-authentication / unforgeability** — the substrate's, and not uniform: `unix > vsock > tcp`.
3. **cryptographic binding** — present for *signed grants* (`signedGrantAuthorizer`
   verifies an Ed25519 signature against the issuer's published key,
   `verifyGrantWithKeys`); still absent for the *caveat chain itself* (the macaroon
   C+ gap), where the live registry stands in.

So the honest headline is not "we match these specs." It is: **guest-room is a
faithful, now partly-*proven*, instance of the DECISION side of these specs, and is
explicit that the ENFORCEMENT side largely reduces to the broker and substrate** —
with the interposition chokepoint (`interpose.ts`) now the one piece of enforcement
proven in-repo.

## The ratings

| Spec | Grade | Proven in engine (`mod.ts`, tested/▣ proven) | Deferred / out of scope | Biggest gap |
|---|---|---|---|---|
| **Saltzer & Schroeder (1975)** | A− | economy of mechanism (tiny pure TCB); fail-safe defaults (`deniedDoors`, `checkCaveats` ▣); least privilege (rulebook); psychological acceptability (legible rulebook); **complete-mediation mechanism now proven in-repo** (`interpose.ts` never forwards a denial) | complete mediation's *unavoidability* (the broker being on every path) is deployment | **separation of privilege** ~absent (the two-key "hotel-safe" is still deferred) — the one principle left materially down. "Nearly 1:1" was an overclaim. |
| **Reference monitor (Anderson 1972)** | B+ | "small enough to verify" — strongly (pure fns + ▣ proofs); the **enforcement chokepoint now exists in-repo** — `interpose.ts` enforces before forwarding, and `interpose.test.ts` proves a denied request is NEVER forwarded, over real unix sockets and chained interposers (authority only shrinks down a chain) | that the chokepoint is *unavoidably* on every path ("always invoked" in the deployment sense) still reduces to the substrate; so does "tamper-proof" | **2 of 3** now provable in-repo: verifiability + a proven chokepoint. Only substrate-level non-bypass + tamper-proofness remain. |
| **Object-capability (Miller)** | A | no ambient authority ("names no guest"); append-only `attenuate`/`attenuatesDoors` ▣; introduction-by-message (`resolveProvider`); revocation via lease (`isConfined` ▣) | unforgeability of the reference itself | the unforgeable token **is the OS socket** — strong on `unix`, **degrades on `tcp`**, now re-armed on the wire by `tokenAuthorizer` / `hmacAuthorizer` (`protocol.ts`) — the latter also defeats tamper + replay. |
| **Macaroons (Google 2014)** | C+ | append-only first-party caveat semantics ▣; non-widening ▣ | — | **macaroon-*shaped*, not macaroon-*secured*** — no HMAC chaining, no third-party/discharge caveats. The registry substitutes for the crypto binding. |
| **NIST Zero Trust (SP 800-207)** | B+ | no ambient trust; per-request `checkCaveats(ctx)` ▣; temporal lease ≈ continuous eval ▣ | the PEP (broker), device identity, telemetry-driven policy | enforcement point + monitoring loop live below the room — half of ZTA, by design. |
| **NIST SP 800-53** | B | the *mechanism* for AC-3, AC-6 (and AC-4 info-flow, AC-16 attributes) | assessment, audit (AU-*), org context | a **building block, not a compliance attestation** — nothing assessed. |
| **OWASP Top 10 A01:2021** | A− | deny-by-default + server-side (broker-side) enforcement — counters A01's named root causes | — | A01 also spans IDOR/CORS/JWT app-layer bugs out of scope. A control for the *design-level* items only. |
| **OWASP LLM Top 10 — LLM06:2025** | A | authority-bounding leg: minimize permissions/functionality; downstream independent enforcement; "don't let the model self-authorize" | human-in-the-loop gating, rate-limiting/metering, logging | covers **one of LLM06's three legs**; autonomy-gating and denial-of-wallet are other layers (PRX / telemetry). Still the sharpest match. |

▣ = the invariant behind this cell is now **exhaustively proven over a bounded
domain** in `algebra-proofs.test.ts`, not merely exampled.

## What is now proven (and what "proven" means here)

`algebra-proofs.test.ts` does **bounded model checking by enumeration**: over a
finite caveat universe it checks *every* case, so over that domain there is no
unchecked case for a bug to hide in — a proof, not a sample. We state the bound
explicitly; the unbounded statement is the corresponding theorem, and randomized
passes with arbitrary strings probe past the bound.

| Theorem | Statement | How |
|---|---|---|
| **Attenuation = superset** | `attenuatesDoors(child, parent).ok ⟺ parent ⊆ child` | exhaustive over all 2⁸ × 2⁸ caveat-set pairs (65 536), + 20 000 randomized arbitrary-string trials |
| **Append-only** | `attenuate` always keeps every original caveat, so it always attenuates its source | exhaustive over all (original, added) pairs |
| **Enforcement exactness** | `checkCaveats` allows ⟺ every caveat's verifier is satisfied | exhaustive over all caveat-sets × all contexts |
| **Enforcement monotonicity** | adding caveats can only turn allow→deny, never deny→allow | exhaustive over (base, added) × contexts |
| **Fail-closed** | unparseable / unknown-verifier / unsatisfied caveats are all denied | truth table |
| **Confinement** | a live introduction is never wider than the ceiling and is confined; it is not confined once the lease lapses; a forgery that drops a ceiling caveat is not confined | exhaustive over ceiling/want sets + the lease boundary |

This moves the ▣ rows from the doc's *"coverage"* tier (tests) toward its
*"formally tractable"* tier (analyzable invariants) — bounded-exhaustive, which is
the honest middle: stronger than examples, not yet a machine-checked unbounded
proof. The next section is how you'd close that last gap.

## Verification roadmap — what language, and what ties into TS or Rust

The question "what's most modern, and does it tie into TS or Rust" has a clean
answer per tier. Pick by what you're proving, not by fashion.

**Tier 0 — in TypeScript, today (done).** Zero-dependency exhaustive enumeration
+ a seeded PRNG. No library, because (a) this engine keeps a deliberately small
TCB and (b) exhaustive beats randomized for finite-domain invariants. If you want
randomized shrinking on top, `fast-check` is the idiomatic TS choice — but it adds
a dev-dependency for a weaker guarantee than we already have.

**Tier 1 — SMT proofs *from* TypeScript.** `z3-solver` is the official **Z3** build
as WASM; it runs in Bun/Node, so you can discharge bounded-but-not-enumerable
properties (e.g. over integer leases/timestamps rather than a tiny finite set)
**without leaving the runtime**. This is the most direct "ties into TS" upgrade:
encode the invariant as SMT constraints, ask Z3 for a counterexample, get `unsat`
= proven. Note there is **no mature prover for TS *source* itself** (the type
system isn't a proof assistant); you model the algebra, you don't verify the `.ts`.

**Tier 2 — the temporal properties want a model checker (done for confinement).**
Confinement is really a *temporal* claim ("a capability dies with its lease, across
all interleavings of register/lease/introduce/teardown"), which enumeration in TS
can't cover. That is **TLA+**'s home turf, and it's now modelled in
[`specs/Confinement.tla`](../specs/Confinement.tla): TLC checks `ConfinedIsBacked`
and `ExpiredNotConfined` against an adversary that forges wider doors and replays
across the lease boundary — **green over 5104 states, depth 13**, with a non-vacuity
witness. Next escalations on this tier: scale the constants, add **Apalache**
(symbolic, SMT-backed TLA+) for larger domains, and model the broker's
register/teardown to attack the "always invoked" gap.

**Tier 3 — a proof assistant, if you want unbounded machine-checked theorems.**
Most modern / actively-developed: **Lean 4** (large momentum, great tooling).
Alternatives: **Rocq** (the 2025 rename of Coq), **Dafny** (verification-aware
language, SMT-backed, pragmatic — and it *compiles to JS* among other targets),
**F***, **Agda/Idris 2**. For *this* repo, Lean 4 or Dafny would let you state
"attenuation is monotone for all caveat sets" unbounded — but it's a separate
artifact to maintain alongside `mod.ts`.

**The Rust tie-in — the strongest modern story, and it's not hypothetical here.**
The earlier design thread already contemplates rewriting brokers (a `keeperd`-style
signer) as hardened native binaries, and Rust is the natural choice. If a broker
goes Rust, verification and implementation become **one artifact**:

- **Verus** — the most modern serious option: write specs and proofs *in Rust
  itself* (ghost code, `requires`/`ensures`), discharged by an SMT solver. You
  prove the actual broker code, not a model of it.
- **Kani** — AWS's bounded model checker for real Rust (CBMC-backed); closest in
  spirit to what we did in TS, but on the shipping Rust.
- **Prusti / Creusot** (Viper- / Why3-backed) and **Aeneas** (translate Rust to
  Lean/Rocq/F* for proof) are the alternatives.

**Recommendation.** Keep the *algebra* proven in-repo where it lives (Tier 0, done;
escalate to `z3-solver` at Tier 1 if you want unbounded numeric proofs without a
new toolchain). Model *confinement-over-time* in **TLA+/Apalache** (Tier 2) — that
is where a checker earns its keep. And the day a broker is written in Rust, prove
it with **Verus** (Tier 3, Rust-native), so the proof can't drift from the binary.
What none of these fix — and shouldn't be asked to — is the **macaroon C+** (needs
*crypto*: HMAC/signing in `keeperd` / `ocap-provenance`, not a prover) and the
**`tcp` ocap degradation**. Those are substrate and crypto gaps, orthogonal to any
validation engine. The second is now **closed on the wire**: `protocol.ts` carries
a fail-closed `RequestAuthorizer` with both a constant-time `tokenAuthorizer`
(bearer) and an `hmacAuthorizer` (per-request HMAC-SHA256 over the canonicalized
request, with bounded-FIFO replay rejection by request id) — so a tcp/vsock door
recovers authenticity, integrity, and anti-replay, the authority a unix socket's
kernel credentials gave for free. The macaroon binding remains the open crypto
work — and it reuses this same HMAC machinery (chain the tag across caveats).
