// The behaviour-lock corpus: each scenario installs a fake world and drives
// handleCall; harness.mjs records every call's result, Apple Events and page
// script bytes into golden.json, and test/lock.test.mjs fails on any drift.
// A scenario's name is its golden key: rename one only with PERCH_LOCK_WRITE=1.
// Add a scenario for any new tool, option, result key or error path;
// test/lock/coverage.mjs lists what none exercises.

// ---- worlds ----

export const CHROME = "Google Chrome";
const tabsOf = (n, p = "t") => Array.from({ length: n }, (_, i) => ({ url: `https://${p}${i}.test/`, title: `${p}${i}`, id: `${p}${i}` }));
const chrome = (windows, extra = {}) => ({ name: CHROME, kind: "chrome", windows, ...extra });
const arc = (windows, extra = {}) => ({ name: "Arc", kind: "arc", windows, ...extra });
const safari = (windows, extra = {}) => ({ name: "Safari", kind: "safari", windows, ...extra });
const KINDS = { chrome, arc, safari };
const OWNER = { chrome: CHROME, arc: "Arc", safari: "Safari" };

// Two Chrome windows, an Arc window and a Safari window, all on screen.
function multi(h) {
  return h.install({
    browsers: [
      chrome([{ id: 1, active: 1, tabs: tabsOf(3, "c") }, { id: 2, active: 0, tabs: tabsOf(1, "d") }]),
      arc([{ id: "W1", active: 0, tabs: tabsOf(2, "a") }]),
      safari([{ id: 5, active: 0, tabs: tabsOf(2, "s") }]),
    ],
    cg: [{ owner: CHROME }, { owner: "Arc" }, { owner: "Safari" }],
  });
}

// One browser of `kind`, one window, one tab showing a happy-dom page.
function onPage(h, html, { kind = "chrome", url = "https://a.test/p", setup, cg, win = {}, state } = {}) {
  const dom = h.page(html, { url });
  // happy-dom stays at "interactive"; a loaded page reads "complete".
  Object.defineProperty(dom.document, "readyState", { value: "complete", configurable: true });
  if (setup) dom.eval(setup);
  const w = h.install({
    browsers: [KINDS[kind]([{ id: kind === "arc" ? "W1" : 1, active: 0, tabs: [{ url, id: "x", title: "A", dom }], ...win }])],
    cg: cg || [{ owner: OWNER[kind] }],
  }, state);
  w.dom = dom;
  return w;
}
const T = { chrome: { tabId: "chrome:x" }, arc: { tabId: "arc:x" } };

// ---- scenarios ----

export const SCENARIOS = {};
const add = (name, fn) => { if (SCENARIOS[name]) throw new Error("duplicate scenario " + name); SCENARIOS[name] = fn; };

// list_tabs
add("list_tabs: all browsers", async (h) => { multi(h); await h.call("list_tabs"); });
add("list_tabs: app filter", async (h) => { multi(h); await h.call("list_tabs", { app: "arc" }); });
add("list_tabs: urlContains, titleContains, limit", async (h) => {
  multi(h);
  await h.call("list_tabs", { urlContains: "c1" });
  await h.call("list_tabs", { titleContains: "s" });
  await h.call("list_tabs", { limit: 2 });
});
add("list_tabs: no browser", async (h) => { h.install({ browsers: [], cg: [] }); await h.call("list_tabs"); });
add("list_tabs: one browser unreadable warns beside the others", async (h) => {
  multi(h);
  h.world.state.aeFail = { errorNumber: -1712, message: "AppleEvent timed out.", app: "Safari" };
  await h.call("list_tabs");
});

// new_tab
for (const kind of ["chrome", "arc", "safari"]) {
  add(`new_tab: ${kind}`, async (h) => {
    h.install({ browsers: [KINDS[kind]([{ id: kind === "arc" ? "W1" : 1, active: 0, tabs: tabsOf(1) }])], cg: [{ owner: OWNER[kind] }] });
    await h.call("new_tab", { url: "https://n.test/" });
  });
}
add("new_tab: default url and app by name", async (h) => { multi(h); await h.call("new_tab", { app: "safari" }); await h.call("new_tab", {}); });
add("new_tab: bad_url", async (h) => { multi(h); await h.call("new_tab", { url: "javascript:alert(1)" }); });
add("new_tab: browser raised warns", async (h) => {
  h.install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabsOf(2) }], { selectOnCreate: true, raiseOnCreate: true })], cg: [{ owner: "Terminal" }, { owner: CHROME }] });
  await h.call("new_tab", { url: "about:blank" });
});
for (const kind of ["chrome", "arc", "safari"]) {
  add(`new_tab: ${kind} puts back the shown tab`, async (h) => {
    h.install({ browsers: [KINDS[kind]([{ id: 1, active: 1, tabs: tabsOf(3) }], { selectOnCreate: true })], cg: [{ owner: "Terminal" }, { owner: OWNER[kind] }] });
    await h.call("new_tab", { url: "about:blank" });
  });
}

