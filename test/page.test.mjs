import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_PRELUDE, PAGE_SCRIPTS, pageScript, buildEvalWrapper, validateLabelPattern } from "../server.js";
import { readFileSync } from "node:fs";
import { page, run, runBody } from "./helpers/page.mjs";

// ---- prelude ----

test("prelude has no template holes and every script parses", () => {
  assert.ok(!PAGE_PRELUDE.includes("${"));
  for (const k of Object.keys(PAGE_SCRIPTS)) {
    assert.doesNotThrow(() => new Function(buildEvalWrapper(pageScript(k, { text: "x", label_pattern: "x", max: 1 }))), k);
  }
});

test("page helper: a field under a [hidden] or display:none ancestor lays out 0x0 and is not shown", () => {
  const w = page(`<section hidden><input id=x></section><section style="display:none"><input id=y></section><section><input id=z></section>`);
  assert.deepEqual(runBody(w, `return ['x','y','z'].map(id => { const e = document.getElementById(id), r = e.getBoundingClientRect(); return [r.width, r.height, fieldVis(e)]; })`),
    [[0, 0, false], [0, 0, false], [100, 20, true]]);
});

test("vis: hidden variants are invisible", () => {
  const w = page(`<i id=a style="display:none">x</i><i id=b style="visibility:hidden">x</i><i id=c style="opacity:0">x</i><i id=d hidden>x</i><i id=e data-zero>x</i><i id=f>x</i>`);
  assert.deepEqual(runBody(w, `return ['a','b','c','d','e','f'].map(id => vis(document.getElementById(id)))`), [false, false, false, false, false, true]);
});

test("accName precedence", () => {
  const w = page(`
    <span id=l1>From labelledby</span>
    <input id=a aria-labelledby=l1 aria-label="aria" placeholder="ph">
    <input id=b aria-label="Aria wins" placeholder="ph">
    <label for=c>For label</label><input id=c placeholder="ph">
    <label>Wrapping <input id=d></label>
    <input id=e placeholder="Just placeholder">
    <input id=f type=submit value="Send it">
    <button id=g>  Button   text </button>
    <select id=h><option>Option text must not name it</option></select>
    <input id=i name="fallback_name">`);
  assert.deepEqual(runBody(w, `return ['a','b','c','d','e','f','g','h','i'].map(id => accName(document.getElementById(id)))`),
    ["From labelledby", "Aria wins", "For label", "Wrapping", "Just placeholder", "Send it", "Button text", "", "fallback_name"]);
});

test("role table", () => {
  const w = page(`<a id=a href=/x>l</a><a id=b>nolink</a><button id=c>b</button><select id=d></select><textarea id=e></textarea>
    <input id=f type=checkbox><input id=g type=radio><input id=h type=submit><input id=i type=range><input id=j type=email>
    <h3 id=k>h</h3><summary id=l>s</summary><div id=m contenteditable></div><div id=n role=tab></div><div id=o></div>`);
  assert.deepEqual(runBody(w, `return 'abcdefghijklmno'.split('').map(id => role(document.getElementById(id)))`),
    ["link", "generic", "button", "combobox", "textbox", "checkbox", "radio", "button", "slider", "textbox", "heading", "button", "textbox", "tab", "generic"]);
});

test("resolveEl: ref hit, stale ref, detached ref, missing and bad selectors", () => {
  const w = page(`<p id=a>x</p><p id=b>y</p>`);
  runBody(w, `window.__perch_refs = { '1': document.getElementById('a'), '2': document.getElementById('b') }; document.getElementById('b').remove(); return 1`);
  assert.equal(runBody(w, `return resolveEl({ ref: '1' }).el.id`), "a");
  assert.deepEqual(runBody(w, `return resolveEl({ ref: '9' }).out`), { __perch_ref_miss: true, ref: "9" });
  assert.deepEqual(runBody(w, `return resolveEl({ ref: '2' }).out`), { __perch_ref_miss: true, ref: "2" });
  assert.equal(runBody(w, `return resolveEl({ selector: '#zz' }).out.ok`), false);
  assert.match(runBody(w, `return resolveEl({ selector: '##' }).out.error`), /bad selector/);
});

