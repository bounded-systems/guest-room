---
bump: minor
---
`call()` can present a signed grant: the optional `grant` opt is set on the request envelope, so a client can authenticate to a tcp/vsock serving room gated by `signedGrantAuthorizer` (no-op on a unix door, where the held reference is authority). Releases the door-bridge presentation primitive (#43) so consumers can depend on it instead of vendoring the protocol.