// activate_tab, close_tab
add("activate_tab: chrome handle", async (h) => {
  multi(h);
  await h.call("activate_tab", { target: { tabId: "chrome:c2" } });
});
add("activate_tab: arc and safari handles", async (h) => {
  multi(h);
  const tabs = (await h.call("list_tabs")).tabs;
  await h.call("activate_tab", { target: { tabId: "arc:a1" } });
  await h.call("activate_tab", { target: { tabId: tabs.find((t) => t.app === "Safari" && t.url === "https://s1.test/").tabId } });
});
add("close_tab: closes, then stale", async (h) => {
  multi(h);
  await h.call("close_tab", { tabId: "chrome:c2" });
  await h.call("close_tab", { tabId: "chrome:c2" });
});
add("close_tab: refuses a window's last tab", async (h) => { multi(h); await h.call("close_tab", { tabId: "chrome:d0" }); });
add("close_tab: safari handle", async (h) => {
  multi(h);
  const tabs = (await h.call("list_tabs", { app: "safari" })).tabs;
  await h.call("close_tab", { tabId: tabs[1].tabId });
});
add("safari: a tab found off its handle's index answers moved", async (h) => {
  const dom = h.page(`<p>x</p>`, { url: "https://u.test/" });
  h.install({ browsers: [safari([{ id: 3, active: 0, tabs: [{ url: "https://o.test/", id: "o" }, { url: "https://u.test/", id: "u", dom }] }])], cg: [{ owner: "Safari" }] });
  const handle = (await h.call("list_tabs")).tabs.find((t) => t.url === "https://u.test/").tabId;
  await h.call("eval_js", { script: "return 1", target: { tabId: handle } });
  h.world.tabsOf("Safari", 0).splice(0, 1);
  await h.call("eval_js", { script: "return 2", target: { tabId: handle } });
  await h.call("get_text", { target: { tabId: handle } });
});
add("close_tab: bad_args without tabId", async (h) => { multi(h); await h.call("close_tab", {}); });

// navigate
for (const kind of ["chrome", "arc", "safari"]) {
  add(`navigate: ${kind} ok`, async (h) => {
    h.install({ browsers: [KINDS[kind]([{ id: kind === "arc" ? "W1" : 1, active: 0, tabs: tabsOf(1) }])], cg: [{ owner: OWNER[kind] }] });
    await h.call("navigate", { url: "https://b.test/next" });
    await h.call("navigate", { url: "https://b.test/next#part" });
  });
}
add("navigate: targeted, redirect reports requested", async (h) => {
  multi(h);
  h.world.state.redirects = { "https://b.test/": "https://b.test/final" };
  await h.call("navigate", { url: "https://b.test/", target: { tabId: "chrome:c0" } });
});
add("navigate: load_failed stayed (204)", async (h) => {
  multi(h);
  h.world.state.noContent = /dl\.test/;
  await h.call("navigate", { url: "https://dl.test/file.zip", target: { tabId: "chrome:c1" } });
});
add("navigate: load_failed error page", async (h) => {
  multi(h);
  h.world.state.errorPage = /down\.test/;
  await h.call("navigate", { url: "https://down.test/", target: { tabId: "chrome:c1" } });
});
add("navigate: timeout not committed", async (h) => {
  multi(h);
  h.world.state.commitMs = 20000;
  await h.call("navigate", { url: "https://slow.test/", target: { tabId: "chrome:c1" } });
});
add("navigate: bad_url", async (h) => { multi(h); await h.call("navigate", { url: "ftp://x.test/" }); });
add("navigate: from a chrome internal page sets the url", async (h) => {
  h.install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "chrome://settings/", id: "i" }] }])], cg: [{ owner: CHROME }] });
  await h.call("navigate", { url: "https://b.test/" });
  await h.call("navigate", { url: "https://b.test/", raise: true });
});
add("navigate: arc background tab is tab_not_visible", async (h) => { multi(h); await h.call("navigate", { url: "https://b.test/", target: { tabId: "arc:a1" } }); });
add("navigate: file url allowed", async (h) => { multi(h); await h.call("navigate", { url: "file:///tmp/proto/a.html", target: { tabId: "chrome:c1" } }); });

// eval_js
add("eval_js: sync value, default target", async (h) => {
  onPage(h, "<p>x</p>");
  await h.call("eval_js", { script: "return document.title + location.href" });
  await h.call("eval_js", { script: "return {a: [1, 'x', null]}" });
  await h.call("eval_js", { script: "return undefined" });
});
for (const kind of ["arc", "safari"]) {
  add(`eval_js: ${kind}`, async (h) => { onPage(h, "<p>x</p>", { kind }); await h.call("eval_js", { script: "return location.href" }); });
}
add("eval_js: thrown error", async (h) => { onPage(h, "<p>x</p>"); await h.call("eval_js", { script: "throw new TypeError('boom')" }); });
add("eval_js: syntax error", async (h) => { onPage(h, "<p>x</p>"); await h.call("eval_js", { script: "return (" }); });
add("eval_js: awaitPromise", async (h) => {
  multi(h);
  await h.call("eval_js", { script: "return await Promise.resolve(41 + 1)", awaitPromise: true });
  await h.call("eval_js", { script: "await null; throw new Error('late boom')", awaitPromise: true, timeout: 2000 });
});
add("eval_js: timeout argument checks", async (h) => {
  onPage(h, "<p>x</p>");
  await h.call("eval_js", { script: "return 1", timeout: 5000 });
  await h.call("eval_js", { script: "return 1", awaitPromise: true, timeout: 5 });
  await h.call("eval_js", { script: "return 1", awaitPromise: true, timeout: 400000 });
});
add("eval_js: no script", async (h) => { onPage(h, "<p>x</p>"); await h.call("eval_js", {}); });
add("eval_js: script_path runs before script", async (h) => {
  onPage(h, "<p>x</p>");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(h.tmp + "/lib.js", "window.__lib = 7;");
  await h.call("eval_js", { script_path: h.tmp + "/lib.js", script: "return window.__lib * 6" });
  await h.call("eval_js", { script_path: h.tmp + "/missing.js" });
});
add("eval_js: world main", async (h) => {
  onPage(h, "<p>x</p>");
  await h.call("eval_js", { script: "return 1 + 1", world: "main" });
});
add("eval_js: world main with ref is refused", async (h) => { onPage(h, "<p>x</p>"); await h.call("eval_js", { script: "return 1", world: "main", ref: "1" }); });
add("eval_js: ref binds el, then stale", async (h) => {
  onPage(h, `<button id=b>Go</button>`);
  const snap = await h.call("accessibility_snapshot");
  const ref = snap.split("\n")[1].split(" ")[0];
  await h.call("eval_js", { script: "return el.id", ref });
  await h.call("eval_js", { script: "return el.id", ref: "999" });
  h.world.dom.document.body.innerHTML = "<p>gone</p>";
  await h.call("eval_js", { script: "return el.id", ref });
});
add("eval_js: frame ref refused", async (h) => { onPage(h, "<p>x</p>"); await h.call("eval_js", { script: "return 1", ref: "f1" }); });

