# Console (`console_capture`)

- `console_capture` injects a `<script>` that patches the main world's console and relays `perch:console` events; under a CSP that blocks inline scripts it patches the isolated console instead (perch's own evals only). Besides `level: text` entries it records `Uncaught ...`, `Unhandled rejection: ...` and `Assertion failed: ...` errors. Servers share one capture per document: only the last `stop` unhooks (earlier ones answer `stillCapturing`), and a read after another server's drain adds `partial:true`.
- A Resource Timing `network` mode was dropped to free schema budget; patching `fetch`/XHR was rejected as close to interception.
- Pinned by `test/cross-server-state.test.mjs`.
