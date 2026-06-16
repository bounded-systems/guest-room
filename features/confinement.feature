# Executed against guest-room/mod.ts by guest-room.test.ts.
# Confinement is the property the design turns on: a capability handed out by the
# concierge never becomes durable authority owned by its holder. It is valid ONLY
# while a live provider backs it (so it dies when the lease lapses) and ONLY
# within that provider's ceiling (so it can never be captured wider than it was
# lent). This is the engine-side statement of "an agent does not become a new
# actor type" — a held grant is a capability checked against the live registry,
# not a standing property of whoever holds it.

Feature: A capability is confined to its provider — it never outlives the lease or exceeds the ceiling

  Scenario: a held capability is confined while its provider's lease is live
    Given the hotel's door catalog
    And a concierge registry with a "reads" provider on the "scout" door, ceiling "repo=acme/widgets", leased until 1000
    When a consumer is introduced to "reads" at time 500 wanting "readonly"
    Then the introduction yields a capability
    And the held capability is confined at time 500

  Scenario: the capability does not outlive its provider — once the lease lapses it is no longer confined
    Given the hotel's door catalog
    And a concierge registry with a "reads" provider on the "scout" door, ceiling "repo=acme/widgets", leased until 1000
    When a consumer is introduced to "reads" at time 500
    Then the held capability is confined at time 500
    And the held capability is not confined at time 1500

  Scenario: a capability widened past the provider ceiling is not confined
    Given the hotel's door catalog
    And a concierge registry with a "reads" provider on the "scout" door, ceiling "repo=acme/widgets", leased until 1000
    When a consumer is introduced to "reads" at time 500
    And a forged capability drops the "repo=acme/widgets" caveat
    Then the held capability is not confined at time 500

  Scenario: a dead capability is never introduced in the first place
    Given the hotel's door catalog
    And a concierge registry with a "reads" provider on the "scout" door, ceiling "repo=acme/widgets", leased until 1000
    When a consumer is introduced to "reads" at time 1500
    Then the introduction yields nothing
