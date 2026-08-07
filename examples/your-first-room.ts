// guest-room — your first room. Run: bun run examples/your-first-room.ts
//
// The quickstart prints the rulebook a room hands an agent. This shows how to
// declare your own: two capabilities in the catalog, one granted to the room,
// the other denied — not by a rule, but by never being wired up.
import {
  expandRoom,
  deniedDoors,
  grantedDoorLines,
  deniedDoorSection,
  type DoorCatalog,
  type RoomCatalog,
} from "../mod.ts";

// 1. The catalog: the doors that exist, written once. Each is a socket to a
//    broker that holds the actual key — the agent connects, it never holds one.
const catalog: DoorCatalog = {
  scout: {
    flag: "--scout", inBox: "/run/scoutd.sock", env: "SCOUTD_SOCK",
    hostDefault: "/tmp/scoutd.sock", grants: "external reads",
    use: "Read external content through the scout door.",
    deny: "No external reads here; relaunch with --scout.",
  },
  net: {
    flag: "--net", inBox: "/run/netd.sock", env: "NETD_SOCK",
    hostDefault: "/tmp/netd.sock", grants: "policed egress",
    use: "All egress goes through the net door.",
    deny: "No network here; relaunch with --net.",
  },
};

// 2. The decision — the whole grant/deny declaration is these three lines. The
//    room names what it gets; everything else in the catalog is denied by
//    omission. There is no deny-list to keep in sync.
const rooms: RoomCatalog = {
  research: { doors: ["scout"], about: "read the web, reach nothing else" },
};
const granted = expandRoom(rooms, catalog, "research", process.env);
const denied = deniedDoors(catalog, new Set(granted.map((d) => d.name)));

console.log("GRANTED:");
console.log(grantedDoorLines(granted).join("\n"));
console.log("");
console.log(deniedDoorSection(denied).join("\n"));
