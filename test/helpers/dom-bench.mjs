// Times perch's page scripts on the large fixture under happy-dom: median ms of
// several runs per case. Indicative only; happy-dom's style, layout and
// selector costs are not a browser's. Not a test, and not the live bench.
//   PERCH_DOM_BENCH=1 node test/helpers/dom-bench.mjs [path/to/server.js] [runs]
// A second server.js (an older checkout's) gives the before column.
import { pathToFileURL } from "node:url";
import { page } from "./page.mjs";
import { build } from "../fixtures/large-dom.mjs";

const SEL = 'a[href], button, input:not([type=hidden]), textarea, select, [role], [tabindex]:not([tabindex="-1"]), h1, h2, h3, h4, h5, h6, [contenteditable]:not([contenteditable=false]), summary';
const MISS = JSON.stringify(["zzz", "qqq xx", "zone 99999", "lodz, iceland, 7"]);

async function cases(serverUrl) {
  const { PAGE_SCRIPTS, pageScript, buildEvalWrapper } = await import(serverUrl);
  const matchLib = PAGE_SCRIPTS.fill_ta_pick.slice(0, PAGE_SCRIPTS.fill_ta_pick.indexOf("const s = window.__perch_ta;"));
  const script = (name, A) => buildEvalWrapper(pageScript(name, A));
  const body = (b, lib = "") => buildEvalWrapper(pageScript(null, { text: "" }) + lib + b);
  return {
    "deepAll(snapshot selector)": body(`return deepAll(${JSON.stringify(SEL)}).length`),
    "snapshot max 500": script("snapshot", { max: 500 }),
    "snapshot all": script("snapshot", { max: 100000 }),
    "get_text body": script("get_text", { offset: 0, maxChars: 1e7 }),
    "fill label miss": script("fill", { label_pattern: "zzz", text: "x" }),
    "fill ancestor fallback": script("fill", { label_pattern: "customer", text: "x" }),
    "matchTier 1600 options, misses": body(`const l = Array.from(document.querySelectorAll("[role=option], option"));
      return ${MISS}.map(function (w) { return matchTier(l, function (x) { return norm(x.textContent); }, norm(w)).hits.length; })`, matchLib),
    "taMatch 1600 options, misses": body(`const l = Array.from(document.querySelectorAll("[role=option], option"));
      return ${MISS}.map(function (w) { return taMatch(l, w).hits.length; })`, matchLib),
  };
}

// happy-dom caches query results and computed styles until the DOM changes, so
// an attribute flips on the page before every run; pages persist for the JIT,
// and servers alternate run by run. Two warm-up runs are dropped.
// -> [{case: median ms}] per server
export async function bench(serverUrls, runs = 15) {
  const sets = [];
  for (const u of serverUrls) sets.push(await cases(u));
  const out = sets.map(() => ({}));
  for (const k of Object.keys(sets[0])) {
    const pages = sets.map(() => { const w = page(""); build(w.document); return w; });
    const times = sets.map(() => []);
    for (let r = 0; r < runs + 2; r++) {
      sets.forEach((set, i) => {
        pages[i].document.body.lastElementChild.setAttribute("data-run", String(r));
        const t0 = performance.now();
        pages[i].eval(set[k]);
        const dt = performance.now() - t0;
        if (r >= 2) times[i].push(dt);
      });
    }
    for (const w of pages) await w.happyDOM.close();
    times.forEach((t, i) => { out[i][k] = +t.sort((a, b) => a - b)[t.length >> 1].toFixed(1); });
  }
  return out;
}

if (process.env.PERCH_DOM_BENCH) {
  const [other, runs] = process.argv.slice(2);
  const here = new URL("../../server.js", import.meta.url).href;
  const res = await bench(other ? [pathToFileURL(other).href, here] : [here], Number(runs) || 15);
  const after = res[res.length - 1], before = other ? res[0] : null;
  for (const k of Object.keys(after)) {
    const b = before && before[k];
    console.log(k.padEnd(32), (b != null ? String(b).padStart(8) + " ->" : "").padEnd(12), String(after[k]).padStart(8), "ms",
      b ? `(${Math.round((1 - after[k] / b) * 100)}% less)` : "");
  }
}