// wait
add("wait: readyState on a loaded page", async (h) => { onPage(h, "<p>x</p>"); await h.call("wait", {}); await h.call("wait", { readyState: "interactive" }); });
add("wait: selector found and timeout", async (h) => {
  onPage(h, `<p id=a>x</p>`);
  await h.call("wait", { selector: "#a" });
  await h.call("wait", { selector: "#nope", timeout: 300 });
  await h.call("wait", { selector: "##bad", timeout: 300 });
});
add("wait: expression value, bad expression, timeout", async (h) => {
  onPage(h, `<p id=a>x</p>`);
  await h.call("wait", { expression: "document.querySelector('#a').textContent" });
  await h.call("wait", { expression: "(" });
  await h.call("wait", { expression: "window.nope", timeout: 300 });
  await h.call("wait", { expression: "null.x", timeout: 300 });
});
add("wait: quiet", async (h) => {
  onPage(h, `<p id=s>Idle</p>`);
  await h.call("wait", { quiet: 500 });
  await h.call("wait", { quiet: 500, selector: "#s" });
  await h.call("wait", { quiet: 5000, timeout: 1000 });
});
for (const kind of ["arc", "safari"]) {
  add(`wait: ${kind} selector`, async (h) => { onPage(h, `<p id=a>x</p>`, { kind }); await h.call("wait", { selector: "#a" }); });
}

// get_text
add("get_text: body, selector, html, paging", async (h) => {
  onPage(h, `<main id=m><h1>Title</h1><p>${"word ".repeat(60)}</p></main>`);
  await h.call("get_text");
  await h.call("get_text", { selector: "h1" });
  await h.call("get_text", { selector: "h1", html: true });
  await h.call("get_text", { maxChars: 50 });
  await h.call("get_text", { maxChars: 50, offset: 50 });
  await h.call("get_text", { selector: "#nope" });
});
add("get_text: by ref", async (h) => {
  onPage(h, `<button id=b>Go now</button>`);
  const ref = (await h.call("accessibility_snapshot")).split("\n")[1].split(" ")[0];
  await h.call("get_text", { ref });
});
for (const kind of ["arc", "safari"]) {
  add(`get_text: ${kind}`, async (h) => { onPage(h, `<p>hello</p>`, { kind }); await h.call("get_text"); });
}

