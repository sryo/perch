---
name: perch
description: Drive the user's own macOS browsers (Chrome family, Arc, Safari) via the perch MCP server. Use whenever a skill needs to list tabs, read or change a live page, fill forms, navigate, or screenshot.
allowed-tools: mcp__perch__*
---

# perch: macOS browser bridge

Every tool takes an optional `target` `{app, windowId, tabIndex}`. The default is the active tab of the topmost browser window. `tabIndex` is a position, not an id: it shifts when tabs open or close, so re-list instead of caching it. `new_tab` returns a target for a newly created background tab.

## Tools

| Tool | Use |
|---|---|
| `list_tabs` | `{tabs:[{app,windowId,tabIndex,url,title,active?}], total}`, 50 rows by default. Filter with `app`, `urlContains`, `titleContains`. |
| `new_tab` | Add an unselected tab to an already running browser window. Creation may focus the browser; defer while the user works. Returns `{app,windowId,tabIndex}`. |
| `activate_tab` | Bring a tab and its window to the front. |
| `navigate` | Load a URL and wait for the new page to finish loading. |
| `eval_js` | Run JS as a function body; `return` a JSON-able value. `script_path` loads a local file; with both, the file runs first, then `script`, in one call. `awaitPromise` for real async. |
| `wait` | Until `selector` exists and `readyState` is reached, or until `expression` is truthy (returned as `value`). |
| `screenshot` | Window image without raising it, plus `{window, image}` for mapping: `screenX = window.x + imageX * window.w / image.w`. |
| `get_text` | innerText, or outerHTML with `html: true`. Paged by `offset` / `maxChars`. |
| `accessibility_snapshot` | Page outline with refs (format below). Filter with `role`; `max: 0` for the header only. |
| `console_capture` | `start`, then `read` drains `"level: text"` strings, `stop` restores. Navigation clears it. |
| `click` | By `ref` / `selector`. `trusted: true` posts a real OS click (see below). |
| `fill` | Inputs, textareas, rich editors; verifies the text landed. `ref` > `selector` > `label_pattern`. `text_path` for long bodies. |
| `select` | Native `<select>`, react-select, ARIA combobox/listbox; reads back what's shown. |
| `file_upload` | Put a local file on an `<input type=file>` without the bytes entering context. |
| `notify` | macOS notification to ping the user. |

## Snapshot format

```
# {"url":"https://x/apply","title":"Apply","ready":"complete","count":37,"focus":"4","dialogs":["Cookies"],"form":{"fields":14,"requiredEmpty":3}}
1 heading "Apply" level=1
2 textbox "Email" name="email" type="email" value="a@b.c" required
3 combobox "Country" options=["Argentina","Brazil"] value="AR"
4 checkbox "I agree" checked
```

Every value is JSON. Keys: `name` (HTML name), `type`, `value`, `options`, `level`, `href`. Flags: `required`, `checked`, `disabled`, `expanded`. Refs die on the next snapshot or navigation; a stale ref errors with a re-snapshot hint.

## Results

- `{ok: false, error}` is an outcome, not a crash: nothing matched, or the value didn't land. Read it before retrying.
- `fill` returns `{ok, kind: "plain"|"rich", el: 'textbox "Email"', len, ambiguous?}`. `ok: true` is proof; don't re-check.
- Page errors come back as `isError` with `__perch_error`, `__perch_error_name` and a stack head.

## Gotchas

- **Chrome runs eval in an isolated world.** The DOM is shared with the page, JS globals are not: read page state through the DOM, never through `window.*` values the page set.
- **Don't sleep in page code.** Chrome throttles timers in background tabs to about one per second, so `awaitPromise` plus `setTimeout` crawls. Use `wait`, which polls from outside the page.
- **Return summaries, not state.** Results land in context verbatim.
- **Arc** runs page JS only on a window's active tab: `activate_tab` first. **Safari** needs the tab current too.

## Trusted input

`click {trusted: true}` uses SkyLight to address the browser window without explicitly activating it or moving the shared cursor. The target tab must already be active in its browser window; perch refuses to switch it in background mode. Background `fill {trusted: true}` clicks the field there, then uses the browser's editing command; it verifies a trusted `input` event and the exact value. Both require Accessibility permission. This route was verified on a Chrome Canary scratch page, but a later test run visibly focused Chrome; use the result checks and verify the page outcome. Pass `raise: true` for the HID route, which takes focus briefly and restores the cursor. Rich editors usually work without trusted mode.

## Permissions

The server names the exact toggle on first failure; show it to the user and wait for them to flip it.

- Chromium family and Arc: View > Developer > Allow JavaScript from Apple Events (per profile).
- Safari: Settings > Advanced > Show Develop menu, then Develop > Allow JavaScript from Apple Events.
- macOS Automation (first call prompts) and, for trusted input only, Accessibility: System Settings > Privacy & Security, for the controlling app.
