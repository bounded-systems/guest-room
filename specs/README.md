# specs — machine-checked models

Where the algebra graduates from *tested* to *model-checked*. `algebra-proofs.test.ts`
proves the engine's pure invariants by exhaustion over a finite caveat universe;
what it can't reach is arbitrary **event orderings** — the temporal heart of
confinement ("a capability dies with its lease"). That's TLA+'s job here.

## `Confinement.tla`

Models the lease/ceiling confinement property as state machine: providers
`Register` doors with a ceiling and a lease, time `Tick`s, consumers are
`Introduce`d to live providers (mirroring `resolveProvider`), and an **adversary**
can `Forge` a wider door (drop a caveat) or replay a grant by holding it as the
clock advances past the lease. Each operator maps 1:1 to a function in `../mod.ts`
(`Attenuate`/`AttenuatesDoors`/`LiveProviders`/`IsConfined`).

TLC checks two invariants over **every reachable interleaving**:

- **`ConfinedIsBacked`** — confinement is never vacuous: anything treated as
  confined really is backed by a live provider whose ceiling it respects (a
  forged-wider grant cannot pass).
- **`ExpiredNotConfined`** — a capability does not outlive its provider: once no
  live provider remains, no amount of replay keeps it confined.

### Run it

```sh
# one-time: fetch the checker (kept out of git — see ../.gitignore)
curl -fsSL -o tla2tools.jar \
  https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar

java -cp tla2tools.jar tlc2.TLC -config Confinement.cfg Confinement.tla
```

### Last result

Green on the `Confinement.cfg` instance (`Caps={reads}`, `CaveatU={r1,r2}`,
`MaxTime=3`, `Leases={1,2}`): **5104 distinct states, depth 13, no error.** A
separate non-vacuity check confirms a *confined* state is reachable, so the
invariant is exercised rather than trivially true.

> Not wired into `bun test` CI — it needs a JVM + `tla2tools.jar`. It's a
> reproducible model check, run on demand or in a dedicated job. Scaling the
> constants (more caveats, larger `MaxTime`) widens coverage at the usual
> state-space cost.
