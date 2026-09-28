---
name: perch
description: Drive the user's own macOS browsers (Chrome family, Arc, Safari) via the perch MCP server. Use whenever a skill needs to list tabs, read or change a live page, fill forms, navigate, or screenshot.
allowed-tools: mcp__perch__*
---

# perch: macOS browser bridge

Which browser a tab lives in is perch's concern. Pass `target: {tabId}` with a `tabId` from `list_tabs` or `new_tab`: one opaque handle for any browser, valid while other tabs open and close. With no target, tools use the active tab of the topmost browser window. `app` (loosely matched, e.g. `"canary"`) only filters `list_tabs` or picks the browser for `new_tab`.

## Tools

| Tool | Use |
|---|---|
| `list_tabs` | `{tabs:[{app,tabId,url,title,active?}], total}`, 50 rows by default. `active`: the tab its window shows. Filter with `app`, `urlContains`, `titleContains`. |
| `new_tab` | Unselected tab in a running browser, default the one in use. May focus the browser; defer while the user works. Returns `{app,tabId}`. |
| `activate_tab` | Raise a tab and its window. |
| `close_tab` | Close a tab by its required `tabId`. Refuses a window's last tab; never changes focus. |
| `navigate` | Load a URL and wait for the new page. Returns the tab's current `tabId`; use it from then on. `waited:false`: load not confirmed. |
| `eval_js` | Run JS as a function body; `return` a JSON-able value. `script_path`: a local file, run before `script` if both. `awaitPromise` for real async. |
| `wait` | Until `selector` exists and `readyState` is reached, or `expression` is truthy (returned as `value`). |
| `screenshot` | On-screen window image without raising it, plus `{window, image}`: `screenX = window.x + imageX * window.w / image.w`. Not for minimized windows. |
| `get_text` | innerText, or outerHTML with `html: true`. Paged by `offset` / `maxChars`. |
| `accessibility_snapshot` | Page outline with refs (below), open shadow roots included. Filter with `role` or `query` (regex per line); `max: 0`: header only. |
| `console_capture` | `start`, `read` drains `"level: text"`, `stop` restores; navigation clears it. `network` drains finished requests as `"status type ms size url"`. |
| `click` | By `ref` / `selector` / `label_pattern` (button/link name; ties: `candidates`, no click). `readback: css` adds `{readback, changed, url?}`: its text once changed (2s cap). `hover: true`: hover events only (JS menus, not CSS `:hover`). `trusted`: below. |
| `press` | `key` (`Enter`, `Escape`, `Tab`, `cmd+k`) on `ref` / `selector` or the focused element, background tabs too. Emulates Enter submit/click, Space click, Tab focus. `{ok, el, prevented, focus}`. `trusted: true`: real keys to the shown tab (named keys, shift) if the page has the keyboard (else `tab_not_visible`: trusted click it first); check `hit`. |
| `fill` | Inputs, textareas, rich editors; verifies it landed. `text_path` for long bodies. One call per form: `fields: [{ref\|selector\|label_pattern, text\|checked\|option}]`. |
| `select` | Native `<select>` or custom combobox, own list only; reads back. Miss or `text:""`: `candidates`. `trusted`: below. |
| `file_upload` | Put a local file on an `<input type=file>`; the bytes skip context. |
| `notify` | macOS notification for the user. |

## Snapshot format

```
# {"url":"https://x/apply","title":"Apply","ready":"complete","count":37,"focus":"4","dialogs":["Cookies"],"form":{"fields":14,"requiredEmpty":3}}
1 heading "Apply" level=1
2 textbox "Email" name="email" type="email" value="a@b.c" required
3 combobox "Country" options=["Argentina","Brazil"] value="AR"
4 checkbox "I agree" checked
```

Every value is JSON. Keys: `name` (HTML name), `type`, `value`, `options`, `level`, `href`. Flags: `required`, `checked`, `pressed`, `selected`, `disabled`, `expanded`. Refs die on the next snapshot or navigation.

## Results

- `{ok: false, error}` is an outcome, not a crash; read it.
- `fill` returns `{ok, kind: "plain"|"rich"|"typeahead", el, len, ambiguous?}`. A typeahead picks a suggestion (`selected`) or fails; free text stays (`note`). `ok: true` is proof.
- `fill {fields}` returns `{ok, results:[{ok, kind, el, error?}]}`, `ok` if all landed. `checked` clicks only on a change; `option` also answers a radio group by question.
- `fill {trusted:true}`: `{ok, trusted, value, el}`; typeahead: pick result + `trusted:true`; free text: `{ok, kind:"plain", note, trusted}`. Require `ok` and `trusted`.
- Page errors: `isError` with `__perch_error`, `__perch_error_name`, a stack head.
- Other errors start with a code; branch on it. `tab_not_visible`: `activate_tab` (takes focus) or retry later. `stale_tab`: re-run `list_tabs`. `window_offscreen`: minimized or on another Space. `window_ambiguous`: move or resize a same-frame window. `no_browser`: none running, or no window. `timeout`: re-list, retry once; if it may have run, check first. `tab_not_scriptable`: internal page; `navigate` first. `dialog_open`: see Dialogs.

## Gotchas

- **Page globals may be invisible.** Some browsers eval in an isolated world: read page state through the DOM.
- **Don't sleep in page code.** Background tabs throttle timers to ~1/s. Use `wait`.
- **Return summaries, not state.**
- **Dialogs.** A call stuck behind a page's alert/confirm/prompt fails in ~3s with `dialog_open`. Answer with `press {key:"Enter"|"Escape", dialog:true, target:{tabId}}` (a string fills a prompt), no raise, then re-read the page. Only the tab's own JS dialog is answered; other browser prompts go to the user.

## Trusted input

`fill {trusted: true}` edits a plain input or textarea through the browser's editing command, verifying a trusted `input` event and the exact value, wherever page JS runs, minimized too, without selecting the tab or taking focus. `click {trusted: true}` reaches an on-screen window without activating it or moving the cursor; its tab must be the one its window shows (else `tab_not_visible`). So does `select {trusted: true}` on a control or option ignoring synthetic presses (`trusted`: what it clicked). Plain `click`: any tab; verify it. `raise: true` takes focus briefly (HID), cursor restored.

`accessibility_snapshot {frames:true}` adds iframe controls as `fN` rows, never values. `fN` takes only `click {trusted:true}`; read its `after`. `handoff` (sign-in, captcha) and `secure` rows won't click: they are the user's.

## Permissions

On first failure the server names the exact toggle; show the user and wait.

- Chromium family and Arc: View > Developer > Allow JavaScript from Apple Events (per profile).
- Safari: Settings > Advanced > Show Develop menu, then Develop > Allow JavaScript from Apple Events.
- macOS Automation (first call prompts) and, for trusted input and dialogs, Accessibility: System Settings > Privacy & Security, for the host app.