// accessibility_snapshot
const FORM = `<h1>Apply</h1><form><label>Email <input name=email type=email required></label>
<label>Country <select name=c required><option value="">Choose</option><option>Argentina</option><option>Brazil</option></select></label>
<label><input type=checkbox name=t required> Terms</label><button type=submit>Send</button></form>
<div role=dialog aria-label="Cookies"><button>Accept</button></div><a href="/help">Help</a>`;
add("accessibility_snapshot: full page with form header", async (h) => { onPage(h, FORM); await h.call("accessibility_snapshot"); });
add("targeted calls on a page tool by tool", async (h) => {
  onPage(h, `<label>Name <input id=n></label><select id=s aria-label="Size"><option>S</option><option>M</option></select><input id=f type=file aria-label="CV"><button id=b>Go</button>`);
  const target = T.chrome;
  const snap = await h.call("accessibility_snapshot", { target });
  const ref = (name) => snap.split("\n").find((l) => l.includes(name)).split(" ")[0];
  await h.call("fill", { ref: ref('"Name"'), text: "Ada", target });
  await h.call("fill", { fields: [{ ref: ref('"Name"'), text: "Bo" }], target });
  await h.call("select", { ref: ref('"Size"'), text: "M", target });
  await h.call("press", { key: "Enter", ref: ref('"Go"'), target });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(h.tmp + "/cv.txt", "hello");
  await h.call("file_upload", { path: h.tmp + "/cv.txt", ref: ref('"CV"'), target });
  await h.call("console_capture", { mode: "start", target });
  await h.call("console_capture", { target });
  await h.call("click", { ref: ref('"Go"'), target });
  await h.call("fill", { ref: ref('"Name"'), text: "x" });
});
add("accessibility_snapshot: max, role, query", async (h) => {
  onPage(h, FORM);
  await h.call("accessibility_snapshot", { max: 0 });
  await h.call("accessibility_snapshot", { max: 2 });
  await h.call("accessibility_snapshot", { role: "button" });
  await h.call("accessibility_snapshot", { role: ["textbox", "combobox"] });
  await h.call("accessibility_snapshot", { query: "help|terms" });
  await h.call("accessibility_snapshot", { query: "(" });
});
for (const kind of ["arc", "safari"]) {
  add(`accessibility_snapshot: ${kind}`, async (h) => { onPage(h, FORM, { kind }); await h.call("accessibility_snapshot", { max: 3 }); });
}
add("accessibility_snapshot: same-origin and cross-origin iframes", async (h) => {
  onPage(h, `<h1>Careers</h1><iframe id=ats data-rect="0,100,600,800"></iframe>`);
  const f = h.world.dom.document.getElementById("ats");
  Object.defineProperty(f, "src", { get: () => "https://jobs.example/acme/apply?token=x", configurable: true });
  Object.defineProperty(f, "contentDocument", { get: () => { throw new Error("SecurityError"); }, configurable: true });
  await h.call("accessibility_snapshot");
});
add("accessibility_snapshot: frames from Accessibility", async (h) => {
  const w = desk(h, `<h1>Shop</h1><iframe id=pay data-rect="44,143,400,150"></iframe>`);
  const f = w.dom.document.getElementById("pay");
  Object.defineProperty(f, "src", { get: () => "https://js.pay.example/v3/card", configurable: true });
  Object.defineProperty(f, "contentDocument", { get: () => { throw new Error("SecurityError"); }, configurable: true });
  w.cg[1].ax.web[0].frames = [{ url: "https://js.pay.example/v3/card", box: { x: 100, y: 300, w: 400, h: 150 }, kids: [
    { role: "AXTextField", subrole: "AXSecureTextField", description: "Card number", value: "4242", box: { x: 110, y: 310, w: 200, h: 30 } },
    { role: "AXButton", title: "Pay", box: { x: 110, y: 390, w: 100, h: 40 } },
  ] }, { url: "https://challenges.cloudflare.com/x", box: { x: 100, y: 500, w: 300, h: 65 }, kids: [{ role: "AXCheckBox", title: "Verify", box: { x: 110, y: 510, w: 20, h: 20 } }] }];
  const snap = await h.call("accessibility_snapshot", { frames: true });
  const row = (name) => snap.split("\n").find((l) => l.includes(name)).split(" ")[0];
  await h.call("click", { ref: row('"Pay"'), trusted: true, target: { tabId: "chrome:x" } });
  await h.call("click", { ref: row('"Verify"'), trusted: true, target: { tabId: "chrome:x" } });
  await h.call("click", { ref: row('"Card number"'), trusted: true, target: { tabId: "chrome:x" } });
  await h.call("click", { ref: row('"Pay"') });
  await h.call("fill", { ref: row('"Pay"'), text: "x" });
});
add("accessibility_snapshot: frames unreadable when the walk fails", async (h) => {
  const w = desk(h, `<h1>Shop</h1>`);
  w.state.unbound = ["AXUIElementCopyAttributeValue"];
  await h.call("accessibility_snapshot", { frames: true });
});
add("accessibility_snapshot: hidden with reveal, unpicked, pressed, expanded", async (h) => {
  const w = onPage(h, `<form><div class=field><label for=cl>Cover Letter</label>
    <div class=acts><button type=button>Attach</button><button type=button aria-controls=paste>Enter manually</button></div>
    <div id=paste style="display:none"><textarea id=cl name=cover_letter required></textarea></div></div>
    <div class=loc><label for=li>Location</label><input id=li required><input type=hidden id=selected-location name=selectedLocation required><div class=dropdown-results></div></div>
    <button type=button aria-pressed=true>Bold</button><button type=button aria-expanded=true>Menu</button><button type=submit>Submit application</button></form>`);
  Object.getOwnPropertyDescriptor(w.dom.HTMLInputElement.prototype, "value").set.call(w.dom.document.getElementById("li"), "Buenos");
  await h.call("accessibility_snapshot");
});
add("accessibility_snapshot: frames unreadable without Accessibility", async (h) => {
  const w = desk(h, `<h1>Shop</h1>`);
  w.state.ax = false;
  await h.call("accessibility_snapshot", { frames: true });
});

// click
add("click: selector, label, ref, hover, coordinates", async (h) => {
  onPage(h, `<button id=a onclick="window.n=(window.n||0)+1">Save</button><button>Save draft</button><a href="#x">Docs</a>`);
  await h.call("click", { selector: "#a" });
  await h.call("click", { label_pattern: "^save$" });
  await h.call("click", { label_pattern: "save" });
  await h.call("click", { label_pattern: "nothing" });
  await h.call("click", { label_pattern: "(" });
  const ref = (await h.call("accessibility_snapshot", { role: "link" })).split("\n")[1].split(" ")[0];
  await h.call("click", { ref });
  await h.call("click", { selector: "#a", hover: true });
  await h.call("click", { x: 10, y: 10 });
  await h.call("click", {});
  await h.call("eval_js", { script: "return window.n" });
});
add("click: disabled refused", async (h) => {
  onPage(h, `<button disabled>Go</button><fieldset disabled><button>Inner</button></fieldset><button aria-disabled=true>Soft</button>`);
  await h.call("click", { label_pattern: "^go$" });
  await h.call("click", { label_pattern: "inner" });
  await h.call("click", { label_pattern: "soft" });
});
for (const kind of ["arc", "safari"]) {
  add(`click: ${kind}`, async (h) => { onPage(h, `<button id=a>Go</button>`, { kind }); await h.call("click", { selector: "#a" }); });
}
add("click: readback changed, unchanged, invalid", async (h) => {
  onPage(h, `<form id=f><label>Email <input id=e name=email required></label><button id=s type=button>Send</button><button id=t type=button>Toggle</button><p id=out>idle</p></form>`, {
    setup: `document.getElementById('t').addEventListener('click', () => { document.getElementById('out').textContent = 'done'; });
      document.getElementById('s').addEventListener('click', () => { const e = document.getElementById('e'); e.setAttribute('aria-invalid', 'true'); e.setCustomValidity('Enter an email'); });`,
  });
  await h.call("click", { selector: "#t", readback: "#out" });
  await h.call("click", { selector: "#t", readback: "#out" });
  await h.call("click", { selector: "#s", readback: "#out" });
  await h.call("click", { selector: "#t", readback: "#nope" });
});
add("click: readback on a busy page is settled:false", async (h) => {
  const w = onPage(h, `<button id=b>Submit</button><p id=s>Idle</p><div id=spin></div>`);
  let n = 0;
  const ev = w.dom.eval.bind(w.dom);
  w.dom.eval = (js) => { w.dom.document.getElementById("spin").textContent = String(n++); return ev(js); };
  await h.call("click", { selector: "#b", readback: "#s" });
});
add("click: _blank link opens a tab", async (h) => {
  const w = onPage(h, `<a id=a href="https://n.test/doc" target=_blank>Open</a>`, { cg: [{ owner: "Terminal" }, { owner: CHROME }] });
  w.dom.document.getElementById("a").addEventListener("click", (e) => w.openTab(CHROME, 0, e.currentTarget.href));
  await h.call("click", { selector: "#a" });
});
add("click: _blank link with no tab is unconfirmed", async (h) => {
  onPage(h, `<a id=a href="https://n.test/doc" target=_blank>Open</a>`, { cg: [{ owner: "Terminal" }, { owner: CHROME }] });
  await h.call("click", { selector: "#a" });
});

