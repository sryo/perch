# File upload and drop zones

- `file_upload` reads the file in Node and ships it base64 in one page call, where a `DataTransfer` sets the input's `files`. It refuses a file over 25MB, or over 700KB without the daemon (one-shot osascript's argument limit). Rejected: a localhost server the page fetches from (local-network prompt).
- The OS file dialog: `raise:true` clicks the control, types the path into its Go to sheet, fails closed (one open, browser behind) and believes only the page. One open (`chooser:"open"`): `raise:true` with no control fills it, `press {Escape, dialog}` cancels it. Pinned by `test/upload-chooser.test.mjs`.
- A target that is not a file input is a drop zone: its own file input comes first; with none, the page dispatches `dragenter`/`dragover`/`drop` with the file. An unwired hidden input (no request, no mutation within 1s) falls back to a drop. A drop (`dropped:true, el`) counts when an input holds the file, its name shows (`shown`) or `took` (`preview`, `request`).
- Pinned by `test/upload.test.mjs`.
