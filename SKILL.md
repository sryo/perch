---
name: perch
description: Drive the user's own macOS browsers (Chrome family, Arc, Safari) and rooms (signed-in Chromium in a VM on this Mac) via the perch MCP server. Use to list tabs, read or change a live page, fill forms, navigate, or screenshot.
allowed-tools: mcp__perch__*
---

# perch

Targeting and errors: server instructions. `app` matches `"canary"`.

## Tools

Adds to the tool descriptions; none for `activate_tab`, `close_tab`, `wait`, `console_capture`, `notify`, `get_text`, `file_upload`.

| Tool | Use |
|---|---|
| `list_tabs` | Filter: `app`, `urlContains`, `titleContains`. |
| `new_tab` | `shown:false`: page tools get `tab_not_visible` until shown; see `note`. |
| `navigate` | Returns the tab's current `tabId`. `url` is the committed URL (`requested` if it differs); `load_failed`: error page, or the tab stayed (download, 204). `waited:false`: not confirmed; `timeout`: not committed yet, may still load. |
| `eval_js` | `awaitPromise` only for real async. `ref` binds `el` (a parameter): `return __avis.add(el, 'x')`. |
| `screenshot` | Off-screen window: last frame only. `ref`: element only; scroll restored; `clipped`: cut. |
| `accessibility_snapshot` | Rows below; open shadow roots too. `max: 0`: header only. |
| `click` | `label_pattern`: button/link name; ties: `candidates`. Natively disabled (own or fieldset's): `ok:false`, not clicked, trusted too; `aria-disabled` clicks. `readback` adds `invalid?`, `form?`, `settled:false` (still busy). `form`: {gone, alert, step} after a submit/Next; navigated: `page` {heading?, alert?}; decide success yourself. `hover: true`: JS events, not `:hover`. New tab: `opened.tabId`; `blocked`/`unconfirmed`+`href`. `trusted`: below. |
| `press` | Background tabs too; Enter submits/clicks, Space clicks. `{ok, el, prevented?, focus?}` (`focus`: if moved). `trusted: true`: real keys in shown tab (named/letter/digit, +shift) if the page has the keyboard (else `tab_not_visible`: trusted click first); check `hit`. |
| `fill` | `text_path`: long bodies. One call per form: `fields` (no `raise`); `fields_path`: JSON file. `label_pattern` also matches a whole autocomplete token (`given-name`, `email`, `tel`). |

## Snapshot format

```
# {"url":"https://x/apply","title":"Apply","count":37,"focus":"4","dialogs":["Cookies"],"form":{"fields":14,"requiredEmpty":3,"unpicked":1}}
1 heading "Apply" level=1
2 textbox "Email" name="email" type="email" value="a@b.c" required
3 combobox "Country" options=["Argentina","Brazil"] value="Argentina"
```

No `ready`: complete. Values are JSON. Keys: `name` (HTML name), `type`, `value` (a pick's text; none on a placeholder), `options`, `level`, `href`, `error`, `reveal` (its button's ref). Flags: `required`, `checked`, `pressed`, `selected`, `disabled`, `expanded`, `invalid`, `unpicked` (typed, no pick), `hidden` (unseen; fill by ref). Refs die on re-snapshot or navigation. Use them with the snapshot's `target`. Header `iframes`: big frames; `same:true` rows end `frame=N`, else open `src`; `in`: parent row. `form.step`: wizard step. `form.unpicked` counts `unpicked` rows; `requiredEmpty` includes required ones.

## Results

- `fill` returns `{ok, kind?: "rich"|"typeahead" (none: plain), el, len, ambiguous?, kept?, reveal?, hidden?}`. Typeaheads pick (`selected`) or fail; an empty lookup retries once with a short query (`query`); free text stays (`note`). `ok: true` is proof. A write the page undoes after the call is reported by the next call on that tab: `late:[{el, error}]`; a `click`/`press` then does nothing: refill, retry.
- `fill {fields}` returns `{ok, results:[{ok, kind?, el, error?}]}`, `ok` if all landed. A field a later one cleared (named if known), or the page put back or emptied a moment later (Chrome; else `late`), is `ok:false` (the latter `reverted:true`; a list rebuilt after an earlier field may name it: refill once it settles), as is a select or radio group moved to another option; text reformatted later stays `ok` with a `note`. A pick the control didn't show is `ok:false` (`pressed`, `value`); `unverified`: count of fields a failed final re-read or a page change left unchecked (`warning`); an error after a field landed ends it with `error`, landed kept. `form: {requiredEmpty, unpicked?, left?:[{name, label}]}` (10 at most) is what the filled fields' form still wants, as the snapshot header counts it; absent after a page change. `checked` clicks only on a change; `option` also answers a radio group by question. `only_empty`: skip absent/filled/disabled fields (`skipped`).
- `select`: a native pick is checked as `fill` is (`late`). A custom pick showing only the typed text is `ok:false`, also when the list stays open: retry `trusted` or check.
- `fill {trusted:true}`: `{ok, trusted, value, el}`; typeahead: pick result + `trusted:true`; free text: `{ok, note, trusted}`. Require `ok` and `trusted`.
- `moved: true` with a new `tabId` (`eval_js`: in a second text item): the tab moved; use it.
- `eval_js` error: `isError`, `__perch_error`, `__perch_error_name`.
- `window_offscreen`: window minimized or on another Space; `no_browser`: none running, or no window; `window_ambiguous`: move or resize a same-frame window; `timeout`: re-list, retry once; if it may have run, check first.

## Gotchas

- **Page globals may be invisible** (isolated world): read the DOM.
- **Don't sleep in page code.** Background timers run ~1/s. Use `wait` (`quiet` to settle).
- **Client timeouts.** Some cut calls at 30-60s; keep `timeout` under.
- **Dialogs.** `dialog_open` comes in ~3s; answer with `press {dialog}`, then re-read. Other prompts are the user's.

## Trusted input

`fill {trusted: true}` edits a plain input or textarea via the browser's editing command (trusted `input`, value verified) wherever page JS runs, minimized too, no tab switch, no focus. `click {trusted: true}` reaches an on-screen window's shown tab (else `tab_not_visible`) without activating it or moving the cursor. So does `select {trusted: true}` on a control or option ignoring synthetic presses (`trusted`: what it clicked); other tabs, or a menu the click leaves shut: a filter typed into its own empty box (`"typed"`). Plain `click`: any tab; verify it. `raise: true` takes focus briefly (HID), cursor restored.

`frames` rows carry no values; read a trusted click's `after`. `handoff` (sign-in, captcha) and `secure` rows won't click: they are the user's. `frames_unreadable`: retry.

## Rooms

A room is a signed-in Chromium in a VM on this Mac (`rooms` CLI). Use one when a site must stay signed in, the work shouldn't touch the user's windows, or the Mac may be locked.

| Step | Call |
|---|---|
| Find | `list_tabs {app:"room"}` or `{app:"room:work"}`; ids are `room:<name>:<targetId>`. No `app`: rooms that are up list after the browsers. |
| Open | `new_tab {app:"room:work"}`, then `navigate`. |
| Act | Any tool with that `target.tabId`. Untargeted calls never reach a room. |
| Move | `new_tab {from: <browser tabId>, app:"room:work"}`: same URL, page state stays behind; refill. `from` stays open. Errors needing the user's window suggest it. |

Room tabs answer like shown ones: no `tab_not_visible`, `activate_tab` or `raise`. `click` is trusted by default (CDP input, no cursor or focus; `trusted:false` for `el.click()`). Not in rooms: `frames` rows and `fN` refs, the file chooser (`file_upload` sets the file through the page), the `late` check. Downloads are denied except in `click {download: true}`, which returns `download.file`, its path on this Mac.

| Error | Next |
|---|---|
| `signed_out` / `challenge` (`handoff.status: "pending"`) | The user's; perch has notified them. Show `handoff.command` (`rooms view <room> --signin <url>`), wait, `navigate` again. Never type credentials. |
| `no_browser: room 'x' is not up` | Run `rooms up x` in a shell, then retry. |
| `no_browser: no room 'x'` | Setup is the user's (`rooms init x`). |
| `tab_held` | Another agent has the tab: retry after 5s idle, or `new_tab`. |
| `stale_tab` | Closed or crashed: `list_tabs {app:"room:x"}`. |

When done, close the tabs you opened, `from` too; never the user's. `rooms check x` lists signed-out sites (exit 1 if any). Leave `rooms down`, `restore`, `teleport` and `flags` to the user.

## Permissions

The first failure names the toggle (JavaScript from Apple Events per profile, Automation, Accessibility); show the user, wait.
