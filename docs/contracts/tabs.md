# Tabs

- **`list_tabs`** returns `{tabs, total, warning?}`; rows carry the full app name and a `tabId`.
- **`new_tab`** returns `{app, tabId}`, defaults to the browser in use (`defaultBrowser`), needs a running browser with a window, never calls `activate()`, and puts back the tab a window showed if the browser switched to the new one. When the browser came to the front anyway, the result carries `warning: "creating the tab brought the browser to the front"`. Pinned by `test/new-tab-restore.test.mjs`.
- **`activate_tab`** is the only tool that selects a tab and raises its window.