test("validateLabelPattern rejects bad regexes before they reach the page", () => {
  assert.throws(() => validateLabelPattern("fill", "("), /fill: invalid label_pattern/);
  assert.doesNotThrow(() => validateLabelPattern("fill", "e-?mail"));
});

// ---- get_text ----

test("get_text: text, html, ref, paging marker, no match", () => {
  const w = page(`<main id=m>Hello world</main>`);
  assert.equal(run(w, "get_text", { selector: "#m", maxChars: 20000, offset: 0 }), "Hello world");
  assert.match(run(w, "get_text", { html: true, maxChars: 20000, offset: 0 }), /^<html>/);
  assert.equal(run(w, "get_text", { selector: "#m", maxChars: 5, offset: 2 }), "llo w\n[truncated: chars 2-7 of 11; pass offset/maxChars for the rest]");
  assert.equal(run(w, "get_text", { selector: "#nope", maxChars: 5, offset: 0 }).ok, false);
  assert.deepEqual(run(w, "get_text", { ref: "4", maxChars: 5, offset: 0 }), { __perch_ref_miss: true, ref: "4" });
});

// ---- snapshot ----

const FORM = `
  <h1>Apply</h1>
  <form>
    <label>Email <input name=email type=email required value="a@b.c"></label>
    <label>Country <select name=country><option value="">--</option><option value=AR selected>Argentina</option><option>Brazil</option></select></label>
    <label><input type=checkbox checked> I agree</label>
    <textarea name=hidden_ta style="display:none"></textarea>
    <label>Cover <textarea name=cover required></textarea></label>
  </form>
  <a href="/jobs?x=1">Jobs</a>
  <div role=dialog aria-label="Cookie settings"><button>Accept</button></div>`;

test("snapshot: header + one line per visible element", () => {
  const w = page(FORM, { url: "https://a.test/apply" });
  w.document.title = "Apply";
  const out = run(w, "snapshot", { max: 500 });
  const [head, ...lines] = out.split("\n");
  assert.ok(head.startsWith("# "));
  const h = JSON.parse(head.slice(2));
  assert.equal(h.url, "https://a.test/apply");
  assert.equal(h.count, lines.length);
  assert.deepEqual(h.dialogs, ["Cookie settings"]);
  assert.deepEqual(h.form, { fields: 4, requiredEmpty: 1 });
  assert.deepEqual(lines, [
    `1 heading "Apply" level=1`,
    `2 textbox "Email" name="email" type="email" value="a@b.c" required`,
    `3 combobox "Country" name="country" options=["Argentina","Brazil"] value="AR"`,
    `4 checkbox "I agree" checked`,
    `5 textbox "Cover" name="cover" type="textarea" required`,
    `6 link "Jobs" href="/jobs?x=1"`,
    `7 dialog "Cookie settings"`,
    `8 button "Accept"`,
  ]);
  assert.equal(runBody(w, `return window.__perch_refs['2'].name`), "email");
});

test("snapshot: role filter, max cap, header-only, focus", () => {
  const w = page(FORM);
  const tb = run(w, "snapshot", { max: 500, role: ["textbox"] }).split("\n").slice(1);
  assert.equal(tb.length, 2);
  const capped = run(w, "snapshot", { max: 2 });
  assert.equal(JSON.parse(capped.split("\n")[0].slice(2)).truncated, true);
  assert.equal(capped.split("\n").length, 3);
  assert.equal(run(w, "snapshot", { max: 0 }).split("\n").length, 1);
  w.document.querySelector("[name=email]").focus();
  const h = JSON.parse(run(w, "snapshot", { max: 500 }).split("\n")[0].slice(2));
  assert.equal(h.focus, "2");
});

test("snapshot values survive quotes and newlines", () => {
  const w = page(`<textarea aria-label='Say "hi"'></textarea>`);
  w.document.querySelector("textarea").value = 'a "b"\nc';
  const line = run(w, "snapshot", { max: 500 }).split("\n")[1];
  assert.equal(line, `1 textbox "Say \\"hi\\"" type="textarea" value="a \\"b\\" c"`);
});

