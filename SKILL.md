---
name: perch
description: Drive the user's own macOS browsers (Chrome family, Arc, Safari) via the perch MCP server. Use whenever a skill needs to list tabs, read or change a live page, fill forms, navigate, or screenshot.
allowed-tools: mcp__perch__*
---

# perch: macOS browser bridge

Which browser a tab lives in is perch's concern. Pass `target: {tabId}` with a `tabId` from `list_tabs` or `new_tab`: one opaque handle that works for every browser and stays valid while other tabs open and close. With no target, tools use the active tab of the topmost browser window. `app` (loosely matched, e.g. `"canary"`) only filters `list_tabs` or picks the browser for `new_tab`.

## Tools

| Tool | Use |
|---|---|
| `list_tabs` | `{tabs:[{app,tabId,url,title,active?}], total}`, 50 rows by default, in the order the browser shows them. `active` marks the tab its window shows. Filter with `app`, `urlContains`, `titleContains`. |
| `new_tab` | Add an unselected tab to an already running browser window, by default the browser in use. Creation may focus the browser; defer while the user works. Returns `{app,tabId}`. |
| `activate_tab` | Bring a tab and its window to the front. |
| `close_tab` | Close a tab by its `tabId` (required; no default). Refuses a window's last tab; never changes focus. |
| `navigate` | Load a URL and wait for the new page to finish loading. Returns the tab's current `tabId`; use it from then on. `waited:false`: load not confirmed. |
| `eval_js` | Run JS as a function body; `return` a JSON-able value. `script_path` loads a local file; with both, the file runs first, then `script`, in one call. `awaitPromise` for real async. |
| `wait` | Until `selector` exists and `readyState` is reached, or until `expression` is truthy (returned as `value`). |
| `screenshot` | On-screen window image without raising it, plus `{window, image}` for mapping: `screenX = window.x + imageX * window.w / image.w`. Minimized windows cannot be captured. |
| `get_text` | innerText, or outerHTML with `html: true`. Paged by `offset` / `maxChars`. |
| `accessibility_snapshot` | Page outline with refs (format below). Filter with `role`; `max: 0` for the header only. |
| `console_capture` | `start`, then `read` drains `"level: text"` strings, `stop` restores. Navigation clears it. |
| `click` | By `ref` / `selector`. `readback: css` adds `{readback, changed, url?}`: its text once changed (2s cap), no follow-up read. `trusted: true`: see below. |
| `fill` | Inputs, textareas, rich editors; verifies the text landed. `text_path` for long bodies. One call per form: `fields: [{ref\|selector\|label_pattern, text\|checked\|option}]`. |
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
- `fill {fields}` returns `{ok, results:[{ok, kind, el, error?}]}`, `ok` if all landed. `checked` clicks only on a change.
- `fill {trusted:true}` returns `{ok, trusted, value, el}` for background plain fields. Require both `ok` and `trusted`.
- Page errors come back as `isError` with `__perch_error`, `__perch_error_name` and a stack head.
- Other errors start with a code; branch on it, never on the browser. `tab_not_visible`: needs the tab its window shows: `activate_tab` (takes focus) or retry later. `stale_tab`: tab gone; re-run `list_tabs`. `window_offscreen`: minimized or on another Space. `no_browser`: none running or no window (never launched). `timeout`: re-list, retry once. `tab_not_scriptable`: internal page; `navigate` first.

## Gotchas

- **Page globals may be invisible.** Some browsers run eval in an isolated world: the DOM is shared with the page, JS globals are not. Read page state through the DOM, never through `window.*` values the page set.
- **Don't sleep in page code.** Background tabs throttle timers to ~1/s. Use `wait`, which polls from outside the page.
- **Return summaries, not state.** Results land in context verbatim.

## Trusted input

`fill {trusted: true}` edits a plain input or textarea through the browser's editing command and verifies a trusted `input` event and the exact value. It works in background tabs and minimized windows wherever page JS runs, without changing the selected tab or taking key focus. `click {trusted: true}` uses SkyLight to reach an on-screen window without activating it or moving the cursor; its tab must be the one its window shows (else `tab_not_visible`), and a minimized window does not receive it. Plain `click` (untrusted) works in background or minimized tabs; verify the outcome. `raise: true` uses the foreground HID route: brief focus, cursor restored. Rich editors usually work without trusted mode.

## Permissions

The server names the exact toggle on first failure; show it to the user and wait.

- Chromium family and Arc: View > Developer > Allow JavaScript from Apple Events (per profile).
- Safari: Settings > Advanced > Show Develop menu, then Develop > Allow JavaScript from Apple Events.
- macOS Automation (first call prompts) and, for SkyLight/HID input only, Accessibility: System Settings > Privacy & Security, for the controlling app.
