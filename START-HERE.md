# guest-room — start here

**guest-room scopes what an agent is allowed to do, and refuses everything else
by construction — not by a reminder you hope it reads.**

```sh
bun run examples/quickstart.ts
```

That prints the rulebook an agent receives at launch: what this launch grants
and, by name, what it denies. The denied lines are not advice — the capability is
absent, so there is nothing in the box to reach for.

A container bounds *where* an agent runs and what it can *write*; guest-room
bounds what it can *reach*. Each capability is a socket to a broker that holds the
actual key. The agent knocks; it never holds the key.

Every claim in the [README](README.md) runs — `bun test` goes red if the docs
drift from the engine. [`docs/scorecard.md`](docs/scorecard.md) is the honest
self-grading against the security canon.
