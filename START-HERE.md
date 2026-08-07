# guest-room — start here

**guest-room scopes what an agent is allowed to do, and refuses everything else
by construction — not by a reminder you hope it reads.**

It is the capability runtime under
[claude-box](https://github.com/bounded-systems/claude-box), guest-agnostic and
usable on its own. Every claim on this page is executable — `bun test` goes red if
the docs drift from the engine — and [`docs/scorecard.md`](docs/scorecard.md) is
the self-grading against the security canon, gaps included.

## See it

```sh
git clone https://github.com/bounded-systems/guest-room
cd guest-room
bun run examples/quickstart.ts
```

Needs [bun](https://bun.sh). There is no install step — the engine has no
dependencies.

That prints the rulebook an agent receives at launch: what this launch grants
and, by name, what it denies. The denied lines are not advice — the capability is
absent, so there is nothing in the box to reach for.

A container bounds *where* an agent runs and what it can *write*; guest-room
bounds what it can *reach*. Each capability is a socket to a broker that holds the
actual key. The agent knocks; it never holds the key.

## Wire your own

```sh
bun run examples/your-first-room.ts
```

The grant/deny declaration is these three lines. A room names the doors it gets;
everything else in the catalog is denied by omission, so there is no deny-list to
keep in sync.

```ts
const rooms: RoomCatalog = {
  research: { doors: ["scout"], about: "read the web, reach nothing else" },
};
const granted = expandRoom(rooms, catalog, "research", process.env);
const denied = deniedDoors(catalog, new Set(granted.map((d) => d.name)));
```

[`examples/your-first-room.ts`](examples/your-first-room.ts) is that, complete and
runnable — the catalog it sits on is the part you write once.

To use it in your own project:
[`@bounded-systems/guest-room`](https://jsr.io/@bounded-systems/guest-room) on
JSR; the full API is in the [README](README.md).
