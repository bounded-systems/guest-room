# Executed against guest-room/mod.ts by guest-room.test.ts.
# A door is a (name, capability) addressed over a TRANSPORT. The capability model
# is transport-agnostic: the SUBSTRATE — a container, a microVM, a remote host —
# decides whether the broker is reached over a unix socket (same machine), a vsock
# (across the VM boundary), or tcp (across the network). What the door GRANTS, the
# env var that points at it, and the in-room socket the guest connects to do not
# change when the wire does. Only the substrate boundary moves.
#
# What this feature does NOT claim: that any transport AUTHENTICATES its peer.
# That is the broker's/substrate's job, not the engine's — a unix socket carries
# kernel peer credentials, a vsock carries a peer CID, tcp carries nothing — and
# the trust each wire affords is documented in docs/authority-and-attenuation.md,
# not asserted here. This feature proves only that the authority is the SAME
# object across wires.

Feature: A door's authority is transport-agnostic — same capability, different wire

  Scenario: a door's in-room side is a unix socket by default
    Given the hotel's door catalog
    When the room resolves the "keeper" door
    Then its in-room socket is "/run/keeperd.sock"
    And its broker is reached at "/tmp/keeperd.sock"

  Scenario: the broker can be reached across a VM boundary over tcp, and the capability is unchanged
    Given the hotel's door catalog
    When the room resolves the "keeper" door with the broker over tcp "host.containers.internal:3002"
    Then its broker is reached at "tcp:host.containers.internal:3002"
    And its in-room socket is "/run/keeperd.sock"
    And the rulebook card for it shows "signed git writes"
    And the room reaches it via the "KEEPERD_SOCK" env var

  Scenario: the broker can be reached over vsock on a microVM substrate, and the capability is unchanged
    Given the hotel's door catalog
    When the room resolves the "keeper" door with the broker over vsock "2:3002"
    Then its broker is reached at "vsock:2:3002"
    And its in-room socket is "/run/keeperd.sock"
    And the rulebook card for it shows "signed git writes"