// Terminal in front; a background Chrome window whose shown tab is a happy-dom
// page with Accessibility, so trusted input, element screenshots and frames work.
// A posted press reaches the element the probe armed; the editing command lands
// as trusted input; a posted key reaches the focused element.
const AREA = { x: 56, y: 157, w: 798, h: 500 };
const KEY_OF = { 36: "Enter", 53: "Escape", 48: "Tab", 125: "ArrowDown", 49: " " };
function desk(h, html, { setup, kind = "chrome" } = {}) {
  const dom = h.page(html, { url: "https://form.test/" });
  Object.defineProperty(dom.document, "readyState", { value: "complete", configurable: true });
  for (const [k, v] of Object.entries({ screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 })) Object.defineProperty(dom, k, { value: v, configurable: true });
  if (setup) dom.eval(setup);
  const owner = OWNER[kind];
  const w = h.install({
    browsers: [KINDS[kind]([{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "https://form.test/", id: "x", title: "Form", dom }] }])],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner, pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ ...AREA, frames: [] }] } }],
  }, { helper: {} });
  const fire = (el, types, C) => types.forEach((type) => {
    const e = new C(type, { bubbles: true, cancelable: true, button: 0, key: type });
    Object.defineProperty(e, "isTrusted", { value: true });
    el.dispatchEvent(e);
  });
  let target = null;
  w.state.onPost = (e) => {
    if (e.kind === "key") {
      const ev = new dom.KeyboardEvent(e.down ? "keydown" : "keyup", { key: KEY_OF[e.vk], bubbles: true });
      Object.defineProperty(ev, "isTrusted", { value: true });
      (dom.document.activeElement || dom.document.body).dispatchEvent(ev);
      return;
    }
    if (e.kind !== "mouse" || e.pt.x < 0 || (e.type !== 1 && e.type !== 2)) return;
    if (e.type === 1) target = dom.__perch_trusted && dom.__perch_trusted.el;
    if (!target) return;
    if (e.type === 1) fire(target, ["mousedown"], dom.MouseEvent);
    else fire(target, ["mouseup", "click"], dom.MouseEvent);
  };
  dom.document.execCommand = (_c, _ui, text) => {
    const el = dom.document.activeElement;
    el.value = text;
    const ev = new dom.Event("input", { bubbles: true });
    Object.defineProperty(ev, "isTrusted", { value: true });
    el.dispatchEvent(ev);
    return true;
  };
  w.state.focus = { window: { x: 0, y: 57, w: 854, h: 600 }, chain: [{ role: "AXTextField", box: { x: 60, y: 160, w: 100, h: 20 } }, { role: "AXWebArea", box: AREA }, { role: "AXWindow", box: { x: 0, y: 57, w: 854, h: 600 } }] };
  w.dom = dom;
  return w;
}

add("click: trusted background", async (h) => {
  desk(h, `<button id=b>Buy</button><input id=pw type=password aria-label="Password">`);
  await h.call("click", { selector: "#b", trusted: true });
  await h.call("click", { label_pattern: "buy", trusted: true });
});
add("click: trusted raised", async (h) => {
  desk(h, `<button id=b>Buy</button>`);
  await h.call("click", { selector: "#b", trusted: true, raise: true });
});
add("click: trusted needs the shown tab", async (h) => {
  const w = desk(h, `<button id=b>Buy</button>`);
  w.winSpec(CHROME, 0).active = null;
  await h.call("click", { selector: "#b", trusted: true, target: { tabId: "chrome:x" } });
});
add("click: trusted without Accessibility", async (h) => {
  const w = desk(h, `<button id=b>Buy</button>`);
  w.state.ax = false;
  await h.call("click", { selector: "#b", trusted: true });
});

// press
add("press: keys, chords, selector, focus", async (h) => {
  onPage(h, `<form id=f onsubmit="event.preventDefault(); window.sent=1"><input id=i aria-label="City"><button id=b type=button onclick="window.b=1">Go</button></form>`);
  await h.call("press", { key: "Enter", selector: "#i" });
  await h.call("press", { key: "Space", selector: "#b" });
  await h.call("press", { key: "Tab" });
  await h.call("press", { key: "cmd+k" });
  await h.call("press", { key: "Escape", selector: "#nope" });
  await h.call("press", { key: "NotAKey" });
  await h.call("eval_js", { script: "return [window.sent, window.b]" });
});
add("press: trusted", async (h) => {
  desk(h, `<input id=i aria-label="City"><button id=b>Go</button>`);
  await h.call("press", { key: "Enter", selector: "#i", trusted: true });
  await h.call("press", { key: "cmd+k", trusted: true });
});
add("press: trusted when the page lacks the keyboard", async (h) => {
  const w = desk(h, `<input id=i aria-label="City">`);
  w.state.focus = null;
  await h.call("press", { key: "Enter", selector: "#i", trusted: true });
});
for (const kind of ["arc", "safari"]) {
  add(`press: ${kind}`, async (h) => { onPage(h, `<input id=i aria-label="City">`, { kind }); await h.call("press", { key: "ArrowDown", selector: "#i" }); });
}

