// Preloaded into every test process (package.json "test"). server.js builds its
// real osascript daemons at import and deps.exec runs real commands, so a test that
// calls a tool before installing a fake would drive the user's browser. These stubs
// make that a loud failure instead. Tests that want the real thing say so: the
// darwin-only live tests spawn osascript themselves.
// Set before any later server.js instance loads (the lock harness loads one per
// scenario): each reads ROOMS_HOME at load.
process.env.ROOMS_HOME = "/nonexistent/perch-test-rooms";
// No loft: holder.json is read per call, so a test that wants one points LOFT_HOME at a temp dir.
process.env.LOFT_HOME = "/nonexistent/perch-test-loft";
// No loft CLI either: a routed new_tab would otherwise run the user's own `loft up`.
process.env.LOFT_BIN = "/nonexistent/perch-test-loft/loft";
const { DAEMONS, deps, roomsReset, focus } = await import("../../server.js");
// The suite runs under a focus grant, so tests of raise:true and activate_tab keep
// their meaning; test/focus-grant.test.mjs clears it.
focus.granted = true;

const refuse = (what) => { throw new Error(`test isolation: ${what} reached the real system; install a fake world or stub deps.exec first`); };
for (const lane of Object.keys(DAEMONS)) DAEMONS[lane] = { run: async () => refuse(`DAEMONS.${lane}`) };
deps.exec = async (cmd) => refuse(`deps.exec(${cmd})`);
// Rooms: no registry and no endpoint, so a room tab only answers through a fake (test/fakes/cdp-room.mjs).
roomsReset({ home: "/nonexistent/perch-test-rooms", fetch: async () => refuse("rooms.fetch"), WebSocket: class { constructor() { refuse("rooms.WebSocket"); } } });
