# Working in a Cowork sandbox

A Cowork session is a Linux VM with no ambient network, reaching the outside only
through a policy gateway that **injects credentials on the way out**. That single
property decides everything below.

Measured 2026-08-20 on Ubuntu 24.04 / kernel 6.18.5. Re-measure before trusting;
egress policy is per-organization and per-session.

## The two dials

Authority in a session is set by exactly two things. They are orthogonal, both
fail closed, and both are legible from inside.

**1. The egress allowlist — which hosts you may act as yourself on.**

The gateway attaches your GitHub credential past any door you can build. A box
with no NIC, uid 65534, an `env -i` environment and `GITHUB_TOKEN` unset — a box
that is credential-free by every check `claude-box` makes — still answers as you:

```
GITHUB_TOKEN in box: <unset>
api.github.com/user -> {"login":"…"}
```

So an allowlist here is not a reach control. `--net github.com` does not mean
*may reach github*; it means **may act as me on github**. netd refuses to serve
behind an injecting parent unless the room says otherwise
(`NETD_ALLOW_INJECTING_PARENT=1`), and names the principal when it does.

**2. The repo attach set — which repositories that identity may touch.**

Per-session, per-repository, read separated from push, with an explicit request
protocol. Nothing else about the session changes what it can do to a repo:

```
remote: access denied by the git proxy: bounded-systems/claude-box is not in
this session's authorized repository set, so the proxy will not inject a
credential for it.
```

**The attach set is the blast radius.** A session that attaches nothing can
disclose your identity and read public source. A session that attaches a repo
with `push` grants write on that repo to *every process in the VM*, including
anything it happens to install.

## Rooms

Work runs in a box, not in the session. Rooms differ in one dimension only —
which hosts a box may act as you on.

| room | allowlist | may act as you | for |
|---|---|---|---|
| `survey` | `github.com` | nothing | read public source, run its tests |
| `land` | `github.com`, `api.github.com` | both, acknowledged | clone, commit, push, open PRs |

`survey` keeps `api.github.com` off the list, so a surveying box cannot identify
— let alone act as — the operator. `land` includes it on purpose, which is why
netd warns at every launch. The warning is the feature.

```sh
./work.sh survey bun test          # third-party code, acting as nobody
./work.sh land   git push origin HEAD
```

## Protocol

**Before.** Decide the attach set first. Nothing attached by default; read when
the session needs your repos; `push` only when the session's job is to land a
change, and end the session when it lands.

**During.** Third-party code runs in `survey`, never in the session. The session
is the launcher; it is not also the workshop.

**After.** Nothing survives a session except what is in a repo or a published
artifact. Not the VM, not the transcript, not agent memory — memory holds facts
about people, not findings. A session that cannot convert its own output into a
patch, an issue, or a page should say so at the start rather than discover it at
the end.

## What this is not

**It is a seatbelt, not a cage.** Root in the guest can undo the layers the
launcher puts up. `setpriv` is what closes the gaps, and nothing forces the
launcher to use it. What the rooms buy is a safe *default* and a legible one —
not enforcement. The specific ways a root child can defeat the room boundary are
tracked as issues rather than documented here.

Real enforcement would require the session's own process to be the box: dropped
privileges and a door reference handed in before the agent gets control, rather
than a full-authority VM that voluntarily builds walls inside itself. That is a
change on the platform side, not something a session can do to itself. Until
then, treat the protocol above as a convention that a careless launch silently
skips — which is exactly the failure mode this org exists to design out.

## Where the dials actually are

The egress allowlist is a **setting**, not architecture. A blocked host says so
in as many words — `Host not in allowlist: index.crates.io. Add this host to
your network egress settings to allow access.` It lives at:

    environment settings → Code → Network access → Custom → Allowed domains

and, for a shared environment, at admin settings → Cloud environments, where it
applies to every session that runs there. Widening it is what makes `npm`,
`crates.io`, `jsr` and the nix cache reachable — most of this org's repos cannot
have their dependencies installed in a default sandbox for exactly this reason.

Widen it deliberately, per environment, and remember what an added host means
under an injecting parent: not *may reach*, but *may act as me on*.

## The asymmetry worth knowing about

**A session can publish an artifact it cannot read back.** Publishing goes out
through the tool layer, which has no allowlist and no gate at all; reading comes
back through the VM's network, which is allowlisted. So a page can be created,
listed, and shown as owned — and its content still refuses to load:

    this environment's network allowlist blocks <id>.frame.claudeusercontent.com
    … your access to the artifact itself is fine (the permission check passed)

The permission check passing while the read fails is the tell: authorization and
reach are separate dials here too, and nothing reconciles them. Add
`*.frame.claudeusercontent.com` to the allowed domains above if sessions should
read their own pages back. Note which direction is ungated by default — the one
that writes to the outside world permanently.

## Known traps

- **The CA bundle is wired by env var into a root-only path.** Children inherit
  `CURL_CA_BUNDLE=/root/.ccr/ca-bundle.crt` and get `curl: (77)` after dropping
  privileges. Use `env -i`; the system store already trusts the proxy CA.
- **bun may be unreachable from an unprivileged box** (it lives under `/root`,
  mode 0700). Entrypoint tooling that must run in-box should be stdlib Python.
- **The gateway's port is not stable across turns.** Read `HTTPS_PROXY`.

Caller-identification and room-boundary defects are tracked in the org's private
tracker, not here and not in a public repo's issues.
