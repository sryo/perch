// Preloaded into every test process (package.json "test"). server.js builds its
// real osascript daemons at import and deps.exec runs real commands, so a test that
// calls a tool before installing a fake would drive the user's browser. These stubs
// make that a loud failure instead. Tests that want the real thing say so: the
// darwin-only live tests spawn osascript themselves.
import { DAEMONS, deps } from "../../server.js";

const refuse = (what) => { throw new Error(`test isolation: ${what} reached the real system; install a fake world or stub deps.exec first`); };
for (const lane of Object.keys(DAEMONS)) DAEMONS[lane] = { run: async () => refuse(`DAEMONS.${lane}`) };
deps.exec = async (cmd) => refuse(`deps.exec(${cmd})`);
