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
| `list_tabs` | All open tabs across running browsers. `active: true` marks the frontmost browser's front-window active tab. |
| `new_tab` | Open a new tab in a named browser (default Google Chrome). Launches the app if needed. |
| `close_tab` | Close the target tab. |
| `activate_tab` | Bring the target tab and its window to the foreground. |
| `navigate` | Load a URL in the target tab. Waits for `readyState === "complete"` by default. |
| `reload` / `go_back` / `go_forward` | History navigation on the target tab. |
| `eval_js` | Run JS in the target tab. Code runs inside an IIFE; use `return <value>` to send a value back. |
| `wait_for` | Block until a `readyState` / CSS selector / JS expression condition is met. Polls inside one osascript call. |
| `screenshot` | PNG of the target browser window. Captures by CGWindowID so background windows work without focus steal; pass `raise: true` to bring the window forward first. |
| `get_page_info` | URL, title, readyState, viewport, scroll, doc size, meta tags. |
| `get_text` / `get_html` | innerText / outerHTML of an element (default `body` / `html`). |
| `open_devtools` | Toggle DevTools / Web Inspector (Cmd+Opt+I). Optional `panel: "console" \| "elements"` on Chrome/Arc. Focus-stealer. |
| `notify` | macOS notification — ping the user when something is ready. Title/subtitle/sound optional. Shows as "Script Editor" (osascript limitation). |

## Targeting

Every tool except `new_tab` and `list_tabs` accepts an optional `target`:

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
wait_for({ selector: "[data-testid=root]", timeout: 5000 })
```

**Hands-free agent loop.** `wait_for` with `expression` polls a JS expression and returns its first truthy non-null value as `{ok, waited, value}`. Use this to wait on new annotations, network responses, login flows — anything where you'd otherwise be re-polling from the agent side.

```
wait_for({
  expression: "window.__avis.summary().filter(a => !a.status).length ? window.__avis.summary() : null",
  timeout: 60000
})
```

Returns the unacknowledged annotations the moment any appear. Exceptions inside the expression are swallowed (treated as null), so it's safe to reference state that may not exist yet.

**Capture for visual review.** `screenshot` returns an `image` content block — usable inline by vision-capable models.

## Permission setup

On first use against a browser, the server returns an error pointing the user at the right toggle. Surface verbatim:

- **Chromium-family** (Chrome, Brave, Edge, Vivaldi, Arc): `View > Developer > Allow JavaScript from Apple Events`. Per-profile.
- **Safari**: `Preferences > Advanced > Show Develop menu`, then `Develop > Allow JavaScript from Apple Events`.
- **macOS Automation**: `System Settings > Privacy & Security > Automation` — the controlling app (Claude Code / Terminal / iTerm) must have the target browser ticked. macOS prompts on first call.

Don't retry until the user confirms they flipped the toggle.

## Failure modes

- **Permission off** — error message names the exact menu path. Show it to the user; do not retry blindly.
- **`no matching tab`** — `target` referenced an app/window/tab that doesn't exist. Re-call `list_tabs` and rebuild the target.
- **Safari `eval_js` no-op** — Safari's bridge only runs JS in the document's current tab. Call `activate_tab` first, or accept the default (frontmost active tab).

## When to suggest perch

Whenever a skill needs to point at, read from, or modify a page in the user's existing browser — design reviews, scraping a live SPA, annotating a dev page, running a quick `getBoundingClientRect` on something the user is looking at. For headless scraping, Playwright fits better; for network capture or pre-load instrumentation, CDP or a real extension.