test("snapshot leaves out elements inside a hidden container", () => {
  const w = page(`<div style="display:none"><button>Ghost</button></div><button>Real</button>`);
  const lines = run(w, "snapshot", { max: 500 }).split("\n").slice(1);
  assert.deepEqual(lines, [`1 button "Real"`]);
});

// ---- fill ----

const BODY = "Hi there, this is a multi-line reply body.\nSecond line.\n\nA second paragraph that makes the text comfortably longer than fifty characters.";

// Some forms render a field only after a button such as "Enter manually" is clicked.
test("fill by label with no matching field says the field may appear after a click", () => {
  const w = page(`<label>Cover letter</label><button>Enter manually</button>`);
  const o = run(w, "fill", { label_pattern: "cover letter", text: "hi" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^no fillable field matched .*after clicking one of reveal/);
  assert.deepEqual(o.reveal, [`button "Enter manually"`]);
});

test("fill by label never claims another field through page text around it", () => {
  for (const [html, near] of [
    [`<h1>Pick a location</h1><label>Name <input></label><label>Email <input type=email></label>`, 0],
    [`<div><h2>Delivery location</h2><label>Name <input></label><label>Email <input type=email></label></div>`, 2],
  ]) {
    const w = page(html);
    const o = run(w, "fill", { label_pattern: "location", text: "Rosario" });
    assert.equal(o.ok, false, JSON.stringify(o));
    assert.match(o.error, /^no fillable field matched \/location\/i/);
    assert.equal((o.candidates || []).length, near);
    assert.deepEqual([...w.document.querySelectorAll("input")].map((i) => i.value), ["", ""]);
  }
});

test("fill by label still takes the one field its section text names", () => {
  const w = page(`<h1>Checkout location</h1><div><span>Location</span><input></div><label>Name <input></label>`);
  const o = run(w, "fill", { label_pattern: "location", text: "Rosario" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual([...w.document.querySelectorAll("input")].map((i) => i.value), ["Rosario", ""]);
});

test("fill by label never claims a labelled field through a heading its own section lacks", () => {
  for (const html of [
    `<form><h2>Cover letter</h2><div class=slot></div><label>Name <input></label><button type=button>Attach</button></form>`,
    `<form><h2>Cover letter</h2><div class=slot></div><input placeholder="Name"></form>`,
    `<form><h2>Cover letter</h2><div><span id=n>Name</span><input aria-labelledby=n></div></form>`,
    `<form><h2>Cover letter</h2><div class=slot></div><div><span>Name</span><input></div><div><span>Email</span><input></div></form>`,
  ]) {
    const w = page(html);
    const o = run(w, "fill", { label_pattern: "cover letter", text: "Dear team" });
    assert.equal(o.ok, false, html + " " + JSON.stringify(o));
    assert.match(o.error, /^no fillable field matched \/cover letter\/i/);
    assert.ok([...w.document.querySelectorAll("input")].every((i) => i.value === ""));
  }
});

test("fill by label still fills a lone unlabelled textarea under its heading", () => {
  for (const html of [
    `<form><label>Name <input></label><section><h3>Cover letter</h3><p>Tell us why you want this role.</p><textarea></textarea></section></form>`,
    `<form><h3>Cover letter</h3><textarea name="q7"></textarea></form>`,
    `<div><h3>Cover letter</h3><textarea></textarea></div><div><h3>Notes</h3><textarea></textarea></div>`,
  ]) {
    const w = page(html);
    const o = run(w, "fill", { label_pattern: "cover letter", text: "Dear team" });
    assert.equal(o.ok, true, html + " " + JSON.stringify(o));
    const [first, ...rest] = w.document.querySelectorAll("textarea, input");
    const want = first.tagName === "TEXTAREA" ? first : w.document.querySelector("textarea");
    assert.equal(want.value, "Dear team");
    for (const f of [first, ...rest]) if (f !== want) assert.equal(f.value, "");
  }
});

test("fill by label fills a lone field under its question whose placeholder only asks for an answer", () => {
  for (const ph of ["Type your response", "Your answer", "Type here", "Enter your answer", "Add a cover letter or anything else you want to share", "Start typing...", "Write something"]) {
    for (const tag of ["textarea", "input"]) {
      const w = page(`<form><label>Name <input></label><div><h3>Cover letter</h3><${tag} placeholder="${ph}"${tag === "textarea" ? "></textarea>" : ">"}</div></form>`);
      const o = run(w, "fill", { label_pattern: "cover letter", text: "Dear team" });
      assert.equal(o.ok, true, ph + " " + tag + " " + JSON.stringify(o));
      const [name, field] = w.document.querySelectorAll("input, textarea");
      assert.equal(name.value, "");
      assert.equal(field.value, "Dear team");
    }
  }
});

test("fill by label never claims a lone field whose placeholder names something else", () => {
  for (const html of [
    `<form><h3>Cover letter</h3><input placeholder="Name"></form>`,
    `<div><h3>Cover letter</h3><input placeholder="Company name"></div>`,
    `<div><h3>Cover letter</h3><input placeholder="Your name"></div>`,
    `<div><h3>Cover letter</h3><input placeholder="Enter your phone"></div>`,
    `<div><h3>Cover letter</h3><input placeholder="Enter your email"></div>`,
    `<div><h3>Cover letter</h3><input placeholder="Type your address"></div>`,
  ]) {
    const w = page(html);
    const o = run(w, "fill", { label_pattern: "cover letter", text: "Dear team" });
    assert.equal(o.ok, false, html + " " + JSON.stringify(o));
    assert.equal(w.document.querySelector("input").value, "");
  }
});

test("fill by label fails closed on a hidden field and offers the reveal hint", () => {
  const w = page(`<form><label>Name <input></label><div><label for=cl>Cover letter</label><textarea id=cl style="display:none"></textarea><button type=button>Enter manually</button></div></form>`);
  const o = run(w, "fill", { label_pattern: "cover letter", text: "Dear team" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /the field is hidden/);
  assert.equal(o.el, `textbox "Cover letter" hidden`);
  assert.deepEqual(o.reveal, [`button "Enter manually"`]);
  assert.deepEqual([...w.document.querySelectorAll("input, textarea")].map((f) => f.value), ["", ""]);
  const bare = page(`<textarea aria-label="Cover letter" hidden></textarea>`);
  const b = run(bare, "fill", { label_pattern: "cover letter", text: "Dear team" });
  assert.equal(b.ok, false, JSON.stringify(b));
  assert.match(b.error, /the field is hidden/);
  assert.equal(b.reveal, undefined);
  assert.equal(bare.document.querySelector("textarea").value, "");
});

test("fill by label takes a styled control's faded input inside its visible box", () => {
  const w = page(`<form><label for=loc>Location</label><div class="select__control"><div class="select__value-container"><div class="select__single-value">Rosario</div><div class="select__input-container"><input id=loc role=combobox aria-autocomplete=list aria-expanded=false autocomplete=off style="opacity:0"></div></div></div></form>`);
  const o = run(w, "fill", { label_pattern: "location", text: "Cordoba" });
  assert.doesNotMatch(o.error || "", /hidden/, JSON.stringify(o));
  assert.doesNotMatch(o.el || "", /hidden/, JSON.stringify(o));
});

// Honeypots: faded or zero-size plain inputs that bots fill and people never see.
test("fill by label never lands in a honeypot input faded inside a visible box", () => {
  for (const [html, pattern] of [
    [`<form><div class=row><label for=hp>Email</label><input id=hp name=email2 tabindex=-1 autocomplete=off style="position:absolute;opacity:0" data-zero></div><div class=row><label for=em>Email</label><input id=em type=email></div></form>`, "email"],
    [`<form><div class=row><label for=hp>Website</label><input id=hp style="opacity:0"></div><div class=row><label for=ws>Website</label><input id=ws></div></form>`, "website"],
    [`<form><div class=box><label for=n>Nickname</label><input id=n style="opacity:0;position:absolute;width:1px;height:1px"></div><div class=row><label for=nn>Nickname</label><input id=nn></div></form>`, "nickname"],
  ]) {
    const w = page(html);
    const o = run(w, "fill", { label_pattern: pattern, text: "ada@x.test" });
    assert.equal(o.ok, true, html + " " + JSON.stringify(o));
    const [hp, real] = w.document.querySelectorAll("input");
    assert.equal(hp.value, "", html);
    assert.equal(real.value, "ada@x.test", html);
  }
  const lone = page(`<form><div class=box><label for=t>Leave this field empty</label><input id=t style="opacity:0"></div></form>`);
  const o = run(lone, "fill", { label_pattern: "leave this field", text: "x" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /bot trap/);
  assert.doesNotMatch(o.error, /anyway/);
  assert.equal(lone.document.querySelector("input").value, "");
});

test("fill by label prefers a plainly visible field over a faded combobox decoy before it", () => {
  const w = page(`<div class=ctl><label for=d>Email</label><input id=d aria-autocomplete=list style=opacity:0></div><label for=e>Email</label><input id=e>`);
  const o = run(w, "fill", { label_pattern: "email", text: "ada@x.test" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(w.document.getElementById("e").value, "ada@x.test");
  assert.equal(w.document.getElementById("d").value, "");
});

test("fill by label skips an offscreen or pixel-sized honeypot", () => {
  for (const hp of [`data-rect="-9999,0,100,20"`, `data-rect="0,0,1,1"`, `data-rect="0,0,100,1"`]) {
    const w = page(`<div><label for=hp>Email</label><input id=hp name=email_confirm ${hp}></div><label for=em>Email</label><input id=em>`);
    const o = run(w, "fill", { label_pattern: "email", text: "ada@x.test" });
    assert.equal(o.ok, true, hp + " " + JSON.stringify(o));
    assert.equal(w.document.getElementById("em").value, "ada@x.test", hp);
    assert.equal(w.document.getElementById("hp").value, "", hp);
  }
});

test("fill by label on the honeypot fixture lands in the visible field only", () => {
  const html = readFileSync(new URL("./fixtures/honeypot.html", import.meta.url), "utf8");
  const w = page(html.slice(html.indexOf("<style>")));
  const o = run(w, "fill", { label_pattern: "email", text: "ada@x.test" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(["decoy", "trap", "email"].map((id) => w.document.getElementById(id).value), ["", "", "ada@x.test"]);
});

test("honeypot: a text input clipped to nothing, as the browser computes clip", () => {
  const w = page(`<input id=a><input id=b type=checkbox>`);
  const gcs = w.getComputedStyle.bind(w);
  w.getComputedStyle = (el) => new Proxy(gcs(el), { get: (cs, k) => (k === "clip" ? "rect(0px, 0px, 0px, 0px)" : cs[k]) });
  assert.deepEqual(runBody(w, `return ['a', 'b'].map(id => honeypot(document.getElementById(id)))`), [true, false]);
});

test("fill by label refuses a lone bot trap without offering to fill it anyway", () => {
  for (const hp of [`tabindex=-1 autocomplete=off style="opacity:0"`, `data-rect="-9999,0,100,20"`, `data-rect="0,-500,100,20"`]) {
    const w = page(`<div class=row><label for=hp>Email</label><input id=hp name=email_confirm ${hp}></div>`);
    const o = run(w, "fill", { label_pattern: "email", text: "ada@x.test" });
    assert.equal(o.ok, false, hp + " " + JSON.stringify(o));
    assert.match(o.error, /bot trap/, hp);
    assert.doesNotMatch(o.error, /anyway/, hp);
    assert.equal(o.reveal, undefined, hp);
    assert.equal(w.document.getElementById("hp").value, "", hp);
  }
});

// A required field named by a visible label is one the form wants filled, even
// styled sr-only; a trap's own markup still gives it away.
test("fill by label fills a required, visibly labelled sr-only input instead of calling it a trap", () => {
  const sr = `style="position:absolute;width:1px;height:1px;overflow:hidden" data-rect="0,0,1,1"`;
  for (const html of [
    `<form><label for=r>Referral code</label><input id=r required ${sr}></form>`,
    `<form><label for=r>Referral code</label><input id=r aria-required=true ${sr}></form>`,
    `<form><span id=l>Referral code</span><input id=r aria-labelledby=l required ${sr}></form>`,
  ]) {
    const w = page(html);
    const o = run(w, "fill", { label_pattern: "referral code", text: "AB12" });
    assert.equal(o.ok, true, html + " " + JSON.stringify(o));
    assert.equal(w.document.getElementById("r").value, "AB12", html);
  }
  for (const html of [
    `<form><label for=r>Referral code</label><input id=r required tabindex=-1 ${sr}></form>`,
    `<form><label for=r>Referral code</label><input id=r required aria-hidden=true ${sr}></form>`,
    `<form><label for=r>Referral code, leave this blank</label><input id=r required ${sr}></form>`,
    `<form><label for=r>Referral code</label><input id=r ${sr}></form>`,
  ]) {
    const w = page(html);
    const o = run(w, "fill", { label_pattern: "referral code", text: "AB12" });
    assert.equal(o.ok, false, html + " " + JSON.stringify(o));
    assert.match(o.error, /bot trap/, html);
    assert.equal(w.document.getElementById("r").value, "", html);
  }
});

test("fill by label checks an sr-only checkbox inside its label", () => {
  const w = page(`<label><input id=c type=checkbox style="position:absolute;opacity:0" data-rect="0,0,1,1"><span>Agree</span></label>`);
  assert.equal(runBody(w, `return fieldVis(document.getElementById('c'))`), true);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "agree", checked: true }] });
  assert.equal(o.results[0].ok, true, JSON.stringify(o));
  assert.equal(w.document.getElementById("c").checked, true);
});

test("fill miss names its candidates by their own names, not the section heading", () => {
  const w = page(`<section><h2>Contact details</h2><input placeholder="Company name"><input placeholder=City></section>`);
  const o = run(w, "fill", { label_pattern: "contact details", text: "x" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.candidates, [`textbox "Company name"`, `textbox "City"`]);
});

test("fill by selector counts only shown fields as ambiguous, honeypots aside", () => {
  const w = page(`<div class=row><input class=f style="opacity:0"></div><input class=f>`);
  const o = run(w, "fill", { selector: ".f", text: "hi" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.ambiguous, undefined, JSON.stringify(o));
});

test("fieldVis: a styled control's faded input in a visible box is shown; plain, aria-hidden or untabbable ones are not", () => {
  const w = page(`
    <label class=check><input id=a type=checkbox style="opacity:0;position:absolute"><span>Agree</span></label>
    <div class=ctl><div>Select...</div><div><div><input id=b role=combobox autocomplete=off style="opacity:0"></div></div></div>
    <div class=ctl><div>Select...</div><input id=c aria-autocomplete=list data-zero></div>
    <div class=ctl><input id=d role=combobox style="display:none"></div>
    <div class=ctl><input id=e role=combobox style="visibility:hidden;opacity:0"></div>
    <div style="display:none"><input id=f role=combobox style="opacity:0"></div>
    <div data-zero><input id=g role=combobox style="opacity:0"></div>
    <input id=h hidden>
    <div class=ctl><input id=i style="opacity:0"></div>
    <div class=ctl><input id=j role=combobox tabindex=-1 style="opacity:0"></div>
    <div class=ctl aria-hidden=true><label><input id=k type=radio style="opacity:0"> Yes</label></div>
    <div class=ctl><input id=l autocomplete=off data-zero></div>
    <div class=ctl><input id=m role=combobox style="opacity:0"></div>`);
  assert.deepEqual(runBody(w, `return 'abcdefghijklm'.split('').map(id => fieldVis(document.getElementById(id)))`),
    [true, true, true, false, false, false, false, false, false, false, false, false, false]);
});

test("fill by selector into a hidden field still writes and says hidden", () => {
  const w = page(`<textarea id=t aria-label="Cover letter" style="display:none"></textarea><input id=v aria-label="Name">`);
  const o = run(w, "fill", { selector: "#t", text: "Dear team" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.hidden, true);
  assert.equal(w.document.querySelector("#t").value, "Dear team");
  assert.equal(run(w, "fill", { selector: "#v", text: "Ada" }).hidden, undefined);
});

test("fill by label skips a field whose container is hidden", () => {
  const w = page(`<div style="display:none"><textarea aria-label="Message"></textarea></div><textarea aria-label="Message body"></textarea>`);
  const o = run(w, "fill", { label_pattern: "message", text: "hi" });
  assert.equal(o.ok, true, JSON.stringify(o));
  const [hidden, shown] = w.document.querySelectorAll("textarea");
  assert.equal(hidden.value, "");
  assert.equal(shown.value, "hi");
});

test("fill by label skips a hidden textarea and lands in the visible editor", () => {
  const w = page(`<textarea name="bodyHtml" style="display:none"></textarea><div contenteditable aria-label="Message Body"></div>`);
  const o = run(w, "fill", { label_pattern: "body", text: BODY });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "rich");
  assert.equal(o.el, `textbox "Message Body"`);
  assert.equal(o.ambiguous, undefined);
});

test("fill: short text into a rich editor still verifies", () => {
  const w = page(`<div contenteditable aria-label="Note"></div>`);
  assert.equal(run(w, "fill", { label_pattern: "note", text: "Hi" }).ok, true);
});

test("fill: plain input via ref, bypassing an instance value override", () => {
  const w = page(`<input aria-label="Name">`);
  runBody(w, `const i = document.querySelector('input'); Object.defineProperty(i, 'value', { set() {}, get() { return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get.call(this); } }); window.__perch_refs = { '1': i }; return 1`);
  const o = run(w, "fill", { ref: "1", text: "Ada" });
  assert.deepEqual(o, { ok: true, kind: "plain", el: `textbox "Name"`, len: 3 });
});

// React tracks the last value it saw through an instance property. A write through
// that property updates the tracker too, so the following input event looks like no
// change and onChange never fires. Only a prototype-setter write followed by an input
// event reaches the component.
test("fill: a React-controlled input sees onChange with the new value", () => {
  const w = page(`<input aria-label="City">`);
  const changes = runBody(w, `
    const i = document.querySelector('input');
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    let tracked = '';
    Object.defineProperty(i, 'value', { configurable: true,
      get() { return proto.get.call(this); },
      set(v) { tracked = String(v); proto.set.call(this, v); } });
    window.__changes = [];
    i.addEventListener('input', () => { const now = proto.get.call(i); if (now !== tracked) { tracked = now; window.__changes.push(now); } });
    return 1`);
  assert.equal(changes, 1);
  const o = run(w, "fill", { label_pattern: "city", text: "Rosario" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(runBody(w, "return window.__changes"), ["Rosario"]);
});

test("fill: a TinyMCE editor writes into its iframe body, not the outer page", () => {
  const w = page(`<label for=x>Description</label><div class="tox-edit-area"><iframe id=x title="Description"></iframe></div><textarea id=raw style="display:none"></textarea>`);
  const body = w.document.querySelector("iframe").contentDocument.body;
  body.setAttribute("contenteditable", "true");
  const o = run(w, "fill", { label_pattern: "description", text: "Hello rich world" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "rich");
  assert.equal(body.textContent, "Hello rich world");
  assert.equal(w.document.querySelector("#raw").value, "");
});

test("fill: Trusted-Types-style innerHTML ban does not break rich fill", () => {
  const w = page(`<div contenteditable aria-label="Body"></div>`);
  runBody(w, `Object.defineProperty(document.querySelector('[contenteditable]'), 'innerHTML', { set() { throw new TypeError('TrustedHTML required'); } }); return 1`);
  assert.equal(run(w, "fill", { label_pattern: "body", text: BODY }).ok, true);
});

test("fill: stale ref is the shared miss sentinel; ambiguous selector is reported", () => {
  const w = page(`<input class=x aria-label=A><input class=x aria-label=B>`);
  assert.deepEqual(run(w, "fill", { ref: "3", text: "a" }), { __perch_ref_miss: true, ref: "3" });
  const o = run(w, "fill", { selector: ".x", text: "a" });
  assert.equal(o.ok, true);
  assert.deepEqual(o.ambiguous, [`textbox "A"`, `textbox "B"`]);
  assert.equal(run(w, "fill", { label_pattern: "zzz", text: "a" }).ok, false);
});

// ---- click, upload, console, wait ----

test("click returns the element identity; miss shapes", () => {
  const w = page(`<button id=b>Go</button>`);
  runBody(w, `window.clicks = 0; document.getElementById('b').addEventListener('click', () => window.clicks++); return 1`);
  assert.deepEqual(run(w, "click", { selector: "#b" }), { ok: true, el: `button "Go"` });
  assert.equal(runBody(w, `return window.clicks`), 1);
  assert.equal(run(w, "click", { selector: "#zz" }).ok, false);
  assert.deepEqual(run(w, "click", { ref: "7" }), { __perch_ref_miss: true, ref: "7" });
});

test("file_upload assigns a File via DataTransfer, by selector or ref", () => {
  const w = page(`<input type=file id=f style="display:none">`);
  const A = { b64: Buffer.from("hello").toString("base64"), name: "a.txt", mime: "text/plain" };
  assert.deepEqual(run(w, "file_upload", A), { ok: true, name: "a.txt", size: 5, type: "text/plain" });
  runBody(w, `window.__perch_refs = { '1': document.getElementById('f') }; return 1`);
  assert.equal(run(w, "file_upload", { ...A, ref: "1" }).ok, true);
});

test("console capture: start is idempotent, entries are strings, stop restores", () => {
  const w = page(``);
  assert.equal(run(w, "console_start").ok, true);
  assert.equal(run(w, "console_start").already, true);
  runBody(w, `console.warn('x', {a: 1}); console.log('y'); return 1`);
  assert.deepEqual(run(w, "console_read"), { ok: true, entries: ['warn: x {"a":1}', "log: y"] });
  assert.deepEqual(run(w, "console_read").entries, []);
  for (let i = 0; i < 501; i++) w.eval("console.log(" + i + ")");
  const r = run(w, "console_read");
  assert.equal(r.entries.length, 500);
  assert.equal(r.dropped, 1);
  assert.equal(run(w, "console_stop").ok, true);
  assert.equal(run(w, "console_read").ok, false);
});

test("console capture relays the main world's console (the page's own logs on Chrome)", () => {
  const w = page(``);
  assert.equal(run(w, "console_start").ok, true);
  // happy-dom has one world: prove the bridge path by delivering an entry the way
  // the main-world <script> does, as a perch:console event with a string detail.
  w.document.dispatchEvent(new w.CustomEvent("perch:console", { detail: "error: from the page" }));
  assert.deepEqual(run(w, "console_read").entries, ["error: from the page"]);
  // A page log is recorded exactly once (bridge only, no second local patch).
  w.eval("console.warn('once')");
  assert.deepEqual(run(w, "console_read").entries, ["warn: once"]);
  assert.equal(run(w, "console_stop").ok, true);
  w.eval("console.warn('after stop')");
  run(w, "console_start");
  assert.deepEqual(run(w, "console_read").entries, []);
  run(w, "console_stop");
});

test("console capture falls back to a local patch when CSP blocks the bridge", () => {
  const w = page(``);
  for (const root of [w.document.head, w.document.documentElement]) {
    const orig = root.appendChild.bind(root);
    root.appendChild = (n) => (n.tagName === "SCRIPT" ? n : orig(n));
  }
  const o = run(w, "console_start");
  assert.equal(o.ok, true);
  assert.equal(o.bridge, false);
  w.eval("console.log('local')");
  assert.deepEqual(run(w, "console_read").entries, ["log: local"]);
  run(w, "console_stop");
});

test("wait_check: readyState ordering and selector presence", () => {
  const w = page(`<p id=x></p>`);
  assert.equal(run(w, "wait_check", { readyState: "interactive" }), true);
  assert.equal(run(w, "wait_check", { selector: "#x" }), true);
  assert.equal(run(w, "wait_check", { selector: "#y" }), false);
});
