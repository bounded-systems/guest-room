// guest-room quickstart — run: bun run examples/quickstart.ts
//
// Opens a room and prints the rulebook it hands an agent at launch: what is
// GRANTED, and — by name — what is DENIED. The denied lines are not advice; the
// capability is physically absent, so there is nothing in the box to reach for.
import {
  expandRoom,
  deniedDoors,
  capabilityPreamble,
  grantedDoorLines,
  deniedDoorSection,
  type DoorCatalog,
  type RoomCatalog,
} from "../mod.ts";

// 1. You (the consumer) own the catalog: the doors a room can furnish. Each door
//    is a socket to a broker that holds the actual key — the agent never does.
const catalog: DoorCatalog = {
  keeper: {
    flag: "--keeper", inBox: "/run/keeperd.sock", env: "KEEPERD_SOCK",
    hostDefault: "/tmp/keeperd.sock", grants: "signed git writes",
    use: "Route every git write through the keeper door.",
    deny: "No git-write authority here; relaunch with --keeper.",
  },
  net: {
    flag: "--net", inBox: "/run/netd.sock", env: "NETD_SOCK",
    hostDefault: "/tmp/netd.sock", grants: "policed egress",
    use: "All egress goes through the net door.",
    deny: "No network here; relaunch with --net.",
  },
  scout: {
    flag: "--scout", inBox: "/run/scoutd.sock", env: "SCOUTD_SOCK",
    hostDefault: "/tmp/scoutd.sock", grants: "external reads",
    use: "Read external content through the scout door.",
    deny: "No external reads here; relaunch with --scout.",
  },
};

// 2. ...and the rooms: named bundles of doors for a kind of work.
const rooms: RoomCatalog = {
  read: { doors: ["scout"], about: "external reads only" },
  dev: { doors: ["keeper", "net", "scout"], about: "edit, commit, read & policed egress" },
};

// 3. Open the "read" room. guest-room resolves what is granted (scout) and
//    states what is denied (keeper, net) — the honest surface is both.
const granted = expandRoom(rooms, catalog, "read", process.env);
const denied = deniedDoors(catalog, new Set(granted.map((d) => d.name)));

const rulebook = [
  ...capabilityPreamble("example-workcell"),
  "",
  "GRANTED:",
  ...grantedDoorLines(granted),
  "",
  ...deniedDoorSection(denied),
].join("\n");

console.log(rulebook);
