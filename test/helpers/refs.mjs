// Stands in for an accessibility_snapshot that listed `els` ({ref: element}):
// the page gets the map and its id, and this server remembers the refs for
// `target`. Returns each ref as the server shows it (a ref it showed before
// comes back renumbered).
import { keepSnapshot } from "../../server.js";

export function mapRefs(win, els, target) {
  win.__perch_refsId = "m";
  win.__perch_refs = els;
  const keys = Object.keys(els);
  const lines = keepSnapshot(target, `# {"rid":"m","url":"x"}\n` + keys.map((k) => k + " x").join("\n")).split("\n").slice(1);
  return Object.fromEntries(keys.map((k, i) => [k, lines[i].split(" ")[0]]));
}
