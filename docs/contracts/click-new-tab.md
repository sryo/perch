# Clicks that open a tab

A popup blocker drops a synthetic click's new tab silently, so `click` reports both outcomes. The first pass stops before clicking a `_blank` link or submit (`blankHref`), keeps a closure on `window.__perch_blank` under an owner token, and the runtime reads every window's tabs, clicks through the kept closure and diffs the tabs for up to 500ms.
- `opened: {tabId, url}`: the click's tab (at the link's URL, still blank, or on its origin); perch never selects it, and `note: "the browser showed the new tab"` when the browser did.
- `unconfirmed: true, href, note` with `ok:true`: no tab seen (blocked or still opening); check `list_tabs urlContains href` before clicking again. New tabs that aren't the click's are never `opened`.
- `blocked`: only when the page saw `window.open` return null.
- Ordinary clicks cost what they did. Pinned by `test/click-new-tab.test.mjs`; live: `scripts/trusted-live.mjs --yes --new-tab`.