// fill
add("fill: plain by label, selector, ref; clear; text_path", async (h) => {
  onPage(h, `<form><label>First name <input name=first></label><label>Email <input name=email type=email></label><label>Born <input type=date name=d></label><textarea aria-label="Bio"></textarea></form>`);
  await h.call("fill", { label_pattern: "first", text: "Ada" });
  await h.call("fill", { selector: "[name=email]", text: "ada@x.test" });
  const ref = (await h.call("accessibility_snapshot", { query: "Bio" })).split("\n")[1].split(" ")[0];
  await h.call("fill", { ref, text: "Hello" });
  await h.call("fill", { label_pattern: "first", text: "" });
  await h.call("fill", { label_pattern: "born", text: "tomorrow" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(h.tmp + "/bio.txt", "Long body\nline two");
  await h.call("fill", { ref, text_path: h.tmp + "/bio.txt" });
  await h.call("fill", { label_pattern: "nothing", text: "x" });
  await h.call("fill", { text: "x" });
  await h.call("fill", { label_pattern: "first" });
});
add("fill: rich editor and hidden field", async (h) => {
  onPage(h, `<div contenteditable aria-label="Message"></div><input id=h type=text style="display:none" name=hid>`);
  await h.call("fill", { label_pattern: "message", text: "Hi there" });
  await h.call("fill", { selector: "#h", text: "x" });
});
add("fill: checkbox, radio, ambiguous", async (h) => {
  onPage(h, `<form><label><input type=checkbox name=t> Terms</label>
    <fieldset><legend>Size</legend><label><input type=radio name=s value=s> Small</label><label><input type=radio name=s value=l> Large</label></fieldset>
    <label>Name <input name=a></label><label>Name <input name=b></label></form>`);
  await h.call("fill", { label_pattern: "terms", checked: true });
  await h.call("fill", { fields: [{ label_pattern: "terms", checked: true }, { label_pattern: "size", option: "Large" }] });
  await h.call("fill", { label_pattern: "name", text: "x" });
});
add("fill: fields with form census, only_empty, preference list", async (h) => {
  onPage(h, `<form><label>First <input name=first required></label><label>Last <input name=last required></label>
    <label>Country <select name=c required><option value="">Choose</option><option>Argentina</option><option>Brazil</option></select></label>
    <label>Phone <input name=p required></label></form>`);
  await h.call("fill", { fields: [{ label_pattern: "first", text: "Ada" }, { label_pattern: "country", option: ["Chile", "Brazil"] }, { label_pattern: "nothing", text: "x" }] });
  await h.call("fill", { only_empty: true, fields: [{ label_pattern: "first", text: "Bob" }, { label_pattern: "last", text: "L" }, { label_pattern: "nothing", text: "x" }] });
  await h.call("fill", { fields: [{ label_pattern: "country", option: ["Chile", "Peru"] }] });
});
add("fill: fields_path and bad fields", async (h) => {
  onPage(h, `<form><label>First <input name=first></label></form>`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(h.tmp + "/f.json", JSON.stringify([{ label_pattern: "first", text: "Ada" }]));
  writeFileSync(h.tmp + "/bad.json", "{");
  await h.call("fill", { fields_path: h.tmp + "/f.json" });
  await h.call("fill", { fields_path: h.tmp + "/bad.json" });
  await h.call("fill", { fields: [] });
  await h.call("fill", { fields: [{ text: "x" }] });
  await h.call("fill", { fields: [{ label_pattern: "first", text: "x", raise: true }] });
});
add("fill: fields after a pick that leaves the page are unverified", async (h) => {
  const w = onPage(h, `<label>State <input id=st></label><label id=lab>Level</label><div class="select__control"><div role=combobox aria-labelledby=lab aria-expanded=false tabindex=0><span class=v>Choose</span></div></div><div id=menu></div><label>City <input id=ci></label>`, {
    setup: `const cb = document.querySelector('[role=combobox]');
      document.querySelector('.select__control').addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !e.view) return;
        cb.setAttribute('aria-expanded', 'true');
        document.getElementById('menu').innerHTML = '<div role=option>Junior</div><div role=option>Senior</div>';
        document.querySelectorAll('[role=option]').forEach(o => o.addEventListener('click', () => { cb.querySelector('.v').textContent = o.textContent; }));
      });`,
  });
  w.dom.document.getElementById("menu").addEventListener("click", () => { w.dom.dispatchEvent(new w.dom.Event("pagehide")); });
  await h.call("fill", { fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "level", option: "senior" }, { label_pattern: "city", text: "Rio" }] });
});
add("fill: late revert reported by the next call and held click", async (h) => {
  onPage(h, `<form><label>Zip <input id=zip name=zip></label><button id=go type=button>Go</button></form>`, {
    setup: `window.__q = []; const z = document.getElementById('zip'); z.addEventListener('input', () => { window.__q.push(() => { z.value = ''; }); });`,
  });
  const ev = h.world.dom.eval.bind(h.world.dom);
  h.world.dom.eval = (js) => { const q = h.world.dom.__q.splice(0); q.forEach((f) => f()); return ev(js); };
  await h.call("fill", { label_pattern: "zip", text: "2000" });
  await h.call("click", { selector: "#go" });
  await h.call("click", { selector: "#go" });
});
add("fill: typeahead pick and miss", async (h) => {
  onPage(h, `<label for=city>City</label><input id=city role=combobox aria-autocomplete=list aria-controls=list aria-expanded=false><ul id=list role=listbox></ul>`, {
    setup: `const i = document.getElementById('city'), l = document.getElementById('list');
      const all = ['Buenos Aires', 'Berlin', 'Bern'];
      i.addEventListener('input', () => { l.innerHTML = all.filter((c) => c.toLowerCase().startsWith(i.value.toLowerCase())).map((c) => '<li role=option>' + c + '</li>').join(''); i.setAttribute('aria-expanded', 'true'); });
      l.addEventListener('click', (e) => { i.value = e.target.textContent; l.innerHTML = ''; i.setAttribute('aria-expanded', 'false'); });`,
  });
  await h.call("fill", { label_pattern: "city", text: "Buenos Aires" });
  await h.call("fill", { label_pattern: "city", text: "Ber" });
  await h.call("fill", { label_pattern: "city", text: "Zzz" });
});
add("fill: trusted background and raised", async (h) => {
  desk(h, `<label>Email <input id=e name=email></label><label>Email <input type=checkbox></label>`);
  await h.call("fill", { label_pattern: "email", text: "a@b.test", trusted: true });
  await h.call("fill", { selector: "#e", text: "c@d.test", trusted: true, raise: true });
  await h.call("fill", { fields: [{ selector: "#e", text: "e@f.test", trusted: true }] });
});
for (const kind of ["arc", "safari"]) {
  add(`fill: ${kind}`, async (h) => { onPage(h, `<label>Name <input name=n></label>`, { kind }); await h.call("fill", { label_pattern: "name", text: "Ada" }); });
}

// select
add("select: native exact, word, ambiguous, miss, disabled", async (h) => {
  onPage(h, `<label>Country <select id=c><option value="">Choose</option><option value=ar>Argentina</option><option value=br>Brazil</option><option disabled>Chile</option></select></label>
    <label>Plan <select id=p><option>Pro monthly</option><option>Pro yearly</option></select></label><select id=d disabled aria-label="Off"><option>A</option></select>`);
  await h.call("select", { label_pattern: "country", text: "Brazil" });
  await h.call("select", { selector: "#c", text: "ar" });
  await h.call("select", { selector: "#c", text: "Brazil" });
  await h.call("select", { selector: "#p", text: "pro" });
  await h.call("select", { selector: "#c", text: "Chile" });
  await h.call("select", { selector: "#c", text: "Peru" });
  await h.call("select", { selector: "#c", text: "" });
  await h.call("select", { selector: "#d", text: "A" });
  await h.call("select", { selector: "#nope", text: "A" });
  await h.call("select", { label_pattern: "country" });
});
add("select: custom listbox", async (h) => {
  onPage(h, `<div id=w><button id=c role=combobox aria-controls=l aria-expanded=false aria-label="Fruit">Pick</button><ul id=l role=listbox hidden><li role=option>Apple</li><li role=option>Banana</li></ul></div>`, {
    setup: `const c = document.getElementById('c'), l = document.getElementById('l');
      c.addEventListener('click', () => { l.hidden = false; c.setAttribute('aria-expanded', 'true'); });
      l.addEventListener('click', (e) => { c.textContent = e.target.textContent; l.hidden = true; c.setAttribute('aria-expanded', 'false'); });`,
  });
  await h.call("select", { selector: "#c", text: "banana" });
  await h.call("select", { selector: "#c", text: "Cherry" });
});
add("select: trusted", async (h) => {
  desk(h, `<label>Size <select id=s><option>S</option><option>M</option></select></label>`);
  await h.call("select", { selector: "#s", text: "M", trusted: true });
});
for (const kind of ["arc", "safari"]) {
  add(`select: ${kind}`, async (h) => { onPage(h, `<select id=c aria-label="C"><option>A</option><option>B</option></select>`, { kind }); await h.call("select", { selector: "#c", text: "B" }); });
}

// file_upload
add("file_upload: input, label, drop zone, misses", async (h) => {
  onPage(h, `<label>Resume <input id=f type=file accept=".pdf,.txt"></label><div id=z aria-label="Drop files">Drop here</div>`, {
    setup: `document.getElementById('z').addEventListener('drop', (e) => { e.preventDefault(); document.getElementById('z').textContent = e.dataTransfer.files[0].name; });
      document.getElementById('z').addEventListener('dragover', (e) => e.preventDefault());`,
  });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(h.tmp + "/cv.txt", "hello");
  await h.call("file_upload", { path: h.tmp + "/cv.txt", selector: "#f" });
  await h.call("file_upload", { path: h.tmp + "/cv.txt", label_pattern: "resume" });
  await h.call("file_upload", { path: h.tmp + "/cv.txt" });
  await h.call("file_upload", { path: h.tmp + "/cv.txt", selector: "#z" });
  await h.call("file_upload", { path: h.tmp + "/missing.txt", selector: "#f" });
  await h.call("file_upload", { selector: "#f" });
  await h.call("file_upload", { path: h.tmp + "/cv.txt", selector: "#nope" });
  await h.call("file_upload", { path: h.tmp + "/cv.txt", selector: "#f", raise: true });
});

// console_capture
add("console_capture: start, read, stop, network", async (h) => {
  const w = onPage(h, `<p>x</p>`);
  w.dom.performance.getEntriesByType = () => [{ name: "https://api.test/r1", initiatorType: "fetch", duration: 84, transferSize: 1200, responseStatus: 200 }];
  await h.call("console_capture", { mode: "read" });
  await h.call("console_capture", { mode: "start" });
  await h.call("eval_js", { script: "console.log('hello', 1); console.error('bad'); return 1" });
  await h.call("console_capture");
  await h.call("console_capture", { mode: "stop" });
  await h.call("console_capture", { mode: "network" });
  await h.call("console_capture", { mode: "net" });
});

// notify
// The fake daemon evaluates each script in one shared context (the real one
// wraps each in a function), so each notify gets its own world.
add("notify: message, title, subtitle, sound", async (h) => {
  for (const args of [{ message: "Done" }, { message: "Done", title: "T", subtitle: "S", sound: "" }, {}]) {
    h.install({ browsers: [], cg: [] });
    h.world.run(`globalThis.Application.currentApplication = () => ({ displayNotification: (m, o) => { globalThis.shown = [m, o]; } })`);
    await h.call("notify", args);
  }
});

// screenshot
add("screenshot: window, jpeg, maxWidth", async (h) => {
  desk(h, `<p>x</p>`);
  await h.call("screenshot");
  await h.call("screenshot", { format: "jpeg", maxWidth: 400 });
  await h.call("screenshot", { maxWidth: 0, target: { tabId: "chrome:x" } });
  await h.call("screenshot", { raise: true });
});
add("screenshot: element by selector and ref", async (h) => {
  desk(h, `<button id=b data-rect="100,100,200,40">Buy</button>`);
  await h.call("screenshot", { selector: "#b" });
  const ref = (await h.call("accessibility_snapshot")).split("\n")[1].split(" ")[0];
  await h.call("screenshot", { ref });
  await h.call("screenshot", { selector: "#nope" });
});
add("screenshot: element past the viewport edge is clipped", async (h) => {
  desk(h, `<button id=b data-rect="-20,450,300,100">Buy</button>`);
  await h.call("screenshot", { selector: "#b" });
});
add("screenshot: no Screen Recording grant", async (h) => {
  const w = desk(h, `<p>x</p>`);
  w.state.capture = false;
  await h.call("screenshot");
});
add("screenshot: window_offscreen", async (h) => {
  h.install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabsOf(1) }])], cg: [] }, { helper: {} });
  await h.call("screenshot");
});

