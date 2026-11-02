// accessibility_snapshot {diff:true}: only rows new or changed since this
// server's last snapshot of the tab print; the rest keep their refs (`unchanged`),
// and refs whose element left are listed in `gone` and miss. Anything that
// breaks the chain (another server's snapshot, other filters, a new document)
// answers a full snapshot under fresh refs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const HTML = `<form><label for=e>Email</label><input id=e required>
<label for=n>Name</label><input id=n required>
<label for=c>City</label><input id=c>
<button id=go type=submit onclick="window.clicked = (window.clicked || []).concat('go'); return false">Send</button></form>`;

function install(spec, daemons = DAEMONS) {
  const w = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [spec] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  w.run(JXA_PRELUDE);
  DAEMONS.fast = DAEMONS.slow = w.daemon;
  if (daemons !== DAEMONS) daemons.fast = daemons.slow = w.daemon;
  w.reset();
  return w;
}
const tab = (dom) => ({ url: "https://a.test/p", id: "t", dom });
const text = (r) => r.content.find((c) => c.type === "text").text;
const snap = async (args = {}, call = handleCall) => {
  const r = await call("accessibility_snapshot", args);
  assert.equal(r.isError, undefined, text(r));
  return text(r);
};
const head = (s) => JSON.parse(s.split("\n")[0].slice(2));
const rows = (s) => s.split("\n").slice(1).map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)]);
const refOf = (s, name) => {
  const row = rows(s).find(([, l]) => l.includes(JSON.stringify(name)));
  assert.ok(row, s);
  return row[0];
};

test("a diff prints only the changed row; unchanged rows keep working refs", async () => {
  const dom = page(HTML);
  install(tab(dom));
  const full = await snap();
  const email = refOf(full, "Email"), name = refOf(full, "Name"), send = refOf(full, "Send");
  dom.document.getElementById("e").value = "a@b.co";
  const d = await snap({ diff: true });
  const h = head(d);
  assert.equal(h.unchanged, rows(full).length - 1, d);
  assert.equal(h.gone, undefined, d);
  assert.equal(h.rid, undefined, d);
  assert.equal(h.count, rows(full).length, d);
  assert.deepEqual(rows(d).map(([r]) => r), [email], d);
  assert.match(d, /value="a@b\.co"/);
  assert.equal(h.form.requiredEmpty, 1, d);

  const f = await handleCall("fill", { ref: name, text: "Ana" });
  assert.equal(f.isError, undefined, text(f));
  assert.equal(dom.document.getElementById("n").value, "Ana");
  const c = await handleCall("click", { ref: send });
  assert.equal(c.isError, undefined, text(c));
  assert.equal(String(dom.clicked), "go");
});

test("a removed element's ref is gone and misses; a new one gets a fresh ref", async () => {
  const dom = page(HTML);
  install(tab(dom));
  const full = await snap();
  const city = refOf(full, "City"), email = refOf(full, "Email");
  dom.document.getElementById("c").remove();
  dom.document.querySelector("label[for=c]").remove();
  const extra = dom.document.createElement("div");
  extra.innerHTML = `<label for=p>Phone</label><input id=p required>`;
  dom.document.querySelector("form").insertBefore(extra, dom.document.getElementById("go"));
  const d = await snap({ diff: true });
  assert.deepEqual(head(d).gone, [city], d);
  const phone = refOf(d, "Phone");
  assert.ok(![...rows(full).map(([r]) => r)].includes(phone), d);
  assert.equal(rows(d).length, 1, d);

  const miss = await handleCall("fill", { ref: city, text: "x" });
  assert.equal(miss.isError, true, text(miss));
  assert.match(text(miss), new RegExp(`ref ${city} is stale or unknown`));
  for (const [ref, id] of [[phone, "p"], [email, "e"]]) {
    const ok = await handleCall("fill", { ref, text: "1" });
    assert.equal(ok.isError, undefined, text(ok));
    assert.equal(dom.document.getElementById(id).value, "1");
  }
});

test("diffs chain: each one is against the snapshot before it", async () => {
  const dom = page(HTML);
  install(tab(dom));
  const full = await snap();
  dom.document.getElementById("e").value = "x";
  await snap({ diff: true });
  const d = await snap({ diff: true });
  assert.equal(rows(d).length, 0, d);
  assert.equal(head(d).unchanged, rows(full).length, d);
  const ok = await handleCall("fill", { ref: refOf(full, "City"), text: "Córdoba" });
  assert.equal(ok.isError, undefined, text(ok));
});

test("with no snapshot before, other filters, or another server's snapshot in between, a diff is a full snapshot", async () => {
  const dom = page(HTML);
  install(tab(dom));
  const first = await snap({ diff: true });
  assert.equal(head(first).unchanged, undefined, first);
  assert.equal(rows(first).length, 4, first);

  const btn = await snap({ diff: true, role: "button" });
  assert.equal(head(btn).unchanged, undefined, btn);
  assert.deepEqual(rows(btn).map(([, l]) => l.split(" ")[0]), ["button"]);

  const B = await import("../server.js?server-diff");
  const dom2 = page(HTML);
  install(tab(dom2), B.DAEMONS);
  const mine = await snap();
  await snap({}, B.handleCall);
  const d = await snap({ diff: true });
  assert.equal(head(d).unchanged, undefined, d);
  assert.equal(rows(d).length, 4, d);
  const stale = await handleCall("click", { ref: refOf(mine, "Send") });
  assert.equal(stale.isError, true, text(stale));
});

test("refs this server renumbered keep their shown numbers through a diff", async () => {
  // Two documents seeded alike reuse the same page refs, so the second's are
  // shown renumbered; a diff of the second must answer in those numbers.
  const spec = tab(page(HTML, { timeOrigin: 1800000000100 }));
  install(spec);
  await snap();
  spec.dom = page(HTML, { timeOrigin: 1800000009100 });
  const full = await snap();
  const name = refOf(full, "Name");
  assert.ok(!Object.hasOwn(spec.dom.__perch_refs, name) || spec.dom.__perch_refs[name] !== spec.dom.document.getElementById("n"), "expected a renumbered ref");
  spec.dom.document.getElementById("n").value = "Ana";
  const d = await snap({ diff: true });
  assert.deepEqual(rows(d).map(([r]) => r), [name], d);
  const ok = await handleCall("fill", { ref: refOf(full, "City"), text: "x" });
  assert.equal(ok.isError, undefined, text(ok));
  assert.equal(spec.dom.document.getElementById("c").value, "x");
});

test("diff and frames together are refused before any Apple Event", async () => {
  const w = install(tab(page(HTML)));
  let execs = 0;
  w.state.onExecute = () => { execs++; };
  const r = await handleCall("accessibility_snapshot", { diff: true, frames: true });
  assert.equal(r.isError, true);
  assert.match(text(r), /bad_args: /);
  assert.equal(execs, 0);
});

test("on a 40-field form, a diff after one write is a small fraction of a full snapshot", async () => {
  const fields = Array.from({ length: 40 }, (_, i) => `<label for=f${i}>Question number ${i}</label><input id=f${i} name=q${i} required>`).join("");
  const dom = page(`<form>${fields}<button type=submit>Send</button></form>`);
  install(tab(dom));
  const full = await snap();
  const same = await snap({ diff: true });
  assert.equal(same.split("\n").length, 1, same);
  dom.document.getElementById("f7").value = "yes";
  const d = await snap({ diff: true });
  assert.equal(rows(d).length, 1, d);
  assert.ok(d.length < full.length / 10, `${d.length} vs ${full.length}`);
});
