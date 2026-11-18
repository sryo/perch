# Tabs

- **`list_tabs`** returns `{tabs, total, warning?}`; rows carry the full app name and a `tabId`.
- **`new_tab`** returns `{app, tabId}`, defaults to the browser in use (`defaultBrowser`), needs a running browser with a window, never `activate()`s, and puts back the tab a window showed if the browser switched. When the browser came to the front anyway, the result carries `warning: "creating the tab brought the browser to the front"`. Pinned by `test/new-tab-restore.test.mjs`.
- **`activate_tab`** alone selects a tab and raises its window.
- **Claims:** a tab perch opened is its server's; others get `tab_held`, rows `holder`/`mine`. Idle 1h: closed if untouched. `test/tab-claim.test.mjs`.