// dialogs
add("dialog_open and press {dialog}", async (h) => {
  h.install({
    browsers: [chrome([{ id: 5, active: 0, tabs: [{ id: 5, url: "https://a.test/" }] }])],
    cg: [{ owner: "Terminal", pid: 1 }, { owner: CHROME, pid: 40, wid: 400, x: 0, y: 0, w: 800, h: 700, ax: { web: [{ x: 0, y: 80, w: 800, h: 620 }] } }],
  });
  h.world.state.dialogs = [{ pid: 40, parent: 400, blocks: 5, texts: ["a.test says", "Your name?"], buttons: ["Cancel", "OK"], field: "" }];
  await h.call("wait", { expression: "false", timeout: 1000, target: { tabId: "chrome:5" } });
  await h.call("press", { key: "Enter", dialog: "Ada", target: { tabId: "chrome:5" } });
  await h.call("press", { key: "Enter", dialog: true });
});

// coded errors
add("errors: stale_tab across tools", async (h) => {
  multi(h);
  for (const [tool, args] of [["eval_js", { script: "return 1" }], ["get_text", {}], ["wait", {}], ["activate_tab", {}], ["click", { selector: "a" }]]) {
    await h.call(tool, { ...args, target: { tabId: "chrome:gone" } });
  }
  await h.call("eval_js", { script: "return 1", target: { tabId: "safari:5.9.abc" } });
  await h.call("eval_js", { script: "return 1", target: { tabId: "nope" } });
});
add("errors: tab_not_visible on an Arc background tab", async (h) => { multi(h); await h.call("eval_js", { script: "return 1", target: { tabId: "arc:a1" } }); });
add("errors: tab_not_scriptable on a browser page", async (h) => {
  h.install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "chrome://newtab/", id: "n" }] }]), arc([{ id: "W1", active: 0, tabs: [{ url: "arc://newtab/", id: "m" }] }])], cg: [{ owner: CHROME }, { owner: "Arc" }] });
  await h.call("eval_js", { script: "return 1" });
  await h.call("get_text", { target: { tabId: "arc:m" } });
});
add("errors: no_browser", async (h) => {
  h.install({ browsers: [], cg: [] });
  await h.call("eval_js", { script: "return 1" });
  await h.call("new_tab", { url: "https://n.test/" });
  await h.call("list_tabs", { app: "nonesuch" });
});
add("errors: timeout from a hung page and a quit browser", async (h) => {
  multi(h);
  h.world.state.aeFail = { errorNumber: -1712, message: "AppleEvent timed out.", app: CHROME, key: /execute/ };
  await h.call("eval_js", { script: "return 1", target: { tabId: "chrome:c1" } });
  await h.call("eval_js", { script: "return 1" });
  h.world.state.aeFail = { errorNumber: -600, message: "Application isn't running.", app: CHROME };
  await h.call("eval_js", { script: "return 1", target: { tabId: "chrome:c1" } });
  await h.call("list_tabs", { app: "chrome" });
  h.world.state.aeFail = null;
  h.world.state.hung = true;
  await h.call("eval_js", { script: "return 1", target: { tabId: "chrome:c1" } });
});
add("errors: permission messages", async (h) => {
  multi(h);
  h.world.state.jsOff = true;
  await h.call("eval_js", { script: "return 1", target: { tabId: "chrome:c1" } });
  h.world.state.jsOff = false;
  h.world.state.aeFail = { errorNumber: -1743, message: "Not authorized to send Apple events to Google Chrome.", app: CHROME };
  await h.call("eval_js", { script: "return 1", target: { tabId: "chrome:c1" } });
});
add("errors: unknown tool and bad label_pattern", async (h) => {
  onPage(h, `<p>x</p>`);
  await h.call("nonesuch", {});
  await h.call("fill", { label_pattern: "a".repeat(400), text: "x" });
});
add("errors: window_ambiguous with a second instance", async (h) => {
  const w = desk(h, `<button id=b>Go</button>`);
  w.cg.push({ owner: CHROME, pid: 4343, wid: 51, x: 0, y: 57, w: 854, h: 600 });
  await h.call("click", { selector: "#b", trusted: true });
});
