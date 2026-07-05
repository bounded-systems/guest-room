---
bump: minor
---
`call()` now rejects with `DoorCallError` (exported), preserving the daemon's machine-readable `error.code` instead of collapsing every failure into a plain `Error` with only a message — per-door clients that pattern-match on `.code` (e.g. `INVALID_PARAMS`, `NOT_FOUND`) can now delegate to `call()` directly instead of hand-rolling their own connect/request loop. Also fixes a latent hang: a server closing the connection before writing a response line previously left the promise unsettled forever; it now rejects with `CONNECTION_CLOSED`.
