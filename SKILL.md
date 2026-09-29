---
name: perch
description: Drive the user's own macOS browsers (Chrome family, Arc, Safari) via the perch MCP server. Use whenever a skill needs to list tabs, read or change a live page, fill forms, navigate, or screenshot.
allowed-tools: mcp__perch__*
---

# perch: macOS browser bridge

Targeting, element hints and error codes: the server instructions. `app` matches loosely (`"canary"`).

## Tools

Tool descriptions come with the schema; this adds what they leave out. `new_tab`, `activate_tab`, `close_tab`, `wait`, `console_capture`, `notify`: nothing to add.

| Tool | Use |
|---|---|
| `list_tabs` | Filter: `app`, `urlContains`, `titleContains`. |
| `navigate` | Returns the tab's current `tabId`. `url` is the committed URL (`requested` if it differs); `load_failed`: error page, or the tab stayed (download, 204). `waited:false`: not confirmed; `timeout`: not committed yet, may still load. |
| `eval_js` | `awaitPromise` only for real async. `ref` binds `el` (a parameter): `return __avis.add(el, 'x')`. |
| `screenshot` | Not for minimized windows. |
| `get_text` | Paged: `offset`/`maxChars`. |
| `accessibility_snapshot` | Refs and rows below; open shadow roots too. Filter: `role`, `query` (regex per line); `max: 0`: header only. |
| `click` | By `ref`/`selector`/`label_pattern` (button/link name; ties: `candidates`, no click). Natively disabled (own or fieldset's): `ok:false`, not clicked, trusted too; `aria-disabled` clicks. `readback: css` adds `{readback, changed, url?, invalid?, form?}`: text once changed (2s; 0.7s quiet, 1.2s hidden). `form`: {gone, alert, step} after a submit/Next; decide success yourself. `hover: true`: JS events, not `:hover`. New tab: `opened.tabId`; `blocked`/`unconfirmed`+`href`. `trusted`: below. |
| `press` | `key` (`Enter`, `Escape`, `Tab`, `cmd+k`) on `ref` / `selector` or the focused element, background tabs too. Emulates Enter submit/click, Space click, Tab focus. `{ok, el, prevented, focus}`. `trusted: true`: real keys to the shown tab (named keys, shift) if the page has the keyboard (else `tab_not_visible`: trusted click it first); check `hit`. |
| `fill` | Inputs, textareas, rich editors; verifies it landed; `text:""` clears. `text_path`: long bodies. One call per form: `fields: [{ref\|selector\|label_pattern, text\|checked\|option}]`; `fields_path`: JSON file; `option` may list preferences in order. |
| `select` | Native `<select>` or custom combobox, own list only; reads back. Miss or `text:""`: `candidates`. `trusted`: below. |
| `file_upload` | File onto an `<input type=file>` or drop zone (`dropped`); bytes skip context. |

## Snapshot format

```
# {"url":"https://x/apply","title":"Apply","ready":"complete","count":37,"focus":"4","dialogs":["Cookies"],"form":{"fields":14,"requiredEmpty":3,"unpicked":1}}
1 heading "Apply" level=1
2 textbox "Email" name="email" type="email" value="a@b.c" required
3 combobox "Country" options=["Argentina","Brazil"] value="AR"
```

Values are JSON. Keys: `name` (HTML name), `type`, `value`, `options`, `level`, `href`, `error`, `reveal` (its button's ref). Flags: `required`, `checked`, `pressed`, `selected`, `disabled`, `expanded`, `invalid`, `unpicked` (typed, no pick), `hidden` (unseen; fill by ref). Refs die on re-snapshot or navigation. Header `iframes`: big frames; `same:true` rows end `frame=N`, else open `src`; `in`: parent row. `form.step`: wizard step. `form.unpicked` counts `unpicked` rows; `requiredEmpty` includes required ones.

## Results

- `fill` returns `{ok, kind: "plain"|"rich"|"typeahead", el, len, ambiguous?, kept?, reveal?, hidden?}`. Typeaheads pick (`selected`) or fail; free text stays (`note`). `ok: true` is proof.
- `fill {fields}` returns `{ok, results:[{ok, kind, el, error?}]}`, `ok` if all landed (a field a later one cleared comes back `ok:false`); `unverified`: count of picks the control didn't show, or of fields a failed final re-read left unchecked (`warning`); an error after a field landed ends it with `error`, landed results kept. `checked` clicks only on a change; `option` also answers a radio group by question. `only_empty`: skip absent/filled/disabled fields (`skipped`).
- `fill {trusted:true}`: `{ok, trusted, value, el}`; typeahead: pick result + `trusted:true`; free text: `{ok, kind:"plain", note, trusted}`. Require `ok` and `trusted`.
- `moved: true` with a new `tabId` (`eval_js`: in a second text item): the tab changed place; use that `tabId` from now on.
- Page errors: `isError` with `__perch_error`, `__perch_error_name`.
- Other errors start with a code (server instructions list them). Also `window_offscreen`: window minimized or on another Space; `no_browser`: none running, or no window; `window_ambiguous`: move or resize a same-frame window; `timeout`: re-list, retry once; if it may have run, check first.

## Gotchas

- **Page globals may be invisible** (isolated world): read state via the DOM.
- **Don't sleep in page code.** Background tabs throttle timers to ~1/s. Use `wait` (`quiet` to let it settle).
- **Return summaries, not state.**
- **Dialogs.** A call stuck behind a page's alert/confirm/prompt fails in ~3s with `dialog_open`. Answer with `press {key:"Enter"|"Escape", dialog:true, target:{tabId}}` (a string fills a prompt), no raise, then re-read. Only the tab's own JS dialog; other prompts go to the user.

## Trusted input

`fill {trusted: true}` edits a plain input or textarea via the browser's editing command (trusted `input`, value verified) wherever page JS runs, minimized too, no tab switch, no focus. `click {trusted: true}` reaches an on-screen window's shown tab (else `tab_not_visible`) without activating it or moving the cursor. So does `select {trusted: true}` on a control or option ignoring synthetic presses (`trusted`: what it clicked); other tabs, or a menu the click leaves shut: a filter typed into its own empty box (`"typed"`). Plain `click`: any tab; verify it. `raise: true` takes focus briefly (HID), cursor restored.

`accessibility_snapshot {frames:true}` adds iframe controls as `fN` rows, never values. `fN` takes only `click {trusted:true}`; read its `after`. `handoff` (sign-in, captcha) and `secure` rows won't click: they are the user's. `frames_unreadable`: retry.

## Permissions

On first failure the error names the toggle (Allow JavaScript from Apple Events per profile, Automation, Accessibility); show the user, wait.
