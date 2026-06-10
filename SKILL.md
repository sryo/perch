---
name: perch
description: Drive macOS browsers (Chrome family + Safari) via the perch MCP server. Use whenever a skill needs to list tabs, run JavaScript in a real page, navigate, screenshot, or wait for a load.
allowed-tools: mcp__perch__*
---

# perch — macOS browser bridge for Claude

Tools target the active tab of the frontmost browser by default; pass an explicit `target` to pin a specific tab.

## Tool surface

| Tool | What it does |
|---|---|
| `list_tabs` | Open tabs across running browsers. `active: true` marks the frontmost browser's front-window active tab. Prefer the filters over dumping everything: `app: "<browser>"` scopes to one browser; `urlContains` / `titleContains` match case-insensitive substrings; `limit` caps rows. With any filter the result is `{tabs, total}` and each `tabIndex` keeps its real window position. |
| `new_tab` | Open a new tab in a named browser (default Google Chrome). Launches the app if needed. |
| `activate_tab` | Bring the target tab and its window to the foreground. |
| `navigate` | Load a URL in the target tab. `wait: true` (default) blocks until `document.readyState === "complete"` — returns after the page has loaded, not after the URL is set. Pass `wait: false` only when the page intentionally never reaches `complete` (long-polling endpoints, etc.) and you'll handle waiting yourself via `wait`. |
| `eval_js` | Run JS in the target tab. Code runs inside an IIFE; use `return <value>` to send a value back. Pass `script_path` instead of `script` to load the code from a local file — large scripts stay out of tool args. |
| `wait` | Block until a `readyState` / CSS selector / JS expression condition is met. Polls inside one osascript call. |
| `screenshot` | Image of the target browser window. Captures by CGWindowID so obscured windows work without focus steal. If `tabIndex` targets a non-active tab, perch silently switches the window to it and waits 150ms for the render to swap before capturing. `raise: true` brings the window forward. Downscaled to `maxWidth` (default 1568 px; 0 = original); `format: "jpeg"` for smaller payloads. |
| `page_state` | URL, title, readyState, viewport, scroll, doc size, meta tags. Cheaper than separate `eval_js` reads when you need multiple page properties at once. |
| `get_text` / `get_html` | innerText / outerHTML of an element (default `body` / `html`). Accepts `ref` from `accessibility_snapshot` instead of `selector`. Output is capped at `maxChars` (default 20000) with a truncation marker; page long content with `offset`. |
| `accessibility_snapshot` | Compact tree of interactive + landmark elements (links, buttons, form fields, headings) with stable `ref` IDs. Form fields carry `subtype` / `attr_name` / `options`. Refs invalidate on next snapshot or page navigation. Cheaper than `get_html` for navigation/agent loops. Pass `role: "textbox"` or `role: ["textbox","combobox","checkbox","radio"]` to filter at the walk — shrinks both payload and walk time on form-heavy pages. Supported values: `link`, `button`, `textbox`, `combobox`, `checkbox`, `radio`, `heading`, `slider`, plus anything in `[role=...]`. Unknown roles return empty (no throw). |
| `console_capture` | Patch `console.{log,info,warn,error,debug}` on the page; drain buffered entries on `mode: "read"`. Modes: `start \| read \| clear \| stop`. Buffer is per-document — navigation wipes it. |
| `click` | Click an element in the target tab. Default path is `el.click()` via the JS bridge — same isTrusted:false semantics as `eval_js + .click()`, just a first-class tool. Pass `trusted: true` for a real CGEvent (`isTrusted: true`) — needed when Cloudflare/WAF or React/Workday-class validators reject synthetic clicks. Trusted mode requires Accessibility permission + the target window frontmost (or `raise: true`). Targets via `ref` (preferred), `selector`, or screen `x`/`y` (trusted only). |
| `fill` | Plain inputs + rich editors (Froala, Quill, TinyMCE, ProseMirror, contenteditable). Targets via `ref`, `selector`, or `label_pattern`. Pass `trusted: true` for plain `<input>`/`<textarea>` fields that reject synthetic input (React `value_didnt_stick`, Workday-class validators that check `isTrusted` on keystrokes) — types via real CGEvent keyboard. Same permission and frontmost requirements as `click {trusted:true}`. Rich editors don't need trusted mode. |
| `file_upload` | Server-side base64 + DataTransfer assignment to `<input type=file>`. Bytes stay out of agent context. |
| `notify` | macOS notification — ping the user when something is ready. Title/subtitle/sound optional. Shows as "Script Editor" (osascript limitation). |

## Targeting

Every tool except `list_tabs`, `new_tab`, and `notify` accepts an optional `target`:

```json
{ "app": "Google Chrome", "windowId": 1217110652, "tabIndex": 0 }
```

All fields optional. Defaults: frontmost browser, frontmost window, active tab. `windowId` may be string or number — pass through whatever `list_tabs` returned.

## Common patterns

**Pick a tab the user is already on.** Call `list_tabs`, prefer `active: true` or a `localhost` / `127.0.0.1` URL. If nothing matches, ask before navigating.

**Inject a script and read it back.** Two-step:

```
eval_js({ script: "/* mount toolbar via JS */" })
// later
eval_js({ script: "return window.__myThing.summary()" })
```

The eval wrapper JSON-stringifies the return; complex objects come back parsed.

**Navigate and wait for a selector.** SPAs often render after `readyState === complete`:

```
navigate({ url: "http://localhost:3000/app" })
wait({ selector: "[data-testid=root]", timeout: 5000 })
```

**Hands-free agent loop.** `wait` with `expression` polls a JS expression and returns its first truthy non-null value as `{ok, waited, value}`. Use this to wait on new annotations, network responses, login flows — anything where you'd otherwise be re-polling from the agent side.

```
wait({
  expression: "window.__avis.summary().filter(a => !a.status).length ? window.__avis.summary() : null",
  timeout: 60000
})
```

Returns the unacknowledged annotations the moment any appear. Exceptions inside the expression are swallowed (treated as null), so it's safe to reference state that may not exist yet.

**Capture for visual review.** `screenshot` returns an `image` content block — usable inline by vision-capable models.

**Find form fields without scraping HTML.** `accessibility_snapshot` returns the accessibility tree — interactive elements with role, accessible name, refs, and (for form fields) `subtype` / `attr_name` / `options`. Pass the `ref` back into `fill`, `click`, `get_text`, `get_html`. Refs invalidate on the next snapshot or page navigation — always re-snapshot if you've navigated or want fresh state. To click by ref:

```
accessibility_snapshot({ max: 200 })
// pick a ref by reading element names
click({ ref: "7" })
```

**Submit a WAF / validator-gated form.** Cloudflare-protected submits, React forms that silently no-op on synthetic clicks (Nybble-class), Workday-class validators that check `isTrusted` on keystrokes — pass `trusted: true` to the relevant calls. The target window must be frontmost; pass `raise: true` to bring it forward, mirroring `screenshot{raise:true}`.

```
accessibility_snapshot({ role: ["textbox", "button"] })
fill({ ref: "<phone field ref>", text: "...", trusted: true })
fill({ ref: "<email field ref>", text: "...", trusted: true })
click({ ref: "<submit button ref>", trusted: true, raise: true })
// then the same verification eval_js trabAGItos already uses for submit success/failure
```

Requires Accessibility permission (see "Permission setup"). For Ashby autocomplete and similar option-pickers, `click({ ref, trusted: true })` lands on the first try — no `setTimeout` race workaround needed.

**Catch framework console errors.** SPA validators often `console.warn` an invalidation reason that never reaches the DOM. Wrap the brittle interaction:

```
console_capture({ mode: "start" })
// trigger fill / submit / etc.
console_capture({ mode: "read" })  // → { ok, entries: [{level, ts, args[]}] }
```

Buffer is per-document; if you navigate, call `start` again.

## eval_js gotchas

- **Don't use `awaitPromise: true` as a sleep.** Wrapping `setTimeout` in a Promise to "wait for the page to settle" hangs the full timeout — the timer's resolve never lands in perch's poll channel. Use `wait` (which polls inside one osascript call) plus sync `eval_js` checks for ordering. Reserve `awaitPromise: true` for genuine async — `fetch`, permissions APIs, async DOM extraction.
- **Project large returns before sending them back.** JSON results land in tool output verbatim, so a multi-megabyte return dominates context for the rest of the conversation. Return a summary, not the full state — `return window.__avis.summary()` not `return window.__avis.annotations`, `return rows.slice(0, 50)` not `return rows`.
- **Arc background tabs throw.** Arc's bridge hangs on non-current tabs, so `eval_js` / `wait` against a non-active Arc tab returns an actionable error telling you to `activate_tab` first. Other Chromium browsers do not have this restriction; Safari's bridge requires the tab to be the document's `currentTab`, which perch's targeting handles transparently when you accept the default (active tab).

## Permission setup

On first use against a browser, the server returns an error pointing the user at the right toggle. Surface verbatim:

- **Chromium-family** (Chrome, Brave, Edge, Vivaldi, Arc): `View > Developer > Allow JavaScript from Apple Events`. Per-profile.
- **Safari**: `Preferences > Advanced > Show Develop menu`, then `Develop > Allow JavaScript from Apple Events`.
- **macOS Automation**: `System Settings > Privacy & Security > Automation` — the controlling app (Claude Code / Terminal / iTerm) must have the target browser ticked. macOS prompts on first call.
- **macOS Accessibility** (only for `click {trusted:true}` and `fill {trusted:true}`): `System Settings > Privacy & Security > Accessibility` — same controlling app. CGEvent dispatch silently fails without it, so perch checks via `AXIsProcessTrustedWithOptions` and returns an actionable error before posting any event.

Don't retry until the user confirms they flipped the toggle.

## Failure modes

- **Permission off** — error message names the exact menu path. Show it to the user; do not retry blindly.
- **`no matching tab`** — `target` referenced an app/window/tab that doesn't exist. Re-call `list_tabs` and rebuild the target.
- **Safari `eval_js` no-op** — Safari's bridge only runs JS in the document's current tab. Call `activate_tab` first, or accept the default (frontmost active tab).
- **`target not frontmost`** (trusted input) — Tier 1 only dispatches to the foreground window. Pass `raise: true` or call `activate_tab` first.
- **Accessibility off** (trusted input) — error message names the exact menu path. Once the user toggles it, retry — the toggle takes effect immediately, no app restart.

## When to suggest perch

Whenever a skill needs to point at, read from, or modify a page in the user's existing browser — design reviews, scraping a live SPA, annotating a dev page, running a quick `getBoundingClientRect` on something the user is looking at. For headless scraping, Playwright fits better; for network capture or pre-load instrumentation, CDP or a real extension.
