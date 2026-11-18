// A snapshot under a blocking modal lists only the modal's rows, plus what the
// site left live (a dropdown portaled to <body>), with `behind: N` counting the
// rows it left out. Blocking means the site itself made the rest unreachable: a
// native modal <dialog>, or an aria-modal box with the background under inert or
// aria-hidden. An aria-modal box over a live page is not proof (a promo over a
// form fill still reaches) and prints everything, as do `role` and `query`, and
// a modal with no rows of its own. The `form` header follows the rows.
// A nav of 12 or more shown links, and nothing else to act on, is one row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, run } from "./helpers/page.mjs";

const snap = (w, A = {}) => {
  const [head, ...lines] = run(w, "snapshot", { max: 500, ...A }).split("\n");
  return { head: JSON.parse(head.slice(2)), lines: lines.map((l) => l.slice(l.indexOf(" ") + 1)) };
};
// happy-dom has no top layer: :modal never matches, so a test marks its dialog.
const modal = (w, id) => {
  const d = w.document.getElementById(id), m = d.matches.bind(d);
  d.matches = (s) => s === ":modal" || m(s);
};
const BG = `<a href=/a>Home</a><a href=/b>Docs</a><form><label>Search <input required></label><button>Go</button></form>`;

test("a native modal dialog prints only its own rows; the background is counted in behind", () => {
  const w = page(`${BG}<dialog id=d open><form><label>Code <input name=code required></label><button>Verify</button></form></dialog>`);
  modal(w, "d");
  const { head, lines } = snap(w);
  assert.deepEqual(lines, [`textbox "Code" name="code" required`, `button "Verify"`]);
  assert.equal(head.behind, 4);
  assert.deepEqual(head.form, { fields: 1, requiredEmpty: 1 });
});

test("an aria-modal box over an aria-hidden or inert background is scoped; its portaled listbox stays", () => {
  for (const hide of ["aria-hidden=true", "inert"]) {
    const w = page(`<div ${hide}>${BG}</div>
      <div role=dialog aria-modal=true aria-label=Edit><label>Name <input></label><button>Save</button></div>
      <div role=listbox aria-label=Colors><div role=option>Red</div></div>`);
    const { head, lines } = snap(w);
    assert.deepEqual(lines, [`dialog "Edit"`, `textbox "Name"`, `button "Save"`, `listbox "Colors"`, `option "Red"`], hide);
    assert.equal(head.behind, 4, hide);
    assert.equal(head.form, undefined, "the background form is not the header's");
  }
});

test("background in a shadow root under aria-hidden is behind too", () => {
  const w = page(`<div aria-hidden=true><x-bg id=h></x-bg></div><div role=dialog aria-modal=true aria-label=Edit><button>Save</button></div>`);
  w.document.getElementById("h").attachShadow({ mode: "open" }).innerHTML = `<button>Shadow</button>`;
  const { head, lines } = snap(w);
  assert.deepEqual(lines, [`dialog "Edit"`, `button "Save"`]);
  assert.equal(head.behind, 1);
});

test("an aria-modal box over a live page prints everything, without behind", () => {
  const w = page(`${BG}<div role=dialog aria-modal=true aria-label=Promo><button>Close</button></div>`);
  const { head, lines } = snap(w);
  assert.equal(lines.length, 6);
  assert.equal(head.behind, undefined);
  assert.equal(head.form.fields, 1);
});

test("role and query bypass the scope; a modal with no rows of its own prints everything", () => {
  let w = page(`${BG}<dialog id=d open><button>Close</button></dialog>`);
  modal(w, "d");
  let s = snap(w, { role: "link" });
  assert.deepEqual(s.lines, [`link "Home" href="/a"`, `link "Docs" href="/b"`]);
  assert.equal(s.head.behind, undefined);
  s = snap(w, { query: "Docs" });
  assert.deepEqual(s.lines, [`link "Docs" href="/b"`]);
  w = page(`${BG}<dialog id=d open><p>Loading…</p></dialog>`);
  modal(w, "d");
  s = snap(w);
  assert.equal(s.lines.length, 4);
  assert.equal(s.head.behind, undefined);
});

test("a diff taken once a modal opens lists no background ref as gone", () => {
  const w = page(`<div id=bg>${BG}</div>`);
  const first = snap(w);
  assert.equal(first.lines.length, 4);
  w.document.getElementById("bg").setAttribute("aria-hidden", "true");
  w.document.body.insertAdjacentHTML("beforeend", `<div role=dialog aria-modal=true aria-label=Edit><button>Save</button></div>`);
  const { head, lines } = snap(w, { since: first.head.rid });
  assert.deepEqual(lines, [`dialog "Edit"`, `button "Save"`]);
  assert.equal(head.gone, undefined);
  assert.equal(head.behind, 4);
});

// A nav of links only, 12 or more, prints as one row naming its shown links
// (`click {label_pattern}` reaches each in one call): no refs or hrefs per link.
// A smaller nav, one with other controls (a search box, a menu button) or the
// focus, and any snapshot with `role` or `query`, print link rows as before.
const navOf = (n, extra = "") => `<nav aria-label=Main>${extra}${Array.from({ length: n }, (_, i) => `<a href=/s${i}>Section ${i}</a>`).join("")}<a href=/x style="display:none">Gone</a></nav>`;

test("a nav of 12 or more links collapses to one row naming the shown links", () => {
  const w = page(`${navOf(12, "<h2>Browse</h2>")}<button>Buy</button>`);
  const { head, lines } = snap(w);
  assert.deepEqual(lines, [`navigation "Main" links=${JSON.stringify(Array.from({ length: 12 }, (_, i) => `Section ${i}`))}`, `button "Buy"`]);
  assert.equal(head.count, 2);
  const r = run(w, "click", { label_pattern: "^Section 7$" });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("a small nav, one with other controls or the focus, and role or query keep link rows", () => {
  const rowsOf = (html, A, focus) => { const w = page(html); if (focus) w.document.querySelector(focus).focus(); return snap(w, A).lines; };
  assert.equal(rowsOf(navOf(11)).length, 11);
  assert.equal(rowsOf(navOf(12, "<input aria-label=Search>")).length, 13);
  assert.equal(rowsOf(navOf(12, "<button aria-expanded=false>More</button>")).length, 13);
  assert.equal(rowsOf(navOf(12), {}, "a[href='/s3']").length, 12);
  assert.equal(rowsOf(navOf(12), { role: "link" }).length, 12);
  assert.deepEqual(rowsOf(navOf(12), { query: "Section 1\\b" }), [`link "Section 1" href="/s1"`]);
});
