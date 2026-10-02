// A page script that reads state an earlier call left on window (a picker's
// phases, fill's batch record, a readback, an upload) may run on a document
// that no longer has it: the pick reloaded or navigated the page. It must end
// as a coded reply, never a raw page error with no ok key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_SCRIPTS, pageScript } from "../server.js";
import { page, run } from "./helpers/page.mjs";

const STATE = /window\.__perch_(select|ta|ff|rb|up|blank)\b/;

// Scripts that create the state rather than read a lost one.
const STARTS = {
  fill: "records a fresh typeahead state for the typed field",
  select_start: "records a fresh select state",
  click: "records a fresh new-tab click",
  click_readback: "records a fresh readback before clicking",
  readback_arm: "records a fresh readback",
  file_upload: "records a fresh upload state",
  trusted_fill_background: "records a fresh typeahead state for the typed field",
  trusted_fill_background_label: "holds the field fill's ranking picks",
  trusted_fill_probe_label: "holds the field fill's ranking picks",
};

// The least each reader needs besides its lost state.
const ARGS = {
  fill_fields: { fields: [{ selector: "#x", text: "a" }], from: 1 },
  trusted_probe: { select: "option" },
  trusted_fill_probe: { select: "option" },
  trusted_check: { forFill: true, text: "a" },
  file_upload_shown: { up: true, name: "a.txt" },
};

// Readers whose lost-state reply is a documented shape other than ok:false.
const SHAPES = {
  fill_fields: [(r) => r.gone === true, "a later pass on another document answers {gone}, which fillFields reports"],
  readback_read: [(r) => r.navigated === true, "no readback state means a new document, reported as navigated"],
  select_open: [(r) => r === false, "a probe: false is not open yet"],
  trusted_check: [(r) => r.hit === undefined && r.ok === undefined, "no press was recorded, so no hit"],
};

const readers = Object.keys(PAGE_SCRIPTS).filter((k) => STATE.test(PAGE_SCRIPTS[k]) && !(k in STARTS));

test("page-state-lost: the table covers real scripts", () => {
  for (const k of [...Object.keys(STARTS), ...Object.keys(ARGS), ...Object.keys(SHAPES)]) assert.ok(k in PAGE_SCRIPTS, k);
  for (const k of ["select_read", "fill_ta_read", "fill_ta_miss", "select_pick", "fill_ta_pick"]) assert.ok(readers.includes(k), k);
});

for (const name of readers) {
  for (const extra of [{}, { final: true }]) {
    test(`page-state-lost: ${name} ${JSON.stringify(extra)} with its state gone is a coded reply`, () => {
      const r = run(page("<input id=x>"), name, { ...ARGS[name], ...extra });
      assert.ok(!(r && typeof r === "object" && "__perch_error" in r), JSON.stringify(r));
      if (r === null) return;
      if (SHAPES[name] && SHAPES[name][0](r)) return;
      assert.equal(r && r.ok, false, JSON.stringify(r));
      assert.equal(typeof r.error, "string");
    });
  }
}

// The pick names what it pressed, from the page; its source never carries it.
test("select_pick and fill_ta_pick answer the option they pressed", () => {
  const w = page(`<div id=c role=combobox aria-label=Team aria-controls=pop aria-expanded=true>Pick</div><ul id=pop role=listbox><li role=option>Design (Lima)</li><li role=option>Sales</li></ul>`);
  const A = { selector: "#c", text: "design" };
  run(w, "select_start", A);
  assert.deepEqual(run(w, "select_pick", A), { picked: "Design (Lima)", tok: w.__perch_select.tok });
  const t = page(`<input id=loc role=combobox aria-autocomplete=list aria-controls=lb aria-label=City><ul id=lb role=listbox><li role=option>Rosario, Santa Fe</li></ul>`);
  const K = { selector: "#loc", text: "Rosario" };
  assert.equal(run(t, "fill", K).pending, true);
  assert.deepEqual(run(t, "fill_ta_pick", K), { picked: "Rosario, Santa Fe", tok: t.__perch_ta.tok });
  for (const name of ["select_pick", "fill_ta_pick"]) {
    const a = { selector: "#c", text: "Design" }, b = { selector: "#c", text: "Sales" };
    assert.equal(pageScript(name, a).replace(JSON.stringify(a), ""), pageScript(name, b).replace(JSON.stringify(b), ""));
  }
});
