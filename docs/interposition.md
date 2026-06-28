# Caveat enforcement by interposition

> Status: **designed + prototyped** (`interpose.ts`), not yet wired into live
> spawn. Bead `prx-yweb`; epic `prx-86g9`; trust ledger row 6.3.

## The problem — narrowing as *metadata*, not *structure*

A common shorthand for row 6.3 is "caveats are enforced by string-compare." That
is not accurate, and the inaccuracy hides the real gap. Today's enforcement is
already principled:

- `checkCaveats(grant, ctx, verifiers)` — does **not** string-compare. It parses
  each `k=v` caveat, looks up a broker-supplied verifier by `k`, and calls
  `verifier(value, ctx)`. It **fails closed** on any caveat with no verifier or
  an unsatisfied one.
- `attenuatesDoors(child, parent)` — a **set-superset** check (`parent ⊆ child`),
  proven monotone over 65,536 caveat-set pairs in `algebra-proofs.test.ts`.

So the verdict logic is sound. The gap is *where the boundary is*. When a parent
delegates a narrowed door to a child, the child still holds the **same upstream
socket reference**, and `checkCaveats` runs only where the serving broker chooses
to run it. A narrowed door is therefore **metadata the child is trusted to
honor** — a child that holds the upstream socket can connect to it directly,
unnarrowed. Narrowing is a claim, not a boundary.

## The decision — interpose a proxy that holds the reference

Make narrowing **structural** with an **interposer**: a per-door proxy that

1. **holds the upstream reference** (the real door socket),
2. **serves its own door** on a fresh socket, and
3. runs `checkCaveats` on **every** request before forwarding it upstream — a
   denied request is refused at the proxy and never reaches upstream.

The child is handed **only the interposer's socket**, never the upstream's. The
narrowed door is now a genuinely weaker *capability* — an object that can do
strictly less — not a string the child is trusted to respect. This is exactly the
object-capability principle `prx-86g9` targets: *a box's authority is the set of
references it holds.* Over-granting becomes unsayable, not rejected.

## The mechanism (`interpose.ts`)

- `enforceAndForward(req, opts)` — the enforcement core (no sockets, so it is
  directly testable): derive a context from the request (default `{method,
  params}`), run `checkCaveats(grant, ctx, verifiers)`, and **forward upstream
  iff every caveat holds**. A denial returns `CAVEAT_DENIED` and is never
  forwarded; an upstream failure surfaces distinctly as `UPSTREAM_ERROR`.
- `createInterposerHandlers(opts)` — wraps that core in the standard
  newline-delimited-JSON door protocol (`Bun.listen({ unix, socket })`), so an
  interposer *is* an ordinary door from the child's side.

It **reuses, not replaces**, the existing model:

- `checkCaveats` is the per-request gate the interposer runs — the broker still
  owns the verifier grammar, so the engine stays domain-agnostic.
- `attenuatesDoors` / the algebra proofs still pin that caveat-set narrowing is
  monotone; interposition is what *enforces* that narrowing on traffic.
- Signed grants (`prx-79id`) carry authority **in transit** on tcp/vsock;
  interposition enforces authority **as structure** for a held unix reference.
  They are complementary halves of `prx-86g9`.

### Composition

Interposers chain. Putting an interposer in front of an interposer is a
doubly-narrowed door, and because caveats are append-only (`attenuate`), a
request denied by an outer layer never reaches the inner one or the upstream —
authority only ever shrinks down a delegation chain. `interpose.test.ts` proves
both the keystone (*a denied request never reaches the upstream the child can't
see*) and chaining on real sockets.

## Status, scope, and what is deliberately deferred

- **Done here:** the enforcement primitive, prototyped and tested in isolation
  (the keystone + chaining + fail-closed + upstream-error cases).
- **Gated on reference-passing spawn (`prx-8k08`/`prx-86g9`):** wiring the
  interposer into claude-box spawn — i.e. having `launcherd` *create* an
  interposer at delegation time and hand the child only its socket — needs spawn
  to pass references rather than bind-mount the whole door directory. Until that
  lands, this module is the ready primitive, not a live boundary, so trust ledger
  row 6.3 moves **🔴 → 📐** (designed + prototyped), not ✅.
- **Related:** `prx-e232` (retire the lineage `attenuatesDoors ⊆` ceiling) becomes
  safe once reference-passing makes that ceiling vestigial; interposition is the
  enforcement that replaces it.
